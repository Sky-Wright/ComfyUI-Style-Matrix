import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "StyleMatrix.PromptManager",

    // Called by ComfyUI when the user clicks 'Refresh' or presses 'R'
    refreshComboInNodes() {
        if (!app.graph) return;
        for (const node of app.graph._nodes) {
            if (node.type === "StyleMatrix" && node._refreshStyles) {
                node._refreshStyles();
            }
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "StyleMatrix") {
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

                    const updateStyleList = () => {
                        const selectedCategory = categoryWidget.value;
                        let items = allCategories[selectedCategory] || [];

                        items = items.slice().filter(
                            (s) => s.name !== "Select Style" && s.name !== "No Styles Found"
                        );

                        const currentSortMode = sortWidget.value;

                        if (currentSortMode === "Newest") {
                            items.sort((a, b) => b.mtime - a.mtime);
                        } else if (currentSortMode === "Oldest") {
                            items.sort((a, b) => a.mtime - b.mtime);
                        } else if (currentSortMode === "A-Z") {
                            items.sort((a, b) => a.name.localeCompare(b.name));
                        } else if (currentSortMode === "Z-A") {
                            items.sort((a, b) => b.name.localeCompare(a.name));
                        }

                        const sortedNames = items.map((s) => s.name);

                        if (sortedNames.length > 0) {
                            sortedNames.unshift("Select Style");
                        } else {
                            sortedNames.push("No Styles Found");
                        }

                        const prevValue = styleWidget.value;
                        styleWidget.options.values = sortedNames;

                        if (styleWidget.options.values.includes(prevValue)) {
                            styleWidget.value = prevValue;
                        } else if (styleWidget.options.values.length > 0) {
                            styleWidget.value = styleWidget.options.values[0];
                        }

                        if (this.setDirtyCanvas) {
                            this.setDirtyCanvas(true, true);
                        }
                    };

                    const origCategoryCallback = categoryWidget.callback;
                    categoryWidget.callback = function (value, canvas, node, pos, event) {
                        if (origCategoryCallback) origCategoryCallback.apply(this, arguments);
                        categoryWidget.value = value;
                        updateStyleList();
                    };

                    const origSortCallback = sortWidget.callback;
                    sortWidget.callback = async function (value, canvas, node, pos, event) {
                        if (origSortCallback) origSortCallback.apply(this, arguments);
                        try {
                            await api.fetchApi("/style_matrix/save_sort_mode", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ sort_mode: value }),
                            });
                        } catch (e) {
                            console.error("StyleMatrix: Failed to save sort mode", e);
                        }
                        updateStyleList();
                    };

                    const refreshStyles = async (selectCategory = null, selectName = null) => {
                        try {
                            const confRes = await api.fetchApi("/style_matrix/get_config");
                            if (confRes.ok) {
                                const confData = await confRes.json();
                                if (confData.sort_mode && sortWidget.value === "A-Z") {
                                    sortWidget.value = confData.sort_mode;
                                }
                            }

                            const response = await api.fetchApi("/style_matrix/refresh_styles_detailed");
                            if (response.ok) {
                                const data = await response.json();
                                if (data.categories) {
                                    allCategories = data.categories;

                                    const catNames = Object.keys(allCategories).sort();
                                    if (catNames.length === 0) catNames.push("Uncategorized");
                                    categoryWidget.options.values = catNames;

                                    if (selectCategory && catNames.includes(selectCategory)) {
                                        categoryWidget.value = selectCategory;
                                    } else if (!catNames.includes(categoryWidget.value)) {
                                        categoryWidget.value = catNames[0];
                                    }

                                    updateStyleList();

                                    if (selectName) {
                                        styleWidget.value = selectName;
                                    }
                                }
                            }
                        } catch (error) {
                            console.error("StyleMatrix Refresh Error:", error);
                        }
                    };

                    this._refreshStyles = refreshStyles;

                    const origOnConfigure = this.onConfigure;
                    this.onConfigure = function (info) {
                        if (origOnConfigure) origOnConfigure.apply(this, arguments);
                        updateStyleList();
                    };

                    refreshStyles();

                    const originalCallback = styleWidget.callback;
                    styleWidget.callback = async function (value, canvas, node, pos, event) {
                        if (originalCallback) {
                            originalCallback.apply(this, arguments);
                        }
                        if (value === "Select Style" || value === "No Styles Found") {
                            return;
                        }
                        try {
                            const catValue = categoryWidget.value;
                            const response = await api.fetchApi(
                                `/style_matrix/get_style_content?category=${encodeURIComponent(catValue)}&name=${encodeURIComponent(value)}`
                            );
                            if (response.ok) {
                                const data = await response.json();
                                if (data.positive !== undefined) posWidget.value = data.positive;
                                if (data.negative !== undefined) negWidget.value = data.negative;

                                if (filenameWidget) {
                                    let targetName = value;
                                    targetName = targetName.replace(/^\[.*\]\s*/, "");
                                    const match = targetName.match(/\((.*)\.json\)$/);
                                    if (match) {
                                        targetName = match[1];
                                    } else if (targetName.toLowerCase().endsWith(".json")) {
                                        targetName = targetName.slice(0, -5);
                                    }
                                    filenameWidget.value = targetName;
                                }
                            }
                        } catch (error) {
                            console.error("StyleMatrix Loader Error:", error);
                        }
                    };

                    this.addWidget("button", "New / Clear", "new", (value, canvas, node) => {
                        posWidget.value = "";
                        negWidget.value = "";
                        filenameWidget.value = "MyNewStyle";
                        styleWidget.value = styleWidget.options.values.includes("Select Style")
                            ? "Select Style"
                            : styleWidget.options.values[0];
                        if (node && node.setDirtyCanvas) node.setDirtyCanvas(true, true);
                        else if (this && this.setDirtyCanvas) this.setDirtyCanvas(true, true);
                    });

                    this.addWidget("button", "New Category", "new_category", async (value, canvas, node) => {
                        const categoryName = window.prompt("Enter new category name (e.g., CyberStyle):");
                        if (!categoryName || categoryName.trim() === "") return;

                        try {
                            const response = await api.fetchApi("/style_matrix/create_category", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ category: categoryName.trim() }),
                            });

                            const result = await response.json();

                            if (result.status === "success") {
                                await refreshStyles(categoryName.trim());
                                window.alert(`Category "${categoryName.trim()}" created successfully!`);
                            } else {
                                window.alert(`Error: ${result.detail}`);
                            }
                        } catch (error) {
                            console.error("StyleMatrix: Failed to create category:", error);
                        }
                    });

                    this.addWidget("button", "Refresh List", "refresh", (value, canvas, node) => {
                        refreshStyles();
                    });

                    let isSaving = false;
                    const performSave = async () => {
                        if (isSaving) return;
                        const filename = filenameWidget.value;
                        const category = categoryWidget.value;

                        if (!filename || !filename.trim()) {
                            window.alert("Please enter a filename to save the style.");
                            return;
                        }

                        isSaving = true;
                        const body = {
                            filename: filename,
                            category: category,
                            positive: posWidget.value,
                            negative: negWidget.value,
                        };

                        try {
                            const response = await api.fetchApi("/style_matrix/save_style", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(body),
                            });

                            const res = await response.json();

                            if (response.ok) {
                                const safeFilename = filename.replace(/ /g, "_");
                                await refreshStyles(category, safeFilename);
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

                        // If ComfyUI's inline/Vue input doesn't fire widget.callback on Enter,
                        // detect that this node is active/matches the input and save directly.
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

                    this.addWidget("button", "Delete Style", "delete", async (value, canvas, node) => {
                        const selectedStyle = styleWidget.value;
                        const category = categoryWidget.value;

                        if (
                            !selectedStyle ||
                            selectedStyle === "Select Style" ||
                            selectedStyle === "No Styles Found"
                        ) {
                            window.alert("Please select a style to delete first.");
                            return;
                        }

                        if (!window.confirm(`Delete style "${selectedStyle}" from "${category}"? This cannot be undone.`)) {
                            return;
                        }

                        try {
                            const response = await api.fetchApi("/style_matrix/delete_style", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ category, name: selectedStyle }),
                            });

                            const res = await response.json();

                            if (response.ok) {
                                posWidget.value = "";
                                negWidget.value = "";
                                filenameWidget.value = "MyNewStyle";
                                await refreshStyles(category);
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
