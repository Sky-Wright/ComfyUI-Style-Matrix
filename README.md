# ComfyUI SD.Next Style Loader

A custom node for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that brings the **SD.Next / A1111** style management workflow to the node graph. 

Unlike standard loaders that are "blind" (you pick a file and hope for the best), this node is **interactive**. Selecting a style instantly populates editable text widgets, allowing you to review and modify prompts before generation.

## Features

-   **Interactive Loading:** Selecting a style from the dropdown automatically fetches the JSON content and fills the text boxes via a custom API bridge.
-   **Editable Prompts:** Once loaded, you can freely edit the positive and negative prompts (e.g., adding Loras, tweaking weights) before passing them to the encoder.
-   **A1111/SD.Next JSON Support:** Natively reads standard style JSON files:
    ```json
    {
      "name": "My Style",
      "prompt": "masterpiece, best quality...",
      "negative": "lowres, bad anatomy..."
    }
    ```
-   **Dual Output:** Provides separate `STRING` outputs for Positive and Negative prompts, perfect for wiring into **Advanced CLIP Text Encode** nodes.

## Installation

1.  Clone this repository into your `ComfyUI/custom_nodes/` directory:
    ```bash
    cd ComfyUI/custom_nodes
    git clone https://github.com/YOUR_USERNAME/ComfyUI-SDNext-StyleLoader.git
    ```
2.  Restart ComfyUI.

## Usage

1.  **Place your JSON styles** in `ComfyUI/models/styles/`.
    *   *Note: The node automatically scans this directory on startup.*
2.  **Add the Node:** Right-click > `utils` > `sdnext` > `SD.Next Style Loader (Editable)`.
3.  **Select a Style:** Pick an entry from the dropdown. The text boxes will auto-fill.
4.  **Connect:** Wire the `positive_text` and `negative_text` outputs to your CLIP Text Encode nodes (right-click the CLIP node and select "Convert text to widget" if needed).

## Workflow Recommendation

For the best results, pair this node with **ComfyUI_ADV_CLIP_emb**. 
*   **Why?** SD.Next/A1111 prompts often use specific weighting syntax (e.g., `(text:1.5)`). Standard ComfyUI CLIP nodes parse this differently. The Advanced CLIP nodes handle A1111 weighting logic correctly, ensuring your styles look exactly as intended.

## License

MIT
