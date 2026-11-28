import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "StyleMatrix.PromptManager",

    // Called by ComfyUI when the user clicks 'Refresh' or presses 'R'
    refreshComboInNodes() {
        if (!app.graph) return;
        for (const node of app.graph._nodes) {
            if (node.type === "StyleMatrix" && node._scheduleRefreshStyles) {
                node._scheduleRefreshStyles();
            }
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "StyleMatrix") {
            const origRefreshComboInNodes = nodeType.prototype.refreshComboInNodes;
            nodeType.prototype.refreshComboInNodes = function () {
                const r = origRefreshComboInNodes
                    ? origRefreshComboInNodes.apply(this, arguments)
                    : undefined;
                if (this._scheduleRefreshStyles) {
                    this._scheduleRefreshStyles();
                }
                return r;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

                const categoryWidget = this.widgets.find((w) => w.name === "category");
                const styleWidget = this.widgets.find((w) => w.name === "style");
                const posWidget = this.widgets.find((w) => w.name === "positive");
                const negWidget = this.widgets.find((w) => w.name === "negative");
                const sortWidget = this.widgets.find((w) => w.name === "sort_mode");
                const filenameWidget = this.widgets.find((w) => w.name === "filename");

                if (categoryWidget && styleWidget && posWidget && negWidget && sortWidget && filenameWidget) {
                    let allCategories = {};
                    let allSubcategories = {};
                    let activeStyleCategory = "";
                    let activeStyleSubcategory = "";
                    let styleMetaMap = {};
                    let searchDebounceTimer = null;
                    let isInternalStyleUpdate = false;
                    let _styleValues = Array.isArray(styleWidget.options?.values)
                        ? styleWidget.options.values
                        : ["Select Style"];

                    const setStyleValues = (values) => {
                        isInternalStyleUpdate = true;
                        styleWidget.options.values = values;
                        isInternalStyleUpdate = false;
                    };

                    // Guard styleWidget.options.values so ComfyUI's 'R' refresh can never
                    // clobber our category/subcategory filter & sort order with raw INPUT_TYPES
                    if (styleWidget.options) {
                        Object.defineProperty(styleWidget.options, "values", {
                            configurable: true,
                            enumerable: true,
                            get() {
                                return _styleValues;
                            },
                            set(val) {
                                if (isInternalStyleUpdate) {
                                    _styleValues = val;
                                } else if (typeof scheduleRefreshStyles === "function") {
                                    scheduleRefreshStyles();
                                }
                            },
                        });
                    }

                    // --- Add UI-only Subcategory & Search widgets (serialize: false so saved workflows never shift!) ---
                    const subWidget = this.addWidget(
                        "combo",
                        "subcategory",
                        "(All)",
                        () => {
                            activeStyleSubcategory =
                                subWidget.value === "(All)" || subWidget.value === "(Root)"
                                    ? ""
                                    : subWidget.value;
                            updateStyleList();
                        },
                        { values: ["(All)"] }
                    );
                    subWidget.serialize = false;

                    const filterWidget = this.addWidget(
                        "text",
                        "filter (name / prompt)",
                        "",
                        () => {
                            scheduleSearch();
                        }
                    );
                    filterWidget.serialize = false;

                    // Position subcategory right after category, and filter right before style
                    const moveWidgetAfter = (widgetToMove, anchorWidget) => {
                        const fromIdx = this.widgets.indexOf(widgetToMove);
                        if (fromIdx === -1) return;
                        this.widgets.splice(fromIdx, 1);
                        const anchorIdx = this.widgets.indexOf(anchorWidget);
                        if (anchorIdx === -1) {
                            this.widgets.push(widgetToMove);
                        } else {
                            this.widgets.splice(anchorIdx + 1, 0, widgetToMove);
                        }
                    };
                    moveWidgetAfter(subWidget, categoryWidget);
                    moveWidgetAfter(filterWidget, subWidget);

                    const updateSubcategoryList = (preferredSub = null) => {
                        const selectedCategory = categoryWidget.value;
                        if (selectedCategory === "(All)") {
                            subWidget.options.values = ["(All)"];
                            subWidget.value = "(All)";
                            return;
                        }
                        const subs = allSubcategories[selectedCategory] || [];
                        const items = allCategories[selectedCategory] || [];
                        const hasRootItems = items.some((s) => !s.subcategory);

                        let values;
                        if (subs.length === 0) {
                            values = ["(All)"];
                        } else if (hasRootItems) {
                            values = ["(All)", "(Root)", ...subs];
                        } else {
                            values = ["(All)", ...subs];
                        }

                        subWidget.options.values = values;
                        if (preferredSub && values.includes(preferredSub)) {
                            subWidget.value = preferredSub;
                        } else if (!values.includes(subWidget.value)) {
                            subWidget.value = "(All)";
                        }
                    };

                    const applySortedNames = (items) => {
                        let filtered = items.slice().filter(
                            (s) => s.name !== "Select Style" && s.name !== "No Styles Found"
                        );

                        const currentSortMode = sortWidget.value;
                        if (currentSortMode === "Newest") {
                            filtered.sort((a, b) => b.mtime - a.mtime);
                        } else if (currentSortMode === "Oldest") {
                            filtered.sort((a, b) => a.mtime - b.mtime);
                        } else if (currentSortMode === "A-Z") {
                            filtered.sort((a, b) => a.name.localeCompare(b.name));
                        } else if (currentSortMode === "Z-A") {
                            filtered.sort((a, b) => b.name.localeCompare(a.name));
                        }

                        styleMetaMap = {};
                        const nameCounts = {};
                        for (const s of filtered) {
                            nameCounts[s.name] = (nameCounts[s.name] || 0) + 1;
                        }

                        const sortedNames = filtered.map((s) => {
                            const cat = s.category || categoryWidget.value;
                            const label = nameCounts[s.name] > 1 ? `${s.name} [${cat}]` : s.name;
                            styleMetaMap[label] = {
                                name: s.name,
                                category: cat,
                                subcategory: s.subcategory || "",
                            };
                            return label;
                        });

                        if (sortedNames.length > 0) {
                            sortedNames.unshift("Select Style");
                        } else {
                            sortedNames.push("No Styles Found");
                        }

                        const prevValue = styleWidget.value;
                        setStyleValues(sortedNames);

                        if (styleWidget.options.values.includes(prevValue)) {
                            styleWidget.value = prevValue;
                        } else if (styleWidget.options.values.length > 0) {
                            styleWidget.value = styleWidget.options.values[0];
                        }

                        if (this.setDirtyCanvas) {
                            this.setDirtyCanvas(true, true);
                        }
                    };

                    const updateStyleList = async () => {
                        const selectedCategory = categoryWidget.value;
                        const selectedSub = subWidget.value || "(All)";
                        const query = (filterWidget.value || "").trim();

                        if (query.length > 0) {
                            try {
                                const res = await api.fetchApi(
                                    `/style_matrix/search?category=${encodeURIComponent(selectedCategory)}&subcategory=${encodeURIComponent(selectedSub)}&q=${encodeURIComponent(query)}`
                                );
                                if (res.ok) {
                                    const data = await res.json();
                                    applySortedNames(data.matches || []);
                                    return;
                                }
                            } catch (e) {
                                console.error("StyleMatrix Search Error:", e);
                            }
                        }

                        let items = [];
                        if (selectedCategory === "(All)") {
                            for (const [cat, list] of Object.entries(allCategories)) {
                                for (const s of list) {
                                    items.push({ ...s, category: s.category || cat });
                                }
                            }
                        } else {
                            items = (allCategories[selectedCategory] || []).map((s) => ({
                                ...s,
                                category: s.category || selectedCategory,
                            }));
                            if (selectedSub && selectedSub !== "(All)") {
                                if (selectedSub === "(Root)") {
                                    items = items.filter((s) => !s.subcategory);
                                } else {
                                    items = items.filter(
                                        (s) =>
                                            s.subcategory === selectedSub ||
                                            (s.subcategory && s.subcategory.startsWith(selectedSub + "/"))
                                    );
                                }
                            }
                        }
                        applySortedNames(items);
                    };

                    const scheduleSearch = () => {
                        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                        searchDebounceTimer = setTimeout(() => {
                            updateStyleList();
                        }, 150);
                    };

                    const loadSelectedStyle = async (value) => {
                        if (!value || value === "Select Style" || value === "No Styles Found") {
                            return;
                        }
                        try {
                            const meta = styleMetaMap[value];
                            const catValue = meta ? meta.category : categoryWidget.value;
                            const realName = meta ? meta.name : value;
                            const response = await api.fetchApi(
                                `/style_matrix/get_style_content?category=${encodeURIComponent(catValue)}&name=${encodeURIComponent(realName)}`
                            );
                            if (response.ok) {
                                const data = await response.json();
                                if (data.positive !== undefined) posWidget.value = data.positive;
                                if (data.negative !== undefined) negWidget.value = data.negative;
                                activeStyleCategory = catValue;
                                activeStyleSubcategory = data.subcategory || "";

                                if (filenameWidget) {
                                    let targetName = realName;
                                    targetName = targetName.replace(/\s+\[[^\]]+\]$/, "");
                                    const match = targetName.match(/\((.*)\.json\)$/);
                                    if (match) {
                                        targetName = match[1];
                                    } else if (targetName.toLowerCase().endsWith(".json")) {
                                        targetName = targetName.slice(0, -5);
                                    }
                                    filenameWidget.value = targetName;
                                }

                                if (this.setDirtyCanvas) {
                                    this.setDirtyCanvas(true, true);
                                }
                            }
                        } catch (error) {
                            console.error("StyleMatrix Loader Error:", error);
                        }
                    };

                    const origCategoryCallback = categoryWidget.callback;
                    categoryWidget.callback = function (value, canvas, node, pos, event) {
                        if (origCategoryCallback) origCategoryCallback.apply(this, arguments);
                        categoryWidget.value = value;
                        subWidget.value = "(All)";
                        activeStyleSubcategory = "";
                        updateSubcategoryList("(All)");
                        updateStyleList();
                    };

                    const origSortCallback = sortWidget.callback;
                    sortWidget.callback = function (value, canvas, node, pos, event) {
                        if (origSortCallback) origSortCallback.apply(this, arguments);
                        sortWidget.value = value;
                        updateStyleList();

                        api.fetchApi("/style_matrix/save_sort_mode", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ sort_mode: value }),
                        }).catch((e) => {
                            console.error("StyleMatrix: Failed to save sort mode", e);
                        });
                    };

                    let refreshDebounceTimer = null;
                    const refreshStyles = async (selectCategory = null, selectSub = null, selectName = null) => {
                        const preservedCat = selectCategory || categoryWidget.value;
                        const preservedSub = selectSub || subWidget.value;
                        const preservedSort = sortWidget.value;

                        try {
                            const confRes = await api.fetchApi("/style_matrix/get_config");
                            if (confRes.ok) {
                                const confData = await confRes.json();
                                if (confData.sort_mode && preservedSort === "A-Z") {
                                    sortWidget.value = confData.sort_mode;
                                } else if (preservedSort) {
                                    sortWidget.value = preservedSort;
                                }
                            }

                            const response = await api.fetchApi("/style_matrix/refresh_styles_detailed");
                            if (response.ok) {
                                const data = await response.json();
                                if (data.categories) {
                                    allCategories = data.categories;
                                    allSubcategories = data.subcategories || {};

                                    const catNames = ["(All)", ...Object.keys(allCategories).sort()];
                                    if (catNames.length === 1) catNames.push("Uncategorized");
                                    categoryWidget.options.values = catNames;

                                    if (preservedCat && catNames.includes(preservedCat)) {
                                        categoryWidget.value = preservedCat;
                                    } else if (!catNames.includes(categoryWidget.value)) {
                                        categoryWidget.value = catNames[0];
                                    }

                                    updateSubcategoryList(preservedSub);
                                    await updateStyleList();

                                    if (selectName && styleWidget.options.values.includes(selectName)) {
                                        styleWidget.value = selectName;
                                    }
                                }
                            }
                        } catch (error) {
                            console.error("StyleMatrix Refresh Error:", error);
                        }
                    };

                    const scheduleRefreshStyles = () => {
                        if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
                        refreshDebounceTimer = setTimeout(() => {
                            refreshDebounceTimer = null;
                            refreshStyles();
                        }, 30);
                    };

                    this._refreshStyles = refreshStyles;
                    this._scheduleRefreshStyles = scheduleRefreshStyles;

                    const origOnConfigure = this.onConfigure;
                    this.onConfigure = function (info) {
                        if (origOnConfigure) origOnConfigure.apply(this, arguments);
                        updateSubcategoryList();
                        updateStyleList();
                    };

                    refreshStyles();

                    const originalCallback = styleWidget.callback;
                    styleWidget.callback = async function (value, canvas, node, pos, event) {
                        if (originalCallback) {
                            originalCallback.apply(this, arguments);
                        }
                        await loadSelectedStyle(value);
                    };

                    this.addWidget("button", "🎲 Random Style", "random", async () => {
                        const candidates = (styleWidget.options.values || []).filter(
                            (v) => v !== "Select Style" && v !== "No Styles Found"
                        );
                        if (candidates.length === 0) return;
                        let pick = candidates[Math.floor(Math.random() * candidates.length)];
                        if (candidates.length > 1 && pick === styleWidget.value) {
                            pick = candidates[(candidates.indexOf(pick) + 1) % candidates.length];
                        }
                        styleWidget.value = pick;
                        await loadSelectedStyle(pick);
                    });

                    this.addWidget("button", "New / Clear", "new", (value, canvas, node) => {
                        posWidget.value = "";
                        negWidget.value = "";
                        filenameWidget.value = "MyNewStyle";
                        filterWidget.value = "";
                        styleWidget.value = styleWidget.options.values.includes("Select Style")
                            ? "Select Style"
                            : styleWidget.options.values[0];
                        updateStyleList();
                        if (node && node.setDirtyCanvas) node.setDirtyCanvas(true, true);
                        else if (this && this.setDirtyCanvas) this.setDirtyCanvas(true, true);
                    });

                    this.addWidget("button", "New Category", "new_category", async () => {
                        const currentCat = categoryWidget.value || "";
                        const hint = currentCat && currentCat !== "Uncategorized"
                            ? `${currentCat}/`
                            : "";
                        const categoryName = window.prompt(
                            "Enter new category or nested subfolder (e.g. Characters/Asta):",
                            hint
                        );
                        if (!categoryName || categoryName.trim() === "") return;

                        try {
                            const response = await api.fetchApi("/style_matrix/create_category", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ category: categoryName.trim() }),
                            });

                            const result = await response.json();

                            if (result.status === "success") {
                                await refreshStyles(
                                    result.category || categoryName.trim(),
                                    result.subcategory || "(All)"
                                );
                                window.alert(`Category "${categoryName.trim()}" created successfully!`);
                            } else {
                                window.alert(`Error: ${result.detail}`);
                            }
                        } catch (error) {
                            console.error("StyleMatrix: Failed to create category:", error);
                        }
                    });

                    this.addWidget("button", "Refresh List", "refresh", () => {
                        refreshStyles();
                    });

                    let isSaving = false;
                    const performSave = async () => {
                        if (isSaving) return;
                        const filename = filenameWidget.value;
                        let category = categoryWidget.value;
                        let targetSub = subWidget.value;
                        if (category === "(All)") {
                            if (activeStyleCategory && activeStyleCategory !== "(All)") {
                                category = activeStyleCategory;
                                targetSub = activeStyleSubcategory || "";
                            } else {
                                window.alert("Please select a specific category before saving a new style.");
                                return;
                            }
                        } else if (targetSub === "(All)") {
                            targetSub = activeStyleSubcategory || "";
                        } else if (targetSub === "(Root)") {
                            targetSub = "";
                        }

                        if (!filename || !filename.trim()) {
                            window.alert("Please enter a filename to save the style.");
                            return;
                        }

                        isSaving = true;
                        const sendSave = async (overwrite) => {
                            const response = await api.fetchApi("/style_matrix/save_style", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    filename: filename,
                                    category: category,
                                    subcategory: targetSub,
                                    positive: posWidget.value,
                                    negative: negWidget.value,
                                    overwrite,
                                }),
                            });
                            const res = await response.json();
                            return { response, res };
                        };

                        try {
                            let { response, res } = await sendSave(false);

                            if (response.status === 409 && res.exists) {
                                const safeFilename = filename.replace(/ /g, "_").replace(/\.json$/i, "");
                                const loc = targetSub ? `${category}/${targetSub}` : category;
                                if (!window.confirm(`Style "${safeFilename}" already exists in "${loc}". Overwrite it?`)) {
                                    return;
                                }
                                ({ response, res } = await sendSave(true));
                            }

                            if (response.ok) {
                                const safeFilename = filename.replace(/ /g, "_").replace(/\.json$/i, "");
                                await refreshStyles(category, targetSub || "(All)", safeFilename);
                                filenameWidget.value = safeFilename;
                                window.alert(res.message || "Style saved successfully!");
                            } else {
                                window.alert(`Error saving style: ${res.error || "Unknown error"}`);
                            }
                        } catch (error) {
                            console.error("StyleMatrix Save Error:", error);
                            window.alert(`An error occurred while saving the style: ${error.message}`);
                        } finally {
                            isSaving = false;
                        }
                    };

                    // Save when pressing Enter while editing the filename field
                    let lastEnterTimestamp = 0;
                    const onWindowKeyDown = (e) => {
                        if (e.key !== "Enter") return;
                        const active = document.activeElement;
                        if (!active || active.tagName !== "INPUT") return;

                        lastEnterTimestamp = Date.now();

                        const isDirectInput = filenameWidget.inputEl && active === filenameWidget.inputEl;
                        const isThisNodeSelected = Boolean(
                            this.is_selected || app.canvas?.selected_nodes?.[this.id]
                        );
                        const matchesValue = active.value === filenameWidget.value;

                        if (isDirectInput || (isThisNodeSelected && matchesValue)) {
                            e.preventDefault();
                            filenameWidget.value = active.value;
                            lastEnterTimestamp = 0;
                            performSave();
                        }
                    };
                    window.addEventListener("keydown", onWindowKeyDown, true);

                    const origOnRemoved = this.onRemoved;
                    this.onRemoved = function () {
                        window.removeEventListener("keydown", onWindowKeyDown, true);
                        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                        if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
                        if (origOnRemoved) origOnRemoved.apply(this, arguments);
                    };

                    const origFilenameCallback = filenameWidget.callback;
                    filenameWidget.callback = function (value, canvas, node, pos, event) {
                        if (origFilenameCallback) origFilenameCallback.apply(this, arguments);
                        filenameWidget.value = value;
                        if (Date.now() - lastEnterTimestamp < 250) {
                            lastEnterTimestamp = 0;
                            performSave();
                        }
                    };

                    this.addWidget("button", "Save Style", "save", () => {
                        performSave();
                    });

                    this.addWidget("button", "Delete Style", "delete", async () => {
                        const selectedStyle = styleWidget.value;
                        const meta = styleMetaMap[selectedStyle];
                        const category = meta ? meta.category : categoryWidget.value;
                        const realName = meta ? meta.name : selectedStyle;

                        if (
                            !selectedStyle ||
                            selectedStyle === "Select Style" ||
                            selectedStyle === "No Styles Found"
                        ) {
                            window.alert("Please select a style to delete first.");
                            return;
                        }

                        if (!window.confirm(`Delete style "${realName}" from "${category}"? This cannot be undone.`)) {
                            return;
                        }

                        try {
                            const response = await api.fetchApi("/style_matrix/delete_style", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ category, name: realName }),
                            });

                            const res = await response.json();

                            if (response.ok) {
                                posWidget.value = "";
                                negWidget.value = "";
                                filenameWidget.value = "MyNewStyle";
                                activeStyleSubcategory = "";
                                await refreshStyles(category, subWidget.value);
                                window.alert(res.message || "Style deleted.");
                            } else {
                                window.alert(`Error deleting style: ${res.error || "Unknown error"}`);
                            }
                        } catch (error) {
                            console.error("StyleMatrix Delete Error:", error);
                            window.alert(`An error occurred while deleting the style: ${error.message}`);
                        }
                    });
                }
                return r;
            };
        }
    },
});
