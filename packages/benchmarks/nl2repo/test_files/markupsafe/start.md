## Introduction and Goals of the MarkupSafe Project

MarkupSafe is a Python library focused on secure text processing for HTML/XML. It is dedicated to providing efficient and reliable string escaping and safe marking capabilities for scenarios such as web applications and template engines. Its core goal is to prevent injection attacks (such as XSS) by automatically escaping special characters and safely inserting untrusted input into HTML or XML documents. The main functions include:
- Provide the `escape()` function to escape characters such as `&`, `<`, `>`, `'`, `"` into safe entities.
- Provide the `Markup` type to mark strings as "safe" and support automatic security maintenance during operations such as concatenation, interpolation, and formatting.
- Support the custom `__html__` protocol to be compatible with the secure content recognition of mainstream web frameworks.
- Be compatible with C extension acceleration and pure Python implementation, taking both performance and portability into account.

---

## Natural Language Instruction (Prompt)

Please create a Python project named MarkupSafe to implement a library for securely processing HTML/XML markup. The project should include the following functions:

1. Implement the `escape(s)` function, which can escape special characters (such as `&`, `<`, `>`, `'`, `"`) in a string into HTML-safe sequences to prevent XSS attacks.

2. Implement the `Markup` class, which inherits from `str` and represents an HTML string that has been safely escaped or is inherently safe. This class should support common operations such as string concatenation, formatting, and interpolation, and ensure that the results remain safe.

3. The `escape(s)` function should support automatically recognizing objects that implement the `__html__` method and directly return their safe HTML representation.

4. Implement the `escape_silent(s)` function, which returns an empty string `Markup('')` when encountering `None`, rather than the string `'None'`.

5. Implement the `soft_str(s)` function, which can safely convert an object to a string and does not perform secondary escaping on the `Markup` type.

6. The `Markup` class should support the `unescape()` method (to restore HTML entities to their original characters) and the `striptags()` method (to remove all HTML tags and only keep the text content).

7. The `Markup` class should overload common string methods (such as `split`, `replace`, `format`, `join`, etc.) to ensure that the result of chained operations still returns the `Markup` type.

8. The project should support the C extension (`_speedups`), which is automatically enabled when available to improve escaping performance; otherwise, it falls back to the pure Python implementation (`_native`).

9. The project should include type annotations and support type checking tools such as `mypy`/`pyright`.

10. Core file requirements: The project must include a complete `pyproject.toml` file, which should configure the project as an installable package (supporting `pip install`) and declare a complete list of dependencies (such as `setuptools>=78`, `mypy>=1.6`, `pyright>=1.1`, `ruff>=0.1.0`, `pre-commit>=3.3.0`, etc., the actual core libraries used). The `pyproject.toml` should ensure that all core functional modules can work properly. At the same time, `src/markupsafe/__init__.py` should be provided as a unified API entry, importing and exporting `escape`, `escape_silent`, `soft_str`, `Markup`,`_escape_inner`, and the main import and export functions, and providing version information, so that users can access all the main functions through simple statements such as `import markupsafe` and `from markupsafe import *`.

---

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```plain
exceptiongroup    1.3.0
iniconfig         2.1.0
packaging         25.0
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
setuptools        65.5.1
tomli             2.2.1
typing_extensions 4.14.1
wheel             0.40.0
```
---

## MarkupSafe Project Architecture

### Project Directory Structure

```plain
workspace/
├── .devcontainer
│   ├── devcontainer.json
│   ├── on-create-command.sh
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── CHANGES.rst
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── bench.py
├── pyproject.toml
├── src
│   ├── markupsafe
│   │   ├── __init__.py
│   │   ├── _native.py
│   │   ├── _speedups.c
│   │   ├── _speedups.pyi
│   │   └── py.typed
└── uv.lock
``` 

## API Usage Guide

### 1. Module Import and Core Interfaces

```python
import markupsafe
from markupsafe import escape, escape_silent, soft_str, Markup
```

### 2. _escape_inner

**Description**:
This is an internal function and the core of MarkupSafe's escaping logic. It is responsible for replacing special HTML characters (`&`, `>`, `<`, `'`, `"`) in a string with their corresponding HTML entities. For performance, this function has an accelerated version in C (`_speedups.c`) and a pure Python fallback version (`_native.py`). The program will prioritize loading the C-accelerated version upon import.

**Function Signature**:
```python
def _escape_inner(s: str, /) -> str:
```

**Parameters**:
- `s` (`str`): The original string that needs to be HTML-escaped.

**Return Value**:
- `str`: A new, escaped string.

**Example**:
```python
# This is an internal function and not typically called directly
from markupsafe._native import _escape_inner

unsafe_string = "<script>alert('hello')</script>"
escaped_string = _escape_inner(unsafe_string)
# escaped_string -> '&lt;script&gt;alert(&#39;hello&#39;)&lt;/script&gt;'
```

### 3. `escape(s)` - HTML/XML Character Escaping

**Function**: Escape special characters (such as `&`, `<`, `>`, `'`, `"`) in a string into HTML-safe sequences.

**Parameters**:
- `s`: The object to be escaped (a string or an object that implements the `__html__` method).

**Return Value**: Returns a safe string of the `Markup` type.

**Example**:
```python
escape('<script>')  # Markup('&lt;script&gt;')
escape('你好&><\'"')  # Markup('你好&amp;&gt;&lt;&#39;&#34;')
```

### 4. `escape_silent(s)` - Safe Escaping for Null Values

**Function**: Similar to `escape`, but returns an empty string `Markup('')` when encountering `None`.

**Parameters**:
- `s`: The object to be escaped or `None`.

**Return Value**: Returns a safe string of the `Markup` type.

**Example**:
```python
escape_silent(None)  # Markup('')
escape_silent('<foo>')  # Markup('&lt;foo&gt;')
```

### 5. `soft_str(s)` - Soft String Conversion

**Function**: Safely convert an object to a string. If it is of the `Markup` type, keep its security properties.

**Parameters**:
- `s`: Any object.

**Return Value**: A string or an object of the `Markup` type.

**Example**:
```python
soft_str('abc')  # 'abc'
soft_str(Markup('abc'))  # Markup('abc')
soft_str(123)  # '123'
```

### 6. `format(*args: t.Any, **kwargs: t.Any) -> Markup`
**Functionality**: Formats a string using positional and keyword arguments, automatically escaping all argument values.

**Parameters**:
- `*args`: Positional arguments used for string formatting.
- `**kwargs`: Keyword arguments used for string formatting.

**Return Value**:
- A new `Markup` instance containing the formatted and escaped content.

**Implementation**:
```python
def format(self, *args: t.Any, **kwargs: t.Any) -> te.Self:
    formatter = EscapeFormatter(self.escape)
    return self.__class__(formatter.vformat(self, args, kwargs))
```

**Example**:
```python
template = Markup("<p>Hello, {name}!</p>")
result = template.format(name="<script>alert('XSS')")
# Result: Markup('<p>Hello, &lt;script&gt;alert(\'XSS\')!</p>')
```

### 7. `Markup` Class - HTML Safe String Type

**Function**: Inherits from `str` and represents an HTML string that has been safely escaped or is inherently safe. It supports operations such as string concatenation, formatting, and interpolation, and the results are always safe.

**Common Methods**:
- `Markup(s)`
- `Markup.escape(s)`
- `Markup` object + ordinary string
- `Markup` object % variable
- `Markup` object.format(...)
- `Markup` object.unescape()
- `Markup` object.striptags()

**Example**:
```python
m = Markup('<b>foo</b>')
print(m)  # <b>foo</b>
print(m + '<script>')  # <b>foo</b> &lt;script&gt;
print(Markup('<em>%s</em>') % '<bad>')  # <em>&lt;bad&gt;</em>
print(Markup('<em>%(foo)s</em>') % {'foo': '<foo>'})  # <em>&lt;foo&gt;</em>
print(Markup('<em>{name}</em>').format(name='<bar>'))  # <em>&lt;bar&gt;</em>
```

### 8. `_HasHTML` Class - Protocol for Objects that Implement the `__html__` Method

**Function**: This is a protocol class that defines the `__html__` method. It is used to mark objects that implement the `__html__` method as safe content.

**Class Definition**:
```python
class _HasHTML(t.Protocol):
    def __html__(self, /) -> str: ...
```

**Example**:
```python
class User:
    def __html__(self):
        return '<span>safe</span>'
```

### 9. `_TPEscape` Class - Protocol for Functions that Implement the `__call__` Method

**Function**: This is a protocol class that defines the `__call__` method. It is used to mark functions that implement the `__call__` method as safe escaping functions.

**Class Definition**:
```python
class _TPEscape(t.Protocol):
    def __call__(self, s: t.Any, /) -> Markup: ...
```

**Example**:
```python
def escape(s: t.Any, /) -> Markup:
    return Markup(_escape_inner(str(s)))
```

### 10. `_MarkupEscapeHelper` Class - Helper for `Markup.__mod__`

**Function**: This is a helper class for the `Markup.__mod__` method. It is used to help the `Markup.__mod__` method to escape the object.

**Class Definition**:
```python
class _MarkupEscapeHelper:
    __slots__ = ("obj", "escape")
```

**Example**:
```python
helper = _MarkupEscapeHelper(obj, escape)
print(helper)  # Markup('&lt;span&gt;safe&lt;/span&gt;')
```

### 11. `__html__` and `__html_format__` Protocols

**Function**: If an object implements the `__html__` method, `escape`/`Markup` will automatically call it and treat it as safe content. If it implements `__html_format__`, it is used for formatted interpolation.

**Example**:
```python
class User:
    def __html__(self):
        return '<span>safe</span>'
    def __html_format__(self, spec):
        if spec == 'link':
            return Markup('<a href="/user">user</a>')
        return self.__html__()
user = User()
print(escape(user))  # Markup('<span>safe</span>')
print(Markup('<p>{0:link}</p>').format(user))  # <p><a href="/user">user</a></p>
```

### 12. Inter-module Call Relationships

- `escape`, `escape_silent`, `soft_str`, and `Markup` are all implemented in `markupsafe/__init__.py`, and `Markup` depends on `escape` for safe escaping.
- `Markup` supports mixed operations with ordinary strings and objects that implement `__html__`, always ensuring the safety of the results.
- The C extension `_speedups.c` (if available) automatically accelerates escaping; otherwise, it falls back to `_native.py`.

### 13. Typical Usage Patterns

```python
from markupsafe import escape, Markup
html = escape('<em>Hello</em>')
print(html)  # Markup('&lt;em&gt;Hello&lt;/em&gt;')
print(html + ' <b>World</b>')  # Markup('&lt;em&gt;Hello&lt;/em&gt; &lt;b&gt;World&lt;/b&gt;')

template = Markup('<em>%s</em>')
result = template % '<bad>'  # Automatically escape interpolation

template = Markup('<p>User: {user:link}</p>')
result = template.format(user=User(...))

text = Markup('<b>foo</b>').striptags()  # 'foo'
plain = Markup('&lt;foo&gt;').unescape()  # '<foo>'
```

---

## Detailed Implementation Nodes of Functions

### 1. HTML/XML Safe Escaping (`escape`)

**Function Description**: Escapes special characters (such as `&`, `<`, `>`, `'`, `"`) in a string into HTML-safe sequences to prevent injection attacks.

**Input-Output Examples**:
```python
from markupsafe import escape
print(escape('<script>'))  # Markup('&lt;script&gt;')
print(escape('你好&><\'"'))  # Markup('你好&amp;&gt;&lt;&#39;&#34;')
print(escape('\U0001f363&><\'"'))  # Markup('\U0001f363&amp;&gt;&lt;&#39;&#34;')
```

### 2. HTML Safe String Type (`Markup`)

**Function Description**: Inherits from `str` and represents an HTML string that has been safely escaped or is inherently safe. It supports operations such as concatenation, interpolation, and formatting, and the results are always safe.

**Input-Output Examples**:
```python
from markupsafe import Markup
m = Markup('<b>foo</b>')
print(m)  # <b>foo</b>
print(m + '<script>')  # <b>foo</b> &lt;script&gt;
print(Markup('<em>%s</em>') % '<bad>')  # <em>&lt;bad&gt;</em>
print(Markup('<em>%(foo)s</em>') % {'foo': '<foo>'})  # <em>&lt;foo&gt;</em>
print(Markup('<em>{name}</em>').format(name='<bar>'))  # <em>&lt;bar&gt;</em>
```

### 3. Safe Escaping for Null Values (`escape_silent`)

**Function Description**: Similar to `escape`, but returns an empty string `Markup('')` when encountering `None`.

**Input-Output Examples**:
```python
from markupsafe import escape_silent
print(escape_silent(None))  # Markup('')
print(escape_silent('<foo>'))  # Markup('&lt;foo&gt;')
```

### 4. Soft String Conversion (`soft_str`)

**Function Description**: Safely converts an object to a string. If it is of the `Markup` type, preserves its security properties (returns the `Markup` instance unchanged).

**Input-Output Examples**:
```python
from markupsafe import soft_str, Markup
print(type(soft_str('abc')))  # <class 'str'>
print(type(soft_str(Markup('abc'))))  # <class 'markupsafe.Markup'>
print(type(soft_str(123)))  # <class 'str'>
```

### 5. HTML Entity Unescaping and Tag Stripping (`unescape`, `striptags`)

**Function Description**: The `Markup` class supports the `unescape()` method to restore HTML entities to their original characters. The `striptags()` method removes HTML comments and tags, normalizes whitespace to single spaces, and then unescapes the result to return plain text content.

**Input-Output Examples**:
```python
from markupsafe import Markup
print(Markup('&lt;test&gt;').unescape())  # <test>
print(Markup('<b>foo</b>').striptags())  # foo
```

### 6. Custom `__html__` and `__html_format__` Protocols

**Function Description**: If an object implements the `__html__` method, it can be automatically recognized as safe content by `escape`/`Markup`. Implementing `__html_format__` allows for custom formatted interpolation with format specifiers.

**Input-Output Examples**:
```python
from markupsafe import escape, Markup
class User:
    def __html__(self):
        return '<span>safe</span>'
    def __html_format__(self, spec):
        if spec == 'link':
            return Markup('<a href="/user">user</a>')
        return self.__html__()
user = User()
print(escape(user))  # Markup('<span>safe</span>')
print(Markup('<p>{0:link}</p>').format(user))  # <p><a href="/user">user</a></p>
```

### 7. String Method Compatibility and Chained Operations

**Function Description**: `Markup` overloads common string methods such as `split`, `replace`, `join`, and `format` to ensure that the result of chained operations still returns the `Markup` type.

**Input-Output Examples**:
```python
from markupsafe import Markup
m = Markup('a b')
print(m.split())  # [Markup('a'), Markup('b')]
print(Markup('a') * 3)  # Markup('aaa')
```

### 8. Exception Handling and Type Safety

**Function Description**: When `escape` encounters an exception thrown by a custom `__html__` method, it correctly propagates the exception. The return value type of `escape` is always `Markup`.

**Input-Output Examples**:
```python
from markupsafe import escape, Markup
class Bad:
    def __html__(self):
        raise ValueError('fail')
try:
    escape(Bad())
except ValueError as e:
    print('Exception caught:', e)
print(isinstance(escape('a'), Markup))  # True
```

### 9. C Extension Acceleration and Memory Safety

**Function Description**: If available, automatically enables `_speedups.c` to accelerate escaping; otherwise, falls back to `_native.py`. Tests ensure that multiple calls to `escape` do not cause memory leaks.

**Input-Output Examples**:
```python
from markupsafe import escape
for _ in range(1000):
    escape('foo')
    escape('<foo>')
# After running, the number of memory objects should be stable without leakage.
```