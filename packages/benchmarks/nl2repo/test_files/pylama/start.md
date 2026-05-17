## Introduction and Goals of the Pylama Project

Pylama is a command-line tool **for Python code quality auditing** that can integrate multiple code checkers and static analysis tools to conduct comprehensive quality checks on Python code. This tool performs exceptionally well in the field of code quality checking in the Python ecosystem and can achieve the goals of "unified interface, multi-tool integration, and efficient checking". Its core functions include: integration of multiple Linters (integrating mainstream checking tools such as pycodestyle, pyflakes, mccabe, pydocstyle, pylint, and mypy), **unified configuration management** (supporting configuration files in INI and TOML formats to centrally manage the configurations of all checkers), as well as flexible output formats, asynchronous checking modes, and plugin extension mechanisms. In short, Pylama is dedicated to providing a robust Python code quality checking ecosystem for detecting syntax errors, code style violations, potential bugs, code complexity, and missing documentation (for example, scanning code paths through the `check_paths()` function and parsing configuration options through the `parse_options()` function).

## Natural Language Instruction (Prompt)

Please create a Python project named Pylama to implement a code quality auditing tool. The project should include the following functions:

1. Multi-Linter Integration Engine: It should be able to centrally manage and invoke multiple Python code checking tools, including pycodestyle (PEP8 style check), pyflakes (static code analysis), mccabe (complexity calculation), pydocstyle (docstring check), pylint (comprehensive static analysis), mypy (type checking), isort (import sorting check), eradicate (dead code detection), etc. Each Linter should implement a unified interface specification.

2. Configuration Management System: Implement a powerful configuration system that supports multiple configuration file formats (INI, TOML, setup.cfg, etc.), and hierarchical configuration management such as global configuration, specific file configuration, and specific Linter configuration. The configuration system should support command-line parameter overrides, environment variable integration, and automatic discovery of configuration files.

3. File Scanning and Filtering: Implement a recursive directory scanning function that supports file type filtering, path pattern matching, and ignore rule processing. It should support reading code from stdin, single-file checking, and batch directory checking.

4. Error Reporting and Formatting: Provide multiple output formats (pydocstyle, pycodestyle, pylint, parsable, json, etc.), and support error classification, severity level sorting, and absolute path output. Error reports should include the file name, line number, column number, error type, and description.

5. Asynchronous Processing and Performance Optimization: Implement a concurrent file checking mechanism and support an asynchronous mode to improve the checking efficiency of large projects. It should include memory optimization, caching mechanisms, and performance monitoring functions.

6. Core File Requirements: The project must include a complete setup.py file. This file should not only configure the project as an installable package (supporting `pip install`), but also declare a complete list of dependencies (including core libraries such as pycodestyle>=2.8.0, pyflakes>=2.4.0, mccabe>=0.6.1, pydocstyle>=6.1.1). The configuration file should be able to verify whether all functional modules are working properly. At the same time, it is necessary to provide `pylama/__init__.py` as a unified API entry, import and export `Namespace`, `DEFAULT_SECTION`, `get_config`, `Error`, `remove_duplicates`, `check_async`, `shell`, `check_paths`, `LINTERS`, `run`, `git_hook`, and the main import and export functions, and provide version information, so that users can access all main functions through simple `from pylama.** import **` or `from pylama import **` statements.

## Environment Configuration

### Versions of Core Dependent Libraries

```Plain
# Core libraries for code checking
pycodestyle>=2.9.1              # PEP8 code style checker
pyflakes>=2.5.0                 # Static code analysis tool
mccabe>=0.7.0                   # Code complexity calculation tool
pydocstyle>=6.1.1               # Docstring specification checker

# Optional enhanced checkers
pylint>=2.12.0                  # Comprehensive static code analysis (optional)
mypy>=0.910                     # Static type checker (optional)
isort>=5.10.0                   # Import statement sorting checker (optional)
eradicate>=2.0.0                # Dead code detector (optional)
vulture>=2.3                    # Unused code detector (optional)
radon>=5.1.0                    # Code metric tool (optional)

# Configuration file processing libraries
inirama>=0.3.1                  # INI configuration file parser
tomli>=1.2.0                    # TOML configuration file parser (Python<3.11)

# System and utility libraries (built-in)
argparse                        # Command-line argument parsing
pathlib                         # Path handling
fnmatch                         # File name pattern matching
logging                         # Logging
collections                     # Container datatypes
functools                       # Higher-order functions and operations on callable objects
typing                          # Type hints support
sys                             # System-specific parameters and functions
concurrent                      # Concurrent execution support
json                            # JSON encoder and decoder
subprocess                      # Subprocess management
configparser                    # Configuration file parser
tempfile                        # Generate temporary files and directories
io                              # Core tools for working with streams
warnings                        # Warning control
multiprocessing                 # Process-based parallelism
pkgutil                         # Package extension utility
re                              # Regular expression operations
copy                            # Shallow and deep copy operations
importlib                       # Implementation of import

# Packaging and distribution libraries
pkg_resources                   # Package resource management
setuptools                      # Package setup and distribution

# Testing libraries (see requirements-tests.txt for complete list)
pytest                          # Testing framework
unittest                        # Unit testing framework

Note: Additional testing dependencies are specified in `requirements-tests.txt`.

### Test Dependencies

For development and testing purposes, additional dependencies are required. These are listed in the `requirements-tests.txt` file:

```Plain
pytest      >= 7.1.2
pytest-mypy
eradicate   >= 2.0.0
radon       >= 5.1.0
mypy
pylint      >= 2.11.1
pylama-quotes
toml
vulture

types-setuptools
types-toml
```
```

## Pylama Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .bumpversion.cfg
├── .github
│   ├── dependabot.yml
│   ├── workflows
│   │   ├── docs.yml
│   │   ├── release.yml
│   │   └── tests.yml
├── .gitignore
├── .pre-commit-hooks.yaml
├── Changelog
├── Dockerfile
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.rst
├── docs
│   ├── _static
│   │   ├── logo.png
│   ├── conf.py
│   ├── index.rst
│   ├── requirements.txt
├── dummy.py
├── pylama
│   ├── __init__.py
│   ├── __main__.py
│   ├── check_async.py
│   ├── config.py
│   ├── config_toml.py
│   ├── context.py
│   ├── core.py
│   ├── errors.py
│   ├── hook.py
│   ├── libs
│   │   ├── __init__.py
│   │   ├── inirama.py
│   ├── lint
│   │   ├── __init__.py
│   │   ├── pylama_eradicate.py
│   │   ├── pylama_fake.py
│   │   ├── pylama_mccabe.py
│   │   ├── pylama_mypy.py
│   │   ├── pylama_pycodestyle.py
│   │   ├── pylama_pydocstyle.py
│   │   ├── pylama_pyflakes.py
│   │   ├── pylama_pylint.py
│   │   ├── pylama_radon.py
│   │   ├── pylama_vulture.py
│   ├── main.py
│   ├── pytest.py
│   ├── utils.py
├── setup.cfg
└── setup.py
```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from pylama import config_toml
from pylama.config import DEFAULT_SECTION,get_config
from pylama.libs import inirama
from pylama.errors import Error, remove_duplicates
from pylama.check_async import check_async
from pylama.main import check_paths,shell
from pylama.lint import LINTERS
from pylama.core import run
from pylama.hook import git_hook
```

#### 2. `check_paths()` Function - Code Path Checking

**Function**: Perform code quality checks on the specified file or directory paths and return a list of discovered errors.

**Function Signature**:

```python
def check_paths(
    paths: List[str],
    options: Namespace = None,
    rootdir: Path = None
) -> List[dict]:
```

**Parameter Description**:

- `paths` (List[str]): A list of file or directory paths to be checked.
- `options` (Namespace): Parsed configuration options, including configurations such as linters, ignore, and select.
- `rootdir` (Path): The path to the project root directory, used for relative path parsing.

**Return Value**: A list of error dictionaries, where each error contains the file name, line number, column number, error type, and description.

#### 3. `parse_options()` Function - Configuration Option Parsing

**Function**: Parse command-line arguments and configuration files to generate a unified configuration option object.

**Function Signature**:

```python
def parse_options(
    args: List[str] = None,
    config: bool = True,
    rootdir: Path = None,
    **overrides
) -> Namespace:
```

**Parameter Description**:

- `args` (List[str]): A list of command-line arguments, using `sys.argv` by default.
- `config` (bool): Whether to load the configuration file, default is `True`.
- `rootdir` (Path): The root directory for searching configuration files.
- `**overrides`: Key-value pairs for overriding specific configuration options.

**Return Value**: A `Namespace` object containing all configuration options.

#### 4. Linter Base Class - Base Class for Custom Checkers

**Function**: The base class for all code checkers, defining a unified interface specification.

**Class Definition**:

```python
class Linter:
    name: str = "unknown"
    
    @classmethod
    def add_args(cls, parser: ArgumentParser) -> None:
        """Add command-line arguments specific to this Linter."""
    
    def allow(self, path: Path) -> bool:
        """Determine whether this Linter can check the specified file."""
    
    def run_check(self, ctx: RunContext) -> List[dict]:
        """Perform code checks and return a list of errors."""
```

**Core Methods**:

- `add_args()`: Add command-line options specific to this Linter to the `ArgumentParser`.
- `allow()`: Determine whether checking is supported based on the file path and extension.
- `run_check()`: Execute the actual code checking logic.

#### 5. `RunContext` Class - Checking Context

**Function**: Provide checking context information for the Linter, including file content, configuration options, etc.

**Class Definition**:

```python
class RunContext:
    def __init__(
        self,
        filepath: Path,
        content: str,
        options: Namespace
    ):
    
    def get_params(self, linter_name: str) -> dict:
        """Get the configuration parameters for a specific Linter."""
```

#### 6. Configuration-related

##### `DEFAULT_SECTION`
**Constant**: `DEFAULT_SECTION = "pylama"`  
**Location**: `pylama.config`  
**Description**: The default configuration section name, used to identify the pylama configuration part in the configuration file.

##### `get_config`
**Function**: `get_config(user_path: str = None, rootdir: Path = None) -> inirama.Namespace`  
**Location**: `pylama.config`  
**Function**: Load the configuration from the configuration file.  
**Parameters**:
- `user_path` (str, optional): The path to the configuration file specified by the user.
- `rootdir` (Path, optional): The root directory, used for parsing relative paths.

**Return Value**: `inirama.Namespace` - A namespace object containing configuration information.

**Example**:
```python
from pylama.config import get_config
config = get_config()
```

#### 7. Error Handling

##### `Error` Class
**Class**: `Error`  
**Location**: `pylama.errors`  
**Description**: A class for storing error information.

**Attributes**:
- `filename` (str): The file name.
- `lnum` (int): The line number.
- `col` (int): The column number.
- `number` (str): The error number.
- `text` (str): The error message.
- `type` (str): The error type (e.g., 'E' for error, 'W' for warning).
- `source` (str): The error source (e.g., 'pycodestyle', 'pylint', etc.).

**Methods**:
- `__str__()`: Return the formatted error information.
- `__eq__(other)`: Compare whether two errors are the same.

##### `remove_duplicates`
**Function**: `remove_duplicates(errors: List[Error]) -> List[Error]`  
**Location**: `pylama.errors`  
**Function**: Remove duplicate items from the error list.  
**Parameters**:
- `errors` (List[Error]): The error list.

**Return Value**: `List[Error]` - The error list after removing duplicates.

**Example**:
```python
from pylama.errors import remove_duplicates
unique_errors = remove_duplicates(errors)
```

#### 8. Asynchronous Checking

##### `check_async`
**Function**: `check_async(paths: List[str], code: str = None, options: Namespace = None, rootdir: Path = None) -> List[Error]`  
**Location**: `pylama.check_async`  
**Function**: Asynchronously check the code at the given paths.  
**Parameters**:
- `paths` (List[str]): A list of file paths to be checked.
- `code` (str, optional): The code string to be directly checked.
- `options` (Namespace, optional): Configuration options.
- `rootdir` (Path, optional): The root directory, used for parsing relative paths.

**Return Value**: `List[Error]` - A list of errors found during the check.

**Example**:
```python
from pylama.check_async import check_async
errors = check_async(['file1.py', 'file2.py'])
```

#### 9. Command-line Interface

##### `shell`
**Function**: `shell(args: List[str] = None, error: bool = True) -> Optional[List[Error]]`  
**Location**: `pylama.main`  
**Function**: The command-line entry point, which parses parameters and runs the checker.  
**Parameters**:
- `args` (List[str], optional): A list of command-line arguments.
- `error` (bool, optional): Whether to exit the program when an error occurs.

**Return Value**:
- When `error` is `False`, it returns a list of errors.
- Otherwise, it does not return (it may directly exit the program).

**Example**:
```python
from pylama.main import shell
# Equivalent to the command line: pylama file1.py file2.py
shell(['file1.py', 'file2.py'])
```

#### 10. Code Checkers

##### `LINTERS`
**Constant**: `LINTERS: Dict[str, Type[LinterV2]]`  
**Location**: `pylama.lint`  
**Description**: A dictionary of registered code checkers, where the key is the checker name and the value is the checker class.

**Example**:
```python
from pylama.lint import LINTERS
# Get the names of all registered checkers
linter_names = list(LINTERS.keys())
```

##### `run`
**Function**: `run(path: str, code: str = None, rootdir: Path = CURDIR, options: Namespace = None) -> List[Error]`  
**Location**: `pylama.core`  
**Function**: Run the code checker to check the code at the specified path.  
**Parameters**:
- `path` (str): The file path.
- `code` (str, optional): The code string to be directly checked.
- `rootdir` (Path, optional): The root directory, used for parsing relative paths.
- `options` (Namespace, optional): Configuration options.

**Return Value**: `List[Error]` - A list of errors found during the check.

**Example**:
```python
from pylama.core import run
errors = run('file.py')
```

#### 11. Git Hooks

##### `git_hook`
**Function**: `git_hook(complexity: int = -1, strict: bool = False, linters: str = "pycodestyle,mccabe,pyflakes") -> int`  
**Location**: `pylama.hook`  
**Function**: Install the Git pre-commit hook.  
**Parameters**:
- `complexity` (int, optional): The maximum allowed complexity (-1 means no limit).
- `strict` (bool, optional): Whether to use strict mode (prevent commits when errors are found).
- `linters` (str, optional): A list of checkers to use, separated by commas.

**Return Value**: `int` - The exit code (0 indicates success).

**Example**:
```python
from pylama.hook import git_hook
# Install the Git pre-commit hook
git_hook(complexity=10, strict=True)
```

#### 12. Detailed Description of Configuration Classes

##### 12.1. Global Configuration Options

**Basic Configuration**:

```python
# Basic options
linters: List[str] = ["pycodestyle", "pyflakes", "mccabe"]  # List of enabled checkers
paths: List[str] = ["."]  # List of check paths
ignore: List[str] = []  # List of error codes to ignore
select: List[str] = []  # List of error codes to select only
skip: List[str] = []  # List of file patterns to skip

# Output control
format: str = "pycodestyle"  # Output format
verbose: bool = False  # Verbose output mode
abspath: bool = False  # Use absolute paths
sort: str = "F,E,W,C,D"  # Error sorting order

# Performance configuration
concurrent: bool = False  # Asynchronous checking mode
max_line_length: int = 79  # Maximum line length
max_complexity: int = 10  # Maximum cyclomatic complexity
```

##### 12.2. Linter-specific Configuration

**pycodestyle Configuration**:

```python
# [pylama:pycodestyle] or [tool.pylama.linter.pycodestyle]
max_line_length: int = 79
hang_closing: bool = True
ignore: List[str] = ["E203", "W503"]
select: List[str] = []
```

**pylint Configuration**:

```python
# [pylama:pylint] or [tool.pylama.linter.pylint]
max_line_length: int = 79
disable: List[str] = ["R", "C0111"]
confidence: str = "HIGH"
```

**mccabe Configuration**:

```python
# [pylama:mccabe] or [tool.pylama.linter.mccabe]
max_complexity: int = 10
```

##### 12.3. File-specific Configuration

**Configuration by File Path**:

```python
# [pylama:*/tests/*] or [[tool.pylama.files]]
path: str = "*/tests/*"
ignore: List[str] = ["D100", "D101"]
linters: List[str] = ["pyflakes", "pycodestyle"]
skip: bool = False
```

### Actual Usage Modes

#### Basic Programming Interface Usage

```python
from pylama.main import check_paths, parse_options

# Basic check
options = parse_options()
errors = check_paths(["./src"], options)

for error in errors:
    print(f"{error['filename']}:{error['lnum']}:{error['col']} "
          f"{error['type']} {error['text']}")
```

#### Custom Configuration Usage

```python
from pylama.main import check_paths, parse_options

# Custom configuration
custom_options = {
    'linters': ['pycodestyle', 'pyflakes', 'mccabe'],
    'ignore': ['E203', 'W503'],
    'max_line_length': 100,
    'max_complexity': 15
}

options = parse_options(**custom_options)
errors = check_paths(["./myproject"], options)
```

### Supported Checker Types

- **Code Style Checking**: pycodestyle (PEP8), autopep8 compatibility check
- **Static Analysis**: pyflakes (import, variable, syntax errors)
- **Complexity Calculation**: mccabe (cyclomatic complexity), radon (multi-dimensional code metrics)
- **Documentation Checking**: pydocstyle (PEP257 docstring specification)
- **Type Checking**: mypy (static type annotation verification)
- **Import Checking**: isort (import statement sorting and grouping)
- **Code Cleaning**: eradicate (commented dead code), vulture (unused code)
- **Comprehensive Analysis**: pylint (comprehensive static analysis and style check)

### Error Handling

The system provides a comprehensive error handling mechanism:

- **Configuration Validation**: Check the syntax and option validity of the configuration file.
- **File Access Handling**: Gracefully handle file read permissions and encoding issues.
- **Linter Error Isolation**: The failure of a single checker does not affect the operation of other checkers.
- **Exception Logging**: Record detailed exception information during the checking process.

### Important Notes

1. **Configuration Priority**: Command-line parameters > File-specific configuration > Linter-specific configuration > Global configuration.
2. **Asynchronous Mode Limitation**: pylint does not support the asynchronous mode. When `concurrent` is enabled, pylint will be automatically disabled.
3. **File Encoding Handling**: UTF-8 encoding is used by default, and encoding declaration detection is supported.
4. **Performance Optimization Suggestions**: It is recommended to enable the `concurrent` mode and appropriate file filtering rules for large projects.

## Detailed Function Implementation Nodes

### 1. Code Check Executor (Core Runner)

**Function Description**: Perform the core function of code checking, supporting both synchronous and asynchronous checks.

**Input and Output Types**:
- Input:
  - `path` (str): The file path.
  - `code` (str, optional): The code string to be directly checked.
  - `options` (Namespace, optional): Configuration options.
  - `rootdir` (Path, optional): The root directory, used for parsing relative paths.
- Output: `List[Error]` - A list of errors found during the check.

**Test Interface and Example**:

```python
# Synchronous check
from pylama.core import run

# Check a file
errors = run('dummy.py')

# Check a code string
errors = run('filename.py', code="undefined_call()")

# Use custom options
from pylama.config import parse_options
options = parse_options(['--select=E301', '--ignore=D100'])
errors = run('dummy.py', options=options)

# Error handling
for error in errors:
    print(f"{error.filename}:{error.lnum}:{error.col} {error.text} ({error.source})")

# Asynchronous check
from pylama.check_async import check_async

# Asynchronously check multiple files
errors = check_async(['file1.py', 'file2.py'])
```

### 2. Code Checkers

#### 2.1. pycodestyle Checker

**Function Description**: Check whether Python code complies with the PEP 8 style guide.

**Configuration Options**:
- `max_line_length` (int): The maximum line length, default is 79.
- `ignore` (List[str]): A list of error codes to ignore.
- `select` (List[str]): A list of error codes to check only.

**Test Interface and Example**:

```python
from pylama.lint import LINTERS

# Get the pycodestyle checker
pycodestyle = LINTERS["pycodestyle"]()

# Create a checking context
ctx = create_context()

# Run the check
pycodestyle.run_check(ctx)

# Get the errors
errors = ctx.errors
```

#### 2.2. mccabe Checker

**Function Description**: Check code complexity.

**Configuration Options**:
- `max-complexity` (int): The maximum allowed complexity, default is 10.

**Test Interface and Example**:

```python
from pylama.lint import LINTERS

# Get the mccabe checker
mccabe = LINTERS["mccabe"]()

# Set the maximum complexity
ctx = create_context(mccabe={"max-complexity": 3})

# Run the check
mccabe.run_check(ctx)

# Get the complexity errors
errors = ctx.errors
```

#### 2.3. pydocstyle Checker

**Function Description**: Check whether docstrings comply with the specification.

**Configuration Options**:
- `convention` (str): The documentation style, such as "numpy" or "google".
- `ignore` (List[str]): A list of error codes to ignore.
- `select` (List[str]): A list of error codes to check only.

**Test Interface and Example**:

```python
from pylama.lint import LINTERS

# Get the pydocstyle checker
pydocstyle = LINTERS["pydocstyle"]()

# Use the numpy documentation style
ctx = create_context(pydocstyle={"convention": "numpy"})

# Run the check
pydocstyle.run_check(ctx)

# Get the documentation errors
errors = ctx.errors
```

### 3. Command-line Interface

#### 3.1. `shell` Function

**Function Description**: Provide a command-line interface to parse parameters and run the checker.

**Parameters**:
- `args` (List[str], optional): A list of command-line arguments.
- `error` (bool, optional): Whether to exit the program when an error occurs, default is `True`.

**Test Interface and Example**:

```python
from pylama.main import shell

# Basic usage
shell(['dummy.py'])

# Specify options
shell(['--select=E301', '--ignore=D100', 'dummy.py'])

# Do not exit the program and return the error list
errors = shell(['dummy.py'], error=False)
```

### 4. Version Control Integration

#### 4.1. Git Hooks

**Function Description**: Provide Git pre-commit hook functionality.

**Parameters**:
- `complexity` (int): The maximum allowed complexity, -1 means no limit.
- `strict` (bool): Whether to prevent commits when errors are found.
- `linters` (str): A list of checkers to use, separated by commas.

**Test Interface and Example**:

```python
from pylama.hook import git_hook

# Install the Git hook
git_hook(complexity=10, strict=True, linters="pycodestyle,mccabe")

# Check but do not prevent commits
git_hook(complexity=10, strict=False)
```

#### 4.2. Mercurial Hooks

**Function Description**: Provide Mercurial hook functionality.

**Parameters**:
- `ui`: The Mercurial UI object.
- `repo`: The Mercurial repository object.

**Test Interface and Example**:

```python
from pylama.hook import hg_hook

# Install the Mercurial hook
result = hg_hook(None, {})
assert result is False  # Returning False indicates successful hook execution
```

### 5. Context Management

#### 5.1. `RunContext` Class

**Function Description**: Manage the context of code checking, including configuration, error collection, etc.

**Main Methods**:
- `push()`: Add an error to the context.
- `get_params()`: Get the parameters for a specific checker.
- `update_params()`: Update the parameters.

**Test Interface and Example**:

```python
# Create a context
ctx = create_context()

# Add an error
ctx.push(
    lnum=10,
    col=5,
    text="Undefined name 'foo'",
    number="F821",
    type="F",
    source="pyflakes"
)

# Get the checker parameters
params = ctx.get_params("pycodestyle")

# Update the parameters
ctx.update_params(select={"E301"}, ignore={"W503"})
```

### 6. Error Handling

#### 6.1. `Error` Class

**Function Description**: Represent a code checking error.

**Attributes**:
- `filename` (str): The file name.
- `lnum` (int): The line number.
- `col` (int): The column number.
- `number` (str): The error code.
- `text` (str): The error message.
- `type` (str): The error type ('E' for error, 'W' for warning, etc.).
- `source` (str): The error source (e.g., 'pycodestyle', 'pylint', etc.).

**Test Interface and Example**:

```python
from pylama.errors import Error

# Create an error object
error = Error(
    filename="test.py",
    lnum=10,
    col=5,
    text="Undefined name 'foo'",
    number="F821",
    type="F",
    source="pyflakes"
)

# Format and output
print(str(error))  # "test.py:10:5: F821 undefined name 'foo' (pyflakes)"
```

#### 6.2. `remove_duplicates` Function

**Function Description**: Remove duplicate items from the error list.

**Parameters**:
- `errors` (List[Error]): The error list.

**Return Value**: `List[Error]` - The error list after removing duplicates.

**Test Interface and Example**:

```python
from pylama.errors import Error, remove_duplicates

# Create duplicate errors
error1 = Error(source="pycodestyle", text="E701")
error2 = Error(source="pylint", text="C0321")  # Duplicate with E701
errors = [error1, error2]

# Remove duplicates
unique_errors = list(remove_duplicates(errors))
assert len(unique_errors) == 1
```

### 7. Configuration Management

#### 7.1. Configuration File Parsing

**Function Description**: Parse configuration files (such as pylama.ini, setup.cfg, etc.).

**Supported File Formats**:
- INI format
- TOML format (pyproject.toml)

**Test Interface and Example**:

```python
from pylama.config import get_config

# Load the configuration
config = get_config()

# Get the configuration for a specific checker
pycodestyle_config = config.get("pycodestyle", {})
```

#### 7.2. Command-line Parameter Parsing

**Function Description**: Parse command-line parameters.

**Common Options**:
- `--select`: Check only the specified error codes.
- `--ignore`: Ignore the specified error codes.
- `--linters`: Specify the checkers to use.
- `--max-line-length`: Set the maximum line length.
- `--config`: Specify the configuration file.

**Test Interface and Example**:

```python
from pylama.config import parse_options

# Parse command-line parameters
options = parse_args([
    '--select=E301,W503',
    '--ignore=D100',
    '--linters=pycodestyle,mccabe',
    'dummy.py'
])

# Use the parsed options
print(options.select)    # {'E301', 'W503'}
print(options.ignore)    # {'D100'}
print(options.linters)   # ['pycodestyle', 'mccabe']
```

### 8. Repository Symbols (from log)

#### 8 Class Message

**Function description**: Container for lint message metadata (dummy messages used for testing/illustration).

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class Message(object):
    def __init__(self, filename, loc, use_column): ...
    def __str__(self): ...
```

**Input-output examples**:

```python
msg = Message(filename="file.py", loc=(10, 4), use_column=True)
str(msg)
```

#### 9 Class UnusedImport

**Function description**: Represents an unused import warning.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class UnusedImport(Message):
    def __init__(self, filename, lineno, name): ...
```

**Input-output examples**:

```python
UnusedImport("m.py", 3, "os")
```

#### 10 Class RedefinedWhileUnused

**Function description**: Variable redefined while previously unused.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class RedefinedWhileUnused(Message):
    def __init__(self, filename, lineno, name, orig_lineno): ...
```

**Input-output examples**:

```python
RedefinedWhileUnused("m.py", 7, "x", 2)
```

#### 11 Class ImportShadowedByLoopVar

**Function description**: Import name shadowed by a loop variable.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class ImportShadowedByLoopVar(Message):
    def __init__(self, filename, lineno, name, orig_lineno): ...
```

**Input-output examples**:

```python
ImportShadowedByLoopVar("m.py", 12, "item", 5)
```

#### 12 Class ImportStarUsed

**Function description**: Use of wildcard import.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class ImportStarUsed(Message):
    def __init__(self, filename, lineno, modname): ...
```

**Input-output examples**:

```python
ImportStarUsed("m.py", 1, "module")
```

#### 13 Class UndefinedName

**Function description**: Use of an undefined name.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class UndefinedName(Message):
    def __init__(self, filename, lineno, name): ...
```

**Input-output examples**:

```python
UndefinedName("m.py", 20, "value")
```

#### 14 Class UndefinedExport

**Function description**: Undefined name in exports.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class UndefinedExport(Message):
    def __init__(self, filename, lineno, name): ...
```

**Input-output examples**:

```python
UndefinedExport("m.py", 22, "__all__item")
```

#### 15 Class UndefinedLocal

**Function description**: Local variable used before assignment.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class UndefinedLocal(Message):
    def __init__(self, filename, lineno, name, orig_lineno): ...
```

**Input-output examples**:

```python
UndefinedLocal("m.py", 15, "x", 9)
```

#### 16 Class DuplicateArgument

**Function description**: Duplicate function argument name.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class DuplicateArgument(Message):
    def __init__(self, filename, lineno, name): ...
```

**Input-output examples**:

```python
DuplicateArgument("m.py", 33, "arg")
```

#### 17 Class RedefinedFunction

**Function description**: Function redefined from earlier definition.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class RedefinedFunction(Message):
    def __init__(self, filename, lineno, name, orig_lineno): ...
```

**Input-output examples**:

```python
RedefinedFunction("m.py", 40, "foo", 10)
```

#### 18 Class LateFutureImport

**Function description**: __future__ import not at top of file.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class LateFutureImport(Message):
    def __init__(self, filename, lineno, names): ...
```

**Input-output examples**:

```python
LateFutureImport("m.py", 2, ["annotations"])
```

#### 19 Class UnusedVariable

**Function description**: Assigned variable never used.

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class UnusedVariable(Message):
    def __init__(self, filename, lineno, names): ...
```

**Input-output examples**:

```python
UnusedVariable("m.py", 25, ["tmp"])
```

#### 20 Class BadTyping

**Function description**: Demonstrates a typing-related issue (dummy example).

**Function interfaces**:

```python
# file: pylama-develop/dummy.py
class BadTyping(Message):
    def bad_method(self): ...
```

**Input-output examples**:

```python
BadTyping().bad_method()
```

#### 21 Class _Default

**Function description**: Wrapper for default configuration values.

**Function interfaces**:

```python
# file: pylama-develop/pylama/config.py
class _Default:
    def __init__(self, value=None): ...
    def __str__(self): ...
    def __repr__(self): ...
```

**Input-output examples**:

```python
d = _Default("auto"); str(d); repr(d)
```

#### 22 Class PylamaError

**Function description**: Error raised by pytest plugin when checks fail.

**Function interfaces**:

```python
# file: pylama-develop/pylama/pytest.py
class PylamaError(Exception): ...
```

**Input-output examples**:

```python
try:
    raise PylamaError("failed")
except PylamaError:
    pass
```

#### 23 Class PylamaFile

**Function description**: Pytest file node to collect pylama test item.

**Function interfaces**:

```python
# file: pylama-develop/pylama/pytest.py
class PylamaFile(pytest.File):
    def collect(self): ...
```

**Input-output examples**:

```python
# Used by pytest collection
```

#### 24 Class PylamaItem

**Function description**: Pytest item that runs pylama on a file.

**Function interfaces**:

```python
# file: pylama-develop/pylama/pytest.py
class PylamaItem(pytest.Item):
    def __init__(self, *args, **kwargs): ...
    def setup(self): ...
    def runtest(self): ...
    def repr_failure(self, excinfo, style=None): ...
```

**Input-output examples**:

```python
# Created by PylamaFile.collect()
```

#### 25 Class Scanner

**Function description**: Split a code string into tokens (INI utils).

**Function interfaces**:

```python
# file: pylama-develop/pylama/libs/inirama.py
class Scanner:
    def __init__(self, source, ignore=None, patterns=None): ...
    def reset(self, source): ...
    def scan(self): ...
    def pre_scan(self): ...
    def __repr__(self): ...
```

**Input-output examples**:

```python
sc = Scanner(source="[s]\na=1\n")
sc.scan()
```

#### 26 Class INIScanner

**Function description**: INI-specific scanner with predefined patterns.

**Function interfaces**:

```python
# file: pylama-develop/pylama/libs/inirama.py
class INIScanner(Scanner):
    def pre_scan(self): ...
```

**Input-output examples**:

```python
INIScanner(source="[core]").pre_scan()
```

#### 27 Class Section

**Function description**: Ordered mapping representing an INI section.

**Function interfaces**:

```python
# file: pylama-develop/pylama/libs/inirama.py
class Section(OrderedDict):
    def __init__(self, namespace, *args, **kwargs): ...
    def __setitem__(self, name, value): ...
```

**Input-output examples**:

```python
sec = Section(namespace="tool.pylama")
sec["linters"] = ["pyflakes"]
```

#### 28 Class InterpolationSection

**Function description**: Section with interpolation and raw access controls.

**Function interfaces**:

```python
# file: pylama-develop/pylama/libs/inirama.py
class InterpolationSection(Section):
    def get(self, name, default=None): ...
    def __interpolate__(self, math): ...
    def __getitem__(self, name, raw=False): ...
    def iteritems(self, raw=False): ...
```

**Input-output examples**:

```python
isec = InterpolationSection(namespace="tool.pylama")
val = isec.get("key", "")
```

#### 29 Class InterpolationNamespace

**Function description**: Namespace that enables interpolation by using InterpolationSection.

**Function interfaces**:

```python
# file: pylama-develop/pylama/libs/inirama.py
class InterpolationNamespace(Namespace):
    ...
```

**Input-output examples**:

```python
InterpolationNamespace()
```

#### 30 Class _MyPyMessage

**Function description**: Internal mypy message wrapper.

**Function interfaces**:

```python
# file: pylama-develop/pylama/lint/pylama_mypy.py
class _MyPyMessage:
    def __init__(self, line): ...
```

**Input-output examples**:

```python
_MyPyMessage(line="path:1: note: message")
```

#### 31 Class _PycodestyleReport

**Function description**: Custom report class to capture pycodestyle errors.

**Function interfaces**:

```python
# file: pylama-develop/pylama/lint/pylama_pycodestyle.py
class _PycodestyleReport(BaseReport):
    def error(self, line_number, offset, text, _): ...
```

**Input-output examples**:

```python
rep = _PycodestyleReport(options=None)
rep.error(10, 4, "E123 msg", None)
```

#### 32 Class _Params (pylint)

**Function description**: Helper to prepare and map pylint params to CLI args.

**Function interfaces**:

```python
# file: pylama-develop/pylama/lint/pylama_pylint.py
class _Params:
    def __init__(self, params): ...
    def prepare_value(value): ...
    def to_attrs(self): ...
    def __str__(self): ...
    def __repr__(self): ...
```

**Input-output examples**:

```python
p = _Params({"disable": ["C0111"]}); p.to_attrs()
```

#### 33 Class LinterMeta

**Function description**: Metaclass that builds linter classes with parameters.

**Function interfaces**:

```python
# file: pylama-develop/pylama/lint/__init__.py
class LinterMeta(type):
    def __new__(mcs, name, bases, params): ...
```

**Input-output examples**:

```python
# Used internally to construct linter classes
```


#### 34 Constants from repository

**Function description**: Constants used across modules.

**Function interfaces**:

```python
# file: pylama-develop/setup.py
OPTIONAL_LINTERS = ['pylint', 'eradicate', 'radon', 'mypy', 'vulture']

# file: pylama-develop/pylama/__init__.py
import logging
LOGGER = logging.getLogger("pylama")

# file: pylama-develop/pylama/check_async.py
LOGGER = logging.getLogger("pylama")

# file: pylama-develop/pylama/config.py
DEFAULT_LINTERS = ("pycodestyle", "pyflakes", "mccabe")
from pathlib import Path
HOMECFG = Path.home() / ".pylama.ini"
STREAM = logging.StreamHandler(sys.stdout)
DEFAULT_CONFIG_FILE = get_default_config_file(CURDIR)

# file: pylama-develop/pylama/context.py
MODELINE_RE = re.compile(r"^\s*#\s+(?:pylama:)\s*((?:[\w_]*=[^:\n\s]+:?)+)", re.I | re.M).search
SKIP_PATTERN = re.compile(r"# *noqa\\b", re.I).search

# file: pylama-develop/pylama/errors.py
PATTERN_NUMBER = re.compile(r"^\s*([A-Z]\d+)\s*", re.I)
DUPLICATES = {  # Mapping of duplicate error codes between linters
    # multiple statements on one line
    ("pycodestyle", "E701"): {("pylint", "C0321")},
    # unused variable
    ("pylint", "W0612"): {("pyflakes", "W0612")},
    # undefined variable
    ("pylint", "E0602"): {("pyflakes", "E0602")},
    # unused import
    ("pylint", "W0611"): {("pyflakes", "W0611")},
    # whitespace before ')'
    ("pylint", "C0326"): {("pycodestyle", "E202")},
    # whitespace before '('
    ("pylint", "C0326"): {("pycodestyle", "E211")},
    # multiple spaces after operator
    ("pylint", "C0326"): {("pycodestyle", "E222")},
    # missing whitespace around operator
    ("pylint", "C0326"): {("pycodestyle", "E225")},
    # unexpected spaces
    ("pylint", "C0326"): {("pycodestyle", "E251")},
    # long lines
    ("pylint", "C0301"): {("pycodestyle", "E501")},
    # statement ends with a semicolon
    ("pylint", "W0301"): {("pycodestyle", "E703")},
    # multiple statements on one line
    ("pylint", "C0321"): {("pycodestyle", "E702")},
    # bad indentation
    ("pylint", "W0311"): {("pycodestyle", "E111")},
    # wildcart import
    ("pylint", "W00401"): {("pyflakes", "W0401")},
    # module docstring
    ("pydocstyle", "D100"): {("pylint", "C0111")},
}

# file: pylama-develop/pylama/main.py
DEFAULT_FORMAT = "{filename}:{lnum}:{col} [{etype}] {number} {message} [{source}]"
MESSAGE_FORMATS = {
    "pylint": "{filename}:{lnum}: [{etype}] {number} {message} [{source}]",
    "pycodestyle": "{filename}:{lnum}:{col} {number} {message} [{source}]",
    "parsable": DEFAULT_FORMAT,
}

# file: pylama-develop/pylama/pytest.py
HISTKEY = "pylama/mtimes"

# file: pylama-develop/pylama/libs/inirama.py
__version__ = "0.8.0"  # Module version
__project__ = "Inirama"  # Project name
__author__ = "Kirill Klenov <horneds@gmail.com>"  # Author information
__license__ = "BSD"  # License type
NS_LOGGER = logging.getLogger('inirama')  # Logger instance

# file: pylama-develop/pylama/lint/pylama_pyflakes.py
CODES = { ... }  # mapping from pyflakes message templates to codes

# file: pylama-develop/pylama/lint/pylama_pylint.py
HOME_RCFILE = Path(environ.get("HOME", "")) / ".pylintrc"
```

**Input-output examples**:

```python
from pylama.config import DEFAULT_LINTERS
assert "pyflakes" in DEFAULT_LINTERS
```

#### 35 Function groups

**Function description**: Grouped functions by purpose. Each group lists related interfaces.

##### 35.1 Configuration parsing and setup

**Function interfaces**:


###### setup_parser

- Purpose: Build CLI argument parser and register linter-specific options.
- Parameters: None
- Returns: ArgumentParser

```python
def setup_parser() -> ArgumentParser:
    """Create and setup parser for command line."""
    parser = ArgumentParser(description="Code audit tool for python.")
    parser.add_argument(
        "paths",
        nargs="*",
        default=_Default([CURDIR.as_posix()]),
        help="Paths to files or directories for code check.",
    )
    parser.add_argument(
        "--version", action="version", version="%(prog)s " + __version__
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose mode.")
    parser.add_argument(
        "--options",
        "-o",
        default=DEFAULT_CONFIG_FILE,
        metavar="FILE",
        help=(
            "Specify configuration file. "
            f"Looks for {', '.join(CONFIG_FILES[:-1])}, or {CONFIG_FILES[-1]}"
            f" in the current directory (default: {DEFAULT_CONFIG_FILE})"
        ),
    )
    parser.add_argument(
        "--linters",
        "-l",
        default=_Default(",".join(DEFAULT_LINTERS)),
        type=parse_linters,
        help=(
            f"Select linters. (comma-separated). Choices are {','.join(s for s in LINTERS)}."
        ),
    )
    parser.add_argument(
        "--from-stdin",
        action="store_true",
        help="Interpret the stdin as a python script, "
        "whose filename needs to be passed as the path argument.",
    )
    parser.add_argument(
        "--concurrent",
        "--async",
        action="store_true",
        help="Enable async mode. Useful for checking a lot of files. ",
    )

    parser.add_argument(
        "--format",
        "-f",
        default=_Default("pycodestyle"),
        choices=["pydocstyle", "pycodestyle", "pylint", "parsable", "json"],
        help="Choose output format.",
    )
    parser.add_argument(
        "--abspath",
        "-a",
        action="store_true",
        default=_Default(False),
        help="Use absolute paths in output.",
    )
    parser.add_argument(
        "--max-line-length",
        "-m",
        default=_Default(100),
        type=int,
        help="Maximum allowed line length",
    )
    parser.add_argument(
        "--select",
        "-s",
        default=_Default(""),
        type=split_csp_str,
        help="Select errors and warnings. (comma-separated list)",
    )
    parser.add_argument(
        "--ignore",
        "-i",
        default=_Default(""),
        type=split_csp_str,
        help="Ignore errors and warnings. (comma-separated)",
    )
    parser.add_argument(
        "--skip",
        default=_Default(""),
        type=lambda s: [re.compile(fnmatch.translate(p)) for p in s.split(",") if p],
        help="Skip files by masks (comma-separated, Ex. */messages.py)",
    )
    parser.add_argument(
        "--sort",
        default=_Default(),
        type=prepare_sorter,
        help="Sort result by error types. Ex. E,W,D",
    )
    parser.add_argument("--report", "-r", help="Send report to file [REPORT]")
    parser.add_argument(
        "--hook", action="store_true", help="Install Git (Mercurial) hook."
    )

    for linter_type in LINTERS.values():
        linter_type.add_args(parser)

    return parser
```

###### parse_options

- Purpose: Parse CLI and configuration files, apply overrides, and finalize options.
- Parameters: args (list[str] | None), config (bool), rootdir (Path), overrides (kwargs)
- Returns: Namespace

```python
def parse_options(  # noqa
    args: List[str] = None, config: bool = True, rootdir: Path = CURDIR, **overrides
) -> Namespace:
    """Parse options from command line and configuration files."""
    # Parse args from command string
    parser = setup_parser()
    actions = dict(
        (a.dest, a) for a in parser._actions
    )  # pylint: disable=protected-access

    options = parser.parse_args(args or [])
    options.file_params = {}
    options.linters_params = {}

    # Compile options from ini
    if config:
        cfg = get_config(options.options, rootdir=rootdir)
        for opt, val in cfg.default.items():
            LOGGER.info("Find option %s (%s)", opt, val)
            passed_value = getattr(options, opt, _Default())
            if isinstance(passed_value, _Default):
                if opt == "paths":
                    val = val.split()
                if opt == "skip":
                    val = fix_pathname_sep(val)
                setattr(options, opt, _Default(val))

        # Parse file related options
        for name, opts in cfg.sections.items():

            if name == cfg.default_section:
                continue

            if name.startswith("pylama"):
                name = name[7:]

            if name in LINTERS:
                options.linters_params[name] = dict(opts)
                continue

            mask = re.compile(fnmatch.translate(fix_pathname_sep(name)))
            options.file_params[mask] = dict(opts)

    # Override options
    for opt, val in overrides.items():
        setattr(options, opt, process_value(actions, opt, val))

    # Postprocess options
    for name in options.__dict__:
        value = getattr(options, name)
        if isinstance(value, _Default):
            setattr(options, name, process_value(actions, name, value.value))

    if options.concurrent and "pylint" in options.linters:
        LOGGER.warning("Can't parse code asynchronously with pylint enabled.")
        options.concurrent = False

    return options
```

###### process_value

- Purpose: Convert raw values according to parser action types/const.
- Parameters: actions (dict), name (str), value (any)
- Returns: any converted value

```python
def process_value(actions: Dict, name: str, value: Any) -> Any:
    """Compile option value."""
    action = actions.get(name)
    if not action:

        return value

    if callable(action.type):
        return action.type(value)

    if action.const:
        return bool(int(value))

    return value
```

###### get_config_ini

- Purpose: Read INI configuration into an inirama.Namespace.
- Parameters: ini_path (str)
- Returns: inirama.Namespace

```python
def get_config_ini(ini_path: str) -> inirama.Namespace:
    """Load configuration from INI."""
    config = inirama.Namespace()
    config.default_section = DEFAULT_SECTION
    config.read(ini_path)

    return config
```

###### get_config_toml

- Purpose: Read TOML configuration into an inirama.Namespace.
- Parameters: toml_path (str)
- Returns: inirama.Namespace

```python
def get_config_toml(toml_path: str) -> inirama.Namespace:
    """Load configuration from TOML."""
    config = config_toml.Namespace()
    config.default_section = DEFAULT_SECTION
    config.read(toml_path)

    return config
```

###### get_default_config_file

- Purpose: Find default configuration file under rootdir.
- Parameters: rootdir (Path | None)
- Returns: str | None path

```python
def get_default_config_file(rootdir: Path = None) -> Optional[str]:
    """Search for configuration file."""
    if rootdir is None:
        return DEFAULT_CONFIG_FILE

    for filename in CONFIG_FILES:
        path = rootdir / filename
        if path.is_file() and os.access(path, os.R_OK):
            return path.as_posix()

    return None
```

###### split_csp_str

- Purpose: Split comma-separated string/collection into unique set while keeping order.
- Parameters: val (str | Collection[str])
- Returns: set[str]

```python
def split_csp_str(val: Union[Collection[str], str]) -> Set[str]:
    """Split comma separated string into unique values, keeping their order."""
    if isinstance(val, str):
        val = val.strip().split(",")
    return set(x for x in val if x)
```

###### prepare_sorter

- Purpose: Map error types to sorting order indices.
- Parameters: val (str | Collection[str])
- Returns: dict[str, int] | None

```python
def prepare_sorter(val: Union[Collection[str], str]) -> Optional[Dict[str, int]]:
    """Parse sort value."""
    if val:
        types = split_csp_str(val)
        return dict((v, n) for n, v in enumerate(types, 1))

    return None
```

###### parse_linters

- Purpose: Filter and keep only supported linters.
- Parameters: linters (str)
- Returns: list[str]

```python
def parse_linters(linters: str) -> List[str]:
    """Initialize choosen linters."""
    return [name for name in split_csp_str(linters) if name in LINTERS]
```

###### setup_logger

- Purpose: Configure logging level and handlers based on options.
- Parameters: options (Namespace)
- Returns: None

```python
def setup_logger(options: Namespace):
    """Do the logger setup with options."""
    LOGGER.setLevel(logging.INFO if options.verbose else logging.WARN)
    if options.report:
        LOGGER.removeHandler(STREAM)
        LOGGER.addHandler(logging.FileHandler(options.report, mode="w"))

    if options.options:
        LOGGER.info("Try to read configuration from: %r", options.options)
```

###### fix_pathname_sep

- Purpose: Normalize path separators for Windows/Posix.
- Parameters: val (str)
- Returns: str

```python
def fix_pathname_sep(val: str) -> str:
    """Fix pathnames for Win."""
    return val.replace(os.altsep or "\\", os.sep)
```
##### 35.2 Checking execution (sync/async) and reporting

###### worker

- Purpose: Process-pool worker that invokes core run to check a single path.
- Parameters: params (tuple) → (path, code, options, rootdir)
- Returns: list[Error]

```python
def worker(params):
    """Do work."""
    path, code, options, rootdir = params
    return run(path, code=code, rootdir=rootdir, options=options)
```

###### check_async

- Purpose: Check given paths concurrently using ProcessPoolExecutor.
- Parameters: paths (list[str]), code (str|None), options (Namespace|None), rootdir (Path|None)
- Returns: list[Error]

```python
def check_async(
    paths: List[str], code: str = None, options: Namespace = None, rootdir: Path = None
) -> List[Error]:
    """Check given paths asynchronously."""
    with ProcessPoolExecutor(CPU_COUNT) as pool:
        return [
            err
            for res in pool.map(
                worker, [(path, code, options, rootdir) for path in paths]
            )
            for err in res
        ]
```

###### display_errors

- Purpose: Format and display errors according to selected output format.
- Parameters: errors (list[Error]), options (Namespace)
- Returns: None

```python
def display_errors(errors: List[Error], options: Namespace):
    """Format and display the given errors."""
    if options.format == "json":
        LOGGER.warning(dumps([err.to_dict() for err in errors]))

    else:
        pattern = MESSAGE_FORMATS.get(options.format, DEFAULT_FORMAT)
        for err in errors:
            LOGGER.warning(err.format(pattern))
```

###### get_lines

- Purpose: Read a string as lines.
- Parameters: value (str)
- Returns: list[str]

```python
def get_lines(value: str) -> List[str]:
    """Return lines from the given string."""
    return StringIO(value).readlines()
```

###### read_stdin

- Purpose: Read bytes from stdin and decode as UTF-8 string.
- Parameters: None
- Returns: str

```python
def read_stdin() -> str:
    """Get value from stdin."""
    value = stdin.buffer.read()
    return value.decode("utf-8")
```

###### default_sorter

- Purpose: Sorting key function by error line number.
- Parameters: err (Error)
- Returns: int line number

```python
def default_sorter(err: Error) -> Any:
    """Sort by line number."""
    return err.lnum
```

##### 35.3 Pytest plugin integration

###### pytest_load_initial_conftests

- Purpose: Register the pylama/pycodestyle marker during pytest initialization.
- Parameters: early_config (pytest early config), *_ ignored
- Returns: None

```python
def pytest_load_initial_conftests(early_config, *_):
    # Marks have to be registered before usage
    # to not fail with --strict command line argument
    early_config.addinivalue_line(
        "markers", "pycodestyle: Mark test as using pylama code audit tool."
    )
```

###### pytest_addoption

- Purpose: Register the --pylama CLI option in pytest.
- Parameters: parser (pytest Parser)
- Returns: None

```python
def pytest_addoption(parser):
    group = parser.getgroup("general")
    group.addoption(
        "--pylama",
        action="store_true",
        help="perform some pylama code checks on .py files",
    )
```

###### pytest_sessionstart

- Purpose: Initialize per-session cache for pylama mtimes when --pylama is enabled.
- Parameters: session (pytest Session)
- Returns: None

```python
def pytest_sessionstart(session):
    config = session.config
    if config.option.pylama and getattr(config, "cache", None):
        config._pylamamtimes = config.cache.get(HISTKEY, {})
```

###### pytest_sessionfinish

- Purpose: Persist updated pylama mtimes to pytest cache at session end.
- Parameters: session (pytest Session)
- Returns: None

```python
def pytest_sessionfinish(session):
    config = session.config
    if hasattr(config, "_pylamamtimes"):
        config.cache.set(HISTKEY, config._pylamamtimes)
```

###### pytest_collect_file

- Purpose: Create a PylamaFile node for .py files when --pylama is enabled.
- Parameters: path (pytest path), parent (pytest Collector)
- Returns: PylamaFile | None

```python
def pytest_collect_file(path, parent):
    config = parent.config
    if config.option.pylama and path.ext == ".py":
        return PylamaFile.from_parent(parent, path=pathlib.Path(path))
    return None
```

###### check_file (pytest)

- Purpose: Parse options and run pylama on a single file; used by pytest item.
- Parameters: path (path-like)
- Returns: list[Error]

```python
def check_file(path):
    options = parse_options()
    path = op.relpath(str(path), CURDIR)
    return check_paths([path], options, rootdir=CURDIR)
```

##### 35.4 VCS hooks integration

###### install_git

- Purpose: Install pylama pre-commit hook in a Git repository.
- Parameters: path (str): path to .git/hooks
- Returns: None

```python
def install_git(path):
    """Install hook in Git repository."""
    hook = op.join(path, "pre-commit")
    with open(hook, "w", encoding="utf-8") as target:
        target.write(
            """#!/usr/bin/env python
import sys
from pylama.hook import git_hook

if __name__ == '__main__':
    sys.exit(git_hook())
"""
        )
    chmod(hook, 484)
```

###### install_hg

- Purpose: Configure Mercurial hooks to run pylama on commit/qrefresh.
- Parameters: path (str): path to .hg
- Returns: None

```python
def install_hg(path):
    """Install hook in Mercurial repository."""
    hook = op.join(path, "hgrc")
    if not op.isfile(hook):
        open(hook, "w+", encoding="utf-8").close()

    cfgp = ConfigParser()
    with open(hook, "r", encoding="utf-8") as source:
        cfgp.read_file(source)

    if not cfgp.has_section("hooks"):
        cfgp.add_section("hooks")

    if not cfgp.has_option("hooks", "commit"):
        cfgp.set("hooks", "commit", "python:pylama.hooks.hg_hook")

    if not cfgp.has_option("hooks", "qrefresh"):
        cfgp.set("hooks", "qrefresh", "python:pylama.hooks.hg_hook")

    with open(hook, "w+", encoding="utf-8") as target:
        cfgp.write(target)
```

###### install_hook

- Purpose: Auto-detect VCS and install the corresponding hook; exit with error if none.
- Parameters: path (str): repository root
- Returns: None (may exit)

```python
def install_hook(path):
    """Auto definition of SCM and hook installation."""
    is_git = op.join(path, ".git", "hooks")
    is_hg = op.join(path, ".hg")
    if op.exists(is_git):
        install_git(is_git)
        LOGGER.warning("Git hook has been installed.")

    elif op.exists(is_hg):
        install_hg(is_hg)
        LOGGER.warning("Mercurial hook has been installed.")

    else:
        LOGGER.error("VCS has not found. Check your path.")
        sys.exit(1)
```

##### 35.5 Linter-specific helpers

###### parse_params (vulture)

- Purpose: Convert pylama params dict into vulture CLI-style args and append path.
- Parameters: path (str), params (dict | None)
- Returns: list[str]

```python
    """Convert params from pylama."""
    return [f"--{key}={value}" for key, value in params.items() if value] + [path]
```

###### parse_requirements

- Purpose: Read and parse a requirements file into a list of requirement strings.
- Parameters: path (str)
- Returns: list[str]

```python
def parse_requirements(path: str) -> "list[str]":
    with pathlib.Path(path).open(encoding='utf-8') as requirements:
        return [str(req) for req in pkg_resources.parse_requirements(requirements)]
```