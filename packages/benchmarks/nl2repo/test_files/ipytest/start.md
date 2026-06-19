## Introduction and Goals of the ipytest Project

ipytest is a Python library for test execution in Jupyter Notebooks, seamlessly integrating the pytest testing framework into the interactive notebook environment. This tool excels in the Jupyter development workflow, with core functions including: parsing notebook code (automatically identifying and executing test functions and assertion statements), interactive test execution (supporting both magic commands and functional calls), and intelligent management of complex scenarios such as test status, module reloading, and asynchronous testing.

## Natural Language Instruction (Prompt)

Please create a Python project named ipytest to implement a library for Jupyter Notebook test execution and verification. The project should include the following functions:

1. Configuration Management Module: Capable of flexibly configuring the test execution environment, supporting core configuration items such as assertion rewriting, magic command registration, and test cleanup mode. The configuration results should be persistent settings or equivalent environment states. It should support two configuration modes: autoconfig() for quick configuration and config() for fine-grained configuration, including 9 core configuration parameters such as rewrite_asserts, magics, clean, addopts, run_in_thread, defopts, display_columns, raise_on_error, and coverage.

2. Test Execution Module: Implement functions to execute test code in the notebook, supporting both synchronous and asynchronous test execution. It should support execution methods such as the run() function call, the %%ipytest magic command, command-line parameter passing, plugin integration, and thread isolation, as well as intelligent test discovery and error handling mechanisms.

3. State Management Module: Provide intelligent management of the test state in the notebook environment, including cleaning global variables, reloading modules, and isolating scopes. It should support the clean() function to clean tests matching a pattern, the force_reload() function to force module reloading, and handle global state issues specific to the notebook environment.

4. Assertion Rewriting Module: Implement an AST converter to rewrite assert statements, providing more detailed error information. It should support automatic integration with the IPython shell, registration and deregistration of the converter, and custom AST node processing logic.

5. Coverage Support Module: Provide code coverage analysis for notebook tests, supporting integration with pytest-cov, temporary file name conversion, and cell tracking. It should support automatic generation of coverage configuration, cell identifier conversion, and collection and reporting of coverage data.

6. Environment Preparation Module: Implement tool functions such as temporary file management, module registration, and parameter mapping. It should support dynamically creating temporary module files, registering the notebook as a Python module, template variable replacement (e.g., {MODULE}, {test_name}), and environment preparation functions such as column width control.

7. Interface Design: Design independent API interfaces for each functional module (e.g., configuration management, test execution, state management, assertion rewriting, coverage support), supporting both Python function calls and IPython magic command calls. Each module should define clear input and output formats and error handling mechanisms.

8. Examples and Evaluation Scripts: Provide example code and test cases to demonstrate how to use the autoconfig() and run() functions for environment configuration and test execution (e.g., ipytest.autoconfig(); ipytest.run() should correctly execute the tests in the current module). The above functions need to be combined to build a complete notebook test toolkit.

9. Test Verification System: Provide comprehensive test case coverage, including 10 functional node tests for the complete test process from configuration management to test execution; regression tests for the notebook environment based on real Jupyter notebooks; boundary case tests for abnormal input handling, environment dependency errors, thread safety issues, etc.; and performance benchmark tests for quantitative evaluation of test execution speed and coverage collection accuracy.

10. The project must include a complete `pyproject.toml` file that not only configures the project as an installable package (supporting pip installation), but also declares a complete list of dependencies (including core libraries such as` pytest>=5.4`、`ipython>=8.18.1`、`packaging>=24.2`、`coverage>=7.6.12`、`pytest-cov>=6.0.0`、`pytest-asyncio>=0.25.0`、` nbval>=0.11.0`、`ruff>=0.9.0`)。 The `pyproject.toml` file can verify whether all functional modules are working properly. At the same time, `ipytest/_init__.py` should be provided as a unified API entry point, which can be imported from the ` config ` and ` _impl ` modules respectively autoconfig、config、force_reload、find_coverage_configs、ArgMapping、RewriteAssertTransformer、eval_defots_auto、eval_run_kwargs、clean、runl Wait for core functions and classes, and provide version information, allowing users to access all major functions through simple statements such as `from ipytest. xxx import xxx`. In `ipytest/__init__.py`, it is necessary to define `__all__`, which contains core classes or functions such as "Error", "autoconfig", "clean", "config", "force_deload", "reload", "run", etc.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
asttokens                 3.0.0
attrs                     25.3.0
backports.asyncio.runner  1.2.0
comm                      0.2.3
coverage                  7.10.2
debugpy                   1.8.16
decorator                 5.2.1
exceptiongroup            1.3.0
executing                 2.2.0
fastjsonschema            2.21.1
hatchling                 1.27.0
iniconfig                 2.1.0
ipykernel                 6.30.1
ipython                   8.37.0
jedi                      0.19.2
jsonschema                4.25.0
jsonschema-specifications 2025.4.1
jupyter_client            8.6.3
jupyter_core              5.8.1
matplotlib-inline         0.1.7
nbformat                  5.10.4
nbval                     0.11.0
nest-asyncio              1.6.0
packaging                 25.0
parso                     0.8.4
pathspec                  0.12.1
pexpect                   4.9.0
pip                       23.0.1
platformdirs              4.3.8
pluggy                    1.6.0
prompt_toolkit            3.0.51
psutil                    7.0.0
ptyprocess                0.7.0
pure_eval                 0.2.3
Pygments                  2.19.2
pytest                    8.4.1
pytest-asyncio            1.1.0
pytest-cov                6.2.1
python-dateutil           2.9.0.post0
pyzmq                     27.0.1
referencing               0.36.2
rpds-py                   0.26.0
ruff                      0.12.7
setuptools                65.5.1
six                       1.17.0
stack-data                0.6.3
tomli                     2.2.1
tornado                   6.5.1
traitlets                 5.14.3
trove-classifiers         2025.8.6.13
typing_extensions         4.14.1
wcwidth                   0.2.13
wheel                     0.40.0
```

## ipytest Project Architecture

### Project Directory Structure

```python
workspace/
├── .gitignore
├── Changes.md
├── Example.ipynb
├── License.md
├── MANIFEST.in
├── Readme.md
├── ipytest
│   ├── __init__.py
│   ├── _config.py
│   ├── _impl.py
│   ├── cov.py
│   ├── coveragerc
├── minidoc.py
├── pyproject.toml
├── uv.lock
└── x.py
```

## API Usage Guide

### Core API

#### 1. Module Import

```python
import ipytest

from ipytest import (
    Error,
    autoconfig,
    clean,
    config,
    force_reload,
    reload,
    run,
)

from ipytest._impl import (
    ArgMapping,
    RewriteAssertTransformer,
    eval_defopts_auto,
    eval_run_kwargs,
    find_coverage_configs,
)
```

#### 2. autoconfig() Function - Automatic Configuration

**Function**: Configure ipytest with reasonable default values.

**Function Signature**:

```python
@gen_default_docs
def autoconfig(
    rewrite_asserts=default,
    magics=default,
    clean=default,
    addopts=default,
    run_in_thread=default,
    defopts=default,
    display_columns=default,
    raise_on_error=default,
    coverage=default,
):
```

**Parameter Description**:

- `rewrite_asserts` (default: `True`): Enable IPython AST transformation to rewrite assertions.
- `magics` (default: `True`): Register ipytest magic commands.
- `clean` (default: `"[Tt]est*"`): Pattern for cleaning variables.
- `addopts` (default: `("-q", "--color=yes")`): pytest command-line parameters.
- `run_in_thread` (default: `False`): Run pytest in a separate thread.
- `defopts` (default: `"auto"`): Default option mode ("auto", True, False).
- `display_columns` (default: `100`): Number of display columns.
- `raise_on_error` (default: `False`): Whether to raise an exception when tests fail.
- `coverage` (default: `False`): Whether to collect coverage information.

**Return Value**: `None`

**Example**:

```python
import ipytest
ipytest.autoconfig(raise_on_error=True, coverage=True)
```

#### 3. config() Function - Flexible Configuration

**Function**: Flexibly configure ipytest parameters.

**Function Signature**:

```python
def config(
    rewrite_asserts=keep,
    magics=keep,
    clean=keep,
    addopts=keep,
    run_in_thread=keep,
    defopts=keep,
    display_columns=keep,
    raise_on_error=keep,
    coverage=default,
):
```

**Parameter Description**: Same as `autoconfig`, but use `keep` to keep the current value.

**Return Value**: The current configuration dictionary.

**Example**:

```python
ipytest.config(rewrite_asserts=True, magics=False)
```

#### 4. run() Function - Test Execution

**Function**: Execute tests in the module.

**Function Signature**:

```python
def run(
    *args,
    module=None,
    plugins=(),
    run_in_thread=default,
    raise_on_error=default,
    addopts=default,
    defopts=default,
    display_columns=default,
    coverage=default,
):
```

**Parameter Description**:

- `*args`: Additional command-line options to pass to pytest.
- `module`: The module containing the tests, defaulting to `__main__`.
- `plugins`: Additional plugins to pass to pytest.
- `run_in_thread`: Whether to run in a separate thread.
- `raise_on_error`: Whether to raise an exception when tests fail.
- `addopts`: pytest command-line parameters.
- `defopts`: Default option mode.
- `display_columns`: Number of display columns.
- `coverage`: Whether to collect coverage information.

**Return Value**: The exit code of pytest.

**Example**:

```python
# Basic usage
ipytest.run()

# Run with parameters
ipytest.run("-v", "--tb=short")

# Run in a separate thread
ipytest.run(run_in_thread=True)
```

#### 5. clean() Function - Clean Test Functions

**Function**: Delete variables matching the pattern.

**Function Signature**:

```python
def clean(pattern=default, *, module=None):
```

**Parameter Description**:

- `pattern` (default: `"[Tt]est*"`): The pattern of variables to delete.
- `module`: The module to clean, defaulting to `__main__`.

**Return Value**: `None`

**Example**:

```python
# Clean all test functions
ipytest.clean()

# Clean functions matching a specific pattern
ipytest.clean("test_*")
```

#### 6. force_reload() Function - Force Module Reload

**Function**: Force reload the specified module.

**Function Signature**:

```python
def force_reload(*include: str, modules: Optional[Dict[str, ModuleType]] = None):
```

**Parameter Description**:

- `*include`: The names of the modules to reload.
- `modules`: The module dictionary, defaulting to `None`.

**Return Value**: `None`

**Example**:

```python
# Reload a specific module
ipytest.force_reload("my_module")

# Reload multiple modules
ipytest.force_reload("module1", "module2")
```

#### 7. reload() Function - Reload Module

**Function**: Reload the specified module.

**Function Signature**:

```python
def reload(*mods):
```

**Parameter Description**:

- `*mods`: The modules to reload.

**Return Value**: `None`

**Example**:

```python
# Reload a module
ipytest.reload(my_module)
```

#### 8. `find_coverage_configs`

**Function Signature**:
```python
def find_coverage_configs(root):
```

**Function Description**:
Search for coverage configuration files in the specified root directory. Usually used to find the `.coveragerc`, `setup.cfg`, `tox.ini`, or `pyproject.toml` files containing coverage configuration.

**Parameters**:
- `root`: A path (string or Path object) to the root directory to search for coverage configuration.

**Return Value**:
- A list of Path objects pointing to the found coverage configuration files.

**Example**:
```python
from ipytest._impl import find_coverage_configs

configs = find_coverage_configs('.')
print(f"Found coverage configurations: {configs}")
```

---

#### 9. `ArgMapping`

**Class Signature**:
```python
class ArgMapping(dict)
```

**Function Description**:
A dictionary subclass that provides special handling for test node IDs. Used to map test names to their full module paths and handle special formatting of test identifiers.

**Special Method**:
- `__missing__(self, key)`: Handle missing keys. If the key is NOT all uppercase letters, format it as `{MODULE}::{key}` (treating it as a test name); if the key IS all uppercase letters, raise a KeyError with help information (as it's treated as a special format key).

**Example**:
```python
from ipytest._impl import ArgMapping

mapping = ArgMapping(MODULE='test_module')
print(mapping['test_name'])  # Output: 'test_module::test_name'
# mapping['UPPER'] would raise KeyError
```

---

#### 10. `RewriteAssertTransformer`

**Class Signature**:
```python
class RewriteAssertTransformer(ast.NodeTransformer)
```

**Function Description**:
Rewrite assert statements in the Python AST to provide better assertion messages. Used to enhance the output information of failed assertions.

**Methods**:
- `register_with_shell(shell)`: Register the converter with the IPython shell.
- `unregister_with_shell(shell)`: Unregister the converter from the IPython shell.
- `visit(node)`: Visit and transform assert nodes in the AST.

**Example**:
```python
from IPython import get_ipython
from ipytest._impl import RewriteAssertTransformer

transformer = RewriteAssertTransformer()
transformer.register_with_shell(get_ipython())
# Now assert statements will have better error information
```

---

#### 11. `eval_defopts_auto`

**Function Signature**:
```python
def eval_defopts_auto(args: Sequence[str], arg_mapping: Mapping[str, str]) -> bool
```

**Function Description**:
Evaluate whether the notebook should be automatically added to the pytest parameters based on the provided command-line parameters and parameter mapping. Used internally to determine whether the notebook should be included in test discovery.

**Parameters**:
- `args`: A sequence of command-line argument strings.
- `arg_mapping`: A dictionary containing the parameter mapping.

**Return Value**:
- Return `True` if the notebook should be added to the pytest parameters; otherwise, return `False`.

**Example**:
```python
from ipytest._impl import eval_defopts_auto

should_add = eval_defopts_auto(
    ['-k', 'test_*'],
    {'MODULE': 'test_module'}
)
```

---

#### 12. `eval_run_kwargs`

**Function Signature**:
```python
def eval_run_kwargs(cell: str, module=None) -> Dict[str, Any]
```

**Function Description**:
Parse the `ipytest:` comments in the notebook cell and calculate them as keyword arguments for test execution. This allows configuration of test execution for each cell.

**Parameters**:
- `cell`: The string content of the cell.
- `module`: An optional module for variable resolution (default: `__main__`).

**Return Value**:
- A dictionary of keyword arguments for test execution.

**Example**:
```python
from ipytest._impl import eval_run_kwargs

cell_content = """# ipytest: raise_on_error=True, verbose=2
def test_example():
    assert 1 + 1 == 2
"""

kwargs = eval_run_kwargs(cell_content)
# Return: {'raise_on_error': True, 'verbose': 2}
```

#### Configured Usage

```python
import ipytest

# Custom configuration
ipytest.autoconfig(
    raise_on_error=True,  # Raise an exception when tests fail
    coverage=True,         # Enable coverage collection
    run_in_thread=True,    # Run in a separate thread
    addopts=("-v", "--tb=short")  # Detailed output, short traceback
)

# Run tests
ipytest.run()
```

#### Usage in CI/CD Environments

```python
import ipytest
import os

# Automatically enable error raising in the CI environment
ipytest.autoconfig(raise_on_error="GITHUB_ACTIONS" in os.environ)

# Run tests
ipytest.run()
```

#### Coverage Testing

```python
import ipytest
from ipytest.cov import translate_cell_filenames

# Enable coverage
ipytest.autoconfig(coverage=True)

# Enable filename translation
translate_cell_filenames(True)

# Run coverage tests
%%ipytest --cov

def test_function():
    x = 1
    if x > 0:
        return True
    return False
```

#### Asynchronous Testing

```python
import ipytest
import asyncio

# Run in a separate thread to support asynchronous testing
ipytest.autoconfig(run_in_thread=True)

%%ipytest

async def test_async():
    await asyncio.sleep(0.1)
    assert True

def test_sync():
    assert True
```

#### Module Reload Testing

```python
import ipytest

# Reload the module to test the latest version
ipytest.force_reload("my_module")

%%ipytest

def test_module_function():
    from my_module import my_function
    assert my_function() == expected_result
```

### Error Handling

#### 1. Handling Test Failures

```python
import ipytest

# Enable error raising
ipytest.autoconfig(raise_on_error=True)

try:
    ipytest.run()
except ipytest.Error as e:
    print(f"Tests failed with exit code: {e.args[0]}")
```

#### 2. Handling Timeouts

```python
import ipytest
import signal

def timeout_handler(signum, frame):
    raise TimeoutError("Test execution timed out")

# Set a timeout
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(30)  # 30-second timeout

try:
    ipytest.run()
finally:
    signal.alarm(0)  # Cancel the timeout
```

### Important Notes

1. **Global State Management**: When ipytest runs in the Jupyter notebook environment, there are multiple sources of global state. For example, pytest will find any test functions that were ever defined (including old functions before renaming), the Python module system caches imports and requires manual reloading to test the latest version, and IPython creates an event loop in the current thread, which may interfere with asynchronous testing.
2. **Configuration Priority and Override**: The parameters of the `run()` function override the configurations set by `config()` or `autoconfig()`. Use `keep` to keep the current value and `default` to use the default value. Configuration changes will affect all subsequent test runs.
3. **Thread Safety and Asynchronous Support**: `run_in_thread=True` runs pytest in a separate thread to support asynchronous testing because the IPython event loop may conflict with asynchronous tests. However, the thread mode adds some performance overhead.
4. **Error Handling and Exceptions**: By default, `ipytest.run()` does not raise an exception when tests fail. In the CI environment, set `raise_on_error=True`. When tests fail, an `ipytest.Error` exception will be raised, including the exit code.
5. **Module Reloading and Test Isolation**: Use `force_reload()` to ensure testing the latest version of the module. Use `clean()` or `%%ipytest` to clean old test functions. It is recommended to install the local package using `pip install -e .` for testing.
6. **Limitations of Coverage Collection**: The coverage function requires the `pytest-cov` package. The coverage option hides existing coverage configuration files. You can use `translate_cell_filenames()` to improve the coverage report.
7. **Performance Optimization Suggestions**: `rewrite_asserts=True` provides better error information but affects performance. `display_columns` controls the output format and affects readability. `addopts` can optimize pytest execution parameters.

## Detailed Implementation Nodes of Functions

### Node 1: Automatic Configuration and Flexible Configuration (AutoConfig & Config)

**Function Description**: Automatically or manually configure the parameters of the ipytest test environment, supporting options such as coverage, assertion rewriting, and magic commands.

**Configuration Strategy**:

- Automatic setting of default parameters: Such as assertion rewriting, magic command registration, and coverage collection.
- Flexible parameter override: Support modifying individual configurations as needed.
- Keep/reset mechanism: Use `keep` to keep the current value and `default` to use the default value.
- Support for multiple environments: Jupyter, CI/CD, asynchronous, etc.

**Input/Output Example**:

```python
import ipytest
# Default automatic configuration
ipytest.autoconfig()
# Custom parameters
ipytest.autoconfig(raise_on_error=True, coverage=True, addopts=("-v", "--tb=short"))
# Flexible configuration, keeping some parameters at the current value
ipytest.config(rewrite_asserts=True, magics=False, display_columns=120)
# Check the current configuration
cfg = ipytest.config()
print(cfg)
# Output: {'rewrite_asserts': True, 'magics': False, ...}
```

### Node 2: Test Execution (Run)

**Function Description**: Execute pytest tests in the current module or a specified module, supporting parameter passing, plugin usage, thread mode, etc.

**Execution Strategy**:

- Support for command-line parameters: Such as `-v`, `--tb=short`.
- Specify a module or plugin: Can test any module.
- Run in thread mode: Compatible with asynchronous testing.
- Return an exit code: Used to judge the test result.

**Input/Output Example**:

```python
# Basic execution
ipytest.run()

# Execute with parameters
ipytest.run("-v", "--tb=short")

# Execute in a specified module
import tests.test_config
ipytest.run(module=tests.test_config)

# Support for asynchronous testing
ipytest.run(run_in_thread=True)

# Get the exit code
print(ipytest.exit_code)  # 0 or 1
```

### Node 3: Test Cleaning (Clean)

**Function Description**: Clean test functions matching a pattern in the current module or a specified module to avoid residual old tests.

**Cleaning Strategy**:

- Clean by name pattern: Such as `test_*`, `[Tt]est*`.
- Support specifying a module: Can clean any module.
- Ensure test isolation: Prevent historical tests from affecting the results.

**Input/Output Example**:

```python
# Clean all test functions
ipytest.clean()

# Clean functions matching a specific pattern
ipytest.clean("test_*")

# Clean a specified module
import tests.empty_module
ipytest.clean(module=tests.empty_module)

# Verify after cleaning
assert not hasattr(tests.empty_module, "test_func")
```

### Node 4: Module Reloading (Force Reload & Reload)

**Function Description**: Force reload the specified module to ensure testing the latest code version, supporting batch reloading.

**Reloading Strategy**:

- Reload by module name: Such as "tests.test_config".
- Support for batch reloading: Refresh multiple modules at once.
- Ensure the latest test code: Avoid the impact of caching.

**Input/Output Example**:

```python
import tests.test_config
import tests.test_doctest

# Reload a single module
ipytest.force_reload("tests.test_config")

# Reload multiple modules
ipytest.force_reload("tests.test_config", "tests.test_doctest")

# Usage of reload
ipytest.reload(tests.test_config)

# Verify the function after reloading
from tests.test_config import test_func
assert test_func() == "new result"
```

### Node 5: Error Handling (Error Exception Class)

**Function Description**: Raise an exception when tests fail, including the pytest exit code, facilitating integration into the CI/CD process.

**Exception Strategy**:

- Automatically capture pytest failures.
- Raise a custom exception `ipytest.Error`.
- The exit code can be tracked, facilitating automated processing.

**Input/Output Example**:

```python
ipytest.autoconfig(raise_on_error=True)

try:
    ipytest.run()
except ipytest.Error as e:
    print(f"Tests failed with exit code: {e.args[0]}")
    # Handle the failure logic

# Failing test case
def test_fail():
    assert 1 == 2

ipytest.run()  # Raises ipytest.Error with exit code 1
```

### Node 6: Magic Command (%%ipytest)

**Function Description**: Directly run pytest tests in a Jupyter cell, supporting passing command-line parameters.

**Magic Command Strategy**:

- Register the IPython magic command.
- Parse the cell content as tests.
- Support parameter passing and output format customization.

**Input/Output Example**:

```python
%%ipytest -v

def test_example():
    assert [1, 2, 3] == [1, 2, 3]


# Output:
# test_example PASSED

```

### Node 7: Configuration Option Priority and Override (Config Priority)

**Function Description**: The parameters of the run() function have higher priority than those of config/autoconfig, supporting keep/default to keep or reset parameters.

**Priority Strategy**:

- The parameters of the run() function have the highest priority.
- Support the semantics of keep/default.
- Dynamically override the configuration for flexible adjustment.

**Input/Output Example**:

```python
ipytest.autoconfig(display_columns=120, addopts=("-q",))
ipytest.run(display_columns=80, addopts=("-v", "--tb=short"))

# The actual output is 80 columns with parameters -v --tb=short
```

### Node 8: Configuration and State Debugging (Debug & Inspect)

**Function Description**: Debug the test configuration, output detailed information, and check the exit code to assist in troubleshooting.

**Debugging Strategy**:

- Output the current configuration dictionary.
- Display detailed test information.
- Check the pytest exit code to assist in locating problems.

**Input/Output Example**:

```python
ipytest.run("-v", "-s")
print(ipytest.config())
print(f"Exit code: {ipytest.exit_code}")

# Output:
# {'rewrite_asserts': True, ...}
# Exit code: 0
```

### Node 9: Doctest Integration

**Function Description**: Support running doctest tests in Jupyter notebooks. ipytest temporarily registers the notebook scope as a module to allow pytest's doctest plugin to work correctly.

**Key Features**:
- Temporarily register notebook as importable module
- Support standard doctest syntax in docstrings
- Use with `--doctest-modules` flag
- Can be combined with other pytest features

**Usage Example**:
```python
# In a notebook cell
%%ipytest --doctest-modules

def is_even(n):
    """Check if a number is even
    
    >>> is_even(2)
    True
    >>> is_even(3)
    False
    """
    return n % 2 == 0

# Or use run() directly
ipytest.run("--doctest-modules")
```

**Implementation Details**:
- ipytest creates a temporary file to map the notebook to a Python module
- This allows pytest's doctest plugin to import and inspect the notebook code
- The temporary file is automatically cleaned up after test execution

### Node 10: Code Coverage Integration

**Function Description**: ipytest provides a coverage.py plugin (`ipytest.cov`) specifically designed for Jupyter notebooks, along with automatic configuration management.

**Coverage Features**:
- **Custom coverage.py plugin**: Handles notebook cell filenames and tracing
- **Automatic configuration**: Generates coverage config when using `coverage=True`
- **Multiple report formats**: Supports HTML, JSON, XML, and terminal output
- **Branch coverage**: Full support for branch coverage analysis
- **Cell-level tracking**: Each notebook cell is tracked as an individual file

**Configuration Methods**:

1. **Automatic Configuration** (Recommended):
```python
# ipytest automatically generates coverage config
ipytest.autoconfig(coverage=True)

%%ipytest
def test():
    assert my_function() == expected
```

2. **Manual Configuration**:
```python
# Create .coveragerc in the same directory as your notebook
```

`.coveragerc` file:
```ini
[run]
plugins =
    ipytest.cov
```

Then run:
```python
%%ipytest --cov --cov-report=html
```

**Usage Examples**:
```python
# Basic coverage test
ipytest.run("--cov")

# With branch coverage
ipytest.run("--cov --cov-branch")

# Generate HTML report
ipytest.run("--cov --cov-report=html")

# Generate JSON report
ipytest.run("--cov --cov-report=json")

# Specify coverage target
ipytest.run("--cov=my_module --cov-report=term")
```

**Known Limitations**:
- Each notebook cell is reported as an individual file
- Lines executed at import time may not be traced correctly
- Coverage pragmas for branch exclusion are not fully supported

**Implementation Details**:
- `ipytest.cov` is a coverage.py plugin that handles notebook-specific filename translation
- Configuration file: `ipytest/coveragerc` is automatically used when `coverage=True`
- Uses `find_coverage_configs()` to locate existing coverage configurations

### Node 11: Test Discovery and Selection

**Function Description**: ipytest leverages pytest's powerful test discovery and selection mechanisms, with additional notebook-specific enhancements.

**Discovery Features**:
- **Name-based filtering**: Use `-k` to filter tests by name patterns
- **Marker-based selection**: Use `-m` to select tests by markers
- **Node ID selection**: Directly specify test paths and names
- **Automatic module detection**: `defopts="auto"` intelligently adds the current module
- **Test name formatting**: `{test_name}` expands to `{MODULE}::test_name`

**Usage Examples**:

1. **Filter by Name Pattern**:
```python
# Run tests matching a name pattern
ipytest.run("-k test_important")

# Run tests NOT matching a pattern
ipytest.run("-k 'not slow'")

# Combine multiple patterns
ipytest.run("-k 'test_user and not test_admin'")
```

2. **Select by Markers**:
```python
# Run tests with specific marker
ipytest.run("-m slow")

# Exclude marked tests
ipytest.run("-m 'not slow'")

# Combine markers
ipytest.run("-m 'slow and integration'")
```

3. **Select Specific Tests**:
```python
# Run a specific test using node ID
%%ipytest {MODULE}::test_function

# Run multiple specific tests
ipytest.run("{MODULE}::test_one", "{MODULE}::test_two")

# Or use the expanded format
%%ipytest {test_one} {test_two}
```

4. **Use defopts for Smart Selection**:
```python
# With defopts="auto" (default), ipytest adds MODULE automatically
ipytest.config(defopts="auto")
ipytest.run()  # Runs all tests in current module

# With defopts=False, only explicit args are used
ipytest.run("-k test_specific", defopts=False)
```

**ipytest-Specific Features**:
- **ArgMapping**: Automatically formats test names to full node IDs
- **defopts intelligence**: Detects if user provided node IDs and adjusts behavior
- **Module handling**: Automatically manages the temporary module for the notebook

**Implementation Note**: While the discovery and selection logic is provided by pytest, ipytest adds notebook-specific handling through `ArgMapping` and intelligent `defopts` configuration.