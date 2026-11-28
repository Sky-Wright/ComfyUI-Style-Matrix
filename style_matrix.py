import os
import json
import re
import folder_paths
from server import PromptServer
from aiohttp import web


def clean_prompt(text):
    if not isinstance(text, str):
        return text

    # Convert literal "\n" sequences (common when pasting from LLMs/JSON) into real newlines
    text = text.replace("\\n", "\n")

    lines = text.split("\n")
    cleaned_lines = []
    current_line = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            if current_line:
                cleaned_lines.append(" ".join(current_line))
                current_line = []
            continue

        # Preserve bracketed section headers (e.g. [Section]) on their own line
        if stripped.startswith("["):
            if current_line:
                cleaned_lines.append(" ".join(current_line))
                current_line = []
            current_line.append(stripped)
        else:
            current_line.append(stripped)

    if current_line:
        cleaned_lines.append(" ".join(current_line))

    result_lines = []
    for line in cleaned_lines:
        cleaned_val = re.sub(r"\s+", " ", line).strip()
        if cleaned_val:
            result_lines.append(cleaned_val)

    return "\n".join(result_lines)


CONFIG_FILE_PATH = os.path.join(os.path.dirname(__file__), "style_matrix_config.json")
LEGACY_CONFIG_FILE_PATH = os.path.join(os.path.dirname(__file__), "sdnext_promptloader_config.json")


def load_config():
    for path in (CONFIG_FILE_PATH, LEGACY_CONFIG_FILE_PATH):
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return {}


def save_config(config_data):
    try:
        with open(CONFIG_FILE_PATH, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=4)
        return True
    except Exception:
        return False


def _is_within_base(base_dir, target_path):
    abs_base = os.path.abspath(base_dir)
    abs_target = os.path.abspath(target_path)
    try:
        return os.path.commonpath([abs_base, abs_target]) == abs_base
    except ValueError:
        return False


def load_search_paths_from_config():
    config = load_config()
    if "search_paths" in config and isinstance(config["search_paths"], list):
        valid_paths = [os.path.abspath(p) for p in config["search_paths"] if isinstance(p, str) and p.strip()]
        if valid_paths:
            return valid_paths

    candidates = []

    # 1. Respect ComfyUI extra_model_paths.yaml ("styles") if registered
    try:
        extra_style_paths = folder_paths.get_folder_paths("styles")
        if extra_style_paths:
            candidates.extend(extra_style_paths)
    except Exception:
        pass

    # 2. Check sibling ../models/styles (common multi-install layout)
    sibling_style_path = os.path.abspath(os.path.join(folder_paths.base_path, "..", "models", "styles"))
    if os.path.exists(sibling_style_path):
        candidates.append(sibling_style_path)

    # 3. Standard internal ComfyUI models/styles directory
    comfyui_default_style_path = os.path.abspath(os.path.join(folder_paths.base_path, "models", "styles"))
    candidates.append(comfyui_default_style_path)

    # Deduplicate while preserving order
    seen = set()
    resolved = []
    for path in candidates:
        norm = os.path.normpath(os.path.abspath(path))
        if norm not in seen:
            seen.add(norm)
            resolved.append(norm)

    return resolved


SEARCH_PATHS = load_search_paths_from_config()


def _split_category(rel_path):
    """Split a relative directory path into (top_category, subcategory_path).
    '.' -> ('Uncategorized', '')
    'Sky' -> ('Sky', '')
    'Characters/Asta' -> ('Characters', 'Asta')
    'Characters/BDO/Vizeri' -> ('Characters', 'BDO/Vizeri')
    """
    if not rel_path or rel_path == ".":
        return "Uncategorized", ""
    parts = rel_path.replace("\\", "/").strip("/").split("/")
    top = parts[0]
    sub = "/".join(parts[1:]) if len(parts) > 1 else ""
    return top, sub


def get_all_styles():
    """Walk all configured style paths and return:
    - categorized_prompts: {top_category: {display_name: info_dict}}
    - flat_map: {"top_category||display_name": info_dict}
    - subcategories: {top_category: sorted_list_of_subcategories}
    """
    categorized_prompts = {}
    flat_map = {}
    subcategories_map = {}

    for search_path in SEARCH_PATHS:
        if not os.path.exists(search_path):
            continue
        try:
            for root, dirs, files in os.walk(search_path):
                # Skip hidden directories (.git, .crush, etc.) and __pycache__
                dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__pycache__")

                rel_path = os.path.relpath(root, search_path)
                top_cat, sub_cat = _split_category(rel_path)

                # Register non-root directories even if currently empty
                if rel_path != ".":
                    categorized_prompts.setdefault(top_cat, {})
                    subcategories_map.setdefault(top_cat, set())
                    if sub_cat:
                        subcategories_map[top_cat].add(sub_cat)

                for f in files:
                    if not f.lower().endswith(".json"):
                        continue
                    full_path = os.path.join(root, f)
                    try:
                        mtime = os.path.getmtime(full_path)
                        with open(full_path, "r", encoding="utf-8") as json_f:
                            data = json.load(json_f)

                        if not isinstance(data, dict):
                            continue

                        base_name = data.get("name", os.path.splitext(f)[0])
                        if not isinstance(base_name, str) or not base_name.strip():
                            base_name = os.path.splitext(f)[0]

                        categorized_prompts.setdefault(top_cat, {})
                        subcategories_map.setdefault(top_cat, set())
                        if sub_cat:
                            subcategories_map[top_cat].add(sub_cat)

                        display_name = base_name
                        if display_name in categorized_prompts[top_cat]:
                            if sub_cat:
                                display_name = f"{base_name} [{sub_cat}]"
                            if display_name in categorized_prompts[top_cat]:
                                display_name = f"{base_name} ({f})"

                        pos_str = data.get("prompt", "") or ""
                        neg_str = data.get("negative", "") or ""
                        search_blob = f"{display_name}\n{sub_cat}\n{pos_str}\n{neg_str}".lower()

                        info = {
                            "path": full_path,
                            "mtime": mtime,
                            "category": top_cat,
                            "subcategory": sub_cat,
                            "search_blob": search_blob,
                        }
                        categorized_prompts[top_cat][display_name] = info
                        flat_map[f"{top_cat}||{display_name}"] = info
                    except Exception as e:
                        print(f"StyleMatrix: Skipping '{f}' in '{root}' due to read error: {e}")
                        continue
        except Exception as e:
            print(f"StyleMatrix: Skipping directory '{search_path}' due to access error: {e}")

    sorted_categorized = {k: categorized_prompts[k] for k in sorted(categorized_prompts.keys())}
    sorted_subcats = {k: sorted(subcategories_map.get(k, set())) for k in sorted_categorized.keys()}
    return sorted_categorized, flat_map, sorted_subcats


STYLE_MAP = {}
CATEGORIZED_STYLES = {}
SUBCATEGORIES = {}


def _reload_cache():
    global STYLE_MAP, CATEGORIZED_STYLES, SUBCATEGORIES
    CATEGORIZED_STYLES, STYLE_MAP, SUBCATEGORIES = get_all_styles()


@PromptServer.instance.routes.get("/style_matrix/get_config")
async def get_config_route(request):
    return web.json_response(load_config())


@PromptServer.instance.routes.post("/style_matrix/save_sort_mode")
async def save_sort_mode(request):
    try:
        data = await request.json()
        sort_mode = data.get("sort_mode", "A-Z")
        config = load_config()
        config["sort_mode"] = sort_mode
        save_config(config)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/style_matrix/get_style_content")
async def get_style_content(request):
    category = request.rel_url.query.get("category", "")
    name = request.rel_url.query.get("name", "")
    key = f"{category}||{name}"

    if key in STYLE_MAP:
        info = STYLE_MAP[key]
        path = info["path"]
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    positive = clean_prompt(data.get("prompt", ""))
                    negative = clean_prompt(data.get("negative", ""))
                    return web.json_response({
                        "positive": positive,
                        "negative": negative,
                        "subcategory": info.get("subcategory", ""),
                    })
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "Style not found"}, status=404)


@PromptServer.instance.routes.get("/style_matrix/refresh_styles_detailed")
async def refresh_styles_detailed(request):
    _reload_cache()

    response_data = {}
    for cat, styles in CATEGORIZED_STYLES.items():
        response_data[cat] = [
            {
                "name": name,
                "mtime": info["mtime"],
                "category": cat,
                "subcategory": info.get("subcategory", ""),
            }
            for name, info in styles.items()
        ]

    return web.json_response({
        "categories": response_data,
        "subcategories": SUBCATEGORIES,
    })


@PromptServer.instance.routes.get("/style_matrix/search")
async def search_styles(request):
    """Full-text search across style name, subcategory, positive, and negative prompt text."""
    if not CATEGORIZED_STYLES:
        _reload_cache()

    category = request.rel_url.query.get("category", "")
    subcategory = request.rel_url.query.get("subcategory", "")
    query = request.rel_url.query.get("q", "").strip().lower()
    terms = [t for t in query.split() if t]

    if category == "(All)":
        cats_to_search = list(CATEGORIZED_STYLES.items())
    else:
        cats_to_search = [(category, CATEGORIZED_STYLES.get(category, {}))]

    matches = []
    for cat, styles in cats_to_search:
        for name, info in styles.items():
            sub = info.get("subcategory", "")
            if category != "(All)" and subcategory and subcategory != "(All)":
                if subcategory == "(Root)":
                    if sub != "":
                        continue
                elif sub != subcategory and not sub.startswith(subcategory + "/"):
                    continue

            if terms:
                blob = info.get("search_blob", name.lower())
                if not all(t in blob for t in terms):
                    continue

            matches.append({
                "name": name,
                "mtime": info["mtime"],
                "category": cat,
                "subcategory": sub,
            })

    return web.json_response({"matches": matches})


@PromptServer.instance.routes.post("/style_matrix/create_category")
async def create_new_category_folder(request):
    if not SEARCH_PATHS:
        return web.json_response({"status": "error", "detail": "No search paths configured."}, status=500)

    base_styles_dir = SEARCH_PATHS[0]
    try:
        json_data = await request.json()
        category_name = json_data.get("category", "").strip().replace("\\", "/").strip("/")

        if not category_name:
            return web.json_response({"status": "error", "detail": "Category name cannot be empty"}, status=400)

        target_dir = os.path.normpath(os.path.join(base_styles_dir, category_name))
        if not _is_within_base(base_styles_dir, target_dir):
            return web.json_response({"status": "error", "detail": "Invalid directory path"}, status=400)

        os.makedirs(target_dir, exist_ok=True)
        _reload_cache()
        top_cat, sub_cat = _split_category(category_name)
        return web.json_response({
            "status": "success",
            "message": f"Created category: {category_name}",
            "category": top_cat,
            "subcategory": sub_cat,
        })
    except Exception as e:
        return web.json_response({"status": "error", "detail": str(e)}, status=500)


@PromptServer.instance.routes.post("/style_matrix/save_style")
async def save_style(request):
    if not SEARCH_PATHS:
        return web.json_response({"error": "No search paths configured for saving."}, status=500)

    base_dir = SEARCH_PATHS[0]

    try:
        data = await request.json()
        filename = data.get("filename")
        category = data.get("category", "Uncategorized")
        subcategory = (data.get("subcategory") or "").strip().replace("\\", "/").strip("/")
        positive_prompt = clean_prompt(data.get("positive", ""))
        negative_prompt = clean_prompt(data.get("negative", ""))
        overwrite = bool(data.get("overwrite", False))
    except Exception as e:
        return web.json_response({"error": f"Invalid request data: {e}"}, status=400)

    if not filename:
        return web.json_response({"error": "Filename cannot be empty."}, status=400)

    if category == "(All)":
        return web.json_response({"error": "Please select a specific category before saving a new style."}, status=400)

    if subcategory in ("(All)", "(Root)", "(None)"):
        subcategory = ""

    save_dir = base_dir
    if category and category != "Uncategorized":
        rel_target = os.path.join(category, subcategory) if subcategory else category
        save_dir = os.path.normpath(os.path.join(base_dir, rel_target))
        if not _is_within_base(base_dir, save_dir):
            return web.json_response({"error": "Invalid category path."}, status=400)

    if not os.path.isdir(save_dir):
        try:
            os.makedirs(save_dir, exist_ok=True)
        except Exception as e:
            return web.json_response({"error": f"Save directory could not be created: {e}"}, status=500)

    filename = filename.replace(" ", "_")

    if ".." in filename or "/" in filename or "\\" in filename:
        return web.json_response({"error": "Invalid filename traversal detected."}, status=400)

    if not filename.lower().endswith(".json"):
        filename += ".json"

    style_name = os.path.splitext(filename)[0]
    full_path = os.path.join(save_dir, filename)
    display_loc = f"{category}/{subcategory}" if subcategory else category

    if os.path.exists(full_path) and not overwrite:
        return web.json_response(
            {"exists": True, "error": f"Style '{style_name}' already exists in '{display_loc}'."},
            status=409,
        )

    style_content = {
        "name": style_name,
        "description": "Saved from ComfyUI Style Matrix",
        "prompt": positive_prompt,
        "negative": negative_prompt,
        "extra": "",
    }

    try:
        with open(full_path, "w", encoding="utf-8") as f:
            json.dump(style_content, f, indent=2, ensure_ascii=False)

        _reload_cache()

        return web.json_response({"success": True, "message": f"Style saved to '{display_loc}'!"})
    except Exception as e:
        return web.json_response({"error": f"Failed to save style: {e}"}, status=500)


@PromptServer.instance.routes.post("/style_matrix/delete_style")
async def delete_style(request):
    try:
        data = await request.json()
        category = data.get("category", "")
        name = data.get("name", "")
    except Exception as e:
        return web.json_response({"error": f"Invalid request data: {e}"}, status=400)

    key = f"{category}||{name}"
    if key not in STYLE_MAP:
        return web.json_response({"error": "Style not found."}, status=404)

    target_path = STYLE_MAP[key]["path"]
    if not any(_is_within_base(sp, target_path) for sp in SEARCH_PATHS):
        return web.json_response({"error": "Invalid style path."}, status=400)

    if not os.path.isfile(target_path):
        return web.json_response({"error": "Style file does not exist."}, status=404)

    try:
        os.remove(target_path)
        _reload_cache()
        return web.json_response({"success": True, "message": f"Deleted style '{name}'."})
    except Exception as e:
        return web.json_response({"error": f"Failed to delete style: {e}"}, status=500)


class StyleMatrix:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        _reload_cache()

        categories = ["(All)"] + sorted(list(CATEGORIZED_STYLES.keys()))
        if len(categories) == 1:
            categories = ["(All)", "Uncategorized"]

        # Provide all valid style names across categories so ComfyUI backend validation passes
        all_valid_styles = ["Select Style"]
        for _cat, styles in CATEGORIZED_STYLES.items():
            all_valid_styles.extend(list(styles.keys()))

        all_valid_styles = ["Select Style"] + sorted(list(set(all_valid_styles[1:])))

        if len(all_valid_styles) == 1:
            all_valid_styles = ["Select Style", "No Styles Found"]

        return {
            "required": {
                "category": (categories,),
                "style": (all_valid_styles,),
                "positive": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "negative": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "sort_mode": (["A-Z", "Z-A", "Newest", "Oldest"], {"default": "A-Z"}),
                "filename": ("STRING", {"default": "MyNewStyle"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive_text", "negative_text", "style_name_text")
    FUNCTION = "process"
    CATEGORY = "utils/styles"

    def process(self, category, style, positive, negative, sort_mode, filename):
        style_clean = style.replace(" ", "_")
        clean_pos = clean_prompt(positive)
        clean_neg = clean_prompt(negative)
        return (clean_pos, clean_neg, style_clean)


NODE_CLASS_MAPPINGS = {
    "StyleMatrix": StyleMatrix,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StyleMatrix": "Style Matrix",
}
