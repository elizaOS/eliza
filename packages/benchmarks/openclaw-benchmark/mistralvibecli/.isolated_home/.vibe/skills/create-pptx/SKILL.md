---
name: create-pptx
description: Generate PowerPoint presentations using python-pptx
license: MIT
user-invocable: true
allowed-tools:
  - bash
  - write_file
  - read_file
---

# PowerPoint Presentation Generator

This skill creates properly formatted PPTX presentations using python-pptx.

## Prerequisites

Ensure python-pptx is installed:
```bash
pip install python-pptx
# or: uv pip install python-pptx
```

## Workflow

### Step 1: Create Python Script

Write a Python script that generates the presentation:

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RgbColor
from pptx.enum.text import PP_ALIGN

# Create presentation
prs = Presentation()

# Title slide
title_slide_layout = prs.slide_layouts[0]
slide = prs.slides.add_slide(title_slide_layout)
title = slide.shapes.title
subtitle = slide.placeholders[1]
title.text = "Presentation Title"
subtitle.text = "Subtitle or Author"

# Content slide with bullets
bullet_slide_layout = prs.slide_layouts[1]
slide = prs.slides.add_slide(bullet_slide_layout)
shapes = slide.shapes
title_shape = shapes.title
body_shape = shapes.placeholders[1]
title_shape.text = "Key Points"
tf = body_shape.text_frame
tf.text = "First bullet point"
p = tf.add_paragraph()
p.text = "Second bullet point"
p.level = 0
p = tf.add_paragraph()
p.text = "Sub-point"
p.level = 1

# Save
prs.save('output.pptx')
print("Presentation saved!")
```

### Step 2: Run the Script

```bash
python3 /tmp/create_pptx.py
```

### Step 3: Verify Output

```bash
file output.pptx
ls -la output.pptx
# Should show: Microsoft PowerPoint 2007+
```

## Complete Example: Multi-Slide Presentation

```bash
# Ensure python-pptx is available
pip install python-pptx 2>/dev/null || echo "python-pptx already installed"

# Create the generator script
cat > /tmp/create_presentation.py << 'PYTHON_SCRIPT'
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RgbColor

def create_presentation(filename, title, slides_content):
    """
    Create a PowerPoint presentation.
    
    Args:
        filename: Output filename
        title: Presentation title
        slides_content: List of dicts with 'title' and 'bullets' keys
    """
    prs = Presentation()
    
    # Title slide
    title_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(title_layout)
    slide.shapes.title.text = title
    if len(slide.placeholders) > 1:
        slide.placeholders[1].text = "Generated with Mistral Vibe"
    
    # Content slides
    content_layout = prs.slide_layouts[1]
    for content in slides_content:
        slide = prs.slides.add_slide(content_layout)
        slide.shapes.title.text = content.get('title', 'Slide')
        
        body = slide.placeholders[1]
        tf = body.text_frame
        tf.clear()
        
        bullets = content.get('bullets', [])
        for i, bullet in enumerate(bullets):
            if i == 0:
                tf.paragraphs[0].text = bullet
            else:
                p = tf.add_paragraph()
                p.text = bullet
                p.level = 0
    
    prs.save(filename)
    print(f"Created: {filename}")

# Example usage
slides = [
    {
        'title': 'Introduction',
        'bullets': [
            'Welcome to this presentation',
            'Overview of topics',
            'Goals and objectives'
        ]
    },
    {
        'title': 'Key Points',
        'bullets': [
            'Point 1: Important finding',
            'Point 2: Analysis results',
            'Point 3: Recommendations'
        ]
    },
    {
        'title': 'Conclusion',
        'bullets': [
            'Summary of key takeaways',
            'Next steps',
            'Questions?'
        ]
    }
]

create_presentation('presentation.pptx', 'My Presentation', slides)
PYTHON_SCRIPT

# Run the script
python3 /tmp/create_presentation.py

# Verify
file presentation.pptx
```

## Important Notes

1. **Never write raw PPTX binary** - PPTX is a complex ZIP with XML files
2. **Always use python-pptx** for generating presentations
3. **Check if python-pptx is installed** before starting
4. **Keep slide content concise** - bullets work better than paragraphs

## Available Slide Layouts

- `slide_layouts[0]` - Title slide
- `slide_layouts[1]` - Title and Content
- `slide_layouts[2]` - Section Header
- `slide_layouts[3]` - Two Content
- `slide_layouts[4]` - Comparison
- `slide_layouts[5]` - Title Only
- `slide_layouts[6]` - Blank

## Adding Images

```python
from pptx.util import Inches

slide = prs.slides.add_slide(prs.slide_layouts[5])  # Title only
slide.shapes.title.text = "Image Slide"

# Add image
img_path = 'image.png'
left = Inches(1)
top = Inches(2)
slide.shapes.add_picture(img_path, left, top, width=Inches(5))
```
