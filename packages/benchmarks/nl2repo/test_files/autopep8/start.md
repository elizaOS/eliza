## Introduction and Goals of the Autopep8 Project

Autopep8 is a tool that **automatically formats Python code to comply with the PEP 8 style guide**. It uses the pycodestyle tool to determine which parts of the code need formatting. Autopep8 can fix most formatting issues reported by pycodestyle. In short, Autopep8 aims to provide an automated Python code formatting tool to help developers maintain code style consistency, improve code readability and maintainability.

## Natural Language Instruction (Prompt)

Please create a Python project named autopep8 to implement a tool that automatically formats Python code to comply with the PEP 8 style guide. The project should include the following features:

1. Code formatting engine: Implement a core code formatting engine that can automatically fix PEP 8 style issues in Python code. The engine should support multiple formatting strategies, including indentation fixing, whitespace processing, line length control, import statement normalization, etc. The formatting process should be based on the issues detected by the pycodestyle tool and provide intelligent fixing algorithms.

2. PEP 8 error fixing: Implement a complete PEP 8 error code fixing function, including the E1 series (related to indentation), the E2 series (related to whitespace), the E3 series (related to imports), the E4 series (related to imports), the E5 series (related to line length), the E7 series (related to syntax), the W series (related to warnings), etc. Each error code should have a corresponding fixing function, such as fix_e101(), fix_e201(), fix_e401(), etc.

3. Command-line interface: Provide a complete command-line interface that supports file formatting, recursive directory processing, difference display, in-place modification, etc. The command line should support multiple options, such as --in-place (in-place modification), --diff (display differences), --aggressive (aggressive mode), --max-line-length (maximum line length), --select/--ignore (select/ignore specific errors), etc.

4. Configuration system: Implement a flexible configuration system that supports reading settings from configuration files such as pyproject.toml, setup.cfg, .pep8, and supports the merging of global and local configurations. The configuration system should be able to handle various formatting options, such as indentation size, line length limit, ignored error codes, etc.

5. Multi-file processing: Support batch processing of multiple Python files, including recursive directory scanning, file filtering, parallel processing, etc. It should provide practical functions such as file matching, exclusion patterns, and encoding detection.

6. Core file requirements: The project must include a complete pyproject.toml file, which should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as pycodestyle >= 2.12.0, tomli). The pyproject.toml can verify whether all functional modules work properly. At the same time, autopep8.py should be provided as the main implementation file, including the FixPEP8 class as the core formatting engine, implementing main functions such as fix_code(), fix_file(), fix_multiple_files(), get_module_imports_on_top_of_file, and providing version information so that users can access all main functions through simple statements like "import autopep8" and "from autopep8 import *".


## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
# Core PEP8 checking library
pycodestyle >= 2.12.0              # PEP8 style checking engine, the core dependency of autopep8

# Configuration file parsing library (only required for Python versions below 3.11)
tomli; python_version < '3.11'     # TOML configuration file parsing library

# Testing-related dependencies
pydiff >= 0.1.2                    # Difference comparison library for testing and verification
pytest >= 8.0.0                    # Unit testing framework (recommended, not required)

# Supported Python versions
Python >= 3.9                      # Minimum version requirement
```

## Autopep8 Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .codecov.yml
├── .gitignore
├── .pre-commit-config.yaml
├── .pre-commit-hooks.yaml
├── AUTHORS.rst
├── CONTRIBUTING.rst
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.rst
├── autopep8.py
├── hooks
│   ├── pre-push
├── install_hooks.bash
├── pyproject.toml
├── tox.ini
└── update_readme.py

```
## API Usage Guide

### Core API

#### Module Import

```python
import autopep8
```
### Core Functions

#### 1. `_custom_formatwarning` Function

**Function**: Custom warning formatter for displaying warnings in a specific format.

**Function Signature**:
```python
def _custom_formatwarning(message, category, _, __, line=None):
```

**Parameters**:
- `message` (str): The warning message to display
- `category` (type): The warning category class
- `_` (any): Unused parameter (placeholder)
- `__` (any): Unused parameter (placeholder)  
- `line` (int, optional): Line number where warning occurred

**Returns**:
- `str`: Formatted warning string in the format "{category.__name__}: {message}\n"

**Description**: Creates a custom warning message format that displays the category name followed by the message, with a newline character at the end.

#### 2. `open_with_encoding` Function

**Function**: Open a file with automatic encoding detection and proper line ending handling.

**Function Signature**:
```python
def open_with_encoding(filename, mode='r', encoding=None, limit_byte_check=-1):
```

**Parameters**:
- `filename` (str): Path to the file to open
- `mode` (str, optional): File opening mode, defaults to 'r' (read)
- `encoding` (str, optional): Specific encoding to use, if None will auto-detect
- `limit_byte_check` (int, optional): Number of bytes to check for encoding validation, -1 for no limit

**Returns**:
- `file object`: Opened file handle with proper encoding

**Description**: Opens a file with automatic encoding detection if no encoding is specified. Preserves original line endings and handles encoding errors gracefully.

#### 3. `_detect_encoding_from_file` Function

**Function**: Detect file encoding by examining the file content, particularly looking for BOM and encoding declarations.

**Function Signature**:
```python
def _detect_encoding_from_file(filename: str):
```

**Parameters**:
- `filename` (str): Path to the file to analyze

**Returns**:
- `str`: Detected encoding name (e.g., 'utf-8', 'utf-8-sig', 'latin-1')

**Description**: Examines the first few lines of a file to detect its encoding by looking for UTF-8 BOM markers and Python encoding magic comments. Falls back to 'utf-8' if detection fails.

#### 4. `detect_encoding` Function

**Function**: Detect and validate file encoding with fallback handling.

**Function Signature**:
```python
def detect_encoding(filename, limit_byte_check=-1):
```

**Parameters**:
- `filename` (str): Path to the file to analyze
- `limit_byte_check` (int, optional): Number of bytes to read for validation, -1 for no limit

**Returns**:
- `str`: Validated encoding name

**Description**: Detects file encoding using `_detect_encoding_from_file` and validates it by attempting to read the file. Falls back to 'latin-1' if the detected encoding fails validation.

#### 5. `readlines_from_file` Function

**Function**: Read all lines from a file with proper encoding handling.

**Function Signature**:
```python
def readlines_from_file(filename):
```

**Parameters**:
- `filename` (str): Path to the file to read

**Returns**:
- `list`: List of strings containing all lines from the file

**Description**: Opens a file with automatic encoding detection and returns all lines as a list of strings. Uses `open_with_encoding` internally for proper encoding handling.

#### 6. `extended_blank_lines` Function

**Function**: Check for missing or excessive blank lines after class/function declarations (extends pycodestyle checks).

**Function Signature**:
```python
def extended_blank_lines(logical_line, blank_lines, blank_before, indent_level, previous_logical):
```

**Parameters**:
- `logical_line` (str): Current logical line of code
- `blank_lines` (int): Number of blank lines before current line
- `blank_before` (int): Number of blank lines before previous line
- `indent_level` (int): Current indentation level
- `previous_logical` (str): Previous logical line of code

**Returns**:
- `generator`: Yields tuples of (position, error_message) for violations found

**Description**: Checks for proper blank line usage between function/method definitions and docstrings. Detects E303 (too many blank lines) after function definitions before docstrings, and E301 (missing blank line) between class docstrings and method declarations.

#### 7. `continued_indentation` Function

**Function**: Override pycodestyle's continued indentation checker to provide enhanced indentation validation.

**Function Signature**:
```python
def continued_indentation(logical_line, tokens, indent_level, hang_closing, indent_char, noqa):
```

**Parameters**:
- `logical_line` (str): Current logical line being checked
- `tokens` (list): List of tokens in the logical line
- `indent_level` (int): Base indentation level
- `hang_closing` (bool): Whether closing bracket should hang
- `indent_char` (str): Indentation character (space or tab)
- `noqa` (bool): Whether to skip checking (noqa comment present)

**Returns**:
- `generator`: Yields tuples of (position, error_message) for indentation violations

**Description**: Validates continuation line indentation, checking for proper alignment and hanging indents. Handles special cases for different bracket types and indentation styles (spaces vs tabs).

#### 8. `get_module_imports_on_top_of_file` Function

**Function**: Find the appropriate position to place module imports at the top of a Python file.

**Function Signature**:
```python
def get_module_imports_on_top_of_file(source, import_line_index):
```

**Parameters**:
- `source` (list): Lines of source code
- `import_line_index` (int): Index of the import line to check

**Returns**:
- `int`: Line index where imports should be placed (0 if at file start)

**Description**: Analyzes Python source code to determine the correct position for import statements, taking into account docstrings, future imports, dunder variables, comments, and try/except blocks. Returns the line number where the import should be moved to maintain PEP 8 compliance.

#### 9. `is_string_literal` Function

**Function**: Determine if a line starts with a string literal.

**Function Signature**:
```python
def is_string_literal(line):
```

**Parameters**:
- `line` (str): Line of code to check

**Returns**:
- `bool`: True if line starts with a string literal, False otherwise

**Description**: Checks if a line begins with a string literal by detecting string prefixes (u, U, b, B, r, R) and quote characters. Used internally by `get_module_imports_on_top_of_file` to identify string literals at module level.

#### 10. `is_future_import` Function

**Function**: Check if a line contains a `__future__` import statement.

**Function Signature**:
```python
def is_future_import(line):
```

**Parameters**:
- `line` (str): Line of code to check

**Returns**:
- `bool`: True if line contains a future import, False otherwise

**Description**: Parses a line of code using AST to determine if it contains a `from __future__ import` statement. Used to identify future imports which must appear at the beginning of a file.

#### 11. `has_future_import` Function

**Function**: Check if a source code stream contains a `__future__` import statement.

**Function Signature**:
```python
def has_future_import(source):
```

**Parameters**:
- `source` (iterator): Iterator of (index, line) tuples representing source code lines

**Returns**:
- `tuple`: (bool, int) - True/False indicating if future import found, and the offset line number

**Description**: Iterates through source code lines to detect `from __future__ import` statements. Handles multi-line imports and syntax errors gracefully. Used internally by `get_module_imports_on_top_of_file` to properly position future imports.

#### 12. `get_index_offset_contents` Function

**Function**: Extract line index, column offset, and line contents from a pycodestyle result.

**Function Signature**:
```python
def get_index_offset_contents(result, source):
```

**Parameters**:
- `result` (dict): Dictionary containing error information with 'line' and 'column' keys
- `source` (list): List of source code lines

**Returns**:
- `tuple`: (line_index, column_offset, line_contents) with 0-based line index, 0-based column offset, and the actual line content

**Description**: Converts 1-based line and column numbers from pycodestyle results to 0-based indices and retrieves the corresponding line content. Used for error position processing.

#### 13. `get_fixed_long_line` Function

**Function**: Break up a long line of code and return the best reformatted result.

**Function Signature**:
```python
def get_fixed_long_line(target, previous_line, original, indent_word='    ', max_line_length=79, aggressive=0, experimental=False, verbose=False):
```

**Parameters**:
- `target` (str): The long line to fix
- `previous_line` (str): The line before the target line
- `original` (str): Original version of the line
- `indent_word` (str, optional): Indentation string (default: 4 spaces)
- `max_line_length` (int, optional): Maximum allowed line length (default: 79)
- `aggressive` (int, optional): Aggressiveness level for fixes (default: 0)
- `experimental` (bool, optional): Enable experimental fixes (default: False)
- `verbose` (bool, optional): Enable verbose output (default: False)

**Returns**:
- `str` or `None`: Reformatted line(s) that fit within max_line_length, or None if no suitable reformatting found

**Description**: Generates multiple reformatted candidates for a long line and ranks them heuristically to select the best option. Handles various line breaking strategies and special cases for multiline strings.

#### 14. `longest_line_length` Function

**Function**: Calculate the length of the longest line in a code string.

**Function Signature**:
```python
def longest_line_length(code):
```

**Parameters**:
- `code` (str): Code string to analyze

**Returns**:
- `int`: Length of the longest line (0 if code is empty)

**Description**: Splits code into lines and returns the maximum line length. Used to verify if code meets line length requirements.

#### 15. `join_logical_line` Function

**Function**: Reconstruct a single physical line from a logical line representation.

**Function Signature**:
```python
def join_logical_line(logical_line):
```

**Parameters**:
- `logical_line` (str): Logical line that may span multiple physical lines

**Returns**:
- `str`: Single line with proper indentation and newline

**Description**: Takes a logical line (which may contain continuation lines) and joins it into a single physical line while preserving indentation. Uses tokenization to properly reconstruct the line.

#### 16. `untokenize_without_newlines` Function

**Function**: Convert tokens back to source code without inserting newlines.

**Function Signature**:
```python
def untokenize_without_newlines(tokens):
```

**Parameters**:
- `tokens` (list): List of tokens to convert back to source code

**Returns**:
- `str`: Reconstructed source code string without newlines

**Description**: Reconstructs source code from tokens while removing newline tokens and maintaining proper spacing. Used to join logical lines that span multiple physical lines.

#### 17. `_find_logical` Function

**Function**: Find the start and end positions of all logical lines in source code.

**Function Signature**:
```python
def _find_logical(source_lines):
```

**Parameters**:
- `source_lines` (list): List of source code lines

**Returns**:
- `tuple`: (logical_start, logical_end) - Lists of (row, column) tuples marking logical line boundaries

**Description**: Analyzes source code using tokenization to identify logical line boundaries, accounting for parentheses, brackets, and line continuations. Ignores comments, indents, and other non-code tokens.

#### 18. `_get_logical` Function

**Function**: Extract the logical line corresponding to a specific error result.

**Function Signature**:
```python
def _get_logical(source_lines, result, logical_start, logical_end):
```

**Parameters**:
- `source_lines` (list): List of source code lines
- `result` (dict): Error result dictionary with 'line' and 'column' keys
- `logical_start` (list): List of logical line start positions
- `logical_end` (list): List of logical line end positions

**Returns**:
- `tuple` or `None`: (logical_start, logical_end, original_lines) tuple containing the logical line boundaries and content, or None if not found

**Description**: Locates and returns the complete logical line that contains a specific error position. Assumes input is E702-clean (no multiple statements on one line).

#### 19. `get_item` Function

**Function**: Safely retrieve an item from a list with bounds checking.

**Function Signature**:
```python
def get_item(items, index, default=None):
```

**Parameters**:
- `items` (list): List to retrieve item from
- `index` (int): Index of item to retrieve
- `default` (any, optional): Default value to return if index out of bounds (default: None)

**Returns**:
- `any`: Item at specified index, or default value if index is invalid

**Description**: Provides safe list indexing with automatic bounds checking and default value support. Returns the item if index is valid, otherwise returns the default value.

#### 20. `reindent` Function

**Function**: Reindent all lines in source code to use a specific indent size.

**Function Signature**:
```python
def reindent(source, indent_size, leave_tabs=False):
```

**Parameters**:
- `source` (str): Source code to reindent
- `indent_size` (int): Number of spaces per indentation level
- `leave_tabs` (bool, optional): If True, preserve tabs (default: False)

**Returns**:
- `str`: Reindented source code

**Description**: Completely reindents source code using the specified indent size. Uses the `Reindenter` class internally to parse and reconstruct indentation levels.

#### 21. `code_almost_equal` Function

**Function**: Compare two code strings for semantic equality ignoring whitespace differences.

**Function Signature**:
```python
def code_almost_equal(a, b):
```

**Parameters**:
- `a` (str): First code string to compare
- `b` (str): Second code string to compare

**Returns**:
- `bool`: True if code is semantically similar (ignoring whitespace), False otherwise

**Description**: Compares two code strings by normalizing whitespace within each line. Returns True if both have the same number of non-empty lines and each corresponding line has the same non-whitespace content.

#### 22. `split_and_strip_non_empty_lines` Function

**Function**: Split text by newlines and return only non-empty stripped lines.

**Function Signature**:
```python
def split_and_strip_non_empty_lines(text):
```

**Parameters**:
- `text` (str): Text to split into lines

**Returns**:
- `list`: List of non-empty stripped lines

**Description**: Splits text on newlines, strips whitespace from each line, and filters out empty lines. Useful for comparing code while ignoring blank lines and indentation.

#### 23. `find_newline` Function

**Function**: Detect the type of newline character used in source code.

**Function Signature**:
```python
def find_newline(source):
```

**Parameters**:
- `source` (list): List of source code lines

**Returns**:
- `str`: Newline type (CR, LF, or CRLF) most commonly used in the source

**Description**: Analyzes source code lines to determine the predominant newline style (Windows CRLF, Unix LF, or Mac CR). Returns the most frequently occurring newline type.

#### 24. `_get_indentword` Function

**Function**: Determine the indentation string used in source code.

**Function Signature**:
```python
def _get_indentword(source):
```

**Parameters**:
- `source` (str): Source code to analyze

**Returns**:
- `str`: Indentation string (spaces or tabs) used in the code, defaults to 4 spaces if none found

**Description**: Tokenizes source code to find the first INDENT token and returns its string value. This reveals whether the code uses spaces or tabs and how many. Handles syntax errors gracefully.

#### 25. `_get_indentation` Function

**Function**: Extract the leading whitespace from a line.

**Function Signature**:
```python
def _get_indentation(line):
```

**Parameters**:
- `line` (str): Line of code to analyze

**Returns**:
- `str`: Leading whitespace string, or empty string if line is blank

**Description**: Returns the leading whitespace characters (spaces/tabs) from a line. Returns empty string for blank or whitespace-only lines.

#### 26. `get_diff_text` Function

**Function**: Generate unified diff text between old and new code.

**Function Signature**:
```python
def get_diff_text(old, new, filename):
```

**Parameters**:
- `old` (list): List of original code lines
- `new` (list): List of modified code lines
- `filename` (str): Filename to display in diff headers

**Returns**:
- `str`: Unified diff text showing changes between old and new

**Description**: Creates a unified diff between two versions of code using Python's difflib. The diff uses 'original/' and 'fixed/' prefixes for filenames and includes line numbers and context.

#### 27. `_priority_key` Function

**Function**: Generate sorting key for PEP 8 error results to determine fix order.

**Function Signature**:
```python
def _priority_key(pep8_result):
```

**Parameters**:
- `pep8_result` (dict): Dictionary containing error information with 'id', 'line', and 'column' keys

**Returns**:
- `tuple`: Sorting key tuple (priority_index, line, column)

**Description**: Returns a key for sorting PEP 8 violations to ensure they are fixed in the correct order. Global fixes like indentation are prioritized, followed by line-by-line fixes ordered by position.

#### 28. `shorten_line` Function

**Function**: Generate multiple shortened versions of a long line by breaking at operators.

**Function Signature**:
```python
def shorten_line(tokens, source, indentation, indent_word, max_line_length, aggressive=0, experimental=False, previous_line=''):
```

**Parameters**:
- `tokens` (list): Tokens of the line to shorten
- `source` (str): Source code string
- `indentation` (str): Current indentation string
- `indent_word` (str): Indentation unit to use
- `max_line_length` (int): Maximum allowed line length
- `aggressive` (int, optional): Aggressiveness level (default: 0)
- `experimental` (bool, optional): Enable experimental fixes (default: False)
- `previous_line` (str, optional): Previous line for context (default: '')

**Returns**:
- `generator`: Yields multiple candidate shortened versions of the line

**Description**: Generates multiple candidates for shortening a long line by breaking at various operators. Returns a generator of possible reformatted lines for heuristic selection.

#### 29. `_shorten_line` Function

**Function**: Internal function to generate line shortening candidates by breaking at operators.

**Function Signature**:
```python
def _shorten_line(tokens, source, indentation, indent_word, aggressive=0, previous_line=''):
```

**Parameters**:
- `tokens` (list): Tokens of the line to process
- `source` (str): Source code string
- `indentation` (str): Current indentation string
- `indent_word` (str): Indentation unit to use
- `aggressive` (int, optional): Aggressiveness level (default: 0)
- `previous_line` (str, optional): Previous line for context (default: '')

**Returns**:
- `generator`: Yields shortened line candidates

**Description**: Core implementation of line shortening logic. Identifies break points at binary operators and yields multiple candidates. Input should be free of newlines except inside multiline strings.

#### 30. `_is_binary_operator` Function

**Function**: Determine if a token is a binary operator suitable for line breaking.

**Function Signature**:
```python
def _is_binary_operator(token_type, text):
```

**Parameters**:
- `token_type` (int): Token type from tokenize module
- `text` (str): Token text string

**Returns**:
- `bool`: True if token is a binary operator, False otherwise

**Description**: Checks if a token represents a binary operator (OP type or 'and'/'or' keywords) while excluding parentheses, brackets, commas, and other non-binary operators.

#### 31. `_parse_container` Function

**Function**: Parse container structures (lists, tuples, dicts, sets) from tokens.

**Function Signature**:
```python
def _parse_container(tokens, index, for_or_if=None):
```

**Parameters**:
- `tokens` (list): List of tokens to parse
- `index` (int): Current position in token list
- `for_or_if` (str, optional): Indicator for list comprehensions or if-expressions

**Returns**:
- `tuple`: (Container object, next_index) - Parsed container and position after container

**Description**: Parses high-level container structures like lists, tuples, dictionaries from token stream. Handles nested containers, list comprehensions, and if-expressions. Returns the parsed container object and the index after the closing bracket.

#### 32. `_parse_tokens` Function

**Function**: Convert token list into manipulable parsed token structure.

**Function Signature**:
```python
def _parse_tokens(tokens):
```

**Parameters**:
- `tokens` (list): Raw tokens from tokenizer

**Returns**:
- `list`: List of parsed token objects (Atoms and Containers)

**Description**: Transforms raw tokens into a structured format with Atom and Container objects that can be manipulated for reformatting. Handles all container types and builds a hierarchical representation of code structure.

#### 33. `_reflow_lines` Function

**Function**: Reflow parsed tokens into properly formatted lines.

**Function Signature**:
```python
def _reflow_lines(parsed_tokens, indentation, max_line_length, start_on_prefix_line):
```

**Parameters**:
- `parsed_tokens` (list): List of parsed token objects
- `indentation` (str): Base indentation string
- `max_line_length` (int): Maximum allowed line length
- `start_on_prefix_line` (bool): Whether to start on the same line as prefix

**Returns**:
- `str`: Reformatted code string

**Description**: Takes parsed tokens and reflows them into nicely formatted lines respecting max line length. Handles function definitions with extra indentation and manages line breaks appropriately.

#### 34. `_shorten_line_at_tokens_new` Function

**Function**: Shorten lines using advanced token-based parsing and reflowing.

**Function Signature**:
```python
def _shorten_line_at_tokens_new(tokens, source, indentation, max_line_length):
```

**Parameters**:
- `tokens` (list): Tokens of the line
- `source` (str): Source code string
- `indentation` (str): Current indentation
- `max_line_length` (int): Maximum line length

**Returns**:
- `generator`: Yields candidate shortened lines

**Description**: Modern line shortening approach that parses tokens into structured format and reflows them. Generates multiple candidates by trying different formatting strategies. Input should be newline-free except in multiline strings.

#### 35. `_shorten_line_at_tokens` Function

**Function**: Shorten lines by breaking at specific key token strings.

**Function Signature**:
```python
def _shorten_line_at_tokens(tokens, source, indentation, indent_word, key_token_strings, aggressive):
```

**Parameters**:
- `tokens` (list): Tokens of the line
- `source` (str): Source code string
- `indentation` (str): Current indentation
- `indent_word` (str): Indentation unit
- `key_token_strings` (set): Set of token strings to break at
- `aggressive` (int): Aggressiveness level

**Returns**:
- `generator`: Yields shortened line candidates

**Description**: Traditional line shortening by finding key tokens (operators, keywords) and breaking the line at those positions. Input should be newline-free except in multiline strings.

#### 36. `token_offsets` Function

**Function**: Generate token information with calculated character offsets.

**Function Signature**:
```python
def token_offsets(tokens):
```

**Parameters**:
- `tokens` (list): List of tokens to process

**Returns**:
- `generator`: Yields tuples of (token_type, token_string, start_offset, end_offset)

**Description**: Converts tokens with row/column positions into tokens with character offsets relative to the start of the line. Useful for string slicing operations on source code.

#### 37. `normalize_multiline` Function

**Function**: Normalize multiline code fragments to prevent syntax errors during checking.

**Function Signature**:
```python
def normalize_multiline(line):
```

**Parameters**:
- `line` (str): Line of code to normalize

**Returns**:
- `str`: Normalized line that won't cause syntax errors

**Description**: Adds necessary context to code fragments (like adding 'pass' after function definitions, wrapping 'return' statements in functions) to make them syntactically valid for checking purposes.

#### 38. `fix_whitespace` Function

**Function**: Replace whitespace at a specific offset in a line.

**Function Signature**:
```python
def fix_whitespace(line, offset, replacement):
```

**Parameters**:
- `line` (str): Line to modify
- `offset` (int): Character position to replace whitespace
- `replacement` (str): Replacement string

**Returns**:
- `str`: Modified line with whitespace replaced, or original line if followed by comment

**Description**: Strips whitespace and escaped newlines around the offset position and inserts the replacement. Preserves lines that have comments immediately after the offset.

#### 39. `_execute_pep8` Function

**Function**: Execute pycodestyle checker and collect error results.

**Function Signature**:
```python
def _execute_pep8(pep8_options, source):
```

**Parameters**:
- `pep8_options` (dict): Options to pass to pycodestyle checker
- `source` (list): Source code lines to check

**Returns**:
- `list`: List of error dictionaries with 'id', 'line', 'column', and 'info' keys

**Description**: Runs pycodestyle checker on source code using a custom QuietReport class that collects errors without printing. Returns detailed error information in structured format.

#### 40. `_remove_leading_and_normalize` Function

**Function**: Remove leading whitespace and normalize line endings.

**Function Signature**:
```python
def _remove_leading_and_normalize(line, with_rstrip=True):
```

**Parameters**:
- `line` (str): Line to process
- `with_rstrip` (bool, optional): Whether to strip trailing whitespace (default: True)

**Returns**:
- `str`: Line with leading whitespace removed and normalized ending

**Description**: Strips leading spaces, tabs, and vertical tabs. Optionally strips trailing CR/LF and adds a single newline. Ignores form feed characters in leading whitespace.

#### 41. `_reindent_stats` Function

**Function**: Analyze tokens to extract statement and comment line indentation statistics.

**Function Signature**:
```python
def _reindent_stats(tokens):
```

**Parameters**:
- `tokens` (list): Token list from tokenizer

**Returns**:
- `list`: List of (line_number, indent_level) tuples for each statement and comment line

**Description**: Processes tokens to determine indentation levels for each statement. Comment lines get indent level -1 as a signal that their indentation needs special handling. Used by the reindentation logic.

#### 42. `_leading_space_count` Function

**Function**: Count the number of leading spaces in a line.

**Function Signature**:
```python
def _leading_space_count(line):
```

**Parameters**:
- `line` (str): Line to analyze

**Returns**:
- `int`: Number of leading space characters

**Description**: Counts consecutive space characters at the beginning of a line. Stops at the first non-space character or end of line.

#### 43. `check_syntax` Function

**Function**: Validate if code string has correct Python syntax.

**Function Signature**:
```python
def check_syntax(code):
```

**Parameters**:
- `code` (str): Python code to check

**Returns**:
- `bool`: True if syntax is valid, False otherwise

**Description**: Attempts to compile the code string. Returns True if compilation succeeds, False if any syntax, type, or value errors occur. Used to verify fixes don't break code.

#### 44. `find_with_line_numbers` Function

**Function**: Find all occurrences of a pattern and return their line numbers.

**Function Signature**:
```python
def find_with_line_numbers(pattern, contents):
```

**Parameters**:
- `pattern` (str): Regular expression pattern to search for
- `contents` (str): Text content to search in

**Returns**:
- `list`: List of line numbers where pattern matches were found (1-indexed)

**Description**: Wraps re.finditer to provide line numbers for all matches. Efficiently maps byte offsets to line numbers using a precomputed newline offset dictionary.

#### 45. `get_line_num` Function

**Function**: Get the line number of a match object within file contents.

**Function Signature**:
```python
def get_line_num(match, contents):
```

**Parameters**:
- `match` (re.Match): Regular expression match object
- `contents` (str): File contents being searched

**Returns**:
- `int`: Line number where the match occurs (0-indexed)

**Description**: Converts a regex match's byte offset to a line number by finding the last newline before the match position. This is an internal function used within `find_with_line_numbers` and is not directly accessible as a standalone function.

#### 46. `get_disabled_ranges` Function

**Function**: Extract line ranges where autopep8 is disabled via special comments.

**Function Signature**:
```python
def get_disabled_ranges(source):
```

**Parameters**:
- `source` (str): Source code to analyze

**Returns**:
- `list`: List of (start_line, end_line) tuples representing disabled ranges

**Description**: Finds `# autopep8: off` and `# autopep8: on` comments and returns the line ranges where autopep8 should skip fixes. If disabled without re-enabling, disables for rest of file.

#### 47. `filter_disabled_results` Function

**Function**: Filter out error results that fall within disabled line ranges.

**Function Signature**:
```python
def filter_disabled_results(result, disabled_ranges):
```

**Parameters**:
- `result` (dict): Error result dictionary with 'line' key
- `disabled_ranges` (list): List of (start_line, end_line) tuples

**Returns**:
- `bool`: True if result should be processed, False if it's in a disabled range

**Description**: Checks if an error's line number falls within any disabled range. Returns False for errors in disabled ranges, True otherwise.

#### 48. `filter_results` Function

**Function**: Filter out spurious or unwanted error reports from pycodestyle.

**Function Signature**:
```python
def filter_results(source, results, aggressive):
```

**Parameters**:
- `source` (str): Source code being checked
- `results` (list): List of error result dictionaries
- `aggressive` (int): Aggressiveness level for fixes

**Returns**:
- `list`: Filtered list of error results that should be fixed

**Description**: Filters pycodestyle results to exclude errors in multiline strings, commented-out code, and disabled ranges. Aggressiveness level determines which potentially unsafe fixes are allowed.

#### 49. `multiline_string_lines` Function

**Function**: Identify line numbers that are within multiline strings or docstrings.

**Function Signature**:
```python
def multiline_string_lines(source, include_docstrings=False):
```

**Parameters**:
- `source` (str): Source code to analyze
- `include_docstrings` (bool, optional): Whether to include docstring lines (default: False)

**Returns**:
- `set`: Set of line numbers (1-indexed) within multiline strings

**Description**: Tokenizes source to find all lines within multiline strings. Docstrings can be optionally included or excluded. Handles f-strings if the Python version supports them.

#### 50. `commented_out_code_lines` Function

**Function**: Identify line numbers containing comments that appear to be commented-out code.

**Function Signature**:
```python
def commented_out_code_lines(source):
```

**Parameters**:
- `source` (str): Source code to analyze

**Returns**:
- `list`: List of line numbers (1-indexed) likely containing commented-out code

**Description**: Detects comments that look like code (not just documentation) by checking for code patterns like assignments, keywords, etc. These lines are excluded from formatting to avoid modifying what might be intentionally disabled code.

#### 51. `shorten_comment` Function

**Function**: Trim or wrap a comment line that exceeds maximum length.

**Function Signature**:
```python
def shorten_comment(line, max_line_length, last_comment=False):
```

**Parameters**:
- `line` (str): Comment line to shorten
- `max_line_length` (int): Maximum allowed line length
- `last_comment` (bool, optional): Whether this is the last comment in a block (default: False)

**Returns**:
- `str`: Shortened comment line(s)

**Description**: Wraps long comment lines using text wrapping. PEP 8 recommends 72 characters for comment text. Only wraps if this is the last comment or standalone, to avoid jagged comment blocks.

#### 52. `normalize_line_endings` Function

**Function**: Normalize all line endings to use a consistent newline character.

**Function Signature**:
```python
def normalize_line_endings(lines, newline):
```

**Parameters**:
- `lines` (list): List of lines to normalize
- `newline` (str): Newline character to use (e.g., '\n', '\r\n')

**Returns**:
- `list`: Lines with normalized line endings

**Description**: Strips all CR/LF from lines and replaces with the specified newline character. Preserves files that don't end with a newline by checking the last line.

#### 53. `mutual_startswith` Function

**Function**: Check if either string starts with the other.

**Function Signature**:
```python
def mutual_startswith(a, b):
```

**Parameters**:
- `a` (str): First string
- `b` (str): Second string

**Returns**:
- `bool`: True if a starts with b or b starts with a, False otherwise

**Description**: Symmetric startswith check. Used for matching error codes where 'E1' should match 'E11', 'E12', etc.

#### 54. `code_match` Function

**Function**: Check if an error code matches select/ignore patterns.

**Function Signature**:
```python
def code_match(code, select, ignore):
```

**Parameters**:
- `code` (str): Error code to check (e.g., 'E501')
- `select` (list): List of codes to select (None to select all)
- `ignore` (list): List of codes to ignore

**Returns**:
- `bool`: True if code should be processed, False if it should be skipped

**Description**: Determines if an error code should be fixed based on select/ignore lists. Ignore takes precedence over select. Supports prefix matching (e.g., 'E' matches 'E501').

#### 55. `fix_code` Function

**Function**: Main function to fix PEP 8 violations in source code.

**Function Signature**:
```python
def fix_code(source, options=None, encoding=None, apply_config=False):
```

**Parameters**:
- `source` (str or bytes): Source code to fix
- `options` (dict, optional): Options dict with settings like max_line_length, aggressive, etc.
- `encoding` (str, optional): Encoding to use if source is bytes
- `apply_config` (bool, optional): Whether to apply config from setup.cfg/pyproject.toml (default: False)

**Returns**:
- `str`: Fixed source code

**Description**: Main entry point for fixing code. Applies global and local fixes iteratively based on options. Normalizes line endings, handles encoding, and ensures W503/W504 consistency.

#### 56. `_get_options` Function

**Function**: Parse and validate options from various input formats.

**Function Signature**:
```python
def _get_options(raw_options, apply_config):
```

**Parameters**:
- `raw_options` (dict or Namespace): Options as dict or argparse Namespace
- `apply_config` (bool): Whether to apply config file settings

**Returns**:
- `Namespace`: Parsed options object

**Description**: Converts dictionary or Namespace options into a standardized options object. Validates option names and types. Returns default options if raw_options is None.

#### 57. `fix_lines` Function

**Function**: Fix PEP 8 violations in a list of source code lines.

**Function Signature**:
```python
def fix_lines(source_lines, options, filename=''):
```

**Parameters**:
- `source_lines` (list): List of source code lines to fix
- `options` (Namespace): Options object with fix settings
- `filename` (str, optional): Filename for context (default: '')

**Returns**:
- `str`: Fixed source code as a string

**Description**: Core fixing logic that normalizes line endings, applies global fixes once, then iteratively applies local fixes until convergence or max iterations. Detects fix cycles using hash history.

#### 58. `fix_file` Function

**Function**: Fix PEP 8 violations in a file.

**Function Signature**:
```python
def fix_file(filename, options=None, output=None, apply_config=False):
```

**Parameters**:
- `filename` (str): Path to file to fix
- `options` (Namespace, optional): Options for fixing
- `output` (file, optional): Output file handle for results
- `apply_config` (bool, optional): Whether to apply config (default: False)

**Returns**:
- `str`, `bytes`, or `None`: Fixed source code, diff output (str or bytes), or None depending on options and whether changes were made

**Description**: High-level function to fix a single file. Handles file reading, encoding detection, fixing, and writing back (if in-place) or generating diffs.

#### 59. `global_fixes` Function

**Function**: Discover and yield all global fix functions.

**Function Signature**:
```python
def global_fixes():
```

**Parameters**: None

**Returns**:
- `generator`: Yields (code, function) tuples for each global fix

**Description**: Searches the module's globals for functions that start with 'fix_' and have 'source' as the first parameter. Extracts the error code from the function name and yields code-function pairs.

#### 60. `_get_parameters` Function

**Function**: Extract parameter names from a function.

**Function Signature**:
```python
def _get_parameters(function):
```

**Parameters**:
- `function` (callable): Function to inspect

**Returns**:
- `list`: List of parameter names

**Description**: Uses inspect module to get parameter names from a function. Handles differences between Python 2 and 3. For methods, excludes 'self' to match getargspec behavior.

#### 61. `apply_global_fixes` Function

**Function**: Apply global fixes that only need to run once on entire source.

**Function Signature**:
```python
def apply_global_fixes(source, options, where='global', filename='', codes=None):
```

**Parameters**:
- `source` (str): Source code to fix
- `options` (Namespace): Options object with fix settings
- `where` (str, optional): Fix location context (default: 'global')
- `filename` (str, optional): Filename for context (default: '')
- `codes` (list, optional): List of error codes to fix (default: None)

**Returns**:
- `str`: Source code with global fixes applied

**Description**: Applies fixes that don't depend on pycodestyle errors, such as reindentation, normalization of line endings, and removal of trailing whitespace. These run once before iterative local fixes.

#### 62. `extract_code_from_function` Function

**Function**: Extract the PEP 8 error code from a fix function's name.

**Function Signature**:
```python
def extract_code_from_function(function):
```

**Parameters**:
- `function` (callable): Function to extract code from

**Returns**:
- `str`: Error code (e.g., 'e501') or None if not a fix function

**Description**: Parses function names like 'fix_e501' to extract the error code 'e501'. Returns None if function doesn't follow the naming convention or code is invalid.

#### 63. `_get_package_version` Function

**Function**: Get version information for dependent packages.

**Function Signature**:
```python
def _get_package_version():
```

**Parameters**: None

**Returns**:
- `str`: Comma-separated string of package versions (e.g., 'pycodestyle: 2.10.0')

**Description**: Returns version information for pycodestyle and other dependencies. Used in --version output to show which versions of dependencies are being used.

#### 64. `create_parser` Function

**Function**: Create and configure command-line argument parser.

**Function Signature**:
```python
def create_parser():
```

**Parameters**: None

**Returns**:
- `ArgumentParser`: Configured argparse parser with all autopep8 options

**Description**: Creates argparse parser with all command-line options including verbose, diff, in-place, max-line-length, aggressive, select, ignore, etc. Defines default values and help text for each option.

#### 65. `_expand_codes` Function

**Function**: Expand error code patterns to individual codes and handle conflicts.

**Function Signature**:
```python
def _expand_codes(codes, ignore_codes):
```

**Parameters**:
- `codes` (list): List of error code patterns to expand
- `ignore_codes` (list): List of codes to ignore

**Returns**:
- `set`: Set of individual error codes

**Description**: Expands prefixes like 'E' to all E-codes, 'W5' to W50x codes, etc. Detects conflicting codes (W503/W504) and handles them appropriately. Returns individual error codes.

#### 66. `_parser_error_with_code` Function

**Function**: Display parser error message with a specific exit code.

**Function Signature**:
```python
def _parser_error_with_code(parser: argparse.ArgumentParser, code: int, msg: str) -> None:
```

**Parameters**:
- `parser` (ArgumentParser): Argument parser object
- `code` (int): Exit code to use
- `msg` (str): Error message to display

**Returns**:
- `None`: Function exits the program

**Description**: Prints usage information to stderr, displays the error message, and exits with the specified code. Wrapper around parser.error() with custom exit code support.

#### 67. `parse_args` Function

**Function**: Parse and validate command-line arguments.

**Function Signature**:
```python
def parse_args(arguments, apply_config=False):
```

**Parameters**:
- `arguments` (list): Command-line arguments to parse
- `apply_config` (bool, optional): Whether to read and apply config files (default: False)

**Returns**:
- `Namespace`: Parsed and validated arguments

**Description**: Parses command-line arguments using argparse. Validates file arguments, decodes filenames, reads config files if enabled, and expands select/ignore codes. Handles pyproject.toml and setup.cfg configuration.

#### 68. `_get_normalize_options` Function

**Function**: Normalize and convert config file options to argument types.

**Function Signature**:
```python
def _get_normalize_options(args, config, section, option_list):
```

**Parameters**:
- `args` (Namespace): Parsed arguments object
- `config` (ConfigParser): Configuration file parser
- `section` (str): Config section to read
- `option_list` (dict): Dict mapping option names to expected types

**Returns**:
- `None`: Modifies args in-place

**Description**: Reads options from config file section, normalizes option names (converts dashes to underscores), validates types, and sets values on args object. Handles special cases like "auto" values.

#### 69. `read_config` Function

**Function**: Read configuration from setup.cfg or other config files.

**Function Signature**:
```python
def read_config(args, parser):
```

**Parameters**:
- `args` (Namespace): Parsed arguments
- `parser` (ArgumentParser): Argument parser for validation

**Returns**:
- `ArgumentParser`: Updated parser with config applied

**Description**: Reads global config and local project config files. Searches parent directories for config files. Normalizes and applies config options to args. Supports both global and local configuration.

#### 70. `read_pyproject_toml` Function

**Function**: Read configuration from pyproject.toml file.

**Function Signature**:
```python
def read_pyproject_toml(args, parser):
```

**Parameters**:
- `args` (Namespace): Parsed arguments
- `parser` (ArgumentParser): Argument parser for validation

**Returns**:
- `ArgumentParser`: Updated parser with config applied

**Description**: Reads pyproject.toml using tomllib (Python 3.11+) or tomli. Looks for [tool.autopep8] section. Searches parent directories for pyproject.toml files. Applies configuration options to args.

#### 71. `_split_comma_separated` Function

**Function**: Split a comma-separated string into a set of stripped strings.

**Function Signature**:
```python
def _split_comma_separated(string):
```

**Parameters**:
- `string` (str): Comma-separated string to split

**Returns**:
- `set`: Set of non-empty stripped strings

**Description**: Splits input on commas, strips whitespace from each part, and returns a set of non-empty results. Used for parsing comma-separated lists in config files and command-line options.

#### 72. `decode_filename` Function

**Function**: Convert filename to Unicode string.

**Function Signature**:
```python
def decode_filename(filename):
```

**Parameters**:
- `filename` (str or bytes): Filename to decode

**Returns**:
- `str`: Unicode filename string

**Description**: Converts byte filenames to Unicode using the filesystem encoding. Returns str filenames unchanged. Handles cross-platform filename encoding differences.

#### 73. `supported_fixes` Function

**Function**: Generate list of all PEP 8 error codes that autopep8 can fix.

**Function Signature**:
```python
def supported_fixes():
```

**Parameters**: None

**Returns**:
- `generator`: Yields (code, description) tuples for each supported fix

**Description**: Discovers all fixable error codes by inspecting FixPEP8 class methods and global fix functions. Returns code and a summary description extracted from the fix function's docstring.

#### 74. `docstring_summary` Function

**Function**: Extract the first line summary from a docstring.

**Function Signature**:
```python
def docstring_summary(docstring):
```

**Parameters**:
- `docstring` (str): Docstring to summarize

**Returns**:
- `str`: First line of docstring, or empty string if None

**Description**: Returns the first line of a docstring as a summary. Used to generate short descriptions for error codes in help output and listings.

#### 75. `line_shortening_rank` Function

**Function**: Calculate a ranking score for a line shortening candidate.

**Function Signature**:
```python
def line_shortening_rank(candidate, indent_word, max_line_length, experimental=False):
```

**Parameters**:
- `candidate` (str): Candidate shortened code
- `indent_word` (str): Indentation string used
- `max_line_length` (int): Maximum allowed line length
- `experimental` (bool, optional): Use experimental ranking (default: False)

**Returns**:
- `int`: Rank score (lower is better)

**Description**: Heuristically scores line shortening candidates considering factors like line length violations, consistency, standard deviation of line lengths, and presence of arithmetic operators. Used to select the best reformatting option.

#### 76. `standard_deviation` Function

**Function**: Calculate the standard deviation of a sequence of numbers.

**Function Signature**:
```python
def standard_deviation(numbers):
```

**Parameters**:
- `numbers` (iterable): Sequence of numbers

**Returns**:
- `float`: Standard deviation, or 0 if sequence is empty

**Description**: Computes the standard deviation using the formula sqrt(sum((x-mean)^2)/n). Used in line shortening ranking to prefer consistent line lengths.

#### 77. `has_arithmetic_operator` Function

**Function**: Check if a line contains arithmetic operators.

**Function Signature**:
```python
def has_arithmetic_operator(line):
```

**Parameters**:
- `line` (str): Line of code to check

**Returns**:
- `bool`: True if line contains arithmetic operators (+, -, *, /, etc.), False otherwise

**Description**: Checks for presence of arithmetic operators defined in pycodestyle.ARITHMETIC_OP. Used in line shortening heuristics to avoid breaking arithmetic expressions unnecessarily.

#### 78. `count_unbalanced_brackets` Function

**Function**: Count unmatched opening and closing brackets in a line.

**Function Signature**:
```python
def count_unbalanced_brackets(line):
```

**Parameters**:
- `line` (str): Line to analyze

**Returns**:
- `int`: Total number of unbalanced brackets (parentheses, square, curly)

**Description**: Counts the absolute difference between opening and closing brackets for (), [], and {}. Returns the sum of unbalanced counts. Higher values indicate incomplete expressions.

#### 79. `split_at_offsets` Function

**Function**: Split a line at multiple character offsets.

**Function Signature**:
```python
def split_at_offsets(line, offsets):
```

**Parameters**:
- `line` (str): Line to split
- `offsets` (list): List of character positions to split at

**Returns**:
- `list`: List of string segments

**Description**: Splits a line at specified character positions. Offsets are sorted automatically. Returns list of substrings including segments before first offset and after last offset.

#### 80. `match_file` Function

**Function**: Check if a file should be processed based on exclude patterns.

**Function Signature**:
```python
def match_file(filename, exclude):
```

**Parameters**:
- `filename` (str): File path to check
- `exclude` (list): List of glob patterns to exclude

**Returns**:
- `bool`: True if file should be processed, False if it should be excluded

**Description**: Returns False for hidden files (starting with '.') and files matching any exclude pattern. Patterns can match basename or full path. Used to filter files during recursive directory processing.

#### 81. `find_files` Function

**Function**: Recursively find Python files to process.

**Function Signature**:
```python
def find_files(filenames, recursive, exclude):
```

**Parameters**:
- `filenames` (list): List of file/directory paths to process
- `recursive` (bool): Whether to recursively search directories
- `exclude` (list): List of glob patterns to exclude

**Returns**:
- `generator`: Yields file paths to process

**Description**: Expands directories recursively if enabled, filtering files and directories based on exclude patterns. Yields individual file paths. Modifies filenames list in-place during processing.

#### 82. `_fix_file` Function

**Function**: Helper wrapper for fixing a file, potentially in parallel.

**Function Signature**:
```python
def _fix_file(parameters):
```

**Parameters**:
- `parameters` (tuple): Tuple of (filename, options) for fix_file()

**Returns**:
- `str or None`: Result from fix_file()

**Description**: Wraps fix_file() for use with multiprocessing.Pool. Prints verbose output if enabled and handles IOError exceptions. Used for parallel file processing.

#### 83. `fix_multiple_files` Function

**Function**: Fix multiple files, optionally in parallel and recursively.

**Function Signature**:
```python
def fix_multiple_files(filenames, options, output=None):
```

**Parameters**:
- `filenames` (list): List of files/directories to fix
- `options` (Namespace): Options including recursive, jobs, exclude settings
- `output` (file, optional): Output stream (default: None)

**Returns**:
- `list`: List of results from each file fix

**Description**: Processes multiple files sequentially or in parallel using multiprocessing.Pool if jobs > 1. Handles recursive directory traversal and file filtering. Returns results from all file fixes.

#### 84. `is_python_file` Function

**Function**: Determine if a file is a Python source file.

**Function Signature**:
```python
def is_python_file(filename):
```

**Parameters**:
- `filename` (str): Path to file to check

**Returns**:
- `bool`: True if file is Python source, False otherwise

**Description**: Checks for .py extension or Python shebang (#!...python) in first line. Reads only the first few bytes for efficiency. Used to filter files when processing directories.

#### 85. `is_probably_part_of_multiline` Function

**Function**: Check if a line is likely part of a multiline string.

**Function Signature**:
```python
def is_probably_part_of_multiline(line):
```

**Parameters**:
- `line` (str): Line to check

**Returns**:
- `bool`: True if line appears to be in a multiline string, False otherwise

**Description**: Detects triple quotes (""" or ''') or line continuation backslashes. Used to avoid fixing errors reported at multiline string boundaries where the actual issue is elsewhere.

#### 86. `wrap_output` Function

**Function**: Wrap output stream with specified encoding.

**Function Signature**:
```python
def wrap_output(output, encoding):
```

**Parameters**:
- `output` (file): Output stream to wrap
- `encoding` (str): Encoding to use

**Returns**:
- `file`: Wrapped output stream with encoding

**Description**: Wraps output stream with codecs.getwriter() to handle the specified encoding. Accesses .buffer attribute if available (Python 3) for proper binary/text handling.

#### 87. `get_encoding` Function

**Function**: Get the preferred system encoding.

**Function Signature**:
```python
def get_encoding():
```

**Parameters**: None

**Returns**:
- `str`: Preferred encoding name (e.g., 'utf-8')

**Description**: Returns the locale's preferred encoding or falls back to Python's default encoding if locale encoding is unavailable. Used for console output encoding.

#### 88. `main` Function  

**Function**: Main command-line entry point for autopep8.

**Function Signature**:
```python
def main(argv=None, apply_config=True):
```

**Parameters**:
- `argv` (list, optional): Command-line arguments (default: sys.argv)
- `apply_config` (bool, optional): Whether to apply config files (default: True)

**Returns**:
- `int`: Exit code (0 for success, non-zero for errors)

**Description**: Parses arguments, handles --list-fixes option, reads from stdin if no files specified, processes files (single or multiple), generates diffs if requested, and returns appropriate exit codes. Handles SIGPIPE on Unix systems.

#### 89. `split_readme` Function (update_readme.py)

**Function**: Split README file into sections for updating.

**Function Signature**:
```python
def split_readme(readme_path, before_key, after_key, options_key, end_key):
```

**Parameters**:
- `readme_path` (str): Path to README file
- `before_key` (str): Marker before section to update
- `after_key` (str): Marker after section to update
- `options_key` (str): Marker for options section
- `end_key` (str): Marker at end of section

**Returns**:
- `tuple`: (top, before, bottom) - three README sections

**Description**: Splits README into three parts using marker strings. Used to update specific sections of README (like supported fixes list) while preserving other content. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

#### 90. `indent_line` Function (update_readme.py)

**Function**: Indent a single line by four spaces.

**Function Signature**:
```python
def indent_line(line):
```

**Parameters**:
- `line` (str): Line to indent

**Returns**:
- `str`: Indented line (or empty line unchanged)

**Description**: Adds four spaces to the beginning of non-empty lines. Empty lines are returned unchanged. Used for formatting code examples in documentation. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

#### 91. `indent` Function (update_readme.py)

**Function**: Indent entire text block by four spaces.

**Function Signature**:
```python
def indent(text):
```

**Parameters**:
- `text` (str): Text to indent

**Returns**:
- `str`: Text with all non-empty lines indented by four spaces

**Description**: Splits text into lines and indents each non-empty line using `indent_line()`. Joins lines back with newlines. Used for formatting code blocks in README examples. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

#### 92. `help_message` Function (update_readme.py)

**Function**: Generate autopep8 help message string.

**Function Signature**:
```python
def help_message():
```

**Parameters**: None

**Returns**:
- `str`: Help message text with home directory paths normalized

**Description**: Creates autopep8 argument parser and captures its help output. Replaces expanded home directory paths with '~' for consistency. Used to update README with current help text. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

#### 93. `check` Function (update_readme.py)

**Function**: Validate Python code syntax and run pyflakes checks.

**Function Signature**:
```python
def check(source):
```

**Parameters**:
- `source` (str): Python source code to check

**Returns**:
- `None`: Raises exception if code has errors

**Description**: Compiles source code to check syntax, then runs pyflakes static analysis to detect potential errors like undefined variables. Used to verify README example code is valid. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

#### 94. `main` Function (update_readme.py)

**Function**: Update README.rst with current autopep8 examples and help text.

**Function Signature**:
```python
def main():
```

**Parameters**: None

**Returns**:
- `None`: Writes updated README to file

**Description**: Reads README.rst, extracts example code, runs autopep8 on it to generate "after" examples, validates output code, updates help text and supported fixes list, and writes the updated README. Ensures documentation stays synchronized with code. **Note**: This function is located in `autopep8/update_readme.py`, not in the main `autopep8.py` file.

### Core Constants

#### 1. `CR` Constant

**Constant**: Carriage return character.

**Value**: `'\r'`

**Description**: Represents the carriage return character (ASCII 13). Used for handling different line ending formats, particularly for Windows-style line endings when combined with LF.

#### 2. `LF` Constant

**Constant**: Line feed character.

**Value**: `'\n'`

**Description**: Represents the line feed character (ASCII 10). Standard Unix/Linux line ending character. Used throughout autopep8 for line break detection and normalization.

#### 3. `CRLF` Constant

**Constant**: Carriage return + line feed sequence.

**Value**: `'\r\n'`

**Description**: Represents Windows-style line endings (carriage return followed by line feed). Used for detecting and normalizing Windows line endings in Python files.

#### 4. `PYTHON_SHEBANG_REGEX` Constant

**Constant**: Regular expression to match Python shebang lines.

**Value**: `re.compile(r'^#!.*\bpython[23]?\b\s*$')`

**Description**: Compiled regex pattern that matches shebang lines pointing to Python interpreters (python, python2, python3). Used to detect Python files by their shebang line rather than file extension.

#### 5. `LAMBDA_REGEX` Constant

**Constant**: Regular expression to match lambda function assignments.

**Value**: `re.compile(r'([\w.]+)\s=\slambda\s*([)(=\w,\s.]*):')`

**Description**: Compiled regex pattern that matches lambda function assignments in the format `variable = lambda args:`. Used for detecting and potentially refactoring lambda expressions to regular functions.

#### 6. `COMPARE_NEGATIVE_REGEX` Constant

**Constant**: Regular expression to match negative comparison patterns.

**Value**: `re.compile(r'\b(not)\s+([^][)(}{]+?)\s+(in|is)\s')`

**Description**: Compiled regex pattern that matches "not ... in" or "not ... is" comparison patterns. Used for detecting and potentially refactoring negative comparisons to more Pythonic forms like "not in" or "is not".

#### 7. `COMPARE_NEGATIVE_REGEX_THROUGH` Constant

**Constant**: Regular expression to match "not in" and "is not" patterns.

**Value**: `re.compile(r'\b(not\s+in|is\s+not)\s')`

**Description**: Compiled regex pattern that matches "not in" and "is not" comparison operators. Used for detecting proper negative comparison syntax that should be preserved.

#### 8. `BARE_EXCEPT_REGEX` Constant

**Constant**: Regular expression to match bare except clauses.

**Value**: `re.compile(r'except\s*:')`

**Description**: Compiled regex pattern that matches bare except clauses (except without specifying exception types). Used for detecting potentially problematic exception handling that should specify exception types.

#### 9. `STARTSWITH_DEF_REGEX` Constant

**Constant**: Regular expression to match function definitions.

**Value**: `re.compile(r'^(async\s+def|def)\s.*\):')`

**Description**: Compiled regex pattern that matches both regular function definitions (`def`) and async function definitions (`async def`). Used for detecting function boundaries and analyzing function structure.

#### 10. `DOCSTRING_START_REGEX` Constant

**Constant**: Regular expression to match docstring beginnings.

**Value**: `re.compile(r'^u?r?(?P<kind>["\']{3})')`

**Description**: Compiled regex pattern that matches the start of docstrings, including optional 'u' (unicode) and 'r' (raw) prefixes, followed by triple quotes. Used for detecting and preserving docstring formatting.

#### 11. `ENABLE_REGEX` Constant

**Constant**: Regular expression to match autopep8 enable comments.

**Value**: `re.compile(r'# *(fmt|autopep8): *on')`

**Description**: Compiled regex pattern that matches comments enabling autopep8 formatting (e.g., `# autopep8: on` or `# fmt: on`). Used to detect regions where formatting should be re-enabled after being disabled.

#### 12. `DISABLE_REGEX` Constant

**Constant**: Regular expression to match autopep8 disable comments.

**Value**: `re.compile(r'# *(fmt|autopep8): *off')`

**Description**: Compiled regex pattern that matches comments disabling autopep8 formatting (e.g., `# autopep8: off` or `# fmt: off`). Used to detect regions where formatting should be disabled.

#### 13. `ENCODING_MAGIC_COMMENT` Constant

**Constant**: Regular expression to match Python encoding declarations.

**Value**: `re.compile(r'^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)')`

**Description**: Compiled regex pattern that matches Python encoding magic comments (e.g., `# coding: utf-8` or `# -*- coding: utf-8 -*-`). Used for detecting and preserving file encoding declarations.

#### 14. `COMPARE_TYPE_REGEX` Constant

**Constant**: Regular expression to match type comparison patterns.

**Value**: `re.compile(r'([=!]=)\s+type(?:\s*\(\s*([^)]*[^ )])\s*\))|\btype(?:\s*\(\s*([^)]*[^ )])\s*\))\s+([=!]=)')`

**Description**: Compiled regex pattern that matches type comparison expressions like `== type(obj)` or `type(obj) ==`. Used for detecting potentially problematic type comparisons that should use `isinstance()` instead.

#### 15. `TYPE_REGEX` Constant

**Constant**: Regular expression to match type() function calls.

**Value**: `re.compile(r'(type\s*\(\s*[^)]*?[^\s)]\s*\))')`

**Description**: Compiled regex pattern that matches `type()` function calls. Used for detecting type checking patterns that might need refactoring to use `isinstance()` for better Pythonic code.

#### 16. `EXIT_CODE_OK` Constant

**Constant**: Exit code for successful execution.

**Value**: `0`

**Description**: Standard exit code indicating successful completion of autopep8 processing. Used as return value when all operations complete without errors.

#### 17. `EXIT_CODE_ERROR` Constant

**Constant**: Exit code for general errors.

**Value**: `1`

**Description**: Exit code indicating that an error occurred during autopep8 processing. Used for various error conditions like file I/O errors or processing failures.

#### 18. `EXIT_CODE_EXISTS_DIFF` Constant

**Constant**: Exit code when differences exist (diff mode).

**Value**: `2`

**Description**: Exit code indicating that autopep8 found differences and would modify the code (used in diff mode). Allows scripts to detect if files need formatting changes.

#### 19. `EXIT_CODE_ARGPARSE_ERROR` Constant

**Constant**: Exit code for argument parsing errors.

**Value**: `99`

**Description**: Exit code indicating that command-line argument parsing failed. Used when invalid arguments are provided to the autopep8 command-line interface.

#### 20. `SHORTEN_OPERATOR_GROUPS` Constant

**Constant**: Groups of operators for line shortening optimization.

**Value**: `frozenset([frozenset([',']), frozenset(['%']), frozenset([',', '(', '[', '{']), frozenset(['%', '(', '[', '{']), frozenset([',', '(', '[', '{', '%', '+', '-', '*', '/', '//']), frozenset(['%', '+', '-', '*', '/', '//'])])`

**Description**: Frozen set containing groups of operators that can be used together for line shortening. Each inner frozenset represents a group of operators that can be split across lines. Used by the line shortening algorithm to determine optimal break points.

#### 21. `DEFAULT_IGNORE` Constant

**Constant**: Default PEP 8 error codes to ignore.

**Value**: `'E226,E24,W50,W690'`

**Description**: Comma-separated string of PEP 8 error codes that are ignored by default. Includes E226 (missing whitespace around arithmetic operators), E24 (whitespace before '['), W50 (line too long), and W690 (line too long). Used as fallback when no ignore list is specified.

#### 22. `DEFAULT_INDENT_SIZE` Constant

**Constant**: Default indentation size in spaces.

**Value**: `4`

**Description**: Standard indentation size used by autopep8 when no specific indentation is specified. Represents 4 spaces, which is the PEP 8 recommended indentation size.

#### 23. `CONFLICTING_CODES` Constant

**Constant**: Tuple of conflicting PEP 8 error codes.

**Value**: `('W503', 'W504')`

**Description**: Tuple containing PEP 8 error codes that conflict with each other. W503 (line break before binary operator) and W504 (line break after binary operator) are mutually exclusive. When both would be enabled, both are disabled to avoid conflicts.

#### 24. `PROJECT_CONFIG` Constant

**Constant**: Tuple of project configuration file names.

**Value**: `('setup.cfg', 'tox.ini', '.pep8', '.flake8')`

**Description**: Tuple containing names of configuration files that autopep8 searches for in project directories. These files can contain autopep8 configuration settings. Searched in order of preference.

#### 25. `MAX_PYTHON_FILE_DETECTION_BYTES` Constant

**Constant**: Maximum bytes to read for Python file detection.

**Value**: `1024`

**Description**: Maximum number of bytes to read from the beginning of a file to determine if it's a Python file. Used for efficient file type detection without reading entire files.

#### 26. `IS_SUPPORT_TOKEN_FSTRING` Constant

**Constant**: Boolean indicating f-string token support.

**Value**: `True` (Python 3.12+) or `False` (older versions)

**Description**: Runtime boolean indicating whether the current Python version supports f-string tokens properly. Set to `True` for Python 3.12+ and `False` for older versions. Used to enable/disable f-string related features.

### Core Classes

#### 1. `FixPEP8` Class

**Function**: Fix PEP 8 violations in Python code by applying various formatting rules.

**Class Signature**:
```python
class FixPEP8(object):
    def __init__(self, filename, options, contents=None, long_line_ignore_cache=None)
    def fix(self) -> str
    def _fix_source(self, results) -> str
    def _check_affected_anothers(self, result) -> bool
    def _fix_reindent(self, result) -> List[int]
    def fix_e112(self, result)
    def fix_e113(self, result)
    def fix_e116(self, result)
    def fix_e117(self, result)
    def fix_e125(self, result) -> List[int]
    def fix_e131(self, result)
    def fix_e201(self, result)
    def fix_e224(self, result)
    def fix_e225(self, result)
    def fix_e231(self, result)
    def fix_e251(self, result)
    def fix_e262(self, result)
    def fix_e265(self, result)
    def fix_e266(self, result)
    def fix_e271(self, result)
    def fix_e301(self, result)
    def fix_e302(self, result)
    def fix_e303(self, result)
    def fix_e304(self, result)
    def fix_e305(self, result)
    def fix_e401(self, result)
    def fix_e402(self, result)
    def fix_long_line_logically(self, result, logical) -> List[int]
    def fix_long_line_physically(self, result) -> List[int]
    def fix_long_line(self, target, previous_line, next_line, original) -> str
    def fix_e502(self, result)
    def fix_e701(self, result)
    def fix_e702(self, result, logical)
    def fix_e704(self, result)
    def fix_e711(self, result)
    def fix_e712(self, result)
    def fix_e713(self, result)
    def fix_e714(self, result)
    def fix_e721(self, result)
    def fix_e722(self, result)
    def fix_e731(self, result)
    def fix_w291(self, result)
    def fix_w391(self, _)
    def fix_w503(self, result)
    def fix_w504(self, result)
    def fix_w605(self, result)
```

**Key Methods**:

**Constructor and Main Methods**:
- `__init__(filename, options, contents=None, long_line_ignore_cache=None)`: 
  - **Parameters**: 
    - `filename` (str): Path to the source file
    - `options` (Options): Configuration options for formatting
    - `contents` (str, optional): Source code content as string
    - `long_line_ignore_cache` (set, optional): Cache for ignored long lines
  - **Function**: Initialize the fixer with source code and options, collect import statements, set up method aliases
  - **Returns**: None

- `fix()`: 
  - **Parameters**: None
  - **Function**: Main method that executes pycodestyle checks and applies all fixes
  - **Returns**: str - Fixed source code as a string

- `_fix_source(results)`: 
  - **Parameters**: `results` (list): List of pycodestyle error results
  - **Function**: Internal method that applies all fixes based on pycodestyle results
  - **Returns**: None (modifies self.source in place)

**Indentation Fix Methods**:
- `_fix_reindent(result)`: 
  - **Parameters**: `result` (dict): Error information from pycodestyle
  - **Function**: Fix badly indented lines by adjusting initial indent
  - **Returns**: None (modifies self.source in place)

- `fix_e112(result)`: 
  - **Parameters**: `result` (dict): Error information for E112 (under-indented comments)
  - **Function**: Fix under-indented comments by adding proper indentation
  - **Returns**: None (modifies self.source in place)

- `fix_e113(result)`: 
  - **Parameters**: `result` (dict): Error information for E113 (unexpected indentation)
  - **Function**: Fix unexpected indentation by removing one level
  - **Returns**: None (modifies self.source in place)

- `fix_e116(result)`: 
  - **Parameters**: `result` (dict): Error information for E116 (over-indented comments)
  - **Function**: Fix over-indented comments by removing excess indentation
  - **Returns**: None (modifies self.source in place)

- `fix_e117(result)`: 
  - **Parameters**: `result` (dict): Error information for E117 (over-indented)
  - **Function**: Fix over-indented lines by removing one level of indentation
  - **Returns**: None (modifies self.source in place)

- `fix_e125(result)`: 
  - **Parameters**: `result` (dict): Error information for E125 (indentation undistinguishable)
  - **Function**: Fix indentation to distinguish from next logical line
  - **Returns**: None (modifies self.source in place)

- `fix_e131(result)`: 
  - **Parameters**: `result` (dict): Error information for E131 (hanging indent)
  - **Function**: Fix hanging indent for unaligned continuation lines
  - **Returns**: None (modifies self.source in place)

**Whitespace Fix Methods**:
- `fix_e201(result)`: 
  - **Parameters**: `result` (dict): Error information for E201 (whitespace after bracket)
  - **Function**: Remove extraneous whitespace after opening brackets
  - **Returns**: None (modifies self.source in place)

- `fix_e224(result)`: 
  - **Parameters**: `result` (dict): Error information for E224 (whitespace around operator)
  - **Function**: Remove extraneous whitespace around operators
  - **Returns**: None (modifies self.source in place)

- `fix_e225(result)`: 
  - **Parameters**: `result` (dict): Error information for E225 (missing whitespace around operator)
  - **Function**: Add missing whitespace around operators
  - **Returns**: None (modifies self.source in place)

- `fix_e231(result)`: 
  - **Parameters**: `result` (dict): Error information for E231 (missing whitespace)
  - **Function**: Add missing whitespace after commas
  - **Returns**: None (modifies self.source in place)

- `fix_e251(result)`: 
  - **Parameters**: `result` (dict): Error information for E251 (whitespace around parameter equals)
  - **Function**: Remove whitespace around parameter '=' signs
  - **Returns**: None (modifies self.source in place)

**Import Fix Methods**:
- `fix_e401(result)`: 
  - **Parameters**: `result` (dict): Error information for E401 (multiple imports on one line)
  - **Function**: Fix multiple imports on one line by separating them
  - **Returns**: None (modifies self.source in place)

- `fix_e402(result)`: 
  - **Parameters**: `result` (dict): Error information for E402 (module level import not at top)
  - **Function**: Move module level imports to the top of the file
  - **Returns**: None (modifies self.source in place)

**Long Line Fix Methods**:
- `fix_long_line_logically(result, logical)`: 
  - **Parameters**: 
    - `result` (dict): Error information for long line
    - `logical` (str): Logical line content
  - **Function**: Fix long lines using logical line analysis and smart line breaking
  - **Returns**: list - Modified line numbers or empty list

- `fix_long_line_physically(result)`: 
  - **Parameters**: `result` (dict): Error information for long line
  - **Function**: Fix long lines using physical line analysis
  - **Returns**: list - Modified line numbers or empty list

- `fix_long_line(target, previous_line, next_line, original)`: 
  - **Parameters**: 
    - `target` (str): Target line to fix
    - `previous_line` (str): Previous line content
    - `next_line` (str): Next line content
    - `original` (str): Original line content
  - **Function**: Core method for fixing long lines using various strategies
  - **Returns**: str - Fixed line or None if no fix possible

**Other Fix Methods**:
- `fix_e502(result)`: 
  - **Parameters**: `result` (dict): Error information for E502 (extraneous escape of newline)
  - **Function**: Remove extraneous escape of newline characters
  - **Returns**: None (modifies self.source in place)

- `fix_e701(result)`: 
  - **Parameters**: `result` (dict): Error information for E701 (multiple statements on one line)
  - **Function**: Fix multiple statements on one line
  - **Returns**: None (modifies self.source in place)

- `fix_e702(result, logical)`: 
  - **Parameters**: 
    - `result` (dict): Error information for E702 (multiple statements on one line)
    - `logical` (str): Logical line content
  - **Function**: Fix multiple statements on one line using logical analysis
  - **Returns**: None (modifies self.source in place)

- `fix_e711(result)`: 
  - **Parameters**: `result` (dict): Error information for E711 (comparison to None)
  - **Function**: Fix comparison to None using 'is' instead of '=='
  - **Returns**: None (modifies self.source in place)

- `fix_e712(result)`: 
  - **Parameters**: `result` (dict): Error information for E712 (comparison to True/False)
  - **Function**: Fix comparison to True/False using 'is' instead of '=='
  - **Returns**: None (modifies self.source in place)

- `fix_e713(result)`: 
  - **Parameters**: `result` (dict): Error information for E713 (test for membership)
  - **Function**: Fix test for membership using 'not in' instead of 'not ... in'
  - **Returns**: None (modifies self.source in place)

- `fix_e714(result)`: 
  - **Parameters**: `result` (dict): Error information for E714 (test for object identity)
  - **Function**: Fix test for object identity using 'is not' instead of 'not ... is'
  - **Returns**: None (modifies self.source in place)

- `fix_e721(result)`: 
  - **Parameters**: `result` (dict): Error information for E721 (do not compare types)
  - **Function**: Fix type comparisons using isinstance() instead of type()
  - **Returns**: None (modifies self.source in place)

- `fix_e722(result)`: 
  - **Parameters**: `result` (dict): Error information for E722 (do not use bare except)
  - **Function**: Fix bare except clauses by adding specific exception types
  - **Returns**: None (modifies self.source in place)

- `fix_e731(result)`: 
  - **Parameters**: `result` (dict): Error information for E731 (do not assign a lambda expression)
  - **Function**: Fix lambda expressions by converting to def statements
  - **Returns**: None (modifies self.source in place)

**Warning Fix Methods**:
- `fix_w291(result)`: 
  - **Parameters**: `result` (dict): Error information for W291 (trailing whitespace)
  - **Function**: Remove trailing whitespace from lines
  - **Returns**: None (modifies self.source in place)

- `fix_w391(result)`: 
  - **Parameters**: `result` (dict): Error information for W391 (blank line at end of file)
  - **Function**: Add blank line at end of file
  - **Returns**: None (modifies self.source in place)

- `fix_w503(result)`: 
  - **Parameters**: `result` (dict): Error information for W503 (line break before binary operator)
  - **Function**: Fix line break placement before binary operators
  - **Returns**: None (modifies self.source in place)

- `fix_w504(result)`: 
  - **Parameters**: `result` (dict): Error information for W504 (line break after binary operator)
  - **Function**: Fix line break placement after binary operators
  - **Returns**: None (modifies self.source in place)

- `fix_w605(result)`: 
  - **Parameters**: `result` (dict): Error information for W605 (invalid escape sequence)
  - **Function**: Fix invalid escape sequences in strings
  - **Returns**: None (modifies self.source in place)

**Returns**: Fixed source code string when calling `fix()` method.

#### 2. `ReformattedLines` Class

**Function**: Manage reformatted code lines by breaking code into atomic units for rearrangement.

**Class Signature**:
```python
class ReformattedLines(object):
    def __init__(self, max_line_length)
    def __repr__(self) -> str
    def add(self, obj, indent_amt, break_after_open_bracket)
    def add_comment(self, item)
    def add_indent(self, indent_amt)
    def add_line_break(self, indent)
    def add_line_break_at(self, index, indent_amt)
    def add_space_if_needed(self, curr_text, equal=False)
    def previous_item(self) -> Atom
    def fits_on_current_line(self, item_extent) -> bool
    def current_size(self) -> int
    def line_empty(self) -> bool
    def emit(self) -> str
    def _add_item(self, item, indent_amt)
    def _add_container(self, container, indent_amt, break_after_open_bracket)
    def _prevent_default_initializer_splitting(self, item, indent_amt)
    def _split_after_delimiter(self, item, indent_amt)
    def _enforce_space(self, item)
    def _delete_whitespace(self)
```

**Key Methods**:

**Constructor and Core Methods**:
- `__init__(max_line_length)`: 
  - **Parameters**: `max_line_length` (int): Maximum allowed line length
  - **Function**: Initialize the formatter with line length constraint and internal state
  - **Returns**: None

- `add(obj, indent_amt, break_after_open_bracket)`: 
  - **Parameters**: 
    - `obj` (Atom or Container): Object to add to formatted lines
    - `indent_amt` (int): Amount of indentation to apply
    - `break_after_open_bracket` (bool): Whether to break after opening bracket
  - **Function**: Add an object (Atom or Container) to the formatted lines with proper handling
  - **Returns**: None

- `emit()`: 
  - **Parameters**: None
  - **Function**: Return the formatted code as a string with proper line endings
  - **Returns**: str - Formatted code string

**Line Management Methods**:
- `add_comment(item)`: 
  - **Parameters**: `item` (Atom): Comment atom to add
  - **Function**: Add a comment with proper spacing (2 spaces before comment)
  - **Returns**: None

- `add_indent(indent_amt)`: 
  - **Parameters**: `indent_amt` (int): Amount of indentation to add
  - **Function**: Add indentation to the current line
  - **Returns**: None

- `add_line_break(indent)`: 
  - **Parameters**: `indent` (str): Indentation string to apply after line break
  - **Function**: Add a line break with specified indentation
  - **Returns**: None

- `add_line_break_at(index, indent_amt)`: 
  - **Parameters**: 
    - `index` (int): Position to insert line break
    - `indent_amt` (int): Amount of indentation to add
  - **Function**: Insert a line break at specific position with indentation
  - **Returns**: None

- `add_space_if_needed(curr_text, equal=False)`: 
  - **Parameters**: 
    - `curr_text` (str): Current text to potentially add space before
    - `equal` (bool): Whether this is an equals sign (special spacing rules)
  - **Function**: Add space before current text if needed based on context and spacing rules
  - **Returns**: None

**Query Methods**:
- `previous_item()`: 
  - **Parameters**: None
  - **Function**: Return the previous non-whitespace item
  - **Returns**: Atom or None - Previous item

- `fits_on_current_line(item_extent)`: 
  - **Parameters**: `item_extent` (int): Size of the item to check
  - **Function**: Check if an item fits on the current line without exceeding max length
  - **Returns**: bool - True if item fits, False otherwise

- `current_size()`: 
  - **Parameters**: None
  - **Function**: Get the current line size (excluding indentation)
  - **Returns**: int - Current line size

- `line_empty()`: 
  - **Parameters**: None
  - **Function**: Check if the current line is empty (only contains line break or indent)
  - **Returns**: bool - True if line is empty, False otherwise

**Private Helper Methods**:
- `_add_item(item, indent_amt)`: 
  - **Parameters**: 
    - `item` (Atom): Atom to add
    - `indent_amt` (int): Indentation amount
  - **Function**: Add an atom to the line with proper formatting and reflow logic
  - **Returns**: None

- `_add_container(container, indent_amt, break_after_open_bracket)`: 
  - **Parameters**: 
    - `container` (Container): Container to add
    - `indent_amt` (int): Indentation amount
    - `break_after_open_bracket` (bool): Whether to break after opening bracket
  - **Function**: Add a container to the line with proper formatting
  - **Returns**: None

- `_prevent_default_initializer_splitting(item, indent_amt)`: 
  - **Parameters**: 
    - `item` (Atom): Item being added
    - `indent_amt` (int): Indentation amount
  - **Function**: Prevent inappropriate splitting of default initializers
  - **Returns**: None

- `_split_after_delimiter(item, indent_amt)`: 
  - **Parameters**: 
    - `item` (Atom): Delimiter item
    - `indent_amt` (int): Indentation amount
  - **Function**: Handle line splitting after delimiters like commas
  - **Returns**: None

- `_enforce_space(item)`: 
  - **Parameters**: `item` (Atom): Item to enforce spacing around
  - **Function**: Enforce proper spacing around specific items
  - **Returns**: None

- `_delete_whitespace()`: 
  - **Parameters**: None
  - **Function**: Remove trailing whitespace from the current line
  - **Returns**: None

**Returns**: Formatted code string when calling `emit()` method.

#### 3. `Atom` Class

**Function**: Represent atomic units of code (tokens) that can be reflowed and formatted.

**Class Signature**:
```python
class Atom(object):
    def __init__(self, atom)
    def __repr__(self) -> str
    def __len__(self) -> int
    def reflow(self, reflowed_lines, continued_indent, extent, break_after_open_bracket, is_list_comp_or_if_expr, next_is_dot)
    def emit(self) -> str
    def is_keyword(self) -> bool
    def is_string(self) -> bool
    def is_fstring_start(self) -> bool
    def is_fstring_end(self) -> bool
    def is_name(self) -> bool
    def is_number(self) -> bool
    def is_comma(self) -> bool
    def is_colon(self) -> bool
    def size(self) -> int
```

**Key Methods**:

**Constructor and Core Methods**:
- `__init__(atom)`: 
  - **Parameters**: `atom` (Token): Token object from tokenize module
  - **Function**: Initialize with a token atom from Python's tokenizer
  - **Returns**: None

- `__repr__()`: 
  - **Parameters**: None
  - **Function**: String representation of the atom (returns token string)
  - **Returns**: str - Token string representation

- `__len__()`: 
  - **Parameters**: None
  - **Function**: Get the length of the atom (delegates to size property)
  - **Returns**: int - Length of the atom

- `emit()`: 
  - **Parameters**: None
  - **Function**: Emit the atom as a string (same as __repr__)
  - **Returns**: str - Token string

**Reflow Method**:
- `reflow(reflowed_lines, continued_indent, extent, break_after_open_bracket, is_list_comp_or_if_expr, next_is_dot)`: 
  - **Parameters**: 
    - `reflowed_lines` (ReformattedLines): Lines being formatted
    - `continued_indent` (str): Indentation for continued lines
    - `extent` (int): Total extent/size of the atom
    - `break_after_open_bracket` (bool): Whether to break after opening bracket
    - `is_list_comp_or_if_expr` (bool): Whether this is in a list comprehension or if expression
    - `next_is_dot` (bool): Whether the next item is a dot (for method chaining)
  - **Function**: Reflow the atom into formatted lines with proper spacing and line breaks
  - **Returns**: None (modifies reflowed_lines in place)

**Type Check Methods**:
- `is_keyword()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a Python keyword
  - **Returns**: bool - True if atom is a keyword, False otherwise

- `is_string()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a string literal
  - **Returns**: bool - True if atom is a string, False otherwise

- `is_fstring_start()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is the start of an f-string (Python 3.6+)
  - **Returns**: bool - True if atom is f-string start, False otherwise

- `is_fstring_end()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is the end of an f-string (Python 3.6+)
  - **Returns**: bool - True if atom is f-string end, False otherwise

- `is_name()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a name/identifier
  - **Returns**: bool - True if atom is a name, False otherwise

- `is_number()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a number literal
  - **Returns**: bool - True if atom is a number, False otherwise

- `is_comma()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a comma
  - **Returns**: bool - True if atom is a comma, False otherwise

- `is_colon()`: 
  - **Parameters**: None
  - **Function**: Check if the atom is a colon
  - **Returns**: bool - True if atom is a colon, False otherwise

**Size Method**:
- `size()`: 
  - **Parameters**: None
  - **Function**: Get the size of the atom (length of token string)
  - **Returns**: int - Size of the atom

**Returns**: String representation when calling `emit()` method.

#### 4. `Container` Class

**Function**: Represent containers (lists, tuples, dictionaries, etc.) that hold multiple atoms or other containers.

**Class Signature**:
```python
class Container(object):
    def __init__(self, items)
    def __repr__(self) -> str
    def __iter__(self)
    def __getitem__(self, idx)
    def reflow(self, reflowed_lines, continued_indent, break_after_open_bracket)
    def _get_extent(self, index) -> int
    def is_string(self) -> bool
    def size(self) -> int
    def is_keyword(self) -> bool
    def is_name(self) -> bool
    def is_comma(self) -> bool
    def is_colon(self) -> bool
    def open_bracket(self) -> str
    def close_bracket(self) -> str
```

**Key Methods**:

**Constructor and Core Methods**:
- `__init__(items)`: 
  - **Parameters**: `items` (list): List of items (atoms or containers)
  - **Function**: Initialize with a list of items that make up the container
  - **Returns**: None

- `__repr__()`: 
  - **Parameters**: None
  - **Function**: String representation of the container with proper spacing
  - **Returns**: str - Formatted string representation

- `__iter__()`: 
  - **Parameters**: None
  - **Function**: Iterator over container items
  - **Returns**: Iterator - Yields each item in the container

- `__getitem__(idx)`: 
  - **Parameters**: `idx` (int): Index of item to retrieve
  - **Function**: Get item at specific index
  - **Returns**: Atom or Container - Item at the given index

**Reflow Method**:
- `reflow(reflowed_lines, continued_indent, break_after_open_bracket)`: 
  - **Parameters**: 
    - `reflowed_lines` (ReformattedLines): Lines being formatted
    - `continued_indent` (str): Indentation for continued lines
    - `break_after_open_bracket` (bool): Whether to break after opening bracket
  - **Function**: Reflow the container into formatted lines with proper spacing and line breaks
  - **Returns**: None (modifies reflowed_lines in place)

**Helper Methods**:
- `_get_extent(index)`: 
  - **Parameters**: `index` (int): Index of item to get extent for
  - **Function**: Get the extent (size) of an item at the given index, including related items
  - **Returns**: int - Extent of the item

**Type Check Methods**:
- `is_string()`: 
  - **Parameters**: None
  - **Function**: Check if the container is a string (always False for containers)
  - **Returns**: bool - Always False for containers

- `size()`: 
  - **Parameters**: None
  - **Function**: Get the total size of the container
  - **Returns**: int - Total size of all items in container

- `is_keyword()`: 
  - **Parameters**: None
  - **Function**: Check if the container is a keyword (always False for containers)
  - **Returns**: bool - Always False for containers

- `is_name()`: 
  - **Parameters**: None
  - **Function**: Check if the container is a name/identifier (always False for containers)
  - **Returns**: bool - Always False for containers

- `is_comma()`: 
  - **Parameters**: None
  - **Function**: Check if the container is a comma (always False for containers)
  - **Returns**: bool - Always False for containers

- `is_colon()`: 
  - **Parameters**: None
  - **Function**: Check if the container is a colon (always False for containers)
  - **Returns**: bool - Always False for containers

**Bracket Methods**:
- `open_bracket()`: 
  - **Parameters**: None
  - **Function**: Get the opening bracket character (implemented by subclasses)
  - **Returns**: str - Opening bracket character

- `close_bracket()`: 
  - **Parameters**: None
  - **Function**: Get the closing bracket character (implemented by subclasses)
  - **Returns**: str - Closing bracket character

**Returns**: String representation when calling `emit()` method.

#### 5. `Tuple` Class

**Function**: Represent tuple containers with parentheses.

**Class Signature**:
```python
class Tuple(Container):
    def open_bracket(self) -> str
    def close_bracket(self) -> str
```

**Key Methods**:
- `open_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns "(" for tuple opening bracket
  - **Returns**: str - "(" character

- `close_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns ")" for tuple closing bracket
  - **Returns**: str - ")" character

**Inherits from**: `Container`

#### 6. `List` Class

**Function**: Represent list containers with square brackets.

**Class Signature**:
```python
class List(Container):
    def open_bracket(self) -> str
    def close_bracket(self) -> str
```

**Key Methods**:
- `open_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns "[" for list opening bracket
  - **Returns**: str - "[" character

- `close_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns "]" for list closing bracket
  - **Returns**: str - "]" character

**Inherits from**: `Container`

#### 7. `DictOrSet` Class

**Function**: Represent dictionary or set containers with curly braces.

**Class Signature**:
```python
class DictOrSet(Container):
    def open_bracket(self) -> str
    def close_bracket(self) -> str
```

**Key Methods**:
- `open_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns "{" for dictionary/set opening bracket
  - **Returns**: str - "{" character

- `close_bracket()`: 
  - **Parameters**: None
  - **Function**: Returns "}" for dictionary/set closing bracket
  - **Returns**: str - "}" character

**Inherits from**: `Container`

#### 8. `ListComprehension` Class

**Function**: Represent list comprehension containers with special size calculation.

**Class Signature**:
```python
class ListComprehension(Container):
    def size(self) -> int
```

**Key Methods**:
- `size()`: 
  - **Parameters**: None
  - **Function**: Override size calculation for list comprehensions with special logic
  - **Returns**: int - Calculated size for list comprehension

**Inherits from**: `Container`

#### 9. `IfExpression` Class

**Function**: Represent if expressions (ternary operators) containers.

**Class Signature**:
```python
class IfExpression(Container):
    # Inherits all methods from Container
```

**Key Methods**:
- All methods inherited from `Container` class
- No additional methods defined

**Inherits from**: `Container`

#### 10. `Reindenter` Class

**Function**: Reindent Python code to use consistent indentation.

**Class Signature**:
```python
class Reindenter(object):
    def __init__(self, input_text, leave_tabs)
    def run(self, indent_size) -> str
    def getline(self) -> str
```

**Key Methods**:
- `__init__(input_text, leave_tabs)`: 
  - **Parameters**: 
    - `input_text` (str): Input text to reindent
    - `leave_tabs` (bool): Whether to leave tabs as-is or expand them
  - **Function**: Initialize with input text and tab handling option, process multiline strings
  - **Returns**: None

- `run(indent_size)`: 
  - **Parameters**: `indent_size` (int): Size of indentation to use (default: 4)
  - **Function**: Reindent the code with specified indent size using token analysis
  - **Returns**: str - Reindented code as string

- `getline()`: 
  - **Parameters**: None
  - **Function**: Get the next line from the input for tokenization
  - **Returns**: str - Next line or empty string if at end

**Returns**: Reindented code string when calling `run()` method.

#### 11. `LineEndingWrapper` Class

**Function**: Wrap output to handle line endings consistently across platforms.

**Class Signature**:
```python
class LineEndingWrapper(object):
    def __init__(self, output)
    def write(self, s)
    def flush(self)
```

**Key Methods**:
- `__init__(output)`: 
  - **Parameters**: `output`: Output stream to wrap
  - **Function**: Initialize with output stream for line ending normalization
  - **Returns**: None

- `write(s)`: 
  - **Parameters**: `s` (str): String to write
  - **Function**: Write string with consistent line endings (normalizes \r\n and \r to \n)
  - **Returns**: None

- `flush()`: 
  - **Parameters**: None
  - **Function**: Flush the output stream
  - **Returns**: None

#### 12. `CachedTokenizer` Class

**Function**: Cache tokenizer results for improved performance when processing the same text multiple times.

**Class Signature**:
```python
class CachedTokenizer(object):
    def __init__(self)
    def generate_tokens(self, text)
```

**Key Methods**:
- `__init__()`: 
  - **Parameters**: None
  - **Function**: Initialize the cached tokenizer with empty cache
  - **Returns**: None

- `generate_tokens(text)`: 
  - **Parameters**: `text` (str): Text to tokenize
  - **Function**: Generate tokens from text with caching (only retokenizes if text changed)
  - **Returns**: list - List of tokens

**Returns**: List of tokens when calling `generate_tokens()` method.




### Type Aliases

The following type aliases are defined in the autopep8 module:

#### `__version__`
```python
__version__ = '2.3.2'
```
The version string of the autopep8 package.

#### `Token`
```python
Token = collections.namedtuple('Token', ['token_type', 'token_string', 'spos', 'epos', 'line'])
```
A named tuple type for representing Python code tokens with the following fields:
- `token_type`: The type of the token
- `token_string`: The string content of the token
- `spos`: Start position
- `epos`: End position
- `line`: Line number

#### `_cached_tokenizer`
```python
_cached_tokenizer = CachedTokenizer()
```
An instance of the CachedTokenizer class used for caching Python code tokenization results to improve performance.

### Example Code

#### Basic Usage

```python
import autopep8

# Format the code
source_code = """\
def example():
    x = 1; y = 2
    return x + y
"""
fixed_code = autopep8.fix_code(source_code)
print(fixed_code)
# Output:
# def example():
#     x = 1
#     y = 2
#     return x + y
```

#### Configured Usage

```python
import autopep8

# Custom configuration
options = autopep8.parse_args(['--aggressive', '--aggressive'])
fixed_code = autopep8.fix_code(source_code, options=options)
print(fixed_code)
```

#### File Formatting

```python
import autopep8

# Format the file
autopep8.fix_file('example.py')
```

#### Multi-file Formatting

```python
import autopep8

# Format multiple files
autopep8.fix_multiple_files(['example1.py', 'example2.py'])
```

#### Get Module Imports at the Top of the File

```python
import autopep8

# Get the module imports at the top of the file
imports = autopep8.get_module_imports_on_top_of_file('example.py')
print(imports)
# Output: ['import os', 'import sys']
```



### Example Code

#### Basic Usage

```python
import autopep8

# Format the code
source_code = """\
def example():
    x = 1; y = 2
    return x + y
"""
fixed_code = autopep8.fix_code(source_code)
print(fixed_code)
# Output:
# def example():
#     x = 1
#     y = 2
#     return x + y
```

#### Configured Usage

```python
import autopep8

# Custom configuration
options = autopep8.parse_args(['--aggressive', '--aggressive'])
fixed_code = autopep8.fix_code(source_code, options=options)
print(fixed_code)
```

#### File Formatting

```python
import autopep8

# Format the file
autopep8.fix_file('example.py')
```

#### Multi-file Formatting

```python
import autopep8

# Format multiple files
autopep8.fix_multiple_files(['example1.py', 'example2.py'])
```

#### Get Module Imports at the Top of the File

```python
import autopep8

# Get the module imports at the top of the file
imports = autopep8.get_module_imports_on_top_of_file('example.py')
print(imports)
# Output: ['import os', 'import sys']
```



## Detailed Implementation Nodes of Functions

### Node 1: Indentation Error Fixing
**Function Description**: Fix indentation errors in Python code, including tab replacement, indentation size adjustment, etc.
**Core Algorithm**:
- Tab detection and replacement: Identify tabs in indentation and replace them with spaces.
- Indentation size standardization: Adjust the indentation size according to the configuration (1, 2, 3, 4 spaces).
- Multi-line string protection: Avoid modifying tabs within multi-line strings.
- Docstring processing: Correctly handle indentation in docstrings.
**Input and Output Example**:
```python
# Input
code = """\
while True:
    if True:
    \t1
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# while True:
#     if True:
#         1
```

### Node 2: Whitespace Processing
**Function Description**: Handle whitespace issues in the code, including extra spaces, missing spaces, trailing whitespace, etc.
**Core Algorithm**:
- Whitespace processing inside parentheses: Remove extra spaces inside parentheses.
- Spaces around operators: Add or remove spaces before and after operators.
- Spaces after commas: Add spaces after commas.
- Trailing whitespace cleaning: Remove extra whitespace at the end of lines.
**Input and Output Example**:
```python
# Input
code = 'x = 1  + 1    \n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1 + 1
```

### Node 3: Import Statement Normalization
**Function Description**: Normalize Python import statements, including separating multi-module imports, adjusting import positions, etc.
**Core Algorithm**:
- Separation of multi-module imports: Separate `import os, sys` into `import os\nimport sys`.
- Import position adjustment: Move import statements to the top of the file.
- Duplicate import handling: Remove duplicate import statements.
- Future import protection: Keep `__future__` imports at the beginning of the file.
**Input and Output Example**:
```python
# Input
code = 'import os, sys\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# import os
# import sys
```

### Node 4: Line Length Control
**Function Description**: Control the code line length and split long lines into multiple lines.
**Core Algorithm**:
- Logical line splitting: Intelligently split long lines based on the syntax structure.
- Physical line splitting: Force line breaks at appropriate positions.
- Parenthesis balance: Split preferably at parentheses.
- Comment handling: Correctly handle the splitting of inline comments.
**Input and Output Example**:
```python
# Input
code = """\
print(111, 111, 111, 111, 222, 222, 222, 222, 222, 222, 222, 222, 222, 333, 333, 333, 333)
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# print(111, 111, 111, 111, 222, 222, 222, 222,
#       222, 222, 222, 222, 222, 333, 333, 333, 333)
```

### Node 5: Comment Formatting
**Function Description**: Format code comments, including inline comments, block comments, etc.
**Core Algorithm**:
- Spacing for inline comments: Add appropriate spaces before `#`.
- Comment content formatting: Adjust the format of comment content.
- Special comment protection: Protect special comments such as `# noqa`.
- Block comment processing: Format multi-line block comments.
**Input and Output Example**:
```python
# Input
code = 'x = 1# comment\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1  # comment
```

### Node 6: Function and Class Definition Normalization
**Function Description**: Normalize function and class definitions, including empty line handling, docstrings, etc.
**Core Algorithm**:
- Spacing between class methods: Add empty lines between class methods.
- Function spacing: Add empty lines between functions.
- Spacing between imports and code: Add empty lines between import statements and code.
- Docstring processing: Correctly handle the format of docstrings.
**Input and Output Example**:
```python
# Input
code = """\
class MyClass:
    def method1(self):
        pass
    def method2(self):
        pass
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# class MyClass:
#     def method1(self):
#         pass
#
#     def method2(self):
#         pass
```

### Node 7: Conditional and Loop Statement Formatting
**Function Description**: Format conditional and loop statements, including the format of if, for, while, etc. statements.
**Core Algorithm**:
- Single-line statement processing: Format single-line conditional/loop statements into multiple lines.
- Statements after colons: Add line breaks and indentation after colons.
- Semicolon handling: Remove unnecessary semicolons.
- Syntax protection: Ensure the syntax of the formatted code is correct.
**Input and Output Example**:
```python
# Input
code = 'if True: x = 1\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# if True:
#     x = 1
```

### Node 8: Data Structure Formatting
**Function Description**: Format the representation of data structures such as lists, dictionaries, and tuples.
**Core Algorithm**:
- Whitespace processing inside parentheses: Remove extra spaces inside parentheses.
- Element spacing: Add appropriate spaces between elements.
- Multi-line formatting: Format long data structures into multiple lines.
- Nested structure handling: Correctly handle nested data structures.
**Input and Output Example**:
```python
# Input
code = '[1 , 2  , 3]\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# [1, 2, 3]
```

### Node 9: Exception Handling Statement Formatting
**Function Description**: Format exception handling statements, including try, except, finally, etc. statements.
**Core Algorithm**:
- Exception type handling: Correctly handle the representation of exception types.
- Exception handling block formatting: Format the content of except blocks.
- Syntax protection: Ensure the syntax of exception handling statements is correct.
**Input and Output Example**:
```python
# Input
code = """\
try:
    x = 1/0
except Exception as e: print(e)
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# try:
#     x = 1/0
# except Exception as e:
#     print(e)
```

### Node 10: String and Docstring Processing
**Function Description**: Handle the format of strings and docstrings, including multi-line strings, raw strings, etc.
**Core Algorithm**:
- Escape character handling: Correctly handle escape characters in strings.
- Multi-line string protection: Protect multi-line strings from being modified.
- Raw string processing: Correctly handle the format of raw strings.
**Input and Output Example**:
```python
# Input
code = 'x = "\\n"\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = "\n"
```

### Node 11: Comparison Operator Normalization
**Function Description**: Normalize the use of comparison operators, including `==`, `!=`, `is`, `is not`, etc.
**Core Algorithm**:
- None comparison optimization: Replace `== None` with `is None`.
- Boolean comparison optimization: Replace `== True/False` with `is True/False`.
- Type comparison handling: Correctly handle type comparison operations.
- Syntax protection: Ensure the syntax of comparison operations is correct.
**Input and Output Example**:
```python
# Input
code = 'if x == None:\n    pass\n'
# Output
fixed = autopep8.fix_code(code, options={'aggressive': 2})
print(fixed)
# if x is None:
#     pass
```

### Node 12: Logical Operator Formatting
**Function Description**: Format logical operators, including `and`, `or`, `not`, etc.
**Core Algorithm**:
- Operator precedence: Correctly handle the precedence of logical operators.
- Multi-line formatting: Format long logical expressions into multiple lines.
- Parenthesis handling: Add parentheses when necessary to clarify precedence.
**Input and Output Example**:
```python
# Input
code = 'if a and b or c:\n    pass\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# if (a and b) or c:
#     pass
```

### Node 13: Assignment Operator Formatting
**Function Description**: Format assignment operators, including `=`, `+=`, `-=`, etc.
**Core Algorithm**:
- Spaces around operators: Add spaces before and after assignment operators.
- Compound assignment handling: Correctly handle compound assignment operators.
- Syntax protection: Ensure the syntax of assignment statements is correct.
**Input and Output Example**:
```python
# Input
code = 'x=1\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1
```

### Node 14: Function Call Formatting
**Function Description**: Format function calls, including parameter lists, keyword parameters, etc.
**Core Algorithm**:
- Parameter spacing: Add appropriate spaces between parameters.
- Keyword parameter handling: Correctly handle the format of keyword parameters.
- Long parameter list: Format long parameter lists into multiple lines.
- Default parameter handling: Correctly handle the format of default parameters.
**Input and Output Example**:
```python
# Input
code = 'func(1,2,3)\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# func(1, 2, 3)
```

### Node 15: Class Definition Formatting
**Function Description**: Format class definitions, including class names, inheritance, methods, etc.
**Core Algorithm**:
- Class spacing: Add empty lines between class definitions.
- Inheritance formatting: Correctly handle the format of class inheritance.
- Method spacing: Add empty lines between class methods.
- Docstring processing: Correctly handle class docstrings.
**Input and Output Example**:
```python
# Input
code = """\
class MyClass:
    def method1(self):
        pass
    def method2(self):
        pass
class AnotherClass:
    pass
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# class MyClass:
#     def method1(self):
#         pass
#
#     def method2(self):
#         pass
#
#
# class AnotherClass:
#     pass
```

### Node 16: Configuration File Processing
**Function Description**: Process project configuration files, including `pyproject.toml`, `setup.cfg`, etc.
**Core Algorithm**:
- Configuration file parsing: Parse configuration files in various formats.
- Option merging: Merge global and local configuration options.
- Default value handling: Provide default values for unset options.
- Configuration verification: Verify the validity of configuration options.
**Input and Output Example**:
```python
# Input
config_content = """\
[tool.autopep8]
max_line_length = 88
aggressive = 1
"""
# Output
options = autopep8.parse_args([''], apply_config=True)
# The configuration file will be automatically read and applied.
```

### Node 17: Command Line Interface
**Function Description**: Provide the command-line interface for autopep8, supporting functions such as file formatting, recursive directory processing, difference display, and multi-process processing.
**Core Algorithm/Function Points**:
- Command-line parameter parsing: Support multiple parameter combinations (such as `--in-place`, `--diff`, `--recursive`, `--jobs`, etc.).
- Batch processing of files and directories: Support recursive formatting of all Python files in a directory.
- Difference output: Support displaying the differences before and after formatting.
- Parallel processing: Support multi-process acceleration for formatting a large number of files.
**Input and Output Example**:
```bash
# Input
$ autopep8 example.py --in-place
# Output
# The file example.py is formatted.
```

### Node 18: Utility Functions
**Function Description**: Provide various utility functions inside autopep8, including file processing, code formatting, module import, etc.
**Core Algorithm/Function Points**:
- File reading, writing, and encoding detection
- Code snippet formatting and fixing
- Module import and dependency analysis
- Auxiliary algorithms (such as line shortening, comment handling, token offset, etc.)
**Input and Output Example**:
```python
# Input
fixed = autopep8.fix_code('a=1+2')
# Output
print(fixed)
# a = 1 + 2
```

### Node 19: Integration and Bytecode Verification
**Function Description**: Provide the integration functions of autopep8, including the running effect on various Python files and the consistency verification of bytecode before and after formatting.
**Core Algorithm/Function Points**:
- Processing of diverse real code samples
- Function consistency verification before and after formatting
- Bytecode-level equivalence verification to ensure that formatting does not affect code semantics
**Input and Output Example**:
```python
# Input
from acid import run, compare_bytecode
# Output
assert compare_bytecode('original.py', 'formatted.py')
```

### Node 20: Multiline String Formatting
**Function Description**: Format multi-line strings to ensure they comply with the PEP 8 specification.
**Core Algorithm**:
- Remove extra spaces in multi-line strings
- Ensure the correct indentation of multi-line strings
- Protect the original format of strings
**Input and Output Example**:
```python
# Input
code = '''\
x = """
This is a multiline string
that should not be modified
"""
'''
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = """
# This is a multiline string
# that should not be modified
# """
```

### Node 21: File Encoding Detection and Handling
**Function Description**: Detect the encoding of files and correctly handle the file content.
**Core Algorithm**:
- Automatically detect file encoding
- Support multiple encoding formats
- Preserve the original encoding when processing files
**Input and Output Example**:
```python
# Input
with open('example.py', 'rb') as f:
    encoding = autopep8.detect_encoding(f)
# Output
print(encoding)
# utf-8
```

### Node 22: Code Snippet Fixing
**Function Description**: Fix common problems in code snippets, such as indentation and whitespace.
**Core Algorithm**:
- Identify problems in code snippets
- Apply fixing rules
- Ensure the fixed code complies with the PEP 8 specification
**Input and Output Example**:
```python
# Input
code = 'x=1+2\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1 + 2
```

### Node 23: Module Import Optimization
**Function Description**: Optimize module import statements to reduce unnecessary imports.
**Core Algorithm**:
- Remove duplicate import statements
- Merge multiple import statements
- Optimize the order of import statements
**Input and Output Example**:
```python
# Input
code = 'import os, sys\nimport os\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# import os
# import sys
```

### Node 24: Line Length Optimization
**Function Description**: Optimize the code line length to ensure it complies with the PEP 8 specification.
**Core Algorithm**:
- Intelligently split long lines
- Ensure the line length does not exceed the specified maximum length
- Optimize the line splitting position
**Input and Output Example**:
```python
# Input
code = """\
print(111, 111, 111, 111, 222, 222, 222, 222, 222, 222, 222, 222, 222, 333, 333, 333, 333)
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# print(111, 111, 111, 111, 222, 222, 222, 222,
#       222, 222, 222, 222, 222, 333, 333, 333, 333)
```

### Node 25: Comment Protection
**Function Description**: Protect comments in the code from being accidentally modified during formatting.
**Core Algorithm**:
- Identify comment content
- Avoid modifying comment content
- Protect special comments (such as `# noqa`)
**Input and Output Example**:
```python
# Input
code = 'x = 1  # noqa\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1  # noqa
```

### Node 26: Code Block Formatting
**Function Description**: Format code blocks to ensure they comply with the PEP 8 specification.
**Core Algorithm**:
- Ensure the empty lines between code blocks comply with the specification
- Optimize the indentation of code blocks
- Ensure the format of code blocks is clear and easy to read
**Input and Output Example**:
```python
# Input
code = """\
def example():
    x = 1
    y = 2
"""
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# def example():
#     x = 1
#
#     y = 2
```

### Node 27: File Line Ending Handling
**Function Description**: Handle the line ending characters of files to ensure they comply with the PEP 8 specification.
**Core Algorithm**:
- Remove extra trailing whitespace characters
- Ensure there is a newline character at the end of the file
- Avoid extra empty lines at the end of the file
**Input and Output Example**:
```python
# Input
code = 'x = 1    \n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1
```

### Node 28: Code Formatting Verification
**Function Description**: Verify whether the code format complies with the PEP 8 specification.
**Core Algorithm**:
- Check for format issues in the code
- Provide detailed error reports
- Ensure the code format complies with the specification
**Input and Output Example**:
```python
# Input
code = 'x=1\n'
# Output
fixed = autopep8.fix_code(code)
print(fixed)
# x = 1
```

### Node 29: Configuration File Priority Handling
**Function Description**: Handle the priority of multiple configuration files to ensure that configuration options are correctly applied.
**Core Algorithm**:
- Parse multiple configuration files
- Determine the priority of configuration files
- Merge configuration options
**Input and Output Example**:
```python
# Input
config_content = """\
[tool.autopep8]
max_line_length = 88
aggressive = 1
"""
# Output
options = autopep8.parse_args([''], apply_config=True)
# The configuration file will be automatically read and applied.
```

### Node 30: Code Formatting Before and After Comparison
**Function Description**: Provide a comparison before and after code formatting to facilitate users to view the modified content.
**Core Algorithm**:
- Generate the differences before and after code formatting
- Provide detailed comparison reports
- Support multiple output formats (such as text, HTML, etc.)
**Input and Output Example**:
```python
# Input
code = 'x=1\n'
# Output
fixed = autopep8.fix_code(code)
print(autopep8.diff(code, fixed))
# --- 
# +++ 
# @@ -1 +1 @@
# -x=1
# +x = 1
```