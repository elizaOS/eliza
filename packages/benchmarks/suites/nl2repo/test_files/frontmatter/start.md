## Introduction and Goals of the Python-Frontmatter Project

Python-Frontmatter is a Python library **for document metadata parsing and management** that can parse and manage text documents with YAML (or other formats) front matter metadata. This tool supports multiple metadata formats (YAML, JSON, TOML) and provides a unified API interface to handle documents containing structured metadata. It is widely used in scenarios such as static website generation, content management systems, and document processing. Its core functions include: multi-format metadata parsing (automatically detecting and parsing front matter metadata in YAML, JSON, and TOML formats), **separation of document content and metadata** (clearly separating document content from structured metadata), and flexible metadata operation and export functions. In short, Python-Frontmatter aims to provide a robust document metadata processing system for parsing, modifying, and regenerating documents with front matter metadata (e.g., loading documents via the `load()` function and regenerating documents via the `dumps()` function).

## Natural Language Instruction (Prompt)

Please create a Python project named Python-Frontmatter to implement a document metadata parsing and management library. The project should include the following functions:

1. Multi-format metadata parser: It should be able to extract and parse front matter metadata from the input text, supporting multiple formats such as YAML format (e.g., metadata blocks enclosed by `---`), JSON format (e.g., metadata enclosed by `{}`), and TOML format (e.g., metadata enclosed by `+++`). The parsing result should be a Python dictionary object containing two parts: metadata and document content.

2. Document loading and parsing: Implement functions (or scripts) to load documents from files or strings, automatically detect the metadata format, and separate the metadata and content parts. It should support loading documents from file paths, file objects, or strings and handle different encoding formats (e.g., UTF-8, UTF-8-SIG, etc.).

3. Metadata operation and modification: Provide convenient metadata access and modification interfaces, support dictionary-style access to metadata fields, and support operations such as adding, deleting, modifying, and querying metadata, as well as metadata merging and updating functions.

4. Document regeneration: Implement the function of recombining the modified metadata and content into the original format, support maintaining the original format or converting to other formats, and ensure the consistency of the output format.

5. Custom processor support: Design independent processor classes for each metadata format, support custom delimiters, custom parsing rules, and extend support for new metadata formats.

6. Core file requirements: The project must include a complete `setup.py` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `PyYAML`, `toml`, `pytest`, `mypy`, `types-PyYAML`, `types-toml`, etc.). The `setup.py` file can verify whether all functional modules work properly. At the same time, it is necessary to provide `frontmatter/__init__.py` as a unified API entry, import processor classes such as `YAMLHandler`, `JSONHandler`, and `TOMLHandler` from the `default_handlers` module, export core classes and functions such as `parse`, `load`, `loads`, `dump`, `dumps`, `check`, `checks`, `detect_format`, and `Post`, and provide version information so that users can access all major functions through a simple `import frontmatter` statement. In `default_handlers.py`, there needs to be a `BaseHandler` base class to define the basic interface of the processor (including core methods such as `detect`, `split`, `load`, `export`, and `format`), as well as specific processor implementations for various formats. According to the analysis of the test directory, the test file `tests/unit_test.py` references functions and variables such as `frontmatter.load`, `frontmatter.dumps`, `frontmatter.check`, `frontmatter.detect_format`, and `frontmatter.handlers`. The `tests/test_files.py` references the `frontmatter.load` and `frontmatter.Post` classes. The `tests/test_docs.py` references the `frontmatter` module itself for document testing. The `tests/stub_tests.py` references the `frontmatter.loads` function. These test files verify methods such as `to_dict`, `__getitem__`, `__setitem__`, `__contains__`, `get`, `keys`, and `values` of the `Post` object, as well as methods such as `detect`, `split`, `load`, and `export` of the `YAMLHandler`, `JSONHandler`, and `TOMLHandler` processors to ensure the integrity and correctness of the entire API interface.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.5

### Core Dependency Library Versions

```Plain
docutils              0.22
flake8                7.3.0
iniconfig             2.1.0
mccabe                0.7.0
packaging             25.0
pip                   25.1.1
pluggy                1.6.0
pycodestyle           2.14.0
pyflakes              3.4.0
Pygments              2.19.2
pytest                8.4.1
restructuredtext_lint 1.4.0
```

## Python-Frontmatter Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── LICENSE
├── MANIFEST.in
├── README.md
├── docs
│   ├── Makefile
│   ├── api.rst
│   ├── conf.py
│   ├── handlers.rst
│   ├── index.rst
│   ├── make.bat
├── examples
│   ├── __init__.py
│   ├── content
│   │   ├── pandoc.txt
│   │   ├── reversed.txt
│   │   ├── sorted.txt
│   ├── pandoc.py
│   ├── reversed.py
│   ├── sorted.py
├── frontmatter
│   ├── __init__.py
│   ├── conftest.py
│   ├── default_handlers.py
│   ├── py.typed
│   ├── util.py
├── mypy.ini
└── setup.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
# Core module
import frontmatter
from frontmatter import Post, parse, load, loads, dump, dumps, check, checks, detect_format
from frontmatter.default_handlers import YAMLHandler, JSONHandler, TOMLHandler, BaseHandler

# Processor module
from frontmatter.default_handlers import (
    YAMLHandler,
    JSONHandler, 
    TOMLHandler,
    BaseHandler
)

# Standard library module
import codecs
import doctest
import glob
import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from itertools import chain
from pathlib import Path

# Third-party library module
import pytest
try:
    import pyaml
except ImportError:
    pyaml = None
try:
    import toml
except ImportError:
    toml = None

# Testing tool module
from test_files import files, get_result_filename
```

#### 2. `load()` Function - Load a Document from a File

**Function**: Load a document with front matter metadata from a file path or file object.

**Function Signature**:

```python
def load(
    fd: str | io.IOBase,
    encoding: str = "utf-8",
    handler: BaseHandler | None = None,
    **defaults: object,
) -> Post:
```

**Parameter Description**:

- `fd` (str | io.IOBase): File path or file object
- `encoding` (str): File encoding, default is "utf-8"
- `handler` (BaseHandler | None): Custom processor, default is automatic detection
- `**defaults` (object): Default metadata values

**Return Value**: A `Post` object containing metadata and content

#### 3. `loads()` Function - Load a Document from a String

**Function**: Parse a document with front matter metadata from a string.

**Function Signature**:

```python
def loads(
    text: str,
    encoding: str = "utf-8",
    handler: BaseHandler | None = None,
    **defaults: object,
) -> Post:
```

**Parameter Description**:

- `text` (str): Text string containing front matter metadata
- `encoding` (str): Text encoding, default is "utf-8"
- `handler` (BaseHandler | None): Custom processor, default is automatic detection
- `**defaults` (object): Default metadata values

**Return Value**: A `Post` object containing metadata and content

#### 4. `parse()` Function - Parse Text

**Function**: Parse the front matter metadata in the text and return a metadata dictionary and a content string.

**Function Signature**:

```python
def parse(
    text: str,
    encoding: str = "utf-8",
    handler: BaseHandler | None = None,
    **defaults: object,
) -> tuple[dict[str, object], str]:
```

**Parameter Description**:

- `text` (str): Text string to be parsed
- `encoding` (str): Text encoding, default is "utf-8"
- `handler` (BaseHandler | None): Custom processor, default is automatic detection
- `**defaults` (object): Default metadata values

**Return Value**: A tuple `(metadata_dict, content_string)`

#### 5. `dump()` Function - Save to a File

**Function**: Save a `Post` object to a file.

**Function Signature**:

```python
def dump(
    post: Post,
    fd: str | io.IOBase,
    encoding: str = "utf-8",
    handler: BaseHandler | None = None,
    **kwargs: object,
) -> None:
```

**Parameter Description**:

- `post` (Post): `Post` object to be saved
- `fd` (str | io.IOBase): File path or file object
- `encoding` (str): File encoding, default is "utf-8"
- `handler` (BaseHandler | None): Custom processor
- `**kwargs` (object): Processor-specific parameters

#### 6. `dumps()` Function - Convert to a String

**Function**: Convert a `Post` object to a string format.

**Function Signature**:

```python
def dumps(post: Post, handler: BaseHandler | None = None, **kwargs: object) -> str:
```

**Parameter Description**:

- `post` (Post): `Post` object to be converted
- `handler` (BaseHandler | None): Custom processor
- `**kwargs` (object): Processor-specific parameters

**Return Value**: A formatted string

#### 7. `check()` Function - Check the Document

**Function**: Check if a file-like object or filename has a frontmatter, return True if exists, False otherwise. If it contains a frontmatter but it is empty, return True as well.

**Function Signature**:
```python
def check(fd: str | io.IOBase, encoding: str = "utf-8") -> bool:
```

**Parameter Description**:

- `fd` (str | io.IOBase): File path or file object
- `encoding` (str): File encoding, default is "utf-8"

**Return Value**: True if the document has a frontmatter, False otherwise

#### 8. `checks()` Function - Check the Document

**Function**: Check if a text (binary or unicode) has a frontmatter, return True if exists, False otherwise. If it contains a frontmatter but it is empty, return True as well.

**Function Signature**:
```python
def checks(text: str, encoding: str = "utf-8") -> bool:
```

**Parameter Description**:

- `text` (str): Text string to be checked
- `encoding` (str): Text encoding, default is "utf-8"

**Return Value**: True if the text has a frontmatter, False otherwise

#### 9. `detect_format()` Function - Detect the Document Format

**Function**: Detect the document format from the text.

**Function Signature**:
```python
def detect_format(text: str, handlers: Iterable[BaseHandler]) -> BaseHandler | None:
```

**Parameter Description**:

- `text` (str): Text string to be detected
- `handlers` (Iterable[BaseHandler]): List of handlers to be used for detection

**Return Value**: A `BaseHandler` instance or None

#### 10. `u()` Function - Convert the Text to Unicode

**Function**: Convert the text to unicode.

**Function Signature**:
```python
def u(text: AnyStr, encoding: str = "utf-8") -> str:
```

**Parameter Description**:

- `text` (AnyStr): Text string to be converted
- `encoding` (str): Text encoding, default is "utf-8"

**Return Value**: A unicode string

#### 11. `add_globals()` Function - Add globals to the doctest namespace

**Function**: Add globals to the doctest namespace.

**Function Signature**:
```python
def add_globals(doctest_namespace: dict[str, Any]) -> None:
```

**Parameter Description**:

- `doctest_namespace` (dict[str, Any]): The namespace to add the globals to

**Return Value**: None

#### 12. BaseHandler Class

**Class Function**: The base class for all handlers.

**Class Definition**:
```python
class BaseHandler:
    """
    BaseHandler lays out all the steps to detecting, splitting, parsing and
    exporting front matter metadata.

    All default handlers are subclassed from BaseHandler.
    """

    FM_BOUNDARY: re.Pattern[str] | None = None
    START_DELIMITER: str | None = None
    END_DELIMITER: str | None = None

    def __init__(
        self,
        fm_boundary: re.Pattern[str] | None = None,
        start_delimiter: str | None = None,
        end_delimiter: str | None = None,
    ):
        self.FM_BOUNDARY = fm_boundary or self.FM_BOUNDARY
        self.START_DELIMITER = start_delimiter or self.START_DELIMITER
        self.END_DELIMITER = end_delimiter or self.END_DELIMITER

        if self.FM_BOUNDARY is None:
            raise NotImplementedError(
                "No frontmatter boundary defined. "
                "Please set {}.FM_BOUNDARY to a regular expression".format(
                    self.__class__.__name__
                )
            )

    def detect(self, text: str) -> bool:
        """
        Decide whether this handler can parse the given ``text``,
        and return True or False.

        Note that this is *not* called when passing a handler instance to
        :py:func:`frontmatter.load <frontmatter.load>` or :py:func:`loads <frontmatter.loads>`.
        Args: 
            text (str): Text string to be detected
        Returns:
            bool: True if the text can be parsed by the handler, False otherwise
        """

    def split(self, text: str) -> tuple[str, str]:
        """
        Split text into frontmatter and content
        Args:
            text (str): Text string to be split
        Returns:
            tuple[str, str]: A tuple containing the frontmatter and content
        """

    def load(self, fm: str) -> dict[str, Any]:
        """
        Parse frontmatter and return a dict
        """
        raise NotImplementedError

    def export(self, metadata: dict[str, object], **kwargs: object) -> str:
        """
        Turn metadata back into text
        """
        raise NotImplementedError

    def format(self, post: Post, **kwargs: object) -> str:
        """
        Turn a post into a string, used in ``frontmatter.dumps``
        Args:
            post (Post): Post object to be formatted
            **kwargs: Keyword arguments
        Returns:
            str: A formatted string
        """
```

#### 13. YAMLHandler Class

**Class Function**: Handle YAML format front matter metadata

**Class Definition**:
```python
class YAMLHandler(BaseHandler):
    """
    Load and export YAML metadata. By default, this handler uses YAML's
    "safe" mode, though it's possible to override that.
    """

    FM_BOUNDARY = re.compile(r"^-{3,}\s*$", re.MULTILINE)
    START_DELIMITER = END_DELIMITER = "---"

    def load(self, fm: str, **kwargs: object) -> Any:
        """
        Parse YAML front matter. This uses yaml.SafeLoader by default.
        Args:
            fm (str): YAML front matter to be parsed
            **kwargs: Keyword arguments
        Returns:
            dict[str, Any]: A dictionary containing the YAML front matter
        """

    def export(self, metadata: dict[str, object], **kwargs: object) -> str:
        """
        Export metadata as YAML. This uses yaml.SafeDumper by default.
        Args:
            metadata (dict[str, object]): Metadata dictionary to be exported
            **kwargs: Keyword arguments
        Returns:
            str: A string containing the exported YAML
        """
```

#### 14. JSONHandler Class

**Class Function**: Handle JSON format front matter metadata

**Class Definition**:
```python
class JSONHandler(BaseHandler):
    """
    Load and export JSON metadata.

    Note that changing ``START_DELIMITER`` or ``END_DELIMITER`` may break JSON parsing.
    """

    FM_BOUNDARY = re.compile(r"^(?:{|})$", re.MULTILINE)
    START_DELIMITER = ""
    END_DELIMITER = ""

    def split(self, text: str) -> tuple[str, str]:
        _, fm, content = self.FM_BOUNDARY.split(text, 2)
        return "{" + fm + "}", content

    def load(self, fm: str, **kwargs: object) -> Any:
        return json.loads(fm, **kwargs)  # type: ignore[arg-type]

    def export(self, metadata: dict[str, object], **kwargs: object) -> str:
        """Turn metadata into JSON
        Args:
            metadata (dict[str, object]): Metadata dictionary to be exported
            **kwargs: Keyword arguments
        Returns:
            str: A string containing the exported JSON
        """
        return u(metadata_str)
```

#### 15. Post Class

**Class Function**: A post contains content and metadata from Front Matter.

**Class Definition**:
```python
class Post(object):
    """
    A post contains content and metadata from Front Matter. This is what gets
    returned by :py:func:`load <frontmatter.load>` and :py:func:`loads <frontmatter.loads>`.
    Passing this to :py:func:`dump <frontmatter.dump>` or :py:func:`dumps <frontmatter.dumps>`
    will turn it back into text.

    For convenience, metadata values are available as proxied item lookups.
    """

    def __init__(
        self, content: str, handler: BaseHandler | None = None, **metadata: object
    ) -> None:
        self.content = str(content)
        self.metadata = metadata
        self.handler = handler

    def __getitem__(self, name: str) -> object:
        """Get metadata key
        Args:
            name (str): Metadata key to be retrieved
        Returns:
            object: The value of the metadata key
        """

    def __contains__(self, item: object) -> bool:
        """Check metadata contains key
        Args:
            item (object): Item to be checked
        Returns:
            bool: True if the item is in the metadata, False otherwise
        """

    def __setitem__(self, name: str, value: object) -> None:
        """Set a metadata key
        Args:
            name (str): Metadata key to be set
            value (object): Value to be set
        """
        self.metadata[name] = value

    def __delitem__(self, name: str) -> None:
        """Delete a metadata key
        Args:
            name (str): Metadata key to be deleted
        """


    def __bytes__(self) -> bytes:
        return self.content.encode("utf-8")

    def __str__(self) -> str:
        return self.content

    def get(self, key: str, default: object = None) -> object:
        """Get a key, fallback to default
        Args:
            key (str): Key to be retrieved
            default (object): Default value to be returned if the key is not found
        Returns:
            object: The value of the key
        """

    def keys(self) -> Iterable[str]:
        """Return metadata keys
        Returns:
            Iterable[str]: A list of metadata keys
        """

    def values(self) -> Iterable[object]:
        """Return metadata values
        Returns:
            Iterable[object]: A list of metadata values
        """

    def to_dict(self) -> dict[str, object]:
        """Post as a dict, for serializing
        Returns:
            dict[str, object]: A dictionary containing the metadata and content
        """
```

#### 16. Constants and Type Aliases

```python
# In default_handlers.py
DEFAULT_POST_TEMPLATE = """\
{start_delimiter}
{metadata}
{end_delimiter}

{content}
"""
__all__ = ["BaseHandler", "YAMLHandler", "JSONHandler"]

# In __init__.py
__all__ = ["parse", "load", "loads", "dump", "dumps"]

```
### Detailed Description of the `Post` Class

#### `Post` Object Attributes

```python
class Post:
    def __init__(self, content: str, handler: BaseHandler | None = None, **metadata: object) -> None:
        self.content = str(content)      # Document content
        self.metadata = metadata         # Metadata dictionary
        self.handler = handler           # Processor object
```

#### `Post` Object Methods

```python
# Dictionary-style access to metadata
post['title'] = "New Title"
title = post['title']

# Check metadata keys
if 'author' in post:
    print(post['author'])

# Get metadata (with default value)
author = post.get('author', 'Unknown')

# Get all metadata keys
keys = post.keys()

# Convert to a dictionary
post_dict = post.to_dict()
```

### Actual Usage Patterns

#### Basic Usage

```python
import frontmatter

# Load from a file
post = frontmatter.load('document.md')
print(post['title'])  # Access metadata
print(post.content)   # Access content

# Modify metadata
post['author'] = 'New Author'
post['date'] = '2024-01-01'

# Save to a file
frontmatter.dump(post, 'updated_document.md')
```

#### String Processing

```python
import frontmatter

# Load from a string
text = """---
title: Hello World
author: John Doe
---

This is the content.
"""

post = frontmatter.loads(text)
print(post['title'])  # Hello World

# Convert to a string
output = frontmatter.dumps(post)
print(output)
```

#### Custom Processor

```python
import frontmatter
from frontmatter.default_handlers import BaseHandler

class CustomHandler(BaseHandler):
    FM_BOUNDARY = re.compile(r"^={3,}\s*$", re.MULTILINE)
    START_DELIMITER = END_DELIMITER = "==="

    def load(self, fm: str, **kwargs: object) -> Any:
        # Custom parsing logic
        return self.parse_custom_format(fm)

# Use the custom processor
post = frontmatter.load('document.txt', handler=CustomHandler())
```

#### Encoding Handling

```python
import frontmatter

# Handle UTF-8-BOM encoding
with open('document.md', encoding='utf-8-sig') as f:
    post = frontmatter.load(f)

# Specify encoding for saving
frontmatter.dump(post, 'output.md', encoding='utf-8')
```

### Supported Format Types

- **YAML Format**: Standard YAML front matter metadata using the `---` delimiter
- **JSON Format**: JSON format metadata enclosed by `{}`
- **TOML Format**: TOML format metadata using the `+++` delimiter
- **Custom Format**: Support for custom formats by inheriting from `BaseHandler`

### Error Handling

The system provides a complete error handling mechanism:

- **Format Detection**: Automatically detect the document format and select the appropriate processor
- **Encoding Fault Tolerance**: Support multiple encoding formats and automatically handle encoding issues
- **Format Fault Tolerance**: Tolerate front matter metadata with format errors
- **Exception Capture**: Gracefully handle parsing failures

### Important Notes

1. **Encoding Handling**: For files containing a BOM, it is recommended to use the `utf-8-sig` encoding.
2. **Processor Selection**: If no processor is specified, the system will automatically detect the format.
3. **Metadata Access**: The `Post` object supports dictionary-style access to metadata fields.
4. **Format Preservation**: The original format and processor settings will be maintained when saving.

## Detailed Implementation Nodes of Functions

### Node 1: YAML Frontmatter Parsing

**Function Description**: Parse and process YAML format front matter metadata, support the standard `---` delimiter format, and be able to handle complex YAML structures, including nested objects, arrays, multi-line strings, etc.

**Core Algorithm**:

- Regular expression matching for YAML delimiters
- Parse YAML content using the `PyYAML` library
- Separate metadata and content
- Basic split failure tolerance (metadata parsing errors will bubble up)

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler

# Basic YAML front matter metadata
text = """---
title: Hello, world!
layout: post
author: John Doe
date: 2024-01-01
---

This is the content of the document.
"""

post = frontmatter.loads(text)
print(post['title'])  # Hello, world!
print(post['author'])  # John Doe
print(post.content)  # This is the content of the document.

# Complex YAML structure
complex_text = """---
title: Complex Document
tags:
  - python
  - frontmatter
  - yaml
metadata:
  author:
    name: John Doe
    email: john@example.com
  category: technical
---

Document content here.
"""

post = frontmatter.loads(complex_text)
print(post['tags'])  # ['python', 'frontmatter', 'yaml']
print(post['metadata']['author']['name'])  # John Doe

# Test verification
assert post['title'] == 'Complex Document'
assert 'python' in post['tags']
assert post['metadata']['author']['email'] == 'john@example.com'
```

### Node 2: JSON Frontmatter Parsing

**Function Description**: Parse and process JSON format front matter metadata, support the standard JSON object format, and be able to handle complex JSON structures, including nested objects, arrays, special characters, etc.

**Core Algorithm**:

- Regular expression matching for JSON object boundaries
- Parse JSON content using the `json` library
- Handle special characters and escapes in JSON
- Note: invalid JSON will raise a parsing error (no internal recovery)

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import JSONHandler

# Basic JSON front matter metadata
text = """{
  "title": "Hello, world!",
  "layout": "post",
  "author": "John Doe",
  "date": "2024-01-01"
}

This is the content of the document.
"""

post = frontmatter.loads(text, handler=JSONHandler())
print(post['title'])  # Hello, world!
print(post['author'])  # John Doe
print(post.content)  # This is the content of the document.

# Complex JSON structure
complex_text = """{
  "title": "Complex Document",
  "tags": ["python", "frontmatter", "json"],
  "metadata": {
    "author": {
      "name": "John Doe",
      "email": "john@example.com"
    },
    "category": "technical"
  },
  "settings": {
    "published": true,
    "comments": false
  }
}

Document content here.
"""

post = frontmatter.loads(complex_text, handler=JSONHandler())
print(post['tags'])  # ['python', 'frontmatter', 'json']
print(post['metadata']['author']['name'])  # John Doe
print(post['settings']['published'])  # True

# Test verification
assert post['title'] == 'Complex Document'
assert post['settings']['published'] is True
assert post['settings']['comments'] is False
```

### Node 3: TOML Frontmatter Parsing

**Function Description**: Parse and process TOML format front matter metadata, support the standard `+++` delimiter format, and be able to handle complex TOML structures, including tables, arrays, multi-line strings, etc.

**Core Algorithm**:

- Regular expression matching for TOML delimiters
- Parse TOML content using the `toml` library
- Handle TOML-specific syntax structures
- Note: invalid TOML will raise a parsing error (no internal recovery)

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import TOMLHandler

# Basic TOML front matter metadata
text = """+++
title = "Hello, world!"
layout = "post"
author = "John Doe"
date = "2024-01-01"
+++

This is the content of the document.
"""

post = frontmatter.loads(text, handler=TOMLHandler())
print(post['title'])  # Hello, world!
print(post['author'])  # John Doe
print(post.content)  # This is the content of the document.

# Complex TOML structure
complex_text = """+++
title = "Complex Document"
tags = ["python", "frontmatter", "toml"]

[metadata.author]
name = "John Doe"
email = "john@example.com"

[metadata]
category = "technical"

[settings]
published = true
comments = false
+++

Document content here.
"""

post = frontmatter.loads(complex_text, handler=TOMLHandler())
print(post['tags'])  # ['python', 'frontmatter', 'toml']
print(post['metadata']['author']['name'])  # John Doe
print(post['settings']['published'])  # True

# Test verification
assert post['title'] == 'Complex Document'
assert post['settings']['published'] is True
assert post['metadata']['category'] == 'technical'
```

### Node 4: Format Auto-Detection

**Function Description**: Automatically detect the front matter metadata format of a document, select the appropriate processor for parsing, and support mixed detection and priority processing of multiple formats.

**Detection Strategy**:

- Pattern matching based on delimiters
- Processor priority sorting
- No content validation beyond delimiter-based detection
- Default processor selection

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler, JSONHandler, TOMLHandler

# Automatic detection of YAML format
yaml_text = """---
title: YAML Document
author: John Doe
---

Content here.
"""

post = frontmatter.loads(yaml_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.YAMLHandler'>

# Automatic detection of JSON format
json_text = """{
  "title": "JSON Document",
  "author": "John Doe"
}

Content here.
"""

post = frontmatter.loads(json_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.JSONHandler'>

# Automatic detection of TOML format
toml_text = """+++
title = "TOML Document"
author = "John Doe"
+++

Content here.
"""

post = frontmatter.loads(toml_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.TOMLHandler'>

# Document without front matter
plain_text = """This is a plain text document
without any frontmatter.

Just content here.
"""

post = frontmatter.loads(plain_text)
print(post.metadata)  # {}
print(post.content)  # Original content
print(post.handler)  # None

# Test verification
assert post.metadata == {}
assert "This is a plain text document" in post.content
```

### Node 5: Encoding and BOM Support

**Function Description**: Handle documents in different encoding formats, especially support UTF-8-BOM encoding, and ensure that documents can be correctly parsed in various encoding environments.

**Handling Strategy**:

- Support for multiple encoding formats
- Explicit BOM handling via encoding selection (e.g., "utf-8-sig")
- Newline normalization (CRLF -> LF); no automatic encoding detection

**Input-Output Example**:

```python
import frontmatter
import codecs

# UTF-8 encoding handling
utf8_text = """---
title: UTF-8 Document
author: John Doe
---

Content with UTF-8 characters: é, ñ, ü
"""

post = frontmatter.loads(utf8_text, encoding='utf-8')
print(post['title'])  # UTF-8 Document
print(post.content)  # Content with UTF-8 characters: é, ñ, ü

# UTF-8-BOM encoding handling
bom_text = codecs.BOM_UTF8 + """---
title: BOM Document
author: John Doe
---

Content with BOM.
""".encode('utf-8')

# Simulate reading BOM content from a file
from io import BytesIO
f = BytesIO(bom_text)
post = frontmatter.load(f, encoding='utf-8-sig')
print(post['title'])  # BOM Document

# Save in different encodings
post = frontmatter.loads(utf8_text)
output = frontmatter.dumps(post)
print(output)  # Output with correct encoding

# Test verification
assert post['title'] == 'UTF-8 Document'
assert 'é' in post.content
```

### Node 6: Metadata Manipulation

**Function Description**: Provide convenient metadata access and modification interfaces, support dictionary-style operations, batch modification, metadata merging, and other functions.

**Operation Interface**:

- Dictionary-style access and modification
- Metadata key-value check
- Default value handling
- Support for batch operations

**Input-Output Example**:

```python
import frontmatter

# Create a Post object
post = frontmatter.Post("Content here", title="Original Title")

# Dictionary-style access
print(post['title'])  # Original Title
post['title'] = "Updated Title"
print(post['title'])  # Updated Title

# Metadata check
if 'author' in post:
    print(post['author'])
else:
    print("No author")  # No author

# Access with default value
author = post.get('author', 'Unknown')
print(author)  # Unknown

# Batch modification of metadata
post['author'] = 'John Doe'
post['date'] = '2024-01-01'
post['tags'] = ['python', 'frontmatter']

print(post['author'])  # John Doe
print(post['tags'])  # ['python', 'frontmatter']

# Metadata key operation
print(list(post.keys()))  # ['title', 'author', 'date', 'tags']

# Delete metadata
del post['date']
print('date' in post)  # False

# Convert to a dictionary
post_dict = post.to_dict()
print(post_dict['title'])  # Updated Title
print('content' in post_dict)  # True

# Test verification
assert post['title'] == 'Updated Title'
assert post['author'] == 'John Doe'
assert 'date' not in post
```

### Node 7: Document Regeneration and Format Preservation

**Function Description**: Recombine the modified metadata and content; support converting output formats. Metadata key order and comments are not preserved.

**Generation Strategy**:

- Default output uses the attached handler; if none, YAML is used
- Support for format conversion (e.g., YAML -> JSON/TOML)
- Output customization (e.g., custom delimiters for non-JSON handlers)
- Formatting is handled by the underlying serializer; key order may change

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler, JSONHandler, TOMLHandler

# Original YAML format
original_text = """---
title: Original Title
author: John Doe
date: 2024-01-01
---

Original content here.
"""

post = frontmatter.loads(original_text)

# Modify metadata
post['title'] = 'Updated Title'
post['author'] = 'Jane Smith'

# Output in YAML format
yaml_output = frontmatter.dumps(post)
print(yaml_output)
# Output:
# ---
# author: Jane Smith
# date: '2024-01-01'
# title: Updated Title
# ---
#
# Original content here.

# Convert to JSON format
json_output = frontmatter.dumps(post, handler=JSONHandler())
print(json_output)
# Output:
# {
#   "author": "Jane Smith",
#   "date": "2024-01-01",
#   "title": "Updated Title"
# }
#
# Original content here.

# Convert to TOML format
toml_output = frontmatter.dumps(post, handler=TOMLHandler())
print(toml_output)
# Output:
# +++
# author = "Jane Smith"
# date = "2024-01-01"
# title = "Updated Title"
# +++
#
# Original content here.

# Test verification
assert "Updated Title" in yaml_output
assert "Jane Smith" in json_output
assert "+++" in toml_output
```

### Node 8: File Operations and Encoding

**Function Description**: Handle file read and write operations, support multiple encoding formats, including UTF-8, UTF-8-BOM, etc., and provide file existence checking and encoding fault tolerance mechanisms.

**Operation Interface**:

- Support for file paths and file objects
- Handling of multiple encoding formats (caller supplies encoding)
- BOM support when using an appropriate codec (e.g., "utf-8-sig")
- Error handling for file operations

**Input-Output Example**:

```python
import frontmatter
import codecs
import tempfile
import os

# Load from a file path
post = frontmatter.load("tests/yaml/hello-world.txt")
print(post['title'])  # Hello, world!

# Load from a file object
with open("tests/yaml/hello-world.txt", "r", encoding="utf-8") as f:
    post = frontmatter.load(f)
print(post['title'])  # Hello, world!

# Save to a file
post = frontmatter.load("tests/yaml/hello-world.txt")
tempdir = tempfile.mkdtemp()
filename = os.path.join(tempdir, "hello.md")
frontmatter.dump(post, filename)

# Verify the saved file
with open(filename, "r", encoding="utf-8") as f:
    saved_content = f.read()
    expected_content = frontmatter.dumps(post)
    assert saved_content == expected_content

# Handle UTF-8-BOM encoding
bom_text = codecs.BOM_UTF8 + """---
title: BOM Document
author: John Doe
---

Content with BOM.
""".encode('utf-8')

from io import BytesIO
f = BytesIO(bom_text)
post = frontmatter.load(f, encoding="utf-8-sig")
print(post['title'])  # BOM Document

# Test verification
assert post['title'] == 'BOM Document'
assert 'Content with BOM' in post.content
```

### Node 9: Frontmatter Detection and Validation

**Function Description**: Detect whether a document contains front matter metadata, verify the validity of the metadata format, and provide format checking and existence validation functions.

**Detection Strategy**:

- Automatic format detection
- Existence validation
- Format validity check
- Error handling and fallback

**Input-Output Example**:

```python
import frontmatter

# Detect a file with front matter
has_frontmatter = frontmatter.check("tests/yaml/hello-world.txt")
print(has_frontmatter)  # True

# Detect a file without front matter
no_frontmatter = frontmatter.check("tests/empty/no-frontmatter.txt")
print(no_frontmatter)  # False

# Detect a file with empty front matter
empty_frontmatter = frontmatter.check("tests/empty/empty-frontmatter.txt")
print(empty_frontmatter)  # True

# Detect front matter from a string
text_with_frontmatter = """---
title: Test Document
author: John Doe
---

Content here.
"""
has_fm = frontmatter.checks(text_with_frontmatter)
print(has_fm)  # True

# Detect a string without front matter
plain_text = "This is plain text without frontmatter."
no_fm = frontmatter.checks(plain_text)
print(no_fm)  # False

# Test verification
assert has_frontmatter is True
assert no_frontmatter is False
assert empty_frontmatter is True
assert has_fm is True
assert no_fm is False
```

### Node 10: Post Object Serialization and Conversion

**Function Description**: Provide serialization functions for the `Post` object, support conversion to formats such as dictionaries, strings, and bytes, as well as comparison and copying operations between objects.

**Serialization Interface**:

- Dictionary conversion
- String conversion
- Byte conversion
- Object comparison

**Input-Output Example**:

```python
import frontmatter

# Create a Post object
post = frontmatter.load("tests/yaml/hello-world.txt")

# Convert to a dictionary
post_dict = post.to_dict()
print(post_dict['title'])  # Hello, world!
print(post_dict['content'])  # Well, hello there, world.
print('content' in post_dict)  # True

# String conversion
post_str = str(post)
print(post_str)  # Well, hello there, world.
print(type(post_str))  # <class 'str'>

# Byte conversion
post_bytes = bytes(post)
print(post_bytes)  # b'Well, hello there, world.'
print(type(post_bytes))  # <class 'bytes'>

# Metadata key-value operations
print(list(post.keys()))  # ['title', 'layout']
print(list(post.values()))  # ['Hello, world!', 'post']

# Get metadata (with default value)
author = post.get('author', 'Unknown')
print(author)  # Unknown

# Check metadata keys
print('title' in post)  # True
print('author' in post)  # False

# Test verification
assert post_dict['title'] == 'Hello, world!'
assert str(post) == 'Well, hello there, world.'
assert bytes(post) == b'Well, hello there, world.'
assert 'title' in post
assert 'author' not in post
```

### Node 11: Custom Delimiters and Format Control

**Function Description**: Support custom front matter metadata delimiters, provide format control and output customization functions, including delimiter modification and format option settings.

**Control Interface**:

- Custom delimiters (YAML/TOML-style handlers)
- Format option settings
- Output customization
- Note: JSONHandler uses no delimiters; changing delimiters may break reloads

**Input-Output Example**:

```python
import frontmatter

# Load an original document
post = frontmatter.load("tests/yaml/hello-world.txt")

# Output with custom delimiters
custom_output = frontmatter.dumps(post, start_delimiter="+++", end_delimiter="+++")
print(custom_output)
# Output:
# +++
# layout: post
# title: Hello, world!
# +++
#
# Well, hello there, world.

# Verify custom delimiters
assert "+++" in custom_output
assert "---" not in custom_output

# Use different delimiters
star_output = frontmatter.dumps(post, start_delimiter="***", end_delimiter="***")
print(star_output)
# Output:
# ***
# layout: post
# title: Hello, world!
# ***
#
# Well, hello there, world.

# Test verification
assert "***" in star_output
assert "+++" not in star_output
```

### Node 12: Error Handling and Fault Tolerance

**Function Description**: Describe practical error behavior. Split failures safely fall back to returning original text as content with empty metadata; parsing errors from YAML/JSON/TOML propagate to the caller.

**Error Handling Strategy**:

- Safe fallback on split failures
- Encoding is caller-controlled (e.g., "utf-8", "utf-8-sig"); no auto-detection
- Parsing errors are not swallowed; wrap calls in try/except as needed

**Input-Output Example**:

author: John Doe
```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler
import yaml

# Malformed YAML: yaml loader will raise; wrap in try/except
bad_yaml = """---
title: Test Document
invalid: yaml: format: here
---

Content here.
"""

try:
    frontmatter.loads(bad_yaml)
except yaml.YAMLError:
    # Handle/Log the error as appropriate for your app
    pass

# Document without front matter safely returns original content
plain_text = "This is plain text without any frontmatter."
post = frontmatter.loads(plain_text)
print(post.metadata)  # {}
print(post.content)  # Original text

# Bytes input requires a correct encoding from the caller
data = plain_text.encode("utf-8")
post = frontmatter.loads(data, encoding="utf-8")
print(post.content)  # Original text
```

### Node 13: Handler Detection and Selection

**Function Description**: Automatically detect the document format and select the appropriate processor, support processor priority sorting and custom processor selection.

**Detection Strategy**:

- Automatic format detection
- Processor priority
- Custom processors
- Detection fallback mechanism

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler, JSONHandler, TOMLHandler

# Automatically detect YAML format
yaml_text = """---
title: YAML Document
author: John Doe
---

Content here.
"""
post = frontmatter.loads(yaml_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.YAMLHandler'>

# Automatically detect JSON format
json_text = """{
  "title": "JSON Document",
  "author": "John Doe"
}

Content here.
"""
post = frontmatter.loads(json_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.JSONHandler'>

# Automatically detect TOML format
toml_text = """+++
title = "TOML Document"
author = "John Doe"
+++

Content here.
"""
post = frontmatter.loads(toml_text)
print(type(post.handler))  # <class 'frontmatter.default_handlers.TOMLHandler'>

# Specify a custom processor
custom_handler = YAMLHandler()
post = frontmatter.loads(yaml_text, handler=custom_handler)
print(post.handler is custom_handler)  # True

# Test verification
assert isinstance(post.handler, YAMLHandler)
```

### Node 14: Document Format Conversion and Compatibility

**Function Description**: Support conversion between different formats, maintain data integrity, and provide format compatibility handling and conversion verification.

**Conversion Function**:

- Conversion between formats
- Maintenance of data integrity
- Compatibility handling
- Conversion verification

**Input-Output Example**:

```python
import frontmatter
from frontmatter.default_handlers import YAMLHandler, JSONHandler, TOMLHandler

# Convert from YAML to JSON
yaml_text = """---
title: Test Document
author: John Doe
tags: [python, frontmatter]
---

Content here.
"""
post = frontmatter.loads(yaml_text)
json_output = frontmatter.dumps(post, handler=JSONHandler())
print(json_output)
# Output:
# {
#     "author": "John Doe",
#     "tags": [
#         "python",
#         "frontmatter"
#     ],
#     "title": "Test Document"
# }
#
# Content here.

# Convert from JSON to TOML
json_text = """{
  "title": "Test Document",
  "author": "John Doe",
  "tags": ["python", "frontmatter"]
}

Content here.
"""
post = frontmatter.loads(json_text, handler=JSONHandler())
toml_output = frontmatter.dumps(post, handler=TOMLHandler())
print(toml_output)
# Output:
# +++
# author = "John Doe"
# tags = ["python", "frontmatter"]
# title = "Test Document"
# +++
#
# Content here.

# Verify conversion integrity
post_yaml = frontmatter.loads(yaml_text)
post_json = frontmatter.loads(json_output, handler=JSONHandler())
assert post_yaml.metadata == post_json.metadata
assert post_yaml.content == post_json.content

# Test verification
assert "title" in json_output
assert "+++" in toml_output
assert post_yaml['title'] == post_json['title']
```