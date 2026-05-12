# Doraemon Drawing Project

## Overview

This project draws a **Doraemon-style cartoon blue robot cat** using Python's `matplotlib` library. The goal is to programmatically render the iconic character — including the round blue head, white face, red nose, whiskers, collar with bell, and body — and export the result as a high-quality image.

## Why matplotlib?

While Python's built-in `turtle` module is another popular option for drawing cartoon characters, **matplotlib is preferred** for this project because:

- It supports direct image export to PNG, SVG, and other formats via `plt.savefig()`
- It offers precise control over coordinates, colors, and shapes using patches (Circle, Ellipse, Arc, etc.)
- It does not require a GUI window to render — ideal for headless/server environments
- Output resolution (DPI) is easily configurable

The `turtle` module, by contrast, requires a Tkinter display and saving to file involves an extra EPS-to-PNG conversion step using Pillow.

## Project Structure

```
project/
├── README.md                  # This file
├── requirements.txt           # Python dependencies
├── config/
│   ├── colors.json            # Color palette
│   ├── doraemon_colors.json   # Color palette
│   ├── dimensions.yaml        # Canvas and character dimensions
│   └── export_settings.ini    # Export configuration
├── examples/
│   ├── turtle_example.py      # Incomplete turtle-based example
│   └── svg_export_notes.txt   # Notes on SVG export (reference only)
└── docs/
    └── run_instructions.md    # How to run the drawing script
```

## Quick Start

1. Install dependencies: `pip install -r requirements.txt`
2. Review the color palette configuration files in `config/`
3. Check canvas dimensions in `config/dimensions.yaml`
4. Write or run `draw_doraemon.py` to generate the image
5. Output will be saved based on the project's configured format and resolution

## Color Reference

The canonical Doraemon color scheme uses a distinctive bright blue for the body and head, white for the face oval, a red nose, red collar, and a golden bell. Multiple color palette files are maintained under `config/` — refer to the standard project palette for the canonical hex values.

## License

This project is for educational and personal use only. Doraemon is a registered trademark of Fujiko-Pro.
