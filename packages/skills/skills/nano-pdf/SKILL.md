---
name: nano-pdf
description: Edits PDF files using natural-language instructions via the nano-pdf CLI. Supports modifying text, changing titles, fixing typos, and updating content on specific pages. Use when the user wants to edit a PDF, modify PDF content, update PDF text, fix a typo in a PDF, change a PDF title, or rewrite part of a PDF page.
homepage: https://pypi.org/project/nano-pdf/
metadata:
  {
    "otto":
      {
        "emoji": "📄",
        "requires": { "bins": ["nano-pdf"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "nano-pdf",
              "bins": ["nano-pdf"],
              "label": "Install nano-pdf (uv)",
            },
          ],
      },
  }
---

# nano-pdf

Use `nano-pdf` to apply edits to a specific page in a PDF using a natural-language instruction.

## Quick start

```bash
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"
```

Notes:

- Page numbers are 0-based or 1-based depending on the tool’s version/config; if the result looks off by one, retry with the other.
- Always sanity-check the output PDF before sending it out.
