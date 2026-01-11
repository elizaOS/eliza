# elizaOS PDF Plugin (Python)

PDF reading and text extraction for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-pdf
```

## Usage

```python
from elizaos_plugin_pdf import PdfClient

# Create client
client = PdfClient()

# Extract text from PDF file
text = await client.extract_text_from_file("document.pdf")
print(text)

# Extract text from PDF bytes
with open("document.pdf", "rb") as f:
    pdf_bytes = f.read()
text = await client.extract_text(pdf_bytes)
print(text)

# Get full document info
info = await client.get_document_info(pdf_bytes)
print(f"Pages: {info.page_count}")
print(f"Title: {info.metadata.title}")
for page in info.pages:
    print(f"Page {page.page_number}: {page.text[:100]}...")
```

## Features

- Extract text from PDF files
- Get document metadata (title, author, etc.)
- Page-by-page text extraction
- Configurable text cleaning
- Async/await support
- Type-safe with Pydantic models

## License

MIT



