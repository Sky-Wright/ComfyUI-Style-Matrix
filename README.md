# ComfyUI Style Matrix

An interactive JSON prompt style manager for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — built as much for **organizing large style libraries** as for **rapidly creating and iterating on new ones**.

It effectively replaces typing prompts directly into your CLIP Text Encode nodes: right-click your positive/negative CLIP nodes, convert `text` to an input, and wire **Style Matrix** straight in. Browse categorized `.json` styles, sort by name or recency, live-edit prompts before generating, and save or delete styles without leaving the graph.

## Features

- **Interactive Loading:** Selecting a style from the dropdown immediately loads its JSON into editable `positive` and `negative` text boxes.
- **Folder-Based Categories:** Subdirectories inside your styles folder automatically become categories, with an in-node **New Category** button.
- **Sorting:** Sort styles `A-Z`, `Z-A`, `Newest`, or `Oldest`.
- **Save & Delete:** Save edits or new styles back to `.json` files, or remove unwanted styles safely with a confirmation prompt.
- **Flexible Path Discovery:** Checks `style_matrix_config.json` (`search_paths`), `extra_model_paths.yaml` (`styles`), `../models/styles`, and `ComfyUI/models/styles`.
- **Standard JSON Format:**
  ```json
  {
    "name": "My_Style",
    "description": "Saved from ComfyUI Style Matrix",
    "prompt": "masterpiece, best quality...",
    "negative": "lowres, bad anatomy...",
    "extra": ""
  }
  ```
- **Universal Outputs:** Outputs `positive_text`, `negative_text`, and `style_name_text` (`STRING`), compatible with any CLIP Text Encode node.

## Installation

1. Clone this repository into your `ComfyUI/custom_nodes/` directory:
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/Sky-Wright/ComfyUI-Style-Matrix.git
   ```
2. Restart ComfyUI.

## Usage

1. **Place your JSON styles** in `ComfyUI/models/styles/` (or configure `styles:` in `extra_model_paths.yaml`).
2. **Add the Node:** Right-click > `utils` > `styles` > `Style Matrix`.
3. **Select a Category & Style:** Pick a style from the dropdown to populate the prompt boxes.
4. **Connect:** Wire `positive_text` and `negative_text` into your CLIP Text Encode nodes.

## License

MIT
