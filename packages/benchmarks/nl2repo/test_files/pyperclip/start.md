## Introduction and Goals of the Pyperclip Project

Pyperclip is a Python library for **cross-platform clipboard operations** that enables text copying and pasting on Windows, macOS, and Linux systems. The tool aims to provide Python developers with a simple and unified clipboard interface without having to consider the underlying differences of different operating systems. Its core functions include: cross-platform text copying (writing text to the system clipboard via the `copy()` function), **cross-platform text pasting** (reading text content from the clipboard via the `paste()` function), and clipboard availability detection (checking if the clipboard function is available via the `is_available()` function). In short, Pyperclip is dedicated to providing an easy-to-use cross-platform clipboard solution to help developers easily implement the interaction between programs and the system clipboard (for example, copying text to the clipboard via `copy('Hello World')` and getting the text content in the clipboard via `paste()`).

---

## Natural Language Instruction (Prompt)

Please create a Python project named `pyperclip` to implement a cross-platform clipboard operation library. The project should include the following functions:

1. Cross-platform Clipboard Support: Automatically detect and adapt to the clipboard mechanisms of different operating systems. On Windows systems, use the Windows API (call user32.dll via ctypes). On macOS systems, support the pbcopy/pbpaste command-line tools and the PyObjC framework. On Linux systems, support multiple clipboard tools such as xclip, xsel, wl-clipboard, and klipper. Provide special support in the WSL environment and support /dev/clipboard in the Cygwin environment. The program needs to automatically select the most suitable clipboard implementation for the current system and support the automatic detection of Wayland and X11 display servers.

2. Core Clipboard Operations: Provide unified copy and paste function interfaces. The `copy(text)` function can write text content to the system clipboard and supports the automatic conversion of basic data types such as strings, numbers, and boolean values (unsupported types such as None and lists will throw exceptions). The `paste()` function can read text content from the system clipboard and return it. Both functions should handle the encoding issues of Unicode characters, emoji symbols, and special characters and support UTF-8 encoding.

3. Clipboard Mechanism Management: Implement the dynamic selection and switching functions of the clipboard mechanism. The `determine_clipboard()` function can automatically detect available clipboard implementations. The `set_clipboard(clipboard_type)` function allows users to manually specify the clipboard mechanism (such as "windows", "pbcopy", "xclip", "xsel", "wl-clipboard", "klipper", "qt", "pyobjc", "no", etc.). The `is_available()` function checks if the clipboard function is available. Support the lazy loading mechanism to avoid automatically initializing the clipboard when importing.

4. Exception Handling and Error Management: Provide a complete exception handling mechanism, including the PyperclipException base class, PyperclipWindowsException (Windows-specific errors), and PyperclipTimeoutException (timeout errors). When the clipboard is unavailable, provide graceful degradation by selecting the "no" clipboard backend; attempts to copy/paste in this state should raise PyperclipException with helpful guidance. Support the CheckedCall class for error checking of Windows API calls.

5. Command Line Interface: Provide a command-line tool interface for clipboard operations. Support the `python -m pyperclip -c [text]` command to copy text to the clipboard and support the `python -m pyperclip -p` command to paste text from the clipboard to the standard output. When no text parameter is provided, read content from the standard input for copying.

6. Test System Construction: Provide comprehensive unit tests covering all supported clipboard mechanisms. The test scope includes: basic copy and paste function tests, Unicode character and emoji support tests, blank character and special character handling tests, data type conversion tests (integers, floating-point numbers, boolean values, and exception tests for unsupported types such as None and lists), specific clipboard mechanism tests for each platform (Windows, macOS, Linux, WSL, Cygwin, Qt, XClip, XSel, WlClipboard, Klipper), and exception handling tests. A dedicated test class needs to be provided for each clipboard mechanism, supporting platform detection and conditional skipping.

7. Advanced Clipboard Features: Support the distinction between the primary selection buffer (PRIMARY selection) and the clipboard buffer (CLIPBOARD selection) on Linux systems. Tools such as xclip, xsel, and wl-clipboard support the primary parameter to operate the primary selection buffer. Support the clipboard operations of the Qt framework, including the automatic detection of PyQt5 and qtpy. Support the Klipper clipboard manager in the KDE desktop environment. Provide a context manager to safely manage Windows clipboard resources and ensure the correct release of resources.

8. Core File Requirements:
The project must include a complete setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare the complete dependency list (including test libraries such as pytest==8.2.2, mypy==1.10.0, etc.). The setup.py can verify whether all functional modules work properly. At the same time, it is necessary to provide pyperclip/__init__.py as a unified API entry, importing initialization functions for various clipboards such as init_osx_pbcopy_clipboard, init_osx_pyobjc_clipboard, init_dev_clipboard_clipboard, init_qt_clipboard, init_xclip_clipboard, init_xsel_clipboard, init_wl_clipboard, init_klipper_clipboard, init_no_clipboard, init_windows_clipboard, init_wsl_clipboard from each clipboard initialization module, and exporting core utilities and exception classes such as _executable_exists and PyperclipException, and providing version information, so that users can access major functions through a simple "from pyperclip import *" statement. In __init__.py, there needs to be an _executable_exists() function to check if the system command exists, a PyperclipException exception class to handle clipboard operation errors, and corresponding clipboard initialization functions for each platform to support clipboard operations on different systems such as Windows, macOS, Linux, WSL, and Cygwin.

---

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
colorama          0.4.6
exceptiongroup    1.3.0
iniconfig         2.1.0
mypy              1.17.1
mypy_extensions   1.1.0
packaging         25.0
pathspec          0.12.1
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
setuptools        65.5.1
tomli             2.2.1
typing_extensions 4.14.1
wheel             0.40.0
```

## Pyperclip Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── AUTHORS.txt
├── CHANGES.txt
├── LICENSE.txt
├── Pipfile
├── Pipfile.lock
├── pyproject.toml
├── README.md
├── src
│   ├── pyperclip
│   │   ├── __init__.py
│   │   └── __main__.py
├── tests
│   └── test_pyperclip.py
└── tox.ini

```

---

## API Usage Guide

### Core API

#### 1. Module Import

```python
import pyperclip
from typing import Callable
from pyperclip import _executable_exists
from pyperclip import (
    init_osx_pbcopy_clipboard,
    init_osx_pyobjc_clipboard,
    init_dev_clipboard_clipboard,
    init_qt_clipboard,
    init_xclip_clipboard,
    init_xsel_clipboard,
    init_wl_clipboard,
    init_klipper_clipboard,
    init_no_clipboard,
    init_windows_clipboard,
    init_wsl_clipboard,
    PyperclipException,
)
```

### Detailed Explanation of Core Functions

#### 1. copy() Function - Text Copy

**Function**: Copy text content to the system clipboard.

**Implementation Note**: `copy` is not a directly defined function but a dynamically assigned variable. Initially set to `lazy_load_stub_copy`, it gets reassigned to the platform-specific copy function (e.g., `copy_windows`, `copy_osx_pbcopy`) when first called or when `determine_clipboard()` is executed.

**Function Signature** (runtime behavior):
```python
copy(text: str | int | float | bool) -> None
```

**Parameter Explanation**:
- `text` (str | int | float | bool): The text content to be copied.
  - **String**: Copy the text content directly.
  - **Integer**: Automatically convert to a string and then copy.
  - **Floating-point number**: Automatically convert to a string and then copy.
  - **Boolean value**: Automatically convert to a string and then copy (True → "True", False → "False").

**Return Value**: No return value.

**Exceptions**:
- `PyperclipException`: Thrown when the clipboard is unavailable or the copy fails.
- `PyperclipWindowsException`: Clipboard errors specific to Windows systems.
- `PyperclipTimeoutException`: Operation timeout error.

**Example**:
```python
import pyperclip

# Copy a string
pyperclip.copy('Hello, World!')

# Copy a number (will be automatically converted to a string)
pyperclip.copy(42)  # Copy "42"

# Copy a floating-point number
pyperclip.copy(3.14159)  # Copy "3.14159"

# Copy a boolean value
pyperclip.copy(True)  # Copy "True"
pyperclip.copy(False)  # Copy "False"

# Copy Unicode characters and emojis
pyperclip.copy('你好，世界！🌍')

# Copy text containing line breaks
pyperclip.copy('First line\nSecond line\nThird line')
```

#### 2. paste() Function - Text Paste

**Function**: Get text content from the system clipboard.

**Implementation Note**: `paste` is not a directly defined function but a dynamically assigned variable. Initially set to `lazy_load_stub_paste`, it gets reassigned to the platform-specific paste function (e.g., `paste_windows`, `paste_osx_pbcopy`) when first called or when `determine_clipboard()` is executed.

**Function Signature** (runtime behavior):
```python
paste() -> str
```

**Parameters**: No parameters.

**Return Value**:
- `str`: The text content in the clipboard.

**Exceptions**:
- `PyperclipException`: Thrown when the clipboard is unavailable or the paste fails.
- `PyperclipWindowsException`: Clipboard errors specific to Windows systems.
- `PyperclipTimeoutException`: Operation timeout error.

**Example**:
```python
import pyperclip

# Get the clipboard content
text = pyperclip.paste()
print(text)  # Output the text in the clipboard

# Check if the clipboard is empty
if pyperclip.paste():
    print("The clipboard is not empty")
else:
    print("The clipboard is empty")

# Process the clipboard content
clipboard_text = pyperclip.paste()
if clipboard_text:
    lines = clipboard_text.split('\n')
    print(f"The clipboard contains {len(lines)} lines of text")
```

#### 3. set_clipboard() Function - Clipboard Mechanism Setting

**Function**: Manually set the clipboard mechanism, overriding the automatic detection result.

**Function Signature**:
```python
def set_clipboard(clipboard):
```

**Parameter Explanation**:
- `clipboard`: The type of the clipboard mechanism. Optional values include:
  - `"windows"`: Windows system clipboard (use ctypes to call the Windows API).
  - `"pbcopy"`: macOS pbcopy/pbpaste commands.
  - `"pyobjc"`: macOS PyObjC framework (requires PyObjC>=9.0).
  - `"qt"`: Qt framework clipboard (requires PyQt5>=5.15.0).
  - `"xclip"`: Linux xclip tool.
  - `"xsel"`: Linux xsel tool.
  - `"wl-clipboard"`: Wayland clipboard.
  - `"klipper"`: KDE Klipper clipboard manager.
  - `"no"`: No clipboard support (for testing).

**Return Value**: No return value.

**Exceptions**:
- `ValueError`: Thrown when the specified clipboard type is invalid.

**Example**:
```python
import pyperclip

# Manually set to use xclip
pyperclip.set_clipboard('xclip')

# Manually set to use the Qt framework
pyperclip.set_clipboard('qt')

# Manually set to use the Windows clipboard
pyperclip.set_clipboard('windows')

# Set no clipboard support (for testing)
pyperclip.set_clipboard('no')
```

#### 4. determine_clipboard() Function - Automatic Clipboard Detection

**Function**: Automatically detect and select the appropriate clipboard mechanism for the current environment, returning the concrete copy and paste callables.

**Function Signature**:
```python
def determine_clipboard():
```

**Return Value**:
- `tuple`: A pair `(copy_function, paste_function)` that will be assigned to `pyperclip.copy` and `pyperclip.paste`.

**Example**:
```python
import pyperclip

# Automatically detect the clipboard mechanism
copy_func, paste_func = pyperclip.determine_clipboard()
print(f"Detected clipboard type: {copy_func.__name__}")
```

#### 5. is_available() Function - Clipboard Availability Check

**Function**: Check if the clipboard function is available.

**Function Signature**:
```python
def is_available():
```

**Parameters**: No parameters.

**Return Value**:
- `bool`: True if `pyperclip.copy` and `pyperclip.paste` have been bound to real backend functions (i.e., not the lazy stub wrappers). Note: this does not guarantee that the OS clipboard is usable; if the "no clipboard" backend is selected, calling these functions will raise `PyperclipException`.

**Example**:
```python
import pyperclip

if pyperclip.is_available():
    print("The clipboard function is available")
else:
    print("The clipboard function is unavailable")
```

### Clipboard Initialization Functions

#### 1. init_windows_clipboard() - Windows Clipboard Initialization

**Function**: Initialize the Windows system clipboard.

**Function Signature**:
```python
def init_windows_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Example**:
```python
from pyperclip import init_windows_clipboard

copy_func, paste_func = init_windows_clipboard()
```

#### 2. init_osx_pbcopy_clipboard() - macOS pbcopy Clipboard Initialization

**Function**: Initialize the macOS pbcopy/pbpaste clipboard.

**Function Signature**:
```python
def init_osx_pbcopy_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Example**:
```python
from pyperclip import init_osx_pbcopy_clipboard

copy_func, paste_func = init_osx_pbcopy_clipboard()
```

#### 3. init_osx_pyobjc_clipboard() - macOS PyObjC Clipboard Initialization

**Function**: Initialize the macOS PyObjC framework clipboard.

**Function Signature**:
```python
def init_osx_pyobjc_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires PyObjC>=9.0.

**Example**:
```python
from pyperclip import init_osx_pyobjc_clipboard

copy_func, paste_func = init_osx_pyobjc_clipboard()
```

#### 4. init_qt_clipboard() - Qt Clipboard Initialization

**Function**: Initialize the Qt framework clipboard.

**Function Signature**:
```python
def init_qt_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires PyQt5>=5.15.0 and qtpy>=1.11.0.

**Example**:
```python
from pyperclip import init_qt_clipboard

copy_func, paste_func = init_qt_clipboard()
```

#### 5. init_xclip_clipboard() - xclip Clipboard Initialization

**Function**: Initialize the Linux xclip tool clipboard.

**Function Signature**:
```python
def init_xclip_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires the xclip tool to be installed on the system.

**Example**:
```python
from pyperclip import init_xclip_clipboard

copy_func, paste_func = init_xclip_clipboard()
```

#### 6. init_xsel_clipboard() - xsel Clipboard Initialization

**Function**: Initialize the Linux xsel tool clipboard.

**Function Signature**:
```python
def init_xsel_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires the xsel tool to be installed on the system.

**Example**:
```python
from pyperclip import init_xsel_clipboard

copy_func, paste_func = init_xsel_clipboard()
```

#### 7. init_wl_clipboard() - Wayland Clipboard Initialization

**Function**: Initialize the Wayland clipboard.

**Function Signature**:
```python
def init_wl_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires the wl-clipboard tool to be installed on the system.

**Example**:
```python
from pyperclip import init_wl_clipboard

copy_func, paste_func = init_wl_clipboard()
```

#### 8. init_klipper_clipboard() - Klipper Clipboard Initialization

**Function**: Initialize the KDE Klipper clipboard manager.

**Function Signature**:
```python
def init_klipper_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Dependencies**: Requires the klipper and qdbus tools to be installed on the system.

**Example**:
```python
from pyperclip import init_klipper_clipboard

copy_func, paste_func = init_klipper_clipboard()
```

#### 9. init_dev_clipboard_clipboard() - Cygwin Clipboard Initialization

**Function**: Initialize the Cygwin development environment clipboard.

**Function Signature**:
```python
def init_dev_clipboard_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Example**:
```python
from pyperclip import init_dev_clipboard_clipboard

copy_func, paste_func = init_dev_clipboard_clipboard()
```

#### 10. init_wsl_clipboard() - WSL Clipboard Initialization

**Function**: Initialize the Windows Subsystem for Linux clipboard.

**Function Signature**:
```python
def init_wsl_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function).

**Example**:
```python
from pyperclip import init_wsl_clipboard

copy_func, paste_func = init_wsl_clipboard()
```

#### 11. init_no_clipboard() - No Clipboard Support Initialization

**Function**: Initialize the no clipboard support mode (for testing).

**Function Signature**:
```python
def init_no_clipboard():
```

**Parameters**: No parameters.

**Return Value**:
- `tuple`: Return a tuple of (copy_function, paste_function), but an exception will be thrown when called.

**Example**:
```python
from pyperclip import init_no_clipboard

copy_func, paste_func = init_no_clipboard()
# An exception will be thrown when called
```

#### 12 macOS (pbcopy/pbpaste) Functions

- Function Signatures:
```python
def copy_osx_pbcopy(text):
    """Copy text using pbcopy."""

def paste_osx_pbcopy():
    """Paste text using pbpaste."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_osx_pbcopy: None
  - paste_osx_pbcopy: str clipboard contents

#### 13. macOS (PyObjC) Functions

- Function Signatures:
```python
def copy_osx_pyobjc(text):
    """Copy text via AppKit/NSPasteboard."""

def paste_osx_pyobjc():
    """Paste text via AppKit/NSPasteboard."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_osx_pyobjc: None
  - paste_osx_pyobjc: str clipboard contents

#### 14. Qt Clipboard Functions

- Function Signatures:
```python
def copy_qt(text):
    """Copy text via Qt QApplication clipboard."""

def paste_qt():
    """Paste text via Qt QApplication clipboard."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_qt: None
  - paste_qt: str clipboard contents

#### 15. XClip (X11) Functions

- Function Signatures:
```python
def copy_xclip(text, primary=False):
    """Copy text via xclip. Use primary=True for PRIMARY selection, otherwise CLIPBOARD."""

def paste_xclip(primary=False):
    """Paste text via xclip. Read PRIMARY when primary=True, otherwise CLIPBOARD."""
```
- Parameters:
  - text: Text to copy.
  - primary (bool, default False): Whether to operate on PRIMARY selection.
- Return Values:
  - copy_xclip: None
  - paste_xclip: str clipboard contents

#### 16. XSel (X11) Functions

- Function Signatures:
```python
def copy_xsel(text, primary=False):
    """Copy text via xsel. Use primary=True for PRIMARY selection, otherwise CLIPBOARD."""

def paste_xsel(primary=False):
    """Paste text via xsel. Read PRIMARY when primary=True, otherwise CLIPBOARD."""
```
- Parameters:
  - text: Text to copy.
  - primary (bool, default False): Whether to operate on PRIMARY selection.
- Return Values:
  - copy_xsel: None
  - paste_xsel: str clipboard contents

#### 17. Wayland (wl-clipboard) Functions

- Function Signatures:
```python
def copy_wl(text, primary=False):
    """Copy text via wl-copy. Use primary=True to target PRIMARY selection; clears when text is empty."""

def paste_wl(primary=False):
    """Paste text via wl-paste with text MIME type. Reads PRIMARY when primary=True."""
```
- Parameters:
  - text: Text to copy (empty string triggers clear behavior).
  - primary (bool, default False): Whether to operate on PRIMARY selection.
- Return Values:
  - copy_wl: None
  - paste_wl: str clipboard contents

#### 18. KDE Klipper Functions

- Function Signatures:
```python
def copy_klipper(text):
    """Copy text via Klipper using qdbus."""

def paste_klipper():
    """Paste text via Klipper using qdbus (trailing newline removed)."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_klipper: None
  - paste_klipper: str clipboard contents

#### 19. Cygwin /dev/clipboard Functions

- Function Signatures:
```python
def copy_dev_clipboard(text):
    """Copy text by writing to /dev/clipboard (Cygwin)."""

def paste_dev_clipboard():
    """Paste text by reading from /dev/clipboard (Cygwin)."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_dev_clipboard: None
  - paste_dev_clipboard: str clipboard contents

#### 20. Windows API Functions

- Function Signatures:
```python
def copy_windows(text):
    """Copy text using Windows clipboard APIs (CF_UNICODETEXT)."""

def paste_windows():
    """Paste text using Windows clipboard APIs (CF_UNICODETEXT)."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_windows: None
  - paste_windows: str clipboard contents

#### 21. WSL (Windows Subsystem for Linux) Functions

- Function Signatures:
```python
def copy_wsl(text):
    """Copy text via clip.exe (UTF-16LE)."""

def paste_wsl():
    """Paste text via powershell.exe decoding UTF-8 from base64."""
```
- Parameters:
  - text: Text to copy.
- Return Values:
  - copy_wsl: None
  - paste_wsl: str clipboard contents


### Utility Functions

> **Internal API Notice**: The functions and constants in this section are internal implementation details of pyperclip and are not included in the `__all__` export list. These APIs do not guarantee stability and may be changed or removed in future versions. It is not recommended to use them directly in production code. The only stable public APIs are: `copy`, `paste`, `set_clipboard`, `determine_clipboard`.

#### 1. _executable_exists() Function - Executable File Detection

**Function**: Check if a system command exists.

**Implementation Note**: `_executable_exists` is a dynamically assigned variable that points to either `_py3_executable_exists` (Python 3+) or `_py2_executable_exists` (Python 2), depending on the Python version.

**Function Signature** (runtime behavior):
```python
def _executable_exists(name):
```

**Parameter Explanation**:
- `name`: The name of the command to be checked.

**Return Value**:
- `bool`: Return True if the command exists, otherwise return False.

**Example**:
```python
from pyperclip import _executable_exists

# Check if xclip exists
if _executable_exists('xclip'):
    print("xclip is available")
else:
    print("xclip is not installed")

# Check if xsel exists
if _executable_exists('xsel'):
    print("xsel is available")
else:
    print("xsel is not installed")
```

#### 2. lazy_load_stub_copy() Function - Lazy Loading Copy Stub

**Function**: Deferred-load wrapper for copy() that initializes the actual backend on first call.

**Function Signature**:
```python
def lazy_load_stub_copy(text):
```

**Parameters**:
- `text`: Content to copy; internally coerced to str by the selected backend.

**Return Value**: Same as the selected backend copy() function (typically None)

#### 3. lazy_load_stub_paste() Function - Lazy Loading Paste Stub

**Function**: Deferred-load wrapper for paste() that initializes the actual backend on first call.

**Function Signature**:
```python
def lazy_load_stub_paste():
```

**Parameters**: None

**Return Value**: `str` clipboard contents

#### 4. _IS_RUNNING_PYTHON_2 Constant

**Type**: `bool`

**Meaning**: True when running under Python 2 (False on Python 3). Used for internal compatibility branches.

#### 5. ENCODING Constant

**Type**: `str`

**Default Value**: `'utf-8'`

**Meaning**: Default text encoding used for subprocess I/O and decoding clipboard data.


### Detailed Explanation of Exception Classes

#### 1. PyperclipException - Base Exception Class

**Function**: The base exception class for clipboard operations, inheriting from `RuntimeError`.

**Attributes**:
- `message`: Error message.

**Example**:
```python
import pyperclip

try:
    pyperclip.copy("test")
except pyperclip.PyperclipException as e:
    print(f"Clipboard error: {e}")
```

#### 2. PyperclipWindowsException - Windows-Specific Exception

**Function**: A Windows-specific clipboard exception, inheriting from `PyperclipException`.

**Attributes**:
- `message`: Error message containing the Windows error code.

**Example**:
```python
import pyperclip

try:
    pyperclip.copy("test")
except pyperclip.PyperclipWindowsException as e:
    print(f"Windows clipboard error: {e}")
```

#### 3. PyperclipTimeoutException - Timeout Exception

**Function**: A timeout exception for clipboard operations, inheriting from `PyperclipException`.

**Attributes**:
- `message`: Timeout error message.

**Example**:
```python
import pyperclip

try:
    # Some operations that may require timeout checking
    pass
except pyperclip.PyperclipTimeoutException as e:
    print(f"Clipboard operation timed out: {e}")
```

### Actual Usage Modes

#### Basic Usage

```python
import pyperclip

# Simple copy and paste
pyperclip.copy('Hello, World!')
text = pyperclip.paste()
print(text)  # Output: Hello, World!
```

#### Error Handling Mode

```python
import pyperclip

try:
    pyperclip.copy('test')
    text = pyperclip.paste()
    print(f"Clipboard content: {text}")
except pyperclip.PyperclipException as e:
    print(f"Clipboard operation failed: {e}")
except pyperclip.PyperclipWindowsException as e:
    print(f"Windows clipboard error: {e}")
except pyperclip.PyperclipTimeoutException as e:
    print(f"Operation timed out: {e}")
```

#### Platform-Specific Configuration Mode

```python
import pyperclip

# Check clipboard availability
if pyperclip.is_available():
    # Set the clipboard according to the platform
    import platform
    if platform.system() == 'Windows':
        pyperclip.set_clipboard('windows')
    elif platform.system() == 'Darwin':
        pyperclip.set_clipboard('pbcopy')
    else:
        pyperclip.set_clipboard('xclip')
    
    # Perform copy and paste operations
    pyperclip.copy('Configuration completed')
else:
    print("The clipboard is unavailable")
```

#### Data Type Handling Mode

```python
import pyperclip

# Handle different data types
data_types = [
    "String",           # String
    42,                # Integer
    3.14159,          # Floating-point number
    True,             # Boolean value
    "Hello, World!🌍"   # Unicode characters
]

for data in data_types:
    try:
        pyperclip.copy(data)
        result = pyperclip.paste()
        print(f"Original data: {data} ({type(data).__name__})")
        print(f"Copy result: {result} ({type(result).__name__})")
        print("---")
    except pyperclip.PyperclipException as e:
        print(f"Copy failed: {e}")
```

### Supported Platforms and Clipboard Types

- **Windows**: Windows API clipboard
- **macOS**: pbcopy/pbpaste commands, PyObjC framework
- **Linux (X11)**: xclip, xsel tools
- **Linux (Wayland)**: wl-clipboard
- **Linux (KDE)**: Klipper clipboard manager
- **WSL**: Windows Subsystem for Linux clipboard
- **Cygwin**: Development environment clipboard
- **Qt framework**: Cross-platform Qt clipboard

### Error Handling

The system provides a complete error handling mechanism:
- **Platform detection**: Automatically detect the most suitable clipboard mechanism.
- **Fallback mechanism**: Multiple clipboard strategies ensure maximum compatibility.
- **Exception capture**: Gracefully handle the failure of clipboard operations.
- **Timeout protection**: Prevent the clipboard operation from taking too long.

### Important Notes

1. **Data type conversion**: Non-string types will be automatically converted to strings.
2. **Unicode support**: Fully support Unicode characters and emoji symbols.
3. **Platform compatibility**: Automatically detect and use the most suitable clipboard mechanism.
4. **Error handling**: Provide detailed exception information to help with debugging.
5. **Thread safety**: Support clipboard operations in a multi-threaded environment.


## Detailed Implementation Nodes of Functions

### Basic Clipboard Operation Functions

### Node 1: Simple Text Copy/Paste

**Function Description**: Implement basic text copy and paste functions, supporting clipboard operations for ordinary strings.

**Input/Output Example**:

```python
import pyperclip

# Simple text copy
pyperclip.copy("pyper\r\nclip")

# Simple text paste
text = pyperclip.paste()
print(text)  # Output: pyper\r\nclip
```

**Test Interface**:
```python
def test_copy_simple(self):
    self.copy("pyper\r\nclip")

def test_copy_paste_simple(self):
    msg = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(1000))
    self.copy(msg)
    self.assertEqual(self.paste(), msg)
```

### Node 2: Whitespace Handling

**Function Description**: Correctly handle various whitespace characters, including spaces, tabs, line breaks, etc.

**Input/Output Example**:

```python
import pyperclip
import string

# Whitespace character copy and paste
whitespace_chars = ''.join(random.choice(string.whitespace) for _ in range(1000))
pyperclip.copy(whitespace_chars)
result = pyperclip.paste()
assert result == whitespace_chars
```

**Test Interface**:
```python
def test_copy_paste_whitespace(self):
    msg = ''.join(random.choice(string.whitespace) for _ in range(1000))
    self.copy(msg)
    self.assertEqual(self.paste(), msg)
```

### Node 3: Empty String Handling

**Function Description**: Correctly handle the copy and paste operations of empty strings.

**Input/Output Example**:

```python
import pyperclip

# First copy text with content
pyperclip.copy('TEST')

# Then copy an empty string
pyperclip.copy('')

# Verify that the paste result is empty
result = pyperclip.paste()
assert result == ''
```

**Test Interface**:
```python
def test_copy_blank(self):
    self.copy('TEST')
    self.copy('')
    self.assertEqual(self.paste(), '')
```

### Unicode Character Support Functions

### Node 4: Unicode Character Handling

**Function Description**: Support the copy and paste of Unicode characters, including text symbols in various languages.

**Input/Output Example**:

```python
import pyperclip

# Unicode character copy and paste
unicode_text = "ಠ_ಠ"  # Special Unicode characters
pyperclip.copy(unicode_text)
result = pyperclip.paste()
assert result == unicode_text
```

**Test Interface**:
```python
def test_copy_unicode(self):
    if not self.supports_unicode:
        raise unittest.SkipTest()
    self.copy(u"ಠ_ಠ")

def test_copy_paste_unicode(self):
    if not self.supports_unicode:
        raise unittest.SkipTest()
    msg = u"ಠ_ಠ"
    self.copy(msg)
    self.assertEqual(self.paste(), msg)
```

### Node 5: Emoji Support

**Function Description**: Support the copy and paste operations of emoji symbols.

**Input/Output Example**:

```python
import pyperclip

# Emoji copy and paste
emoji_text = "🙆"  # Emoji
pyperclip.copy(emoji_text)
result = pyperclip.paste()
assert result == emoji_text
```

**Test Interface**:
```python
def test_copy_unicode_emoji(self):
    if not self.supports_unicode:
        raise unittest.SkipTest()
    self.copy(u"🙆")

def test_copy_paste_unicode_emoji(self):
    if not self.supports_unicode:
        raise unittest.SkipTest()
    msg = u"🙆"
    self.copy(msg)
    self.assertEqual(self.paste(), msg)
```

### Data Type Conversion Functions

### Node 6: Numeric Type Conversion

**Function Description**: Automatically convert numeric types to strings for copying, supporting integers, floating-point numbers, and boolean values.

**Input/Output Example**:

```python
import pyperclip

# Integer type conversion
pyperclip.copy(42)
assert pyperclip.paste() == '42'

pyperclip.copy(-1)
assert pyperclip.paste() == '-1'

# Floating-point type conversion
pyperclip.copy(3.141592)
assert pyperclip.paste() == '3.141592'

# Boolean type conversion
pyperclip.copy(True)
assert pyperclip.paste() == 'True'

pyperclip.copy(False)
assert pyperclip.paste() == 'False'
```

**Test Interface**:
```python
def test_non_str(self):
    # Test copying an int.
    self.copy(42)
    self.assertEqual(self.paste(), '42')

    self.copy(-1)
    self.assertEqual(self.paste(), '-1')

    # Test copying a float.
    self.copy(3.141592)
    self.assertEqual(self.paste(), '3.141592')

    # Test copying bools.
    self.copy(True)
    self.assertEqual(self.paste(), 'True')

    self.copy(False)
    self.assertEqual(self.paste(), 'False')
```

### Node 7: Unsupported Type Exception Handling

**Function Description**: Throw an exception for unsupported data types, including None, lists, dictionaries, etc.

**Input/Output Example**:

```python
import pyperclip
from pyperclip import PyperclipException

# Exception handling for None values
try:
    pyperclip.copy(None)
except PyperclipException:
    print("None values are not supported")

# Exception handling for list types
try:
    pyperclip.copy([2, 4, 6, 8])
except PyperclipException:
    print("List types are not supported")
```

**Test Interface**:
```python
def test_non_str(self):
    # All other non-str values raise an exception.
    with self.assertRaises(PyperclipException):
        self.copy(None)

    with self.assertRaises(PyperclipException):
        self.copy([2, 4, 6, 8])
```

### Cross-Platform Clipboard Mechanisms

### Node 8: Windows Clipboard Mechanism

**Function Description**: Implement clipboard operations using the Windows API, calling user32.dll via ctypes.

**Implementation Features**:
- Use the Windows API (user32.dll).
- Support context managers to manage resources.
- Error checking and exception handling.

**Test Interface**:
```python
class TestWindows(_TestClipboard):
    if os.name == 'nt' or platform.system() == 'Windows':
        clipboard = init_windows_clipboard()
```

### Node 9: macOS Clipboard Mechanism

**Function Description**: Support two macOS clipboard implementation methods: pbcopy/pbpaste commands and the PyObjC framework.

**Implementation Features**:
- Prioritize using the PyObjC framework (if available).
- Fall back to the pbcopy/pbpaste commands.
- Automatically detect availability.

**Test Interface**:
```python
class TestOSX(_TestClipboard):
    if os.name == 'mac' or platform.system() == 'Darwin':
        try:
            import Foundation  # check if pyobjc is installed
            import AppKit
        except ImportError:
            clipboard = init_osx_pbcopy_clipboard() # TODO
        else:
            clipboard = init_osx_pyobjc_clipboard()
```

### Node 10: Linux X11 Clipboard Mechanism

**Function Description**: Support multiple Linux clipboard tools, including xclip, xsel, etc.

**Implementation Features**:
- Support the primary selection buffer (PRIMARY selection).
- Support the clipboard buffer (CLIPBOARD selection).
- Automatically detect available tools.

**Test Interface**:
```python
class TestXClip(_TestClipboard):
    if _executable_exists("xclip"):
        clipboard = init_xclip_clipboard()

class TestXSel(_TestClipboard):
    if _executable_exists("xsel"):
        clipboard = init_xsel_clipboard()
```

### Node 11: Wayland Clipboard Mechanism

**Function Description**: Support clipboard operations on the Wayland display server.

**Implementation Features**:
- Use the wl-copy/wl-paste commands.
- Support the primary selection buffer.
- Support clearing the clipboard.

**Test Interface**:
```python
class TestWlClipboard(_TestClipboard):
    if _executable_exists("wl-copy"):
        clipboard = init_wl_clipboard()
```

### Node 12: KDE Klipper Clipboard Mechanism

**Function Description**: Support the Klipper clipboard manager in the KDE desktop environment.

**Implementation Features**:
- Communicate with Klipper using qdbus.
- Handle the line break problem in Klipper.
- Automatically detect the availability of Klipper and qdbus.

**Test Interface**:
```python
class TestKlipper(_TestClipboard):
    if _executable_exists("klipper") and _executable_exists("qdbus"):
        clipboard = init_klipper_clipboard()
```

### Node 13: Qt Framework Clipboard Mechanism

**Function Description**: Implement clipboard operations using the Qt framework, supporting PyQt5 and qtpy.

**Implementation Features**:
- Prioritize using the qtpy abstraction layer.
- Fall back to PyQt5.
- Require display environment support.

**Test Interface**:
```python
class TestQt(_TestClipboard):
    if HAS_DISPLAY:
        try:
            import PyQt5.QtWidgets
        except ImportError:
            pass
        else:
            clipboard = init_qt_clipboard()
```

### Node 14: WSL Clipboard Mechanism

**Function Description**: Support clipboard operations in the Windows Subsystem for Linux environment.

**Implementation Features**:
- Detect the WSL environment.
- Use a special clipboard implementation.
- Be compatible with the characteristics of Windows and Linux.

**Test Interface**:
```python
class TestWSL(_TestClipboard):
    if platform.system() == 'Linux':
        with open('/proc/version', 'r') as f:
            if "Microsoft" in f.read():
                clipboard = init_wsl_clipboard()
```

### Node 15: Cygwin Clipboard Mechanism

**Function Description**: Support clipboard operations in the Cygwin environment, using the /dev/clipboard device.

**Implementation Features**:
- Use the /dev/clipboard device file.
- Handle special characters in Cygwin.
- Warn about unsupported functions.

**Test Interface**:
```python
class TestCygwin(_TestClipboard):
    if 'cygwin' in platform.system().lower():
        clipboard = init_dev_clipboard_clipboard()
```

### Exception Handling Functions

### Node 16: No Clipboard Support Exception

**Function Description**: Provide graceful exception handling when there is no available clipboard mechanism on the system.

**Input/Output Example**:

```python
import pyperclip

# Exception handling when there is no clipboard support
copy_func, paste_func = init_no_clipboard()

try:
    copy_func("foo")
except RuntimeError as e:
    print(f"Copy failed: {e}")

try:
    paste_func()
except RuntimeError as e:
    print(f"Paste failed: {e}")
```

**Test Interface**:
```python
class TestNoClipboard(unittest.TestCase):
    copy, paste = init_no_clipboard()

    def test_copy(self):
        with self.assertRaises(RuntimeError):
            self.copy("foo")

    def test_paste(self):
        with self.assertRaises(RuntimeError):
            self.paste()
```

### Utility Function Features

### Node 17: Executable Detection

**Function Description**: Detect if a specific executable file exists in the system, used for clipboard tool detection.

**Input/Output Example**:

```python
from pyperclip import _executable_exists

# Check if xclip is available
if _executable_exists("xclip"):
    print("xclip is available")

# Check if xsel is available
if _executable_exists("xsel"):
    print("xsel is available")
```

**Test Interface**:
```python
# Use _executable_exists for conditional detection in the test class
class TestXClip(_TestClipboard):
    if _executable_exists("xclip"):
        clipboard = init_xclip_clipboard()
```
