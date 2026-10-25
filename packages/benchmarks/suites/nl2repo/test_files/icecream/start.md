## Introduction and Objectives of the IceCream Project

IceCream is a lightweight Python library **designed for debugging Python code**, offering more powerful and aesthetically pleasing debugging output capabilities than the traditional `print()` function. This tool excels in development and debugging scenarios, achieving "the most intuitive variable display and the most elegant output format." Its core features include: intelligent variable debugging (automatically displaying variable names and values), **syntax highlighting and formatted output** (supporting colored display and data structure beautification), and intelligent display of context information (optional display of file names, line numbers, and function names). In short, IceCream aims to provide a simple and efficient debugging system to replace the traditional print debugging method (for example, quickly debugging variables through the `ic()` function and customizing the output format through the `configureOutput()` function).

---

## Natural Language Instructions (Prompt)

Please create a Python project named IceCream to implement an intelligent debugging tool. The project should include the following key features:

1. **Basic Debugging Output**: Provide a function that can print variable names and values, support outputting multiple variables simultaneously, and automatically highlight the output to improve readability.

2. **Context Information**: Support displaying file names, line numbers, and function names. It can be configured whether to display the full path and support customizing the context information format.

3. **Output Customization**: Allow customizing the prefix, support customizing the output function, configure the way to convert parameters to strings, and support line width limitation.

4. **Syntax Highlighting**: Use the Pygments library to provide syntax highlighting, support the Solarized dark theme, and automatically adapt to different terminal environments.

5. **Windows Support**: Provide Windows terminal color support through colorama and automatically handle ANSI escape sequences.

6. **Configuration Options**: Support dynamic configuration at runtime, enable/disable output, and configure the context display method.

7. **Core File Requirements**:
The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as colorama>=0.3.9, pygments>=2.2.0, executing>=2.1.0, asttokens>=2.0.1). The pyproject.toml can verify whether all functional modules work properly. At the same time, icecream/__init__.py is required as a unified API entry to import and export core functions/variables such as ic, argumentToString, stderrPrint, NO_SOURCE_AVAILABLE_WARNING_MESSAGE, DEFAULT_PREFIX, __title__, __license__, __version__, __author__, __contact__, __url__, __description__. Among them, ic is an instance of IceCreamDebugger, and NO_SOURCE_AVAILABLE_WARNING_MESSAGE, DEFAULT_PREFIX, __title__, __license__, __version__, __author__, __contact__, __url__, __description__ are all variables. This enables users to access all major functions through a simple "from icecream import *" statement. In icecream.py, the IceCreamDebugger class is required to implement debugging functions, including methods such as __call__, format, configureOutput, and the argumentToString function to format the output of different types of parameters. In builtins.py, the install() and uninstall() functions are required to install the ic function into the Python built-in namespace.

---

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.18

### Core Dependency Library Versions

```Plain
cachetools        6.1.0
chardet           5.2.0
colorama          0.4.6
distlib           0.4.0
exceptiongroup    1.3.0
filelock          3.19.1
iniconfig         2.1.0
packaging         25.0
pip               23.0.1
platformdirs      4.3.8
pluggy            1.6.0
Pygments          2.19.2
pyproject-api     1.9.1
pytest            8.4.1
setuptools        65.5.1
tomli             2.2.1
tox               4.28.4
typing_extensions 4.14.1
virtualenv        20.34.0
wheel             0.45.1
```

### Supported Python Versions

```Plain
# Supported Python versions
Python 3.8+                        # Minimum supported version
Python 3.9                         # Fully supported
Python 3.10                        # Fully supported
Python 3.11                        # Fully supported
Python 3.12                        # Fully supported
Python 3.13                        # Fully supported
PyPy3                              # Compatibly supported
```

## IceCream Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── changelog.txt
├── failures-to-investigate
│   ├── freshsales.py
│   ├── freshsales2.py
│   ├── freshsales3.py
├── icecream
│   ├── __init__.py
│   ├── __version__.py
│   ├── builtins.py
│   ├── coloring.py
│   ├── icecream.py
│   ├── py.typed
├── logo.svg
├── pyproject.toml
└── tox.ini

```
---

## API Usage Guide

### 1. Module Import
```python
import icecream

from icecream import ic, argumentToString, stderrPrint, NO_SOURCE_AVAILABLE_WARNING_MESSAGE

import icecream.icecream.__version__ as version_module
globals().update(dict((k, v) for k, v in version_module.__dict__.items()))

```

### Core Debugging Functions

#### `ic(*args)`
The main debugging function used to output the values of variables and expressions.

**Parameters:**
- `*args`: Any number of parameters, which can be variables, expressions, or no parameters.

**Return Value:**
- Returns `None` when there are no parameters.
- Returns the value of the single parameter when there is one parameter.
- Returns a tuple of parameters when there are multiple parameters.

**Example:**
```python
from icecream import ic

# Basic usage
x = 42
ic(x)                    # Output: ic| x: 42

# Expression
ic(x + 1)               # Output: ic| x + 1: 43

# Multiple parameters
ic(x, "hello", [1, 2])  # Output: ic| x: 42, 'hello': 'hello', [1, 2]: [1, 2]

# No parameters (display context)
ic()                    # Output: ic| example.py:10 in main() at 14:30:25.123
```

#### `ic.format(*args)`
Returns a formatted debugging string without directly outputting it.

**Parameters:**
- `*args`: Any number of parameters.

**Return Value:**
- `str`: A formatted debugging string.

**Example:**
```python
from icecream import ic

x = 42
result = ic.format(x)
print(result)  # Output: ic| x: 42
```

### Configuration Functions

#### `ic.configureOutput(prefix=None, outputFunction=None, argToStringFunction=None, includeContext=None, contextAbsPath=None)`
Configures the output behavior of the `ic()` function.

**Parameters:**
- `prefix` (str or callable): The output prefix, which can be a string or a function.
- `outputFunction` (callable): A custom output function.
- `argToStringFunction` (callable): A custom function to convert parameters to strings.
- `includeContext` (bool): Whether to include context information.
- `contextAbsPath` (bool): Whether to use the absolute path.

**Example:**
```python
from icecream import ic

# Custom prefix
ic.configureOutput(prefix='DEBUG -> ')
ic('test')  # Output: DEBUG -> 'test': 'test'

# Include context
ic.configureOutput(includeContext=True)
ic('test')  # Output: ic| example.py:5 in main()- 'test': 'test'

# Use absolute path
ic.configureOutput(includeContext=True, contextAbsPath=True)
ic('test')  # Output: ic| /path/to/example.py:5 in main()- 'test': 'test'
```

#### `ic.enable()`
Enables the output of the `ic()` function.

#### `ic.disable()`
Disables the output of the `ic()` function (but still returns the parameter value).

**Example:**
```python
from icecream import ic

ic('visible')    # Output: ic| 'visible': 'visible'
ic.disable()
ic('hidden')     # No output, but returns 'hidden'
ic.enable()
ic('visible again')  # Output: ic| 'visible again': 'visible again'
```

### Built-in Function Management

#### `install(ic='ic')`
Installs the `ic()` function into the Python built-in module, making it globally available.

**Parameters:**
- `ic` (str): The function name, defaulting to 'ic'.

**Example:**
```python
from icecream import install

install()  # Install the ic function into the built-in module
# Now ic() can be used directly in any file without importing
```

#### `uninstall(ic='ic')`
Uninstalls the `ic()` function from the Python built-in module.

**Parameters:**
- `ic` (str): The function name, defaulting to 'ic'.

**Example:**
```python
from icecream import uninstall

uninstall()  # Uninstall the ic function from the built-in module
```

### Utility Functions

#### `argumentToString(obj)`
Converts an object to a string representation.

**Parameters:**
- `obj`: Any object.

**Return Value:**
- `str`: The string representation of the object.

**Example:**
```python
from icecream import argumentToString

result = argumentToString([1, 2, 3])
print(result)  # Output: [1, 2, 3]
```

#### `argumentToString.register(type)`
Registers a custom string conversion function for a specific type.

**Parameters:**
- `type`: The type to be registered.

**Example:**
```python
from icecream import argumentToString
import numpy as np

@argumentToString.register(np.ndarray)
def _(obj):
    return f"ndarray, shape={obj.shape}, dtype={obj.dtype}"

# Now numpy arrays will use the custom format
```

#### `argumentToString.unregister(type)`
Unregisters the custom string conversion function for a specific type.

**Parameters:**
- `type`: The type to be unregistered.

#### `argumentToString.registry`
Views the registered type conversion functions.

**Return Value:**
- `mappingproxy`: A mapping of the registered functions.

### Color and Formatting Functions

#### `colorize(s)`
Applies syntax highlighting to a string.

**Parameters:**
- `s` (str): The string to be highlighted.

**Return Value:**
- `str`: A string with ANSI color codes.

#### `stderrPrint(*args)`
Prints the parameters to the standard error output.

**Parameters:**
- `*args`: The parameters to be printed.

#### `colorizedStderrPrint(s)`
Prints a colored string to the standard error output.

**Parameters:**
- `s` (str): The string to be printed.

### Context Managers

#### `supportTerminalColorsInWindows()`
A context manager that supports terminal colors on Windows systems.

**Example:**
```python
from icecream import supportTerminalColorsInWindows

with supportTerminalColorsInWindows():
    # In this context, Windows terminals will handle colors correctly
    ic('colored output')
```

### Constants

#### `DEFAULT_PREFIX`
The default output prefix: `'ic| '`

#### `DEFAULT_LINE_WRAP_WIDTH`
The default line wrap width: `70`

#### `DEFAULT_CONTEXT_DELIMITER`
The default context delimiter: `'- '`

#### `DEFAULT_OUTPUT_FUNCTION`
The default output function: `colorizedStderrPrint`

#### `DEFAULT_ARG_TO_STRING_FUNCTION`
The default function to convert parameters to strings: `pprint.pformat`

#### `NO_SOURCE_AVAILABLE_WARNING_MESSAGE`
The warning message when the source code is unavailable.

### Version Information

#### `__version__`
The current version number: `'2.1.5'`

#### `__title__`
The project title: `'icecream'`

#### `__description__`
The project description: `'Never use print() to debug again; inspect variables, expressions, and program execution with a single, simple function call.'`

#### `__author__`
The author: `'Ansgar Grunseid'`

#### `__contact__`
The contact information: `'grunseid@gmail.com'`

#### `__url__`
The project URL: `'Project Address'`

#### `__license__`
The license: `'MIT'`

### Internal Classes

#### `IceCreamDebugger`
The main debugger class, and `ic` is an instance of this class.

**Attributes:**
- `enabled` (bool): Whether the output is enabled.
- `prefix` (str or callable): The output prefix.
- `includeContext` (bool): Whether to include context.
- `outputFunction` (callable): The output function.
- `argToStringFunction` (callable): The function to convert parameters to strings.
- `contextAbsPath` (bool): Whether to use the absolute path.

#### `Source(executing.Source)`
A source code parsing class that inherits from `executing.Source`.

**Methods:**
- `get_text_with_indentation(self, node)`: Gets the text with indentation.

### Helper Functions

#### `isLiteral(s)`
Checks if a string is a literal.

**Parameters:**
- `s` (str): The string to be checked.

**Return Value:**
- `bool`: Whether it is a literal.

#### `callOrValue(obj)`
Calls an object if it is callable; otherwise, returns the object itself.

**Parameters:**
- `obj`: Any object.

**Return Value:**
- The result of the call or the object itself.

#### `prefixLines(prefix, s, startAtLine=0)`
Adds a prefix to the specified lines of a string.

**Parameters:**
- `prefix` (str): The prefix.
- `s` (str): The string.
- `startAtLine` (int): The starting line number.

**Return Value:**
- `str`: The string with the prefix added.

#### `prefixFirstLineIndentRemaining(prefix, s)`
Adds a prefix to the first line and indentation to the remaining lines.

**Parameters:**
- `prefix` (str): The prefix.
- `s` (str): The string.

**Return Value:**
- `str`: A formatted string.

#### `formatPair(prefix, arg, value)`
Formats a parameter-value pair.

**Parameters:**
- `prefix` (str): The prefix.
- `arg` (str): The parameter name.
- `value` (str): The value.

**Return Value:**
- `str`: A formatted string.

### Theme Classes

#### `SolarizedDark(Style)`
The Solarized Dark theme class for syntax highlighting.

**Color Definitions:**
- `BASE03` to `BASE3`: Basic colors
- `YELLOW`, `ORANGE`, `RED`, `MAGENTA`, `VIOLET`, `BLUE`, `CYAN`, `GREEN`: Accent colors

### Import Examples

```python
# Basic import
from icecream import ic

# Import all functions
from icecream import ic, install, uninstall, argumentToString

# Import configuration functions
from icecream import ic
ic.configureOutput(includeContext=True)

# Import utility functions
from icecream import argumentToString, colorize, stderrPrint

# Import version information
from icecream import __version__, __author__
```

### Error Handling

When `ic()` cannot access the source code (e.g., in a REPL environment), it outputs a warning message but still displays the parameter values.

**Example:**
```python
# In the REPL
>>> from icecream import ic
>>> ic('test')
# Outputs a warning and the value instead of the parameter name
```

### Performance Considerations

- `ic()` still returns the parameter values when disabled but does not produce output.
- Using `ic.format()` can avoid output and only obtain the formatted string.
- Customizing the `argToStringFunction` can optimize the display performance of specific types.

---

## Functional Node Analysis
### 1. Core Debugging Functionality

**Function Description**: Provides intelligent debugging output for variables and expressions, supporting multiple calling methods and data types.

```python
class IceCreamDebugger:
    def __call__(self, *args: object) -> object:
        if self.enabled:
            currentFrame = inspect.currentframe()
            assert currentFrame is not None and currentFrame.f_back is not None
            callFrame = currentFrame.f_back
            self.outputFunction(self._format(callFrame, *args))

        if not args:  # E.g. ic().
            passthrough = None
        elif len(args) == 1:  # E.g. ic(1).
            passthrough = args[0]
        else:  # E.g. ic(1, 2, 3).
            passthrough = args

        return passthrough
```

Examples:

```python
# Basic variable debugging
x = 42
ic(x)                    # Output: ic| x: 42

# Expression debugging  
ic(x + 1)               # Output: ic| x + 1: 43

# Multiple parameter debugging
ic(x, "hello", [1, 2])  # Output: ic| x: 42, 'hello': 'hello', [1, 2]: [1, 2]

# Call without parameters (context information)
ic()                    # Output: ic| test_icecream.py:10 in testWithoutArgs() at 14:30:25.123
```
### 2. Output Configuration
Function Description: Fully customizes the format, prefix, output function, etc., of the debugging output.

```python
def configureOutput(
    self: "IceCreamDebugger",
    prefix: Union[str, Literal[Sentinel.absent]] = Sentinel.absent,
    outputFunction: Union[Callable, Literal[Sentinel.absent]] = Sentinel.absent,
    argToStringFunction: Union[Callable, Literal[Sentinel.absent]] = Sentinel.absent,
    includeContext: Union[bool, Literal[Sentinel.absent]] = Sentinel.absent,
    contextAbsPath: Union[bool, Literal[Sentinel.absent]] = Sentinel.absent,
    lineWrapWidth: Union[bool, Literal[Sentinel.absent]] = Sentinel.absent
) -> None:
    noParameterProvided = all(
        v is Sentinel.absent for k, v in locals().items() if k != 'self')
    if noParameterProvided:
        raise TypeError('configureOutput() missing at least one argument')

    if prefix is not Sentinel.absent:
        self.prefix = prefix

    if outputFunction is not Sentinel.absent:
        self.outputFunction = outputFunction

    if argToStringFunction is not Sentinel.absent:
        self.argToStringFunction = argToStringFunction

    if includeContext is not Sentinel.absent:
        self.includeContext = includeContext

    if contextAbsPath is not Sentinel.absent:
        self.contextAbsPath = contextAbsPath

    if lineWrapWidth is not Sentinel.absent:
        self.lineWrapWidth = lineWrapWidth
```

Examples:

```python
# Custom prefix (string)
ic.configureOutput(prefix='DEBUG -> ')
ic('test')              # Output: DEBUG -> 'test': 'test'

# Custom prefix (function)
def prefixFunction():
    return 'lolsup '
ic.configureOutput(prefix=prefixFunction)
ic('test')              # Output: lolsup 'test': 'test'

# Custom output function
lst = []
def appendTo(s):
    lst.append(s)
ic.configureOutput(outputFunction=appendTo)
ic('test')              # No console output; the result is stored in lst

# Include context information
ic.configureOutput(includeContext=True)
ic('test')              # Output: ic| test_icecream.py:5 in testFunction()- 'test': 'test'
```

### 3. Enable/Disable Control
Function Description: Dynamically controls the on/off of the debugging output. The parameter values are still returned when disabled.

```python
def enable(self) -> None:
    self.enabled = True

def disable(self) -> None:
    self.enabled = False
```
Examples:

```python
# Enabled state
ic('visible')           # Output: ic| 'visible': 'visible'

# Disabled state
ic.disable()
ic('hidden')            # No output, but returns 'hidden'

# Re-enable
ic.enable()
ic('visible again')     # Output: ic| 'visible again': 'visible again'
```

### 4. Formatting Output Functionality
Function Description: Returns a formatted debugging string without directly outputting it to the console.
```python
def format(self, *args: object) -> str:
    currentFrame = inspect.currentframe()
    assert currentFrame is not None and currentFrame.f_back is not None
    callFrame = currentFrame.f_back
    out = self._format(callFrame, *args)
    return out
```
Examples:

```python
# Formatted output
x = 42
result = ic.format(x)   # No console output
print(result)           # Output: ic| x: 42

# Formatting for multi-line calls
result = ic.format(
    'sup'
)                       # No console output
print(result)           # Output: ic| 'sup': 'sup'
```
### 5. Output Destination Control
Function Description: Controls whether output goes to stdout or stderr.

```python
def use_stdout(self) -> None:
    self.outputFunction = colorizedStdoutPrint

def use_stderr(self) -> None:
    self.outputFunction = colorizedStderrPrint
```
Examples:

```python
# Output to stdout
ic.use_stdout()
ic('test')              # Output goes to stdout

# Output to stderr (default)
ic.use_stderr()
ic('test')              # Output goes to stderr
```

### 6. Custom Type Handling
Function Description: Registers custom string conversion functions for specific types through the singledispatch mechanism.

```python
@singledispatch
def argumentToString(obj: object) -> str:
    s = DEFAULT_ARG_TO_STRING_FUNCTION(obj)
    s = s.replace('\\n', '\n')  # Preserve string newlines in output.
    return s

@argumentToString.register(str)
def _(obj: str) -> str:
    if '\n' in obj:
        return "'''" + obj + "'''"

    return "'" + obj.replace('\\', '\\\\') + "'"
```

Examples:

```python
# Default handling
x = (1, 2)
default_output = ic.format(x)  # Output: ic| x: (1, 2)

# Register a custom handling function
def argumentToString_tuple(obj):
    return "Dispatching tuple!"
argumentToString.register(tuple, argumentToString_tuple)

# Use custom handling
custom_output = ic.format(x)   # Output: ic| x: Dispatching tuple!
```
### 7. Color Support
Function Description: Provides syntax highlighting and color support for debugging output, including compatibility with Windows terminals.

```python
@contextmanager
def supportTerminalColorsInWindows() -> Generator:
    # Filter and replace ANSI escape sequences on Windows with equivalent Win32
    # API calls. This code does nothing on non-Windows systems.
    if sys.platform.startswith('win'):
        colorama.init()
        yield
        colorama.deinit()
    else:
        yield

def colorizedStderrPrint(s: str) -> None:
    colored = colorize(s)
    with supportTerminalColorsInWindows():
        stderrPrint(colored)

def colorizedStdoutPrint(s: str) -> None:
    colored = colorize(s)
    with supportTerminalColorsInWindows():
        print(colored)
```
Examples:

```python
# Color output
ic({1: 'str'})          # Output: Formatted output with ANSI color codes

# Windows color support
with supportTerminalColorsInWindows():
    ic('colored output') # Output: Windows-compatible colored output
```
### 8. Context Information
Function Description: Includes context information such as file name, line number, and function name in the debugging output.

```python
def _formatContext(self, callFrame: FrameType) -> str:
    filename, lineNumber, parentFunction = self._getContext(callFrame)

    if parentFunction != '<module>':
        parentFunction = '%s()' % parentFunction

    context = '%s:%s in %s' % (filename, lineNumber, parentFunction)
    return context

def _getContext(self, callFrame: FrameType) -> Tuple[str, int, str]:
    frameInfo = inspect.getframeinfo(callFrame)
    lineNumber = frameInfo.lineno
    parentFunction = frameInfo.function

    filepath = (realpath if self.contextAbsPath else basename)(frameInfo.filename)
    return filepath, lineNumber, parentFunction
```
Examples:

```python
# Include context information
ic.configureOutput(includeContext=True)
i = 3
ic(i)                   # Output: ic| test_icecream.py:5 in testIncludeContextSingleLine()- i: 3

# Absolute path context
ic.configureOutput(includeContext=True, contextAbsPath=True)
ic(i)                   # Output: ic| /absolute/path/test_icecream.py:5 in testContextAbsPathSingleLine()- i: 3
```

### 9. Line Wrapping and Formatting
Function Description: Automatically wraps long lines and multi-line content according to the configured line width.

```python
def _constructArgumentOutput(self, prefix: str, context: str, pairs: Sequence[Tuple[Union[str, Sentinel], str]]) -> str:
    # ... complex formatting logic for multi-line and long lines ...
    if multilineArgs or firstLineTooLong:
        # Multi-line formatting logic
        if context:
            lines = [prefix + context] + [
                formatPair(len(prefix) * ' ', arg, value)
                for arg, value in pairs
            ]
        else:
            argLines = [
                formatPair('', arg, value)
                for arg, value in pairs
            ]
            lines = prefixFirstLineIndentRemaining(prefix, '\n'.join(argLines))
    else:
        lines = [prefix + context + contextDelimiter + allArgsOnOneLine]

    return '\n'.join(lines)
```
Examples:

```python
# Long single-parameter line without wrapping
longStr = '*' * (ic.lineWrapWidth + 1)
ic(longStr)             # Output: ic| longStr: '****************...'

# Long multi-parameter line wrapping
val = '*' * int(ic.lineWrapWidth / 4)
v1 = v2 = v3 = v4 = val
ic(v1, v2, v3, v4)      # Output: Multi-line wrapped format

# Multi-line value wrapping
multilineStr = 'line1\nline2'
ic(multilineStr)        # Output: Multi-line value format
```
### 10. Error Handling
Function Description: Gracefully handles various edge cases and errors, including situations where the source code is unavailable.

```python
def _formatArgs(self, callFrame: FrameType, prefix: str, context: str, args: Sequence[object]) -> str:
    callNode = Source.executing(callFrame).node
    if callNode is not None:
        assert isinstance(callNode, ast.Call)
        source = cast(Source, Source.for_frame(callFrame))
        sanitizedArgStrs = [
            source.get_text_with_indentation(arg)
            for arg in callNode.args]
    else:
        warnings.warn(
            NO_SOURCE_AVAILABLE_WARNING_MESSAGE,
            category=RuntimeWarning, stacklevel=4)
        sanitizedArgStrs = [Sentinel.absent] * len(args)

    pairs = list(zip(sanitizedArgStrs, cast(List[str], args)))
    # ... rest of formatting logic ...
```
Examples:

```python
# Source code unavailable (REPL environment)
eval('ic(a, b)')        # Output: Warning message + value output

# Configuration error handling
ic.configureOutput()    # Raises TypeError: configureOutput() missing at least one argument
```

### 11. Return Value Functionality
Function Description: The ic() function returns the passed parameter values, facilitating seamless integration into existing code.
```python
def __call__(self, *args: object) -> object:
    # ... output logic ...
    if not args:  # E.g. ic().
        passthrough = None
    elif len(args) == 1:  # E.g. ic(1).
        passthrough = args[0]
    else:  # E.g. ic(1, 2, 3).
        passthrough = args

    return passthrough
```
Examples:

```python
# Return value without parameters
result = ic()           # result = None

# Return value with a single parameter
result = ic(1)          # result = 1

# Return value with multiple parameters
result = ic(1, 2, 3)    # result = (1, 2, 3)

# Use as a function parameter
noop(ic(a), ic(b))      # Executes normally while outputting debugging information
```
### 12. Builtins Installation Management

**Function Description**: Installs the ic() function into the Python built-in module to achieve global availability.

**Input-Output Examples**:

```python
from icecream import install, uninstall

# Install into the built-in module
install()               # No output
# Input: No parameters or function name
# Output: No return value
# Data Type: None

# Global use (after installation)
# ic() can be used directly in any file without importing
ic('global test')       # Output: ic| 'global test': 'global test'
# Input: Any parameter
# Output: Normal formatted output
# Data Type: Any object

# Uninstall the built-in function
uninstall()             # No output
# Input: No parameters or function name
# Output: No return value
# Data Type: None

# Use after uninstallation (will cause an error)
# NameError: global name 'ic' is not defined
```