---
name: pdf-editing
description: "Complete guide for reading and editing PDF documents with PyMuPDF."
---

# PDF Editing Skill

## CRITICAL RULES - READ FIRST

**NEVER DO THESE:**
- NEVER use strikethrough lines to cross out text
- NEVER rasterize or flatten the PDF to images
- NEVER convert PDF pages to PNG/JPG and draw on them
- NEVER use pdf-to-image-to-pdf workflows
- NEVER use add_redact_annot() with BLACK fill (use WHITE fill instead)
- NEVER add text NEXT TO old values - REPLACE them at the SAME position

**TWO APPROACHES - CHOOSE THE RIGHT ONE:**

1. **For REPLACING text** (e.g., updating name, email, DOB):
   - Use `draw_rect()` with white fill to cover old text
   - Use `insert_text()` at the SAME position
   - Text layer is preserved

2. **For TRUE REDACTION of sensitive data** (e.g., student ID):
   - Use `add_redact_annot(rect, fill=(1,1,1))` with WHITE fill
   - Call `apply_redactions()` to REMOVE text from PDF structure
   - Then `insert_text()` to add masked value (e.g., "****5678")
   - Original text is completely removed, not just covered

## Overview

**USE PYTHON WITH PyMuPDF (fitz)** - it is pre-installed and produces the best results.

PyMuPDF preserves the text layer properly, making text extractable after editing.
JavaScript libraries like pdf-lib may create text that tools like pypdf cannot extract.

```bash
# PyMuPDF is already installed - just use it
python3 -c "import fitz; print('PyMuPDF ready')"
```

## Reading PDF Content

```python
import fitz

doc = fitz.open("input.pdf")
page = doc[0]

# Extract all text to understand the document
text = page.get_text()
print(text)
```

## Finding Text Positions

```python
# search_for() returns list of rectangles where text is found
rects = page.search_for("Label Text")
if rects:
    rect = rects[0]
    # rect.x0, rect.y0 = top-left corner
    # rect.x1, rect.y1 = bottom-right corner
    print(f"Found at: ({rect.x0}, {rect.y0}) to ({rect.x1}, {rect.y1})")
```

## Inserting Text

```python
# Insert text at a specific position
page.insert_text(
    (x_position, y_position),  # coordinates
    "text to insert",
    fontsize=11,
    color=(0, 0, 0)  # black
)

doc.save("output.pdf")
```

## Common Pattern: Fill Empty Form Fields

When a form field is empty (no existing value), insert text next to the label:

```python
import fitz

doc = fitz.open("input.pdf")
page = doc[0]

# Find label, insert value to the right of it
label_rect = page.search_for("FIELD LABEL:")[0]
page.insert_text((label_rect.x1 + 5, label_rect.y1), "value", fontsize=11)

# For today's date
from datetime import datetime
date_rect = page.search_for("Date")[0]
today = datetime.now().strftime("%Y/%m/%d")
page.insert_text((date_rect.x1 + 5, date_rect.y1), today, fontsize=11)

# For signatures - insert the person's name
sig_rect = page.search_for("signature")[0]
page.insert_text((sig_rect.x1 + 5, sig_rect.y1), "Full Name", fontsize=12)

doc.save("output.pdf")
```

## Replacing Existing Text (CRITICAL - MUST FOLLOW)

When you need to replace text that's already in the PDF with new/correct values:

1. First extract the PDF text to see what's currently there
2. Compare with the correct values from your input source
3. For any value that needs to change: **COVER with white rectangle, then insert new text AT THE SAME POSITION**

### WRONG vs RIGHT approaches:

**WRONG - DO NOT DO THIS:**
```python
# WRONG: Adding text next to old value
page.insert_text((old_rect.x1 + 10, old_rect.y1), new_value)  # NO!

# WRONG: Using strikethrough
page.draw_line(start, end, color=(0,0,0))  # NO!

# WRONG: Rasterizing to image
pix = page.get_pixmap()  # NO! Destroys text layer
```

**RIGHT - DO THIS:**
```python
import fitz

doc = fitz.open("input.pdf")
page = doc[0]

# First, extract text to see what's in the PDF
current_text = page.get_text()
print(current_text)  # Examine what values exist

# To replace a value you found that needs changing:
old_value = "..."  # The value you found in the PDF that's wrong
new_value = "..."  # The correct value from your input source

rects = page.search_for(old_value)
if rects:
    rect = rects[0]

    # STEP 1: Draw WHITE rectangle to COMPLETELY COVER old text
    page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1), width=0)

    # STEP 2: Insert new text at the SAME position (not offset!)
    page.insert_text((rect.x0, rect.y1), new_value, fontsize=11, color=(0, 0, 0))

doc.save("output.pdf")
```

**Key points:**
- `draw_rect(rect, fill=(1,1,1), width=0)` draws a WHITE filled rectangle
- `(1, 1, 1)` is white in RGB (0-1 scale)
- Insert new text at `rect.x0` (same X position), NOT `rect.x1 + offset`
- The old text becomes invisible under the white rectangle
- The new text appears in the same location
- Text layer is preserved (text remains extractable)

## TRUE REDACTION for Sensitive Data (IMPORTANT!)

For sensitive data like student IDs, you must use TRUE REDACTION that removes the original text from the PDF structure. A white rectangle only VISUALLY covers text - tools like pypdf can still extract the hidden text!

**CRITICAL DISTINCTION:**
- `draw_rect()` = Visual cover only (text still extractable by machines)
- `add_redact_annot()` + `apply_redactions()` = TRUE redaction (text removed from PDF)

**Example:** "A12345678" should become "****5678" (show only last 4 digits)

```python
import fitz

doc = fitz.open("input.pdf")
page = doc[0]

# 1. First find what value is in the PDF by reading the text
pdf_text = page.get_text()
# Find the ID in the text (e.g., "A88888888")

original_in_pdf = "A88888888"  # Value you found in the PDF
# Extract just the digits for masking
digits = ''.join(c for c in original_in_pdf if c.isdigit())
masked = "****" + digits[-4:]  # Result: "****8888"

rects = page.search_for(original_in_pdf)
if rects:
    rect = rects[0]

    # STEP 1: Create TIGHT bounding box to avoid covering nearby labels
    tight_rect = fitz.Rect(rect.x0, rect.y0 + 8, rect.x1, rect.y1 - 2)

    # STEP 2: Add redaction annotation with WHITE fill (not black!)
    page.add_redact_annot(tight_rect, fill=(1, 1, 1))  # WHITE fill

    # STEP 2: Apply redactions - this REMOVES the text from PDF structure
    page.apply_redactions()

    # STEP 3: Insert masked value at the same position
    page.insert_text((rect.x0, rect.y1), masked, fontsize=11, color=(0, 0, 0))

doc.save("output.pdf")
```

**Why this works:**
- `add_redact_annot(rect, fill=(1, 1, 1))` - marks area with WHITE rectangle
- `apply_redactions()` - REMOVES the underlying text from PDF structure
- `insert_text()` - adds the masked value

**WRONG approaches:**
```python
# WRONG: Black box redaction (ugly and suspicious)
page.add_redact_annot(rect, fill=(0, 0, 0))  # NO! Use white fill

# WRONG: Only using draw_rect (text still extractable!)
page.draw_rect(rect, fill=(1, 1, 1))  # NO! This only covers visually
page.insert_text(...)  # Original text is still in PDF structure!

# WRONG: Adding masked value NEXT TO original
page.insert_text((rect.x1 + 10, rect.y1), masked)  # NO!
```



## Workflow: Compare and Update

```python
import fitz

doc = fitz.open("input.pdf")
page = doc[0]

# Step 1: Read PDF to see current content
pdf_text = page.get_text()
print(pdf_text)

# Step 2: Read your input source to get correct values
# (parse input file, extract the values you need)

# Step 3: For each value that differs, replace it
# Build a dict of {old_value_in_pdf: correct_value}
replacements = {}  # Populate by comparing PDF content with correct values

for old_val, new_val in replacements.items():
    if old_val == new_val:
        continue  # Skip if already correct
    rects = page.search_for(old_val)
    if rects:
        rect = rects[0]
        # Cover old text with white rectangle
        page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1), width=0)
        # Insert new text
        page.insert_text((rect.x0, rect.y1), new_val, fontsize=11, color=(0, 0, 0))

doc.save("output.pdf")
```

## Important Guidelines

1. **COVER then REPLACE** - Use white rectangle to cover old text, insert new text at SAME position
2. **Never use strikethrough** - No lines through text, no crossing out
3. **Never rasterize** - No converting PDF to images, no get_pixmap() workflows
4. **Never add text NEXT TO old values** - Replace AT the same position
5. **Never use add_redact_annot() with black** - It creates black boxes
6. **Preserve all labels** - Form labels should remain visible
7. **Preserve text layer** - Text must remain extractable after editing
8. **Match font size** - Typically 10-12pt for forms

## Alternative: JavaScript with pdf-lib (NOT RECOMMENDED)

**WARNING:** pdf-lib may create text that cannot be extracted by pypdf.
Use Python with PyMuPDF instead whenever possible.

If you must use Node.js/JavaScript, use pdf-lib with the same approach:

```javascript
const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');

async function editPdf() {
  const pdfBytes = fs.readFileSync('input.pdf');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPages()[0];
  const { height } = page.getSize();

  // To replace text at known coordinates:
  // STEP 1: Draw WHITE rectangle to cover old text
  page.drawRectangle({
    x: oldTextX,
    y: oldTextY,
    width: oldTextWidth,
    height: oldTextHeight,
    color: rgb(1, 1, 1),  // WHITE
  });

  // STEP 2: Draw new text at the SAME position
  page.drawText('New Value', {
    x: oldTextX,  // SAME X position, not offset!
    y: oldTextY,
    size: 11,
    color: rgb(0, 0, 0),
  });

  fs.writeFileSync('output.pdf', await pdfDoc.save());
}
```

**WRONG with pdf-lib:**
```javascript
// WRONG: Adding text to the right of old value
page.drawText('New Value', {
  x: oldTextX + oldTextWidth + 10,  // NO! Don't offset
  ...
});

// WRONG: Drawing strikethrough line
page.drawLine({
  start: { x: x1, y: y },
  end: { x: x2, y: y },
  color: rgb(0, 0, 0),  // NO strikethrough!
});
```

