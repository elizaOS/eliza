# Introduction and Goals of the python-dotenv Project

## Overview

`python-dotenv` is a Python library for managing environment variables. Its core function is to read key-value pairs from a `.env` file and set them as operating system environment variables. This tool aims to help developers follow the principles of the [Twelve-Factor App](The Twelve-Factor App) and simplify the process of configuring applications in the development environment. Developers can store configurations (especially sensitive information such as passwords and API keys) in a local `.env` file instead of hard-coding them in the code or version control system. By calling `load_dotenv()` when the application starts, these variables will be loaded into the environment, allowing the code to access the configurations through `os.environ` just like in the production environment, thus achieving seamless switching between development and production environments and centralized management of configurations.

## Natural Language Instructions (Prompt)

Please create a Python project named python_dotenv, which is a Python library for managing environment variables. The project should include the following functions:
1. Environment variable loading:
 - Load environment variables from the .env file into os.environ.
 - Support loading through the load_dotenv() function.
 - Support loading environment variables from a file stream.
2. File parsing:
 - Parse the .env file format.
 - Support values with or without quotes.
 - Support inline comments.
 - Support multi-line values (using triple quotes).
3. Variable parsing:
 - Support variable interpolation (e.g., VAR1=foo and VAR2=${VAR1}/bar).
 - Support default values (e.g., ${VAR:-default}).
 - Support nested references to environment variables.
4. Command-line interface:
 - List all environment variables.
 - Get the value of a specific key.
 - Set a key-value pair.
 - Delete a key-value pair.
 - Run a command with environment variables.
5. Utility functions:
 - Find the .env file in the file system.
 - Get/set/delete a specific key-value pair.
 - Overwrite the .env file.
6. Core file requirements: The project must include a complete setup.py file, which not only configures the project as an installable package (supporting pip install) but also declares a complete list of dependencies (including core libraries such as click>=5.0, pytest, pytest-cov, ipython, twine, wheel, etc.). The setup.py can verify whether all functional modules work properly. At the same time, dotenv/__init__.py needs to be provided as a unified API entry to import and export core functions from the dotenv module, enabling users to access all major functions through simple statements like "from dotenv import get_cli_string as c" or "from dotenv.xx import xxx".

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```plain
asttokens                      3.0.0
bump2version                   1.0.1
bumpversion                    0.6.0
cachetools                     6.1.0
certifi                        2025.7.14
cffi                           1.17.1
cfgv                           3.4.0
chardet                        5.2.0
charset-normalizer             3.4.2
click                          8.2.1
colorama                       0.4.6
coverage                       7.10.1
cryptography                   45.0.5
decorator                      5.2.1
distlib                        0.4.0
docutils                       0.22
executing                      2.2.0
filelock                       3.18.0
ghp-import                     2.1.0
griffe                         1.9.0
id                             1.5.0
identify                       2.6.12
idna                           3.10
importlib_metadata             8.7.0
iniconfig                      2.1.0
ipython                        9.4.0
ipython_pygments_lexers        1.1.1
jaraco.classes                 3.4.0
jaraco.context                 6.0.1
jaraco.functools               4.2.1
jedi                           0.19.2
jeepney                        0.9.0
Jinja2                         3.1.6
keyring                        25.6.0
Markdown                       3.3.7
markdown-it-py                 3.0.0
MarkupSafe                     3.0.2
matplotlib-inline              0.1.7
mdurl                          0.1.2
mdx-truly-sane-lists           1.3
mergedeep                      1.3.4
mkdocs                         1.3.1
mkdocs-autorefs                1.4.2
mkdocs-include-markdown-plugin 3.3.0
mkdocs-material                8.2.16
mkdocs-material-extensions     1.3.1
mkdocstrings                   0.18.1
mkdocstrings-python            0.6.6
mkdocstrings-python-legacy     0.2.2
more-itertools                 10.7.0
nh3                            0.3.0
nodeenv                        1.9.1
packaging                      25.0
parso                          0.8.4
pexpect                        4.9.0
pip                            24.0
platformdirs                   4.3.8
pluggy                         1.6.0
pre_commit                     4.2.0
prompt_toolkit                 3.0.51
ptyprocess                     0.7.0
pure_eval                      0.2.3
pycparser                      2.22
Pygments                       2.19.2
pymdown-extensions             10.4
pyproject-api                  1.9.1
pytest                         8.4.1
pytest-cov                     6.2.1
python-dateutil                2.9.0.post0
pytkdocs                       0.16.5
PyYAML                         6.0.2
pyyaml_env_tag                 1.1
readme_renderer                44.0
requests                       2.32.4
requests-toolbelt              1.0.0
rfc3986                        2.0.0
rich                           14.1.0
ruff                           0.12.7
SecretStorage                  3.3.3
setuptools                     72.1.0
sh                             2.2.2
six                            1.17.0
stack-data                     0.6.3
tox                            4.28.4
traitlets                      5.14.3
twine                          6.1.0
urllib3                        2.5.0
virtualenv                     20.32.0
watchdog                       6.0.0
wcwidth                        0.2.13
wheel                          0.43.0
zipp                           3.23.0
```

## python-dotenv Project Architecture

### Project Directory Structure

```plain
workspace/
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.md
├── mkdocs.yml
├── ruff.toml
├── setup.cfg
├── setup.py
├── src
│   ├── dotenv
│   │   ├── __init__.py
│   │   ├── __main__.py
│   │   ├── cli.py
│   │   ├── ipython.py
│   │   ├── main.py
│   │   ├── parser.py
│   │   ├── py.typed
│   │   ├── variables.py
│   │   └── version.py
└── tox.ini

```

## Python-dotenv API Usage Guide

### Core API

#### 1. Module Import

```python
import dotenv
from dotenv.cli import cli as dotenv_cli
from dotenv.version import __version__
from dotenv.main import find_dotenv
from dotenv.parser import Binding, Original, parse_stream
from dotenv import get_cli_string as c
from dotenv.variables import Literal, Variable, parse_variables

```
#### 2. dotenv.cli.cli() Function - Command-Line Interface

**Function**: Provides a command-line interface (CLI) for managing environment variables.

**Function Signature**:
```python
@click.group()
@click.option('-f', '--file', default=enumerate_env(), type=click.Path(file_okay=True))
@click.option('-q', '--quote', default='always', type=click.Choice(['always', 'never', 'auto']))
@click.option('-e', '--export', is_flag=True, help='Add export prefix to .env file')
@click.pass_context
def cli(ctx, file, quote, export):
    """
    This script is used to get, set, or unset values from a .env file.
    """
    ctx.ensure_object(dict)
    ctx.obj['QUOTE'] = quote
    ctx.obj['EXPORT'] = export
    ctx.obj['FILE'] = file
```

**Parameter Description**:
 - file/-f: Specifies the path to the .env file, defaulting to the .env file in the current directory.
 - quote/-q: Quote handling method, optional values: always/never/auto.
 - export/-e: Whether to add the export prefix before exporting variables.

#### 3. dotenv.version.__version__ - Get Version Number

**Function**: Returns the current version number.

**Function Signature**:
```python
__version__ = '1.1.1'  # Returns the current version number
```

**Parameter Description**:
- None

**Return Value**: The current version number

#### 4. find_dotenv() 、_is_interactive() Function - Find the .env File

**Function**: Searches for the `.env` file in the directory hierarchy, starting from the current directory and going up to the root directory.

**Function Signature**:
```python
def find_dotenv(
    filename: str = ".env",
    raise_error_if_not_found: bool = False,
    usecwd: bool = False,
) -> str:
    """
    Search in increasingly higher folders for the given file

    Returns path to the file if found, or an empty string otherwise
    """

    def _is_interactive():
        """Decide whether this is running in a REPL or IPython notebook"""
        if hasattr(sys, "ps1") or hasattr(sys, "ps2"):
            return True
        try:
            main = __import__("__main__", None, None, fromlist=["__file__"])
        except ModuleNotFoundError:
            return False
        return not hasattr(main, "__file__")

    def _is_debugger():
        return sys.gettrace() is not None

    if usecwd or _is_interactive() or _is_debugger() or getattr(sys, "frozen", False):
        # Should work without __file__, e.g. in REPL or IPython notebook.
        path = os.getcwd()
    else:
        # will work for .py files
        frame = sys._getframe()
        current_file = __file__

        while frame.f_code.co_filename == current_file or not os.path.exists(
            frame.f_code.co_filename
        ):
            assert frame.f_back is not None
            frame = frame.f_back
        frame_filename = frame.f_code.co_filename
        path = os.path.dirname(os.path.abspath(frame_filename))

    for dirname in _walk_to_root(path):
        check_path = os.path.join(dirname, filename)
        if os.path.isfile(check_path):
            return check_path

    if raise_error_if_not_found:
        raise IOError("File not found")

    return ""
```

**Parameter Description**:
- `filename` (str): The name of the file to search for.
- `raise_error_if_not_found` (bool): Whether to raise an `IOError` if the file is not found.
- `usecwd` (bool): Whether to start the search from the current working directory.
** function **:
- `_is_interactive`
- `_is_debugger`
**Return Value**: Returns the path to the `.env` file if found, otherwise an empty string.

#### 5. dotenv.parser.Binding Class - Parsed Key-Value Pair Binding

**Function**: Represents a parsed key-value pair binding.

**Function Signature**:
```python
class Binding(NamedTuple):
    key: Optional[str]          # Key name
    value: Optional[str]        # Value
    original: Original         # Original string and line number
    error: bool                # Whether there was an error during parsing
```

**Parameter Description**:
- `key` (Optional[str]): Key name.
- `value` (Optional[str]): Value.
- `original` (Original): Original string and line number.
- `error` (bool): Whether there was an error during parsing.

**Return Value**: A parsed key-value pair binding.

#### 6. dotenv.parser.Original - Original String and Line Number

**Function**: Represents the original string and line number.

**Function Signature**:
```python
class Original(NamedTuple):
    string: str    # Original string
    line: int      # Line number
```

**Parameter Description**:
- `string` (str): Original string.
- `line` (int): Line number.

**Return Value**: The original string and line number.

#### 7. dotenv.parser.parse_stream() Function - Parse Environment Variables

**Function**: Parses environment variables from a file stream.

**Function Signature**:
```python
def parse_stream(stream: IO[str]) -> Iterator[Binding]:
    """
    Parse environment variables from a file stream.
    """
```

**Parameter Description**:
- `stream` (IO[str]): File stream.

**Return Value**: An iterator of parsed key-value pair bindings.

#### 8. dotenv.get_cli_string (Imported as c)

**Function**: Gets the command-line string. Returns a string suitable for running as a shell script. Useful for converting a arguments passed to a fabric task  to be passed to a `local` or `run` command.

**Function Signature**:
```python
def get_cli_string() -> str:
    """
    Get the command-line string.
    """
```

**Parameter Description**:
- None

**Return Value**: The command-line string.

#### 9 dotenv.variables 

##### 1. dotenv.variables.Atom - Abstract Base Class  

**Function**: Represents the base class for all variable components (atoms), either literals or variables. Provides equality comparison and requires subclasses to implement resolution.  

**Function Signature**:  
```python
class Atom(metaclass=ABCMeta):
    def __ne__(self, other: object) -> bool
    def resolve(self, env: Mapping[str, Optional[str]]) -> str
```

**Parameter Description**:  
- `env` (Mapping[str, Optional[str]]): Mapping of environment variables.  

**Return Value**:  
- `resolve()`: A resolved string value based on the environment mapping.  

---

##### 2. dotenv.variables.Literal - Literal  

**Function**: Represents a literal string component that is not subject to environment variable substitution.  

**Function Signature**:  
```python
class Literal(Atom):
    def __init__(self, value: str) -> None
    def __repr__(self) -> str
    def __eq__(self, other: object) -> bool
    def __hash__(self) -> int
    def resolve(self, env: Mapping[str, Optional[str]]) -> str
```

**Parameter Description**:  
- `value` (str): The literal string value.  

**Return Value**:  
- `resolve()`: Always returns the literal string unchanged.  

---

##### 3. dotenv.variables.Variable - Variable  

**Function**: Represents a variable reference that may be resolved using the environment mapping, with optional default values.  

**Function Signature**:  
```python
class Variable(Atom):
    def __init__(self, name: str, default: Optional[str]) -> None
    def __repr__(self) -> str
    def __eq__(self, other: object) -> bool
    def __hash__(self) -> int
    def resolve(self, env: Mapping[str, Optional[str]]) -> str
```

**Parameter Description**:  
- `name` (str): Name of the environment variable.  
- `default` (Optional[str]): Fallback value if the variable is not found.  
- `env` (Mapping[str, Optional[str]]): Environment mapping to resolve the variable.  

**Return Value**:  
- `resolve()`: Returns the variable’s value from `env` if available, otherwise uses `default`, or an empty string if both are `None`.  

---

#### 4. dotenv.variables.parse_variables() - Parse Variables  

**Function**: Parses a string and yields components (`Literal` or `Variable`) for interpolation. Supports POSIX-style variable substitution (`${VAR:-default}`).  

**Function Signature**:  
```python
def parse_variables(value: str) -> Iterator[Atom]:
    "Parse variables and literals from a string."
```

**Parameter Description**:  
- `value` (str): Input string potentially containing variable references.  

**Return Value**:  
- `Iterator[Atom]`: An iterator over `Literal` and `Variable` objects representing parsed segments.  

---

**Regex Used**:  
```python
_posix_variable = re.compile(
    r"""
    \$\{
        (?P<name>[^\}:]*)
        (?::-
            (?P<default>[^\}]*)
        )?
    \}
    """,
    re.VERBOSE,
)
```
- Matches `${VAR}` and `${VAR:-default}` syntax.  



 #### 12. load_dotenv() 
 ** Function ：**  environment variable file

**Function Signature**:
```python
def load_dotenv(
    dotenv_path: Optional[StrPath] = None,
    stream: Optional[IO[str]] = None,
    verbose: bool = False,
    override: bool = False,
    interpolate: bool = True,
    encoding: Optional[str] = "utf-8",
) -> bool:

    if _load_dotenv_disabled():
        logger.debug(
            "python-dotenv: .env loading disabled by PYTHON_DOTENV_DISABLED environment variable"
        )
        return False

    if dotenv_path is None and stream is None:
        dotenv_path = find_dotenv()

    dotenv = DotEnv(
        dotenv_path=dotenv_path,
        stream=stream,
        verbose=verbose,
        interpolate=interpolate,
        override=override,
        encoding=encoding,
    )
    return dotenv.set_as_environment_variables()
```
** Parameter Description **:
- `dotenv_path` (Optional[StrPath]): Path to the .env file.
- `stream` (Optional[IO[str]]): File stream.
- `verbose` (bool): Whether to print verbose information.
- `override` (bool): Whether to override existing environment variables.
- `interpolate` (bool): Whether to enable interpolation.
- `encoding` (Optional[str]): Encoding of the file.


**Return Value**: Boolean indicating whether the loading was successful.
#### 12. dotenv_values()
** Function ：** Used to read environment variables from. env files or streams and return a dictionary

**Function Signature**:
```python
def dotenv_values(
    dotenv_path: Optional[StrPath] = None,
    stream: Optional[IO[str]] = None,
    verbose: bool = False,
    interpolate: bool = True,
    encoding: Optional[str] = "utf-8",
) -> Dict[str, Optional[str]]:

    if dotenv_path is None and stream is None:
        dotenv_path = find_dotenv()

    return DotEnv(
        dotenv_path=dotenv_path,
        stream=stream,
        verbose=verbose,
        interpolate=interpolate,
        override=True,
        encoding=encoding,
    ).dict()
```
** Parameter Description **:
- `dotenv_path` (Optional[StrPath]): Path to the .env file.
- `stream` (Optional[IO[str]]): File stream.
- `verbose` (bool): Whether to print verbose information.
- `interpolate` (bool): Whether to enable interpolation.
- `encoding` (Optional[str]): Encoding of the file.

**Return Value**: A dictionary of parsed environment variables.
#### 13. get_key()
** Function ：** Get the value of the environment variable

**Function Signature**:
```python
def get_key(
    dotenv_path: StrPath,
    key_to_get: str,
    encoding: Optional[str] = "utf-8",
) -> Optional[str]:
    """
    Get the value of a given key from the given .env.

    Returns `None` if the key isn't found or doesn't have a value.
    """
    return DotEnv(dotenv_path, verbose=True, encoding=encoding).get(key_to_get)

```
** Parameter Description **:
- `dotenv_path` (StrPath): Path to the .env file.
- `key` (str): Key of the environment variable.
- `encoding` (str): Encoding of the file.

**Return Value**: The value of the environment variable.
#### 14. set_key()
** Function ：** Set the value of the environment variable

**Function Signature**:
```python
def set_key(
    dotenv_path: StrPath,
    key_to_set: str,
    value_to_set: str,
    quote_mode: str = "always",
    export: bool = False,
    encoding: Optional[str] = "utf-8",
) -> Tuple[Optional[bool], str, str]:
   
    if quote_mode not in ("always", "auto", "never"):
        raise ValueError(f"Unknown quote_mode: {quote_mode}")

    quote = quote_mode == "always" or (
        quote_mode == "auto" and not value_to_set.isalnum()
    )

    if quote:
        value_out = "'{}'".format(value_to_set.replace("'", "\\'"))
    else:
        value_out = value_to_set
    if export:
        line_out = f"export {key_to_set}={value_out}\n"
    else:
        line_out = f"{key_to_set}={value_out}\n"

    with rewrite(dotenv_path, encoding=encoding) as (source, dest):
        replaced = False
        missing_newline = False
        for mapping in with_warn_for_invalid_lines(parse_stream(source)):
            if mapping.key == key_to_set:
                dest.write(line_out)
                replaced = True
            else:
                dest.write(mapping.original.string)
                missing_newline = not mapping.original.string.endswith("\n")
        if not replaced:
            if missing_newline:
                dest.write("\n")
            dest.write(line_out)

    return True, key_to_set, value_to_set
```
** Parameter Description **:
- `dotenv_path` (StrPath): Path to the .env file.
- `key_to_set` (str): Key of the environment variable.
- `value_to_set` (str): Value of the environment variable.
- `quote_mode` (str): Quote mode for the value.
- `export` (bool): Whether to export the variable.
- `encoding` (Optional[str]): Encoding of the file.

**Return Value**: A tuple containing the operation result, key, and value.

#### 15. unset_key()
** Function ：** Delete the environment variable

**Function Signature**:
```python
def unset_key(
    dotenv_path: StrPath,
    key_to_unset: str,
    quote_mode: str = "always",
    encoding: Optional[str] = "utf-8",
) -> Tuple[Optional[bool], str]:
    """
    Removes a given key from the given `.env` file.

    If the .env path given doesn't exist, fails.
    If the given key doesn't exist in the .env, fails.
    """
    if not os.path.exists(dotenv_path):
        logger.warning("Can't delete from %s - it doesn't exist.", dotenv_path)
        return None, key_to_unset

    removed = False
    with rewrite(dotenv_path, encoding=encoding) as (source, dest):
        for mapping in with_warn_for_invalid_lines(parse_stream(source)):
            if mapping.key == key_to_unset:
                removed = True
            else:
                dest.write(mapping.original.string)

    if not removed:
        logger.warning(
            "Key %s not removed from %s - key doesn't exist.", key_to_unset, dotenv_path
        )
        return None, key_to_unset

    return removed, key_to_unset
```
** Parameter Description **:
- `dotenv_path` (StrPath): Path to the .env file.
- `key_to_unset` (str): Key of the environment variable.
- `quote_mode` (str): Quote mode for the value.
- `encoding` (Optional[str]): Encoding of the file.

**Return Value**: A tuple containing the operation result and key.

#### 16.enumerate_env()
** Function ：** Enumerate environment variables

**Function Signature**:
```python
def enumerate_env() -> Optional[str]:
    """
    Return a path for the ${pwd}/.env file.

    If pwd does not exist, return None.
    """
    try:
        cwd = os.getcwd()
    except FileNotFoundError:
        return None
    path = os.path.join(cwd, ".env")
    return path
```
** Parameter Description **:
- `stream` (IO[str]): File stream.

**Return Value**: An iterator containing the parsing results.

## Detailed Function Implementation Nodes

### Node 1: Environment Variable File Parsing

**Function Description**: Parses the content of the .env file, supporting the definition of key-value pairs in various formats.

```python
# Test case
test_input = "a=b"
expected = [
    Binding(
        key="a",
        value="b",
        original=Original(string="a=b", line=1),
        error=False
    )
]
result = parse_stream(io.StringIO(test_input))
```

**Test Interface**:
- `parse_stream(stream: IO[str]) -> Iterator[Binding]`
- `Binding` includes: key, value, original, error
- `Original` includes: string, line

**Input and Output**:
- Input: File stream or string stream
- Output: An iterator containing the parsing results

### Node 2: Key-Value Pair Operations

**Function Description**: Provides operations for adding, deleting, modifying, and querying key-value pairs in the .env file.

```python
# Set a key-value pair
set_key(dotenv_path, "DATABASE_URL", "postgres://user:pass@localhost/db")

# Get a key's value
value = get_key(dotenv_path, "DATABASE_URL")

# Delete a key
unset_key(dotenv_path, "OLD_CONFIG")
```

**Test Interface**:
- `set_key(dotenv_path, key, value, quote_mode="always", export=False, encoding="utf-8")`
- `get_key(dotenv_path, key, encoding="utf-8")`
- `unset_key(dotenv_path, key, quote_mode="always", encoding="utf-8")`

**Input and Output**:
- Input: File path, key, value, encoding, etc.
- Output: Operation result (boolean) or the value corresponding to the key

### Node 3: Environment Variable Loading

**Function Description**: Loads environment variables from a file or stream into the system environment variables.

```python
# Load from a file
load_dotenv(dotenv_path=".env", override=True)

# Load from a stream
with open(".env") as f:
    load_dotenv(stream=f)
```

**Test Interface**:
- `load_dotenv(dotenv_path=None, stream=None, verbose=False, override=False, interpolate=True, encoding="utf-8")`

**Input and Output**:
- Input: File path or file stream
- Output: Boolean indicating whether the loading was successful

### Node 4: Configuration Value Retrieval

**Function Description**: Retrieves environment variable values without modifying the system environment variables.

```python
# Get configurations from a file
config = dotenv_values(".env")

# Get configurations from a stream
with open(".env") as f:
    config = dotenv_values(stream=f)
```

**Test Interface**:
- `dotenv_values(dotenv_path=None, stream=None, verbose=False, interpolate=True, encoding="utf-8")`

**Input and Output**:
- Input: File path or file stream
- Output: A dictionary containing the configurations

### Node 5: File Search

**Function Description**: Searches for the .env file in the directory tree.

```python
# Find the .env file
dotenv_path = find_dotenv(raise_error_if_not_found=True)

# Start the search from the specified directory
dotenv_path = find_dotenv(usecwd=True)
```

**Test Interface**:
- `find_dotenv(filename=".env", raise_error_if_not_found=False, usecwd=False)`

**Input and Output**:
- Input: File name, whether to raise an exception, whether to use the current directory
- Output: The path of the found file or an empty string

### Node 6: Variable Interpolation

**Function Description**: Supports referencing other variables in values.

```python
# Test variable interpolation
test_input = "a=b\nc=${a}/d"
expected = {"a": "b", "c": "b/d"}
result = dotenv_values(stream=io.StringIO(test_input), interpolate=True)
```

**Test Interface**:
- `parse_variables(value: str) -> Iterator[Atom]`
- `Literal` and `Variable` classes

**Input and Output**:
- Input: A string containing variable references
- Output: The parsed variable values

### Node 7: Command-Line Interface

**Function Description**: Provides a command-line tool for managing the .env file.

```python
# List all variables
!dotenv list

# Get a variable
!dotenv get DATABASE_URL

# Set a variable
!dotenv set DATABASE_URL postgres://user:pass@localhost/db

# Delete a variable
!dotenv unset OLD_CONFIG
```

**Test Interface**:
- `cli()` command group
- Subcommands: list, get, set, unset, run

**Input and Output**:
- Input: Command-line parameters
- Output: The result of the command execution

### Node 8: IPython Integration

**Function Description**: Loads environment variables in IPython.

```python
# Load the extension
%load_ext dotenv

# Load the .env file
%dotenv

# Specify a file to load
%dotenv /path/to/.env

# Override existing variables
%dotenv -o
```

**Test Interface**:
- `load_ipython_extension(ipython)`
- `dotenv(line)`

**Input and Output**:
- Input: IPython magic commands
- Output: None or the loading result

### Node 9: ZIP Import Support

**Function Description**: Supports correctly loading the .env file when importing from a ZIP file.

```python
# Load the .env file in a ZIP package
with zipfile.ZipFile('app.zip') as zf:
    with zf.open('app/.env') as f:
        load_dotenv(stream=io.TextIOWrapper(f))
```

**Test Interface**:
- Special handling of `load_dotenv()` in the context of ZIP import

**Input and Output**:
- Input: A file stream in a ZIP file
- Output: The loading result

### Node 10: Interactive Detection

**Function Description**: Detects whether the program is running in an interactive environment.

```python
# Detect the interactive environment
is_interactive = is_interactive()

# Simulate an interactive environment in a test
with mock.patch('sys.ps1', '>>> '):
    assert is_interactive() is True
```

**Test Interface**:
- `is_interactive()`

**Input and Output**:
- Input: None
- Output: A boolean indicating whether the program is running in an interactive environment

### Node 11: Multi-Line Value Handling

**Function Description**: Supports handling environment variable values that span multiple lines.

```python
# Example of a multi-line value
content = """
MULTILINE='''This is a
multi-line
value'''
"""
with open(".env", "w") as f:
    f.write(content)

load_dotenv(".env")
print(os.getenv("MULTILINE"))
# Output:
# This is a
# multi-line
# value
```

**Test Interface**:
- Multi-line value handling logic in `parse_stream()`
- Value parsing in the `Binding` class

**Input and Output**:
- Input: A multi-line string enclosed in triple quotes
- Output: The correctly parsed multi-line value

### Node 12: Export (export) Prefix Handling

**Function Description**: Supports handling environment variable declarations with the export prefix.

```python
# export prefix handling
content = """
export DB_HOST=localhost
export DB_PORT=5432
"""
with open(".env", "w") as f:
    f.write(content)

load_dotenv(".env")
print(os.getenv("DB_HOST"))  # Output: localhost
```

**Test Interface**:
- export prefix handling in `parse_stream()`
- Variable loading logic in `load_dotenv()`

**Input and Output**:
- Input: Variable declarations with/without the export prefix
- Output: Correctly loaded environment variables

### Node 13: Comment Handling

**Function Description**: Supports adding comments in the .env file.

```python
# Example of .env file content
DB_NAME=mydb  # Database name
# Database connection configuration
DB_HOST=localhost
DB_PORT=5432  # Default PostgreSQL port
```

**Test Interface**:
- Comment handling in `parse_stream()`
- Comment handling in the `Binding` class

**Input and Output**:
- Input: A .env file containing comments
- Output: Ignores the comment content and only processes valid key-value pairs

### Node 14: Encoding Handling

**Function Description**: Supports .env files in different encoding formats.

```python
# Save a file using a different encoding
with open(".env", "w", encoding="utf-8") as f:
    f.write("ENCODING_TEST=Encoding test")

# Load with the specified encoding
load_dotenv(".env", encoding="utf-8")
print(os.getenv("ENCODING_TEST"))  # Output: Encoding test
```

**Test Interface**:
- The encoding parameter in `load_dotenv()`
- The encoding parameter in `dotenv_values()`
- Encoding handling when reading files

**Input and Output**:
- Input: .env files in different encoding formats
- Output: Correctly decoded environment variables

### Node 15: Environment Variable Override Control

**Function Description**: Controls whether to override existing environment variables.

```python
# Set an environment variable
os.environ["EXISTING_VAR"] = "original"

# Do not override existing variables
load_dotenv(".env", override=False)
print(os.getenv("EXISTING_VAR"))  # Output: original

# Override existing variables
load_dotenv(".env", override=True)
print(os.getenv("EXISTING_VAR"))  # Output: new_value
```

**Test Interface**:
- The override parameter in `load_dotenv()`
- Environment variable setting logic

**Input and Output**:
- Input: override=True/False
- Output: Decides whether to override existing variables based on the setting

"""