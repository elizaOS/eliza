---
name: marker
description: Convert PDF documents to Markdown using marker_single. Use when Claude needs to extract text content from PDFs while preserving LaTeX formulas, equations, and document structure. Ideal for academic papers and technical documents containing mathematical notation.
---

# Marker PDF-to-Markdown Converter

Convert PDFs to Markdown while preserving LaTeX formulas and document structure. Uses the `marker_single` CLI from the marker-pdf package.

## Dependencies
- `marker_single` on PATH (`pip install marker-pdf` if missing)
- Python 3.10+ (available in the task image)

## Quick Start

```python
from scripts.marker_to_markdown import pdf_to_markdown

markdown_text = pdf_to_markdown("paper.pdf")
print(markdown_text)
```

## Python API

- `pdf_to_markdown(pdf_path, *, timeout=600, cleanup=True) -> str`
  - Runs `marker_single --output_format markdown --disable_image_extraction`
  - `cleanup=True`: use a temp directory and delete after reading the Markdown
  - `cleanup=False`: keep outputs in `<pdf_stem>_marker/` next to the PDF
  - Exceptions: `FileNotFoundError` if the PDF is missing, `RuntimeError` for marker failures, `TimeoutError` if it exceeds the timeout
- Tips: bump `timeout` for large PDFs; set `cleanup=False` to inspect intermediate files

## Command-Line Usage

```bash
# Basic conversion (prints markdown to stdout)
python scripts/marker_to_markdown.py paper.pdf

# Keep temporary files
python scripts/marker_to_markdown.py paper.pdf --keep-temp

# Custom timeout
python scripts/marker_to_markdown.py paper.pdf --timeout 600
```

## Output Locations
- `cleanup=True`: outputs stored in a temporary directory and removed automatically
- `cleanup=False`: outputs saved to `<pdf_stem>_marker/`; markdown lives at `<pdf_stem>_marker/<pdf_stem>/<pdf_stem>.md` when present (otherwise the first `.md` file is used)

## Troubleshooting
- `marker_single` not found: install `marker-pdf` or ensure the CLI is on PATH
- No Markdown output: re-run with `--keep-temp`/`cleanup=False` and check `stdout`/`stderr` saved in the output folder
