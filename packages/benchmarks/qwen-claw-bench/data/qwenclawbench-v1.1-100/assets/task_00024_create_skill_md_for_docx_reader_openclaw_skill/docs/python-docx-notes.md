# python-docx Quick Reference

Internal team notes for working with Word documents in Python.

## Installation

```bash
pip install docx
```

This installs the docx library for reading and writing .docx files.

## Opening a Document

```python
import docx

# Open an existing document
doc = docx.opendocx('/path/to/file.docx')
```

## Reading Paragraphs

Once you have a document object, you can iterate over paragraphs:

```python
for paragraph in doc.paragraphs:
    print(paragraph.text)
```

Each paragraph has a `.text` property that returns the plain text content without formatting.

## Reading Tables

```python
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            print(cell.text)
```

## Common Gotchas

- Empty paragraphs still appear in the list — filter them with `if paragraph.text.strip()`
- Headers and footers are not included in `doc.paragraphs` — access them via sections
- Images are embedded as inline shapes and require separate extraction logic

## Useful Links

- PyPI page: https://pypi.org/project/docx/
- GitHub: https://github.com/mikemaccana/python-docx
