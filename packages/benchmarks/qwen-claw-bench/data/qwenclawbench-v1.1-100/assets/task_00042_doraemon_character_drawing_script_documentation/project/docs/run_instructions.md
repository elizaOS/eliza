# How to Run the Doraemon Drawing Script

## Prerequisites

Make sure you have Python 3.8 or later installed on your system.

## Step 1: Install Dependencies

Navigate to the project root directory and install the required packages:

```bash
cd project
pip install -r requirements.txt
```

This will install:
- **matplotlib** — for drawing shapes and exporting images
- **Pillow** — for image processing and format conversion
- **numpy** — for numerical operations (coordinate calculations)

## Step 2: Run the Drawing Script

### Using matplotlib (Recommended)

Run the main drawing script:

```bash
python draw_doraemon.py
```

The script uses matplotlib's `patches` module (Circle, Ellipse, Arc, Polygon, etc.) to compose the character. The drawing is rendered on a matplotlib figure and saved directly to a file.

#### Saving the Output

In the script, the image is saved using `plt.savefig()`:

```python
import matplotlib.pyplot as plt

# ... drawing code ...

plt.savefig("doraemon_output.png", dpi=150, bbox_inches='tight', pad_inches=0.1)
plt.close()
```

Key parameters:
- `dpi` — Sets the output resolution (dots per inch). Check the project config for the correct value.
- `bbox_inches='tight'` — Removes excess whitespace around the figure.
- `format` is inferred from the file extension.

### Using turtle (Alternative)

If you prefer the turtle graphics approach, you can run:

```bash
python examples/turtle_example.py
```

**Note:** The turtle example is incomplete and does not save to file automatically.

To save a turtle drawing to PNG:

1. First export to EPS (Encapsulated PostScript):

```python
canvas = turtle.getcanvas()
canvas.postscript(file="doraemon.eps")
```

2. Then convert EPS to PNG using Pillow:

```python
from PIL import Image

img = Image.open("doraemon.eps")
img.save("doraemon_output.png", "PNG")
```

**Important:** EPS-to-PNG conversion with Pillow requires Ghostscript to be installed on your system.

## Step 3: Verify the Output

After running the script, check that the output file was created:

```bash
ls -la doraemon_output.png
```

You can open the PNG file with any image viewer to verify the drawing looks correct.

## Configuration Files

- **`config/colors.json`** — Color palette
- **`config/doraemon_colors.json`** — Color palette
- **`config/dimensions.yaml`** — Canvas dimensions, character proportions, output settings
- **`config/export_settings.ini`** — Export configuration

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `ModuleNotFoundError: No module named 'matplotlib'` | Run `pip install -r requirements.txt` |
| Blank or empty output image | Check that drawing coordinates are within the canvas bounds |
| Low resolution output | Verify DPI setting in the project configuration files |
| Turtle window doesn't close | Press Ctrl+C or close the window manually |
| EPS to PNG conversion fails | Install Ghostscript: `sudo apt install ghostscript` |
