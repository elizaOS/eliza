## Introduction and Goals of the Python-pathspec Project

Python-pathspec is a Python library **for file path pattern matching**, specifically designed to implement pattern matching functions similar to those in Git's `.gitignore` files. Based on Git's wildmatch pattern matching algorithm (derived from Rsync's wildmatch), this library can efficiently parse and apply file path pattern rules, enabling file inclusion, exclusion, and filtering operations. Its core features include: **Git-style pattern matching** (supporting complex patterns such as wildcards, negation patterns, and directory markers), **flexible file matching interfaces** (supporting single-file checks, batch file matching, directory tree traversal, etc.), and **full implementation of the GitIgnore specification** (accurately replicating Git's `.gitignore` behavior through the `GitIgnoreSpec` class). In short, Python-pathspec aims to provide a robust and efficient file path pattern matching system for applications that require precise control over file selection, such as file filtering, backup tools, and code analysis (for example, compiling pattern rules via `PathSpec.from_lines()` and performing file matching via the `match_files()` function).

## Natural Language Instruction (Prompt)

Please create a Python project named python-pathspec to implement a file path pattern matching library. The project should include the following features:

1. **Core Pattern Matching Engine**: Implement a pattern matching system based on the Git wildmatch algorithm, capable of parsing and applying path pattern rules similar to those in `.gitignore` files. Support complex pattern syntax such as wildcards (e.g., `*.txt`, `**/build/`), negation patterns (e.g., `!*.tmp`), and directory markers (e.g., `src/`).

2. **PathSpec Base Class**: Create the `PathSpec` class as the core interface for pattern matching, providing the `from_lines()` method to compile pattern rules from text lines, the `match_file()` method to check if a single file matches, the `match_files()` method to batch match a list of files, and the `match_tree_files()` method to traverse a directory tree for matching.

3. **GitIgnore Specification Implementation**: Implement the `GitIgnoreSpec` class to accurately replicate Git's `.gitignore` behavior, including pattern priority rules, directory matching logic, and negation pattern handling. This class should inherit from `PathSpec` and override the matching logic to conform to Git specifications.

4. **Pattern Parser**: Create the `GitWildMatchPattern` class to implement the Git wildmatch algorithm, converting pattern strings into regular expressions and supporting functions such as escape characters, comment handling, and pattern negation. This class should inherit from the `RegexPattern` base class.

5. **Utility Function Module**: Provide utility functions for file path standardization, directory tree traversal, pattern lookup, etc., such as `normalize_file()`, `iter_tree_files()`, `lookup_pattern()`, etc., supporting cross-platform path handling.

6. **Interface Design**: Design clear API interfaces for each functional module, supporting both command-line and programmatic calls. Each module should define clear input and output formats, providing type hints and docstrings.

7. **Examples**: Provide sample code to demonstrate how to use `PathSpec.from_lines()` to compile pattern rules, how to use `match_files()` to perform file matching, and how to use `GitIgnoreSpec` to implement the full `.gitignore` functionality.

8. **Core File Requirements**: The project must include a complete `pyproject.toml` file in order to configure the project as an installable package (supporting 'pip install') and declare a complete list of dependencies . We need to provide `pathspec/_init__. py` as a unified API entry point to information, allowing users to access all major functions through simple statements such as` from pathspec import xxx `.Import `RecursionError` exception, `check_match_file` function, `iter_tree_entries` function, `iter_tree_files` function, `match_file` function, `normalize_file` function, `CheckResult` class and `lookup_pattern` function from the `pathspec.util` module; import `GitWildMatchPattern` class, `GitWildMatchPatternError` exception, `_BYTES_ENCODING` variable and `_DIR_MARK` variable from the `pathspec.patterns.gitwildmatch` module; import `PathSpec` class from the `pathspec` module; import `GitIgnoreSpec` class from the `pathspec.gitignore` module.Version information is provided through the `pathspec/_meta.py` file, which defines the `__version__` variable to specify the version number (`__version__ = "0.12.2.dev1"`).

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
alabaster                     1.0.0
babel                         2.17.0
certifi                       2025.8.3
charset-normalizer            3.4.2
docutils                      0.21.2
exceptiongroup                1.3.0
flit_core                     3.12.0
idna                          3.10
imagesize                     1.4.1
iniconfig                     2.1.0
Jinja2                        3.1.6
MarkupSafe                    3.0.2
packaging                     25.0
pip                           23.0.1
pluggy                        1.6.0
Pygments                      2.19.2
pytest                        8.4.1
requests                      2.32.4
setuptools                    65.5.1
snowballstemmer               3.0.1
Sphinx                        8.1.3
sphinxcontrib-applehelp       2.0.0
sphinxcontrib-devhelp         2.0.0
sphinxcontrib-htmlhelp        2.1.0
sphinxcontrib-jsmath          1.0.1
sphinxcontrib-qthelp          2.0.0
sphinxcontrib-serializinghtml 2.0.0
tomli                         2.2.1
typing_extensions             4.14.1
urllib3                       2.5.0
wheel                         0.40.0
```

## Architecture of the Python-pathspec Project

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .readthedocs.yaml
├── CHANGES.rst
├── DEV.md
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README-dist.rst
├── README.rst
├── dev
│   ├── .gitignore
│   └── venv.sh
├── doc
│   ├── Makefile
│   ├── requirements.txt
│   ├── source
│   │   ├── api.rst
│   │   ├── changes.rst
│   │   ├── conf.py
│   │   ├── index.rst
│   │   └── readme.rst
├── pathspec
│   ├── __init__.py
│   ├── _meta.py
│   ├── gitignore.py
│   ├── pathspec.py
│   ├── pattern.py
│   ├── patterns
│   │   ├── __init__.py
│   │   └── gitwildmatch.py
│   ├── py.typed
│   └── util.py
├── prebuild.py
├── pyproject.toml
└── tox.ini
```

## API Usage Guide

### 1. Module Import

```python
from pathspec.util import (
	RecursionError,
	check_match_file,
	iter_tree_entries,
	iter_tree_files,
	match_file,
	normalize_file,
    CheckResult,
    lookup_pattern
  )
from pathspec.patterns.gitwildmatch import (
	GitWildMatchPattern,
	GitWildMatchPatternError,
	_BYTES_ENCODING,
	_DIR_MARK)
from pathspec import (
	PathSpec)
from pathspec.gitignore import (
	GitIgnoreSpec)
```


### 2. PathSpec Class

#### Functional Description
The `PathSpec` class is a wrapper around a list of compiled patterns used for file pattern matching. It provides a series of methods to check whether a file path matches a given set of patterns.

#### Basic Import
```python
from pathspec import PathSpec
```

#### Class Initialization
```python
class PathSpec(object):
    def __init__(self, patterns: Iterable[Pattern]) -> None
```
**Parameters**:
- `patterns` (`Iterable[Pattern]`): An iterable containing the patterns to be used.

**Attributes**:
- `patterns` (`Collection[Pattern]`): A collection containing the compiled patterns.

#### Main Methods

##### 1. `check_file`
```python
def check_file(
    self,
    file: TStrPath,
    separators: Optional[Collection[str]] = None,
) -> CheckResult[TStrPath]
```
Checks if a single file matches the path specification.

**Parameters**:
- `file` (`str` or `os.PathLike`): The file path to match.
- `separators` (`Collection[str]`, optional): Path separators to normalize.

**Returns**:
- `CheckResult`: An object containing the file check result.

##### 2. `check_files`
```python
def check_files(
    self,
    files: Iterable[TStrPath],
    separators: Optional[Collection[str]] = None,
) -> Iterator[CheckResult[TStrPath]]
```
Checks if multiple files match the path specification.

**Parameters**:
- `files`: An iterable of file paths to check.
- `separators`: Path separators to normalize.

**Returns**:
- `Iterator[CheckResult]`: An iterator containing the check result for each file.

##### 3. `check_tree_files`
```python
def check_tree_files(
    self,
    root: StrPath,
    on_error: Optional[Callable[[OSError], None]] = None,
    follow_links: Optional[bool] = None,
) -> Iterator[CheckResult[str]]
```
Traverses all files under the specified root directory and checks if they match the path specification.

**Parameters**:
- `root`: The root directory to search.
- `on_error`: A handler function for filesystem exceptions.
- `follow_links`: Whether to follow symbolic links.

**Returns**:
- `Iterator[CheckResult]`: An iterator containing the check result for each file.

##### 4. `from_lines` (Class Method)
```python
@classmethod
def from_lines(
    cls: Type[Self],
    pattern_factory: Union[str, Callable[[AnyStr], Pattern]],
    lines: Iterable[AnyStr],
) -> Self
```
Creates a PathSpec instance from text lines.

**Parameters**:
- `pattern_factory`: The pattern factory, which can be a registered pattern factory name or a callable object.
- `lines`: An iterable containing pattern text lines.

**Returns**:
- `PathSpec`: A new PathSpec instance.

##### 5. `match_file`
```python
def match_file(
    self,
    file: StrPath,
    separators: Optional[Collection[str]] = None,
) -> bool
```
Checks if a file matches the path specification.

**Parameters**:
- `file`: The file path to match.
- `separators`: Path separators to normalize.

**Returns**:
- `bool`: Returns `True` if the file matches, otherwise `False`.

##### 6. `match_files`
```python
def match_files(
    self,
    files: Iterable[StrPath],
    separators: Optional[Collection[str]] = None,
    *,
    negate: Optional[bool] = None,
) -> Iterator[StrPath]
```
Matches multiple files to the path specification.

**Parameters**:
- `files`: An iterable of file paths to match.
- `separators`: Path separators to normalize.
- `negate`: Whether to invert the match result.

**Returns**:
- `Iterator[StrPath]`: An iterator of matched file paths.

##### 7. `match_tree_files` and `match_tree`
```python
def match_tree_files(
    self,
    root: StrPath,
    on_error: Optional[Callable[[OSError], None]] = None,
    follow_links: Optional[bool] = None,
    *,
    negate: Optional[bool] = None,
) -> Iterator[str]

# match_tree is an alias for match_tree_files, maintained for backward compatibility
match_tree = match_tree_files
```
Traverses all files under the specified root directory and matches them to the path specification.

**Parameters**:
- `root`: The root directory to search.
- `on_error`: A handler function for filesystem exceptions.
- `follow_links`: Whether to follow symbolic links.
- `negate`: Whether to invert the match result.

**Returns**:
- `Iterator[str]`: An iterator of matched file paths.

##### 8. `match_entries`
```python
def match_entries(
    self,
    entries: Iterable[TreeEntry],
    separators: Optional[Collection[str]] = None,
    *,
    negate: Optional[bool] = None,
) -> Iterator[TreeEntry]
```
Matches entries to the path specification.

**Parameters**:
- `entries`: An iterable of entries to match.
- `separators`: Path separators to normalize.
- `negate`: Whether to invert the match result.

**Returns**:
- `Iterator[TreeEntry]`: An iterator of matched entries.

##### 9. `match_tree_entries`
```python
def match_tree_entries(
    self,
    root: StrPath,
    on_error: Optional[Callable[[OSError], None]] = None,
    follow_links: Optional[bool] = None,
    *,
    negate: Optional[bool] = None,
) -> Iterator[TreeEntry]
```
Traverses all entries under the specified root directory and matches them to the path specification.

**Parameters**:
- `root`: The root directory to search.
- `on_error`: A handler function for filesystem exceptions.
- `follow_links`: Whether to follow symbolic links.
- `negate`: Whether to invert the match result.

**Returns**:
- `Iterator[TreeEntry]`: An iterator of matched entries.

##### 10. Special Methods

###### `__eq__`
```python
def __eq__(self, other: object) -> bool
```
Compares whether two PathSpec instances are equal.

###### `__len__`
```python
def __len__(self) -> int
```
Returns the number of contained patterns.

###### `__add__`
```python
def __add__(self: Self, other: "PathSpec") -> Self
```
Merges the patterns of two PathSpec instances.

###### `__iadd__`
```python
def __iadd__(self: Self, other: "PathSpec") -> Self
```
Adds the patterns of another PathSpec instance to the current instance.

#### Basic Usage
```python
from pathspec import PathSpec
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Create PathSpec from .gitignore file
with open('.gitignore') as f:
    spec = PathSpec.from_lines(GitWildMatchPattern, f)

# Check if a file matches
if spec.match_file('path/to/file.txt'):
    print("File is ignored")

# Get all matched files
for file in spec.match_tree_files('.'):
    print(f"Ignored: {file}")
```
#### Combining Multiple Patterns
```python
spec1 = PathSpec([...])
spec2 = PathSpec([...])
combined = spec1 + spec2  # Combine two PathSpecs
```

#### Using Custom Patterns
```python
class MyPattern(Pattern):
    # Implement custom pattern matching logic
    pass

spec = PathSpec([MyPattern('*.py')])
```


### 3. GitIgnoreSpec Class

#### Functional Description
The `GitIgnoreSpec` class inherits from `PathSpec` and is specifically designed to implement Git's `.gitignore` file behavior. It provides the same file ignore pattern matching rules as Git.

#### Basic Import
```python
from pathspec.gitignore import GitIgnoreSpec
```

#### Class Inheritance
```python
class GitIgnoreSpec(PathSpec)
```

#### Methods

##### 1. `__eq__`
```python
def __eq__(self, other: object) -> bool
```
**Function**: Compares whether two `GitIgnoreSpec` instances are equal.

**Parameters**:
- `other`: The object to compare.

**Returns**:
- `bool`: Returns `True` if `other` is a `GitIgnoreSpec` instance and the pattern lists are identical, otherwise `False`.

##### 2. `from_lines` (Class Method)
```python
@overload
@classmethod
def from_lines(
    cls: Type[Self],
    pattern_factory: Union[str, Callable[[AnyStr], Pattern]],
    lines: Iterable[AnyStr],
) -> Self: ...

@overload
@classmethod
def from_lines(
    cls: Type[Self],
    lines: Iterable[AnyStr],
    pattern_factory: Union[str, Callable[[AnyStr], Pattern], None] = None,
) -> Self: ...

@classmethod
def from_lines(
    cls: Type[Self],
    lines: Iterable[AnyStr],
    pattern_factory: Union[str, Callable[[AnyStr], Pattern], None] = None,
) -> Self
```

**Overload Description**:
1. First form: `from_lines(pattern_factory, lines)`
2. Second form: `from_lines(lines, pattern_factory=None)`
**Function**: Compiles pattern rules from text lines.

**Parameters**:
- `lines`: An iterable containing uncompiled patterns (such as file objects or string lists).
- `pattern_factory`:
  - Can be `None`: Uses `GitWildMatchPattern` as the default pattern factory.
  - Can be a string: The name of a registered pattern factory.
  - Can be a callable object: A function used to compile patterns.

**Note**:
- This method supports two calling methods, implemented via the `@overload` decorator.
- When `pattern_factory` is `None`, it defaults to using `GitWildMatchPattern`.
- If `lines` is a string or callable and `pattern_factory` is iterable, the parameter order is automatically swapped.

**Returns**:
- `GitIgnoreSpec`: A new `GitIgnoreSpec` instance.

**Note**:
- This method overloads the `PathSpec.from_lines()` method and supports parameter order swapping.
- When `pattern_factory` is `None`, it defaults to using `GitWildMatchPattern`.

##### 3. Protected Methods

###### `_match_file`
```python
@staticmethod
def _match_file(
    patterns: Iterable[Tuple[int, GitWildMatchPattern]],
    file: str,
) -> Tuple[Optional[bool], Optional[int]]
```
**Function**: Checks if a file matches the patterns.

**Parameters**:
- `patterns`: An iterable containing (index, pattern) tuples.
- `file`: The normalized file path to match.

**Returns**:
- `tuple`: A tuple containing two elements.
  - First element: Whether to include the file (`bool` or `None`).
  - Second element: The index of the last matched pattern (`int` or `None`).

**Note**:
- This method implements Git's ignore rule matching logic.
- Directory patterns (ending with `/`) and file patterns have different priorities.
- Later patterns override earlier ones, unless the earlier one is a directory pattern and the later one is a file pattern.

#### 4. Usage Examples

##### Basic Usage
```python
from pathspec.gitignore import GitIgnoreSpec

# Create GitIgnoreSpec from .gitignore file
with open('.gitignore') as f:
    spec = GitIgnoreSpec.from_lines(f)

# Check if a file is ignored
if spec.match_file('path/to/file.txt'):
    print("File is ignored")

# Get all ignored files
for file in spec.match_tree_files('.'):
    print(f"Ignored: {file}")
```

##### Using Custom Pattern Factory
```python
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Create GitIgnoreSpec with custom options
spec = GitIgnoreSpec.from_lines(
    ['*.pyc', '!important.pyc', '__pycache__/'],
    GitWildMatchPattern
)
```

##### Combining Multiple GitIgnoreSpecs
```python
# Create GitIgnoreSpec from multiple sources
spec1 = GitIgnoreSpec.from_lines(['*.pyc', '*.log'])
spec2 = GitIgnoreSpec.from_lines(['!important.pyc'])

# Combine two GitIgnoreSpecs
combined = spec1 + spec2
```


### 4. pathspec.patterns.gitwildmatch Module Constants

#### `_BYTES_ENCODING`
```python
_BYTES_ENCODING = 'latin1'
```
**Description**:
- Encoding used when parsing byte string patterns.

#### `_DIR_MARK`
```python
_DIR_MARK = 'ps_d'
```
**Description**:
- Regex group name for directory markers.
- Only used in the `GitIgnoreSpec` class.

### 5. pathspec.patterns.gitwildmatch Module Exception Class

#### `GitWildMatchPatternError`
```python
class GitWildMatchPatternError(ValueError)
```
**Functional Description**:
- Represents an invalid Git wildcard match pattern.
- Inherits from `ValueError`.

### 6. `pathspec.pattern` Module

#### Module Overview
`pathspec.pattern` is the core module in the `pathspec` library, defining base classes and implementations for file pattern matching. It mainly contains the following classes:
- `Pattern` - Abstract base class for patterns
- `RegexPattern` - Regular expression-based pattern implementation
- `RegexMatchResult` - Regular expression match result class


##### Pattern Class (Abstract Base Class)

**Functional Description**:
`Pattern` is an abstract base class for pattern matching, defining the basic interface and common behavior for pattern matching.

###### Constructor
```python
def __init__(self, include: Optional[bool]) -> None
```
**Parameters**:
- `include` (bool or None): Specifies whether matched files should be included (True), excluded (False), or perform a no-op (None).

**Attributes**:
- `include` (bool or None): Indicates whether matched files should be included (True), excluded (False), or perform a no-op (None).

**Special Attributes**:
- `__slots__`: Used to explicitly declare class instance attributes, optimizing memory usage.
  - Value: `('include',)`
  - Purpose: Restricts class instances to only have the `include` attribute, preventing dynamic addition of new attributes.
  - Advantage: Reduces memory usage and improves attribute access speed.

###### Methods

`match` (Deprecated)
```python
def match(self, files: Iterable[str]) -> Iterator[str]
```
**Function**: Deprecated, use the `match_file()` method instead. Matches the pattern with the specified collection of files.

**Parameters**:
- `files` (Iterable[str]): An iterable containing file paths relative to the root directory.

**Returns**:
- Iterator[str]: An iterator yielding each matched file path.

**Deprecation Note**: This method has been deprecated; it is recommended to use the `match_file()` method combined with a loop to achieve similar functionality.

`match_file` (Abstract Method)
```python
def match_file(self, file: str) -> Optional[Any]
```
**Function**: Matches the current pattern with the specified file (abstract method, must be implemented by subclasses).

**Parameters**:
- `file` (str): The file path relative to the root directory.

**Returns**:
- Any type: Returns the match result if the file matches.
- None: If the file does not match.

**Exceptions**:
- `NotImplementedError`: If the subclass does not implement this method.

###### Usage Example
```python
# Create a custom pattern class
class MyPattern(Pattern):
    def match_file(self, file: str) -> bool:
        # Implement custom matching logic
        return file.endswith('.py') and self.include

# Use custom pattern
pattern = MyPattern(include=True)
result = pattern.match_file('example.py')  # Returns match result
```

##### RegexPattern Class

**Functional Description**:
The `RegexPattern` class is a pattern matching implementation based on regular expressions, used to match file paths. It is a concrete implementation of the `Pattern` class.

###### Constructor
```python
def __init__(
    self,
    pattern: Union[AnyStr, PatternHint, None],
    include: Optional[bool] = None,
) -> None
```
**Parameters**:
- `pattern` (Union[AnyStr, PatternHint, None]): The pattern to compile into a regular expression.
  - Can be a string, byte string, compiled regex object, or None.
- `include` (bool or None, optional): Whether matched files should be included (True), excluded (False), or perform a no-op (None).
  - This parameter must be specified when pattern is a precompiled regex.
  - Default: None.

**Attributes**:
- `pattern` (Union[AnyStr, PatternHint, None]): The uncompiled input pattern, for reference.
- `regex` (re.Pattern): The compiled regex object.
- `include` (bool or None): Whether matched files should be included (True), excluded (False), or perform a no-op (None).

**Special Attributes**:
- `__slots__`: Explicitly declared instance attributes, optimizing memory usage.
  - Value: `('pattern', 'regex', 'include')`
  - Purpose: Restricts class instances to only have the `pattern`, `regex`, and `include` attributes.
  - Advantage: Significantly reduces memory usage compared to using `__dict__` for dynamic attribute storage.

###### Methods

`match_file`
```python
def match_file(self, file: str) -> Optional['RegexMatchResult']
```
**Function**: Matches the current pattern with the specified file.

**Parameters**:
- `file` (str): The file path relative to the root directory (e.g., "relative/path/to/file").

**Returns**:
- `RegexMatchResult`: Returns the match result if the file matches.
- `None`: If the file does not match.

`pattern_to_regex`
```python
@classmethod
def pattern_to_regex(cls, pattern: str) -> Tuple[str, bool]:
```
**Function**: Converts a pattern to an uncompiled regular expression.

**Parameters**:
- `pattern` (str): The pattern to convert to a regular expression.

**Returns**:
- `Tuple[str, bool]`: A tuple containing:
  - The uncompiled regular expression (str or None).
  - Whether matched files should be included (True include, False exclude, None no-op).

**Note**: The default implementation directly returns the original pattern and True.

`__eq__`
```python
def __eq__(self, other: 'RegexPattern') -> bool
```
**Function**: Compares whether two RegexPattern objects are equal.

**Parameters**:
- `other` (RegexPattern): Another RegexPattern object to compare.

**Returns**:
- `bool`: Returns True if both objects have the same include and regex attributes, otherwise False.

###### Usage Example
```python
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Create an include pattern
pattern = RegexPattern(r'.*\.py$', include=True)

# Match files
result = pattern.match_file('src/main.py')  # Returns RegexMatchResult object
no_match = pattern.match_file('README.md')   # Returns None

# Convert pattern using class method
regex, include = RegexPattern.pattern_to_regex('*.py')
print(regex)   # Outputs the converted regex
print(include) # Outputs whether matched files should be included
```

##### RegexMatchResult Class

**Functional Description**:
`RegexMatchResult` is a data class defined using the `@dataclasses.dataclass()` decorator, used to encapsulate regular expression matching result information.

**Class Definition**:
```python
@dataclasses.dataclass()
class RegexMatchResult(object):
    # Restrict instance attributes to optimize memory usage
    __slots__ = ('match',)
    
    match: 're.Match[Any]'
```

**Special Attributes**:
- `__slots__`: Explicitly declared instance attributes.
  - Value: `('match',)`
  - Purpose: Restricts class instances to only have the `match` attribute, preventing dynamic addition of new attributes.
  - Advantage: As a data class, using `__slots__` significantly reduces memory usage, especially when creating many instances.

**Attributes**:
- `match` (re.Match): The regex match result object.
  - Contains complete matching information, such as matched groups, positions, etc.
  - Detailed information can be obtained through methods like `match.group()`, `match.start()`, `match.end()`, etc.

###### Usage Example
```python
import re
from pathspec.patterns import RegexPattern

# Create a regex pattern
pattern = RegexPattern(r'(.*)\.(\\w+)$')

# Match files
result = pattern.match_file('document.txt')
if result is not None:
    print(f"Full match: {result.match.group(0)}")
    print(f"File name: {result.match.group(1)}")
    print(f"Extension: {result.match.group(2)}")
    print(f"Match position: {result.match.start()} to {result.match.end()}")
```
- `include` (bool or None): Whether matched files should be included (True), excluded (False), or perform a no-op (None).


### 7. GitWildMatchPattern Class in pathspec.patterns.gitwildmatch Module

#### Functional Description
The `GitWildMatchPattern` class represents a compiled Git wildcard match pattern, used to implement Git's wildcard matching rules.

#### Class Definition
```python
class GitWildMatchPattern(RegexPattern)
```

#### Class Attributes
- `__slots__ = ()` - Used to optimize memory usage.

#### Class Methods

##### `pattern_to_regex`
```python
@classmethod
def pattern_to_regex(
    cls,
    pattern: AnyStr,
) -> Tuple[Optional[AnyStr], Optional[bool]]
```
**Function**: Converts a Git wildcard pattern to a regular expression.

**Parameters**:
- `pattern` (AnyStr): The Git wildcard pattern to convert, can be a string or byte string.

**Returns**:
- `Tuple[Optional[AnyStr], Optional[bool]]`: A tuple containing two elements.
  - First element: The uncompiled regular expression (string or byte string).
  - Second element: Whether to include matches (`True` include, `False` exclude, `None` indicates no-op).

**Exceptions**:
- `TypeError`: If `pattern` is not a Unicode or byte string.
- `GitWildMatchPatternError`: If the pattern is invalid.
- `GitWildMatchPatternError` - If the pattern is invalid.

##### `_translate_segment_glob` (Static Method)
```python
@staticmethod
def _translate_segment_glob(pattern: str) -> str
```
**Function**: Converts a glob pattern to a regular expression. Used in the constructor to convert path segment glob patterns to their corresponding regular expressions.

**Parameters**:
- `pattern` (str): The glob pattern to convert.

**Returns**:
- `str`: The converted regular expression.

**Exceptions**:
- `ValueError`: If an escape character has no subsequent character.

##### `escape` (Static Method)
```python
@staticmethod
def escape(s: AnyStr) -> AnyStr
```
**Function**: Escapes special characters in the given string. Typically used before adding filenames to `.gitignore`.

**Parameters**:
- `s` (AnyStr): The filename or string to escape, can be a string or byte string.

**Returns**:
- `AnyStr`: The escaped string, return type is the same as the input type.

**Exceptions**:
- `TypeError`: If the input is not a Unicode or byte string.

**Note**:
- Escaped metacharacters include: `[]!*#?`
- For byte strings, uses `_BYTES_ENCODING` for encoding/decoding.

#### Usage Examples

##### Basic Usage
```python
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Escape special characters
escaped = GitWildMatchPattern.escape('file[1].txt')
print(escaped)  # Output: file\[1\].txt

# Create pattern
pattern = GitWildMatchPattern('*.py')

# Check if file matches pattern
if pattern.match_file('test.py'):
    print("File matches pattern")

# Use pattern factory via registered name
from pathspec.util import register_pattern
from pathspec import PathSpec

# Register pattern (usually done during module loading)
# util.register_pattern('gitwildmatch', GitWildMatchPattern)

# Use registered pattern by name
spec = PathSpec.from_lines('gitwildmatch', ['*.py', '!test_*.py'])
```

#### Pattern Registration

The `GitWildMatchPattern` class is registered into `pathspec`'s pattern factory during module loading via the following code:

```python
util.register_pattern('gitwildmatch', GitWildMatchPattern)
```

This allows referencing this pattern class by the name `'gitwildmatch'`, for example:

```python
from pathspec import PathSpec

# Create PathSpec using registered name
spec = PathSpec.from_lines('gitwildmatch', ['*.py', '!test_*.py'])
```

### 8. pathspec.util Module

#### 1. Module Import

```python
from pathspec.util import (
    RecursionError,
    check_match_file,
    iter_tree_entries,
    iter_tree_files,
    match_file,
    normalize_file,
    CheckResult,
    lookup_pattern
)
```

#### 2. Function Documentation

##### 2.1 check_match_file

**Functional Description**: Checks if a file matches the patterns.

**Decorator**: None

**Function Signature**:
```python
def check_match_file(
    patterns: Iterable[Tuple[int, Pattern]],
    file: str,
) -> Tuple[Optional[bool], Optional[int]]
```

**Parameters**:
- `patterns` (`Iterable[Tuple[int, Pattern]]`): An iterable containing index and pattern tuples.
- `file` (`str`): The normalized file path to match.

**Returns**:
- `Tuple[Optional[bool], Optional[int]]`: A tuple containing two elements.
  - First element: Whether to include the file (`bool` or `None`).
  - Second element: The index of the last matched pattern (`int` or `None`).

---

##### 2.2 iter_tree_entries

**Functional Description**: Traverses all files and directories under the specified directory.

**Decorator**: None

**Function Signature**:
```python
def iter_tree_entries(
    root: StrPath,
    on_error: Optional[Callable[[OSError], None]] = None,
    follow_links: Optional[bool] = None,
) -> Iterator['TreeEntry']
```

**Parameters**:
- `root` (`StrPath`): The root directory to search.
- `on_error` (`Callable[[OSError], None]`, optional): A callback handler for filesystem exceptions.
- `follow_links` (`bool`, optional): Whether to follow symbolic links, defaults to `None` meaning `True`.

**Returns**:
- `Iterator[TreeEntry]`: An iterator yielding each file or directory entry.

**Exceptions**:
- `RecursionError`: If recursion is detected.

---

##### 2.3 iter_tree_files

**Functional Description**: Traverses all files under the specified directory.

**Decorator**: None

**Function Signature**:
```python
def iter_tree_files(
    root: StrPath,
    on_error: Optional[Callable[[OSError], None]] = None,
    follow_links: Optional[bool] = None,
) -> Iterator[str]
```

**Parameters**:
- `root` (`StrPath`): The root directory to search.
- `on_error` (`Callable[[OSError], None]`, optional): A callback handler for filesystem exceptions.
- `follow_links` (`bool`, optional): Whether to follow symbolic links, defaults to `None` meaning `True`.

**Returns**:
- `Iterator[str]`: An iterator yielding each file path.

**Exceptions**:
- `RecursionError`: If recursion is detected.

---

##### 2.4 match_file

**Functional Description**: Checks if a file matches any of the patterns.

**Decorator**: None

**Function Signature**:
```python
def match_file(patterns: Iterable[Pattern], file: str) -> bool
```

**Parameters**:
- `patterns` (`Iterable[Pattern]`): The list of patterns to use.
- `file` (`str`): The normalized file path to match.

**Returns**:
- `bool`: Returns `True` if the file matches any pattern, otherwise `False`.

---

##### 2.5 normalize_file

**Functional Description**: Normalizes a file path to use POSIX path separators (`/`) and makes the path relative (removes leading `/`).

**Decorator**: None

**Function Signature**:
```python
def normalize_file(
    file: StrPath,
    separators: Optional[Collection[str]] = None,
) -> str
```

**Parameters**:
- `file` (`StrPath`): The file path.
- `separators` (`Collection[str]`, optional): A collection of path separators to normalize.

**Returns**:
- `str`: The normalized file path.

---

##### 2.6 lookup_pattern

**Functional Description**: Looks up a registered pattern factory by name.

**Decorator**: None

**Function Signature**:
```python
def lookup_pattern(name: str) -> Callable[[AnyStr], Pattern]
```

**Parameters**:
- `name` (`str`): The name of the pattern factory.

**Returns**:
- `Callable[[AnyStr], Pattern]`: The registered pattern factory.

**Exceptions**:
- `KeyError`: If no pattern factory with the specified name is found.

#### 3. Class Documentation

##### 3.1 CheckResult

**Functional Description**: Contains information about a file and its matching pattern.

**Class Definition**:
```python
@dataclass(frozen=True)
class CheckResult(Generic[TStrPath]):
    __slots__ = ('file', 'include', 'index')
```

**Attributes**:
- `file` (`TStrPath`): The file path.
- `include` (`Optional[bool]`): Whether to include the file.
- `index` (`Optional[int]`): The index of the matched pattern.

##### 3.2 RecursionError

**Functional Description**: Exception raised when recursion is detected.

**Class Definition**:
```python
class RecursionError(Exception):
    __slots__ = ()
    
    def __init__(self, real_path: str, first_path: str, second_path: str) -> None:
        """
        Initialize a RecursionError instance.
        
        :param real_path: The actual path where recursion was detected
        :param first_path: The first encountered path
        :param second_path: The second encountered path
        """
        super(RecursionError, self).__init__(real_path, first_path, second_path)
```

**Attributes**:
- `real_path` (`str`): The actual path where recursion was detected.
- `first_path` (`str`): The first encountered path.
- `second_path` (`str`): The second encountered path.
- `message` (`str`): The formatted error message.

**Methods**:

###### `first_path` Property
```python
@property
def first_path(self) -> str
```
**Function**: Gets the first path where `real_path` was encountered.

**Returns**:
- `str`: The first encountered path.

###### `message` Property
```python
@property
def message(self) -> str
```
**Function**: Gets the formatted error message.

**Returns**:
- `str`: The formatted error message containing the actual path, first and second encountered paths.

###### `real_path` Property
```python
@property
def real_path(self) -> str
```
**Function**: Gets the actual path where recursion was detected.

**Returns**:
- `str`: The actual path.

###### `second_path` Property
```python
@property
def second_path(self) -> str
```
**Function**: Gets the second path where `real_path` was encountered.

**Returns**:
- `str`: The second encountered path.

##### 3.3 TreeEntry

**Functional Description**: Contains information about a filesystem entry.

**Class Definition**:
```python
class TreeEntry:
    __slots__ = ('_lstat', 'name', 'path', '_stat')
```

**Methods**:
- `is_dir(follow_links: Optional[bool] = None) -> bool`: Checks if the entry is a directory.
- `is_file(follow_links: Optional[bool] = None) -> bool`: Checks if the entry is a regular file.
- `is_symlink() -> bool`: Checks if the entry is a symbolic link.
- `stat(follow_links: Optional[bool] = None) -> os.stat_result`: Gets the stat result of the entry.

**Attributes**:
- `name` (`str`): The entry name.
- `path` (`str`): The entry relative path.
- `_lstat` (`os.stat_result`): The direct entry stat result.
- `_stat` (`os.stat_result`): The linked entry stat result.

#### 4. Usage Examples

##### 4.1 Basic Usage

```python
from pathlib import Path
from pathspec.util import (
    iter_tree_files,
    match_file,
    normalize_file,
    RecursionError
)

# Traverse all files in a directory
try:
    for file_path in iter_tree_files('/path/to/directory'):
        print(f"Found file: {file_path}")
except RecursionError as e:
    print(f"Recursion detected: {e}")

# Normalize file path
normalized = normalize_file('C:\\Windows\\path\\to\\file.txt')
print(normalized)  # Output: Windows/path/to/file.txt

# Check if file matches patterns
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

patterns = [
    GitWildMatchPattern('*.py'),
    GitWildMatchPattern('!test_*.py')
]

is_matched = match_file(patterns, 'module.py')
print(f"File matched: {is_matched}")
```

##### 4.2 Advanced Usage

```python
from pathlib import Path
from pathspec.util import (
    iter_tree_entries,
    TreeEntry
)

# Get directory entries and their metadata
for entry in iter_tree_entries('/path/to/directory'):
    if entry.is_file():
        stat_info = entry.stat()
        print(f"File: {entry.path}")
        print(f"  Size: {stat_info.st_size} bytes")
        print(f"  Modified: {stat_info.st_mtime}")
```

### 9. Contents in __init__.py
You are supposed to register the following content in pathspec/__init__.py
```python
from .gitignore import (
	GitIgnoreSpec)
from .pathspec import (
	PathSpec)
from .pattern import (
	Pattern,
	RegexPattern)
from .util import (
	RecursionError,
	iter_tree,
	lookup_pattern,
	match_files)

from ._meta import (
	__author__,
	__copyright__,
	__credits__,
	__license__,
	__version__,
)

# Load pattern implementations.
from . import patterns

# DEPRECATED: Expose the `GitIgnorePattern` class in the root module for
# backward compatibility with v0.4.
from .patterns.gitwildmatch import GitIgnorePattern

# Declare private imports as part of the public interface. Deprecated
# imports are deliberately excluded.
__all__ = [
	'GitIgnoreSpec',
	'PathSpec',
	'Pattern',
	'RecursionError',
	'RegexPattern',
	'__author__',
	'__copyright__',
	'__credits__',
	'__license__',
	'__version__',
	'iter_tree',
	'lookup_pattern',
	'match_files',
]
```


## Detailed Implementation Nodes of the Functionality

### Node 1: Core Engine for File Path Pattern Matching (PathSpec Core Engine)

**Function Description**: Implement the core engine for file path pattern matching, providing basic functions such as pattern compilation, file matching, and directory traversal.

**Core Functions**:
- Pattern Compilation: Compile pattern rules from text lines
- File Matching: Check if single or multiple files match patterns
- Directory Traversal: Recursively traverse a directory tree for matching
- Result Checking: Provide detailed matching result information

**Input-Output Examples**:

```python
from pathspec import PathSpec
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Pattern Compilation
patterns = ['*.py', '!test_*.py', 'build/', '!important.py']
spec = PathSpec.from_lines('gitwildmatch', patterns)

# Single-File Matching
is_matched = spec.match_file('main.py')  # True
is_matched = spec.match_file('test_main.py')  # False

# Batch File Matching
files = ['main.py', 'test_main.py', 'build/script.py', 'important.py']
matched_files = list(spec.match_files(files))
# Result: ['main.py', 'important.py']

# Directory Tree Traversal Matching
matched_files = list(spec.match_tree_files('/path/to/project'))

# Detailed Matching Results
result = spec.check_file('document.txt')
# result.include: bool | None (whether it is included)
# result.index: int | None (index of the matching pattern)
```

### Node 2: Git Wildmatch Pattern Parser

**Function Description**: Implement the Git wildmatch algorithm to convert pattern strings into regular expressions, supporting complex wildcards and path matching.

**Core Functions**:
- Pattern Conversion: Convert wildmatch patterns to regular expressions
- Wildcard Support: Handle wildcards such as `*`, `**`, and `?`
- Negation Patterns: Handle `!pattern` negation patterns
- Escape Characters: Handle `\char` escape characters
- Comment Handling: Handle `#comment` comment lines

**Input-Output Examples**:

```python
from pathspec.patterns.gitwildmatch import GitWildMatchPattern

# Basic Wildcards
pattern = GitWildMatchPattern('*.txt')
regex, include = pattern.pattern_to_regex('*.txt')
# regex: '^(?:.+/)?[^/]*\\.txt(?:/.*)?$'
# include: True

# Negation Patterns
pattern = GitWildMatchPattern('!*.tmp')
regex, include = pattern.pattern_to_regex('!*.tmp')
# regex: '^(?:.+/)?[^/]*\\.tmp(?:/.*)?$'
# include: False

# Directory Matching
pattern = GitWildMatchPattern('src/')
regex, include = pattern.pattern_to_regex('src/')
# regex: '^src/(?:/.*)?$'
# include: True

# Absolute Path
pattern = GitWildMatchPattern('/absolute/path')
regex, include = pattern.pattern_to_regex('/absolute/path')
# regex: '^absolute/path(?:/.*)?$'
# include: True

# Double Asterisk Matching
pattern = GitWildMatchPattern('**/build/')
regex, include = pattern.pattern_to_regex('**/build/')
# regex: '^(?:.*/)?build/(?:/.*)?$'
# include: True

# Escape Characters
pattern = GitWildMatchPattern('\\#file')
regex, include = pattern.pattern_to_regex('\\#file')
# regex: '^(?:.+/)?#file(?:/.*)?$'
# include: True
```

### Node 3: GitIgnore Specification Implementation

**Function Description**: Accurately replicate Git's .gitignore behavior, including pattern priority rules, directory matching logic, and negation pattern handling.

**Core Functions**:
- Git Specification Matching: Match according to Git's .gitignore rules
- Pattern Priority: Handle the priority relationship between patterns
- Directory Exclusion: Correctly handle the exclusion logic of directories and files
- Parameter Reversal: Support the from_lines method with reversed parameter order

**Input-Output Examples**:

```python
from pathspec import GitIgnoreSpec

# Create from a .gitignore file
with open('.gitignore', 'r') as f:
    spec = GitIgnoreSpec.from_lines(f)

# Create from a list of strings
patterns = ['*.pyc', '!important.pyc', '__pycache__/']
spec = GitIgnoreSpec.from_lines(patterns)

# Check if a file is ignored
is_ignored = not spec.match_file('path/to/file.py')

# Directory Exclusion Test
spec = GitIgnoreSpec.from_lines([
    '*.txt',
    '!test1/',
])
files = {
    'test1/a.txt',  # Included (because of !test1/)
    'test1/b.bin',  # Not included
    'test2/a.txt',  # Included (matches *.txt)
    'test2/b.bin',  # Not included
}
results = list(spec.check_files(files))
# Included files: {'test1/a.txt', 'test2/a.txt'}

# File Exclusion Test
spec = GitIgnoreSpec.from_lines([
    '*.txt',
    '!b.txt',
])
files = {
    'X/a.txt',  # Included
    'X/b.txt',  # Not included (because of !b.txt)
    'Y/a.txt',  # Included
    'Y/b.txt',  # Not included (because of !b.txt)
}
results = list(spec.check_files(files))
# Included files: {'X/a.txt', 'Y/a.txt'}
```

### Node 4: File Path Standardization and Utility Functions

**Function Description**: Provide utility functions such as file path standardization, directory tree traversal, and pattern lookup, supporting cross-platform path handling.

**Core Functions**:
- Path Standardization: Unify path separators across different operating systems
- Directory Traversal: Recursively traverse a directory tree to get a list of files
- Pattern Lookup: Look up registered pattern factory functions
- Recursion Detection: Detect and handle symbolic link recursion

**Input-Output Examples**:

```python
from pathspec.util import (
    normalize_file, iter_tree_files, iter_tree_entries,
    lookup_pattern, check_match_file, match_file, match_files
)

# Path Standardization
normalized = normalize_file('path\\to\\file.txt')  # 'path/to/file.txt'
normalized = normalize_file(pathlib.PurePath('a.txt'))  # 'a.txt'

# Directory Tree Traversal
files = list(iter_tree_files('/path/to/directory'))
# Returns a list of paths to all files

entries = list(iter_tree_entries('/path/to/directory'))
# Returns a list of TreeEntry objects containing file information

# Pattern Lookup
pattern_factory = lookup_pattern('gitwildmatch')

# File Matching Check
patterns = list(enumerate(map(GitWildMatchPattern, ['*.txt', '!test/'])))
include_index = check_match_file(patterns, "include.txt")
# Returns: (True, 0) - included, matching the 0th pattern

include_index = check_match_file(patterns, "test/exclude.txt")
# Returns: (False, 1) - excluded, matching the 1st pattern

include_index = check_match_file(patterns, "unmatch.bin")
# Returns: (None, None) - no match

# Batch File Matching
patterns = list(map(GitWildMatchPattern, ['*.txt', '!b.txt']))
files = {'X/a.txt', 'X/b.txt', 'Y/a.txt', 'Y/b.txt'}
matched = match_files(patterns, files)
# Returns: {'X/a.txt', 'Y/a.txt'}

# Single-File Matching
include = match_file(patterns, "include.txt")  # True
include = match_file(patterns, "exclude.txt")  # False
```

### Node 5: Pattern Matching Results and Data Structures

**Function Description**: Define the data structures for pattern matching results, including CheckResult, TreeEntry, MatchDetail, etc., providing detailed matching information.

**Core Functions**:
- Matching Results: CheckResult contains the file path, matching status, and pattern index
- Tree Entries: TreeEntry contains file system entry information
- Matching Details: MatchDetail contains detailed matching pattern information
- Recursion Errors: RecursionError handles symbolic link recursion

**Input-Output Examples**:

```python
from pathspec.util import CheckResult, TreeEntry, RecursionError

# CheckResult - File matching result
result = CheckResult("file.txt", True, 0)
# result.file: file path
# result.include: True (included) / False (excluded) / None (not matched)
# result.index: index of the matching pattern

# TreeEntry - File system entry
entry = TreeEntry("file.txt", "path/to/file.txt", stat_result, stat_result)
# entry.name: file name
# entry.path: full path
# entry.is_file(): whether it is a file
# entry.is_dir(): whether it is a directory
# entry.is_symlink(): whether it is a symbolic link

# Recursion error handling
try:
    files = list(iter_tree_files('/path/with/recursive/links'))
except RecursionError as e:
    print(f"Recursion error: {e.first_path} -> {e.second_path}")
    # Handle symbolic link recursion

# Operations on matching result sets
results = list(spec.check_files(['file1.txt', 'file2.py', 'file3.txt']))
included_files = {r.file for r in results if r.include}
excluded_files = {r.file for r in results if r.include is False}
unmatched_files = {r.file for r in results if r.include is None}
```
