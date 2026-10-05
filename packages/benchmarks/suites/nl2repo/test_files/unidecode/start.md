## Introduction and Goals of the Unidecode Project

`Unidecode` is a Python library whose main function is to transliterate Unicode text into ASCII text.

Main uses:

In many scenarios, although we have text in Unicode format, we need to represent it as ASCII characters. For example:

- Integrate with legacy systems that do not support Unicode.
- Facilitate the input of non-Roman alphabet names on an American keyboard.
- Create ASCII-formatted machine identifiers (such as URL slugs) from human-readable Unicode strings (such as article titles).

`Unidecode` provides a compromise solution: it accepts Unicode data and tries its best to represent it as ASCII characters (i.e., commonly displayable characters with code points between 0x00 and 0x7F). The compromise in this conversion aims to approximate the choices a person using an American keyboard would make during the conversion.

## Natural Language Instructions (Prompt)

Please create a Python project named `Unidecode` to implement a transliteration tool library that losslessly downgrades Unicode text to ASCII. The project should include the following functions:

1. Unicode to ASCII Transliteration (Core Function): Provide functions such as `unidecode()`, `unidecode_expect_ascii()`, and `unidecode_expect_nonascii()` to transliterate Unicode strings containing non-ASCII characters into the closest ASCII strings. Support multiple error handling strategies (such as ignore, strict, replace, preserve), and allow customization of the replacement method for unmapped characters. It works well for transliterating Western language characters and only performs simple character mapping for scripts far from the Latin alphabet (such as Chinese, Japanese, and Korean).

2. Command-Line Tool Support: Provide a command-line tool that can directly transliterate text in files, standard input, or command-line parameters in the terminal through the `unidecode` command. Support specifying input files, directly passing strings, specifying input encodings (such as utf-8, sjis, etc.), and support base64-encoded input to be compatible with the transmission of special characters on Windows. Provide clear error messages for incorrect input.

3. API Design and Compatibility: The main API entry is `unidecode/__init__.py`, which exports the core transliteration functions and the exception class `UnidecodeError`. Support Python 3.7 and above, have complete type hints, and include a `py.typed` file to support type checking tools.

4. Transliteration Tables and Module Structure: Use block-based character mapping tables (such as `x000.py`, `x001.py`, etc.). Each module is responsible for the transliteration mapping of a part of the Unicode block and is dynamically loaded on demand to improve performance and maintainability. Optimize the loading efficiency of the transliteration tables with a caching mechanism.

5. Exception and Warning Handling: Provide reasonable warnings or exceptions for unmappable characters, surrogate pairs, private area characters, etc., to facilitate developers in locating problems. Support custom handling methods for unmappable characters (such as replacement, preservation, reporting errors, etc.).

6. Testing System: Provide comprehensive unit tests covering core transliteration logic, command-line tools, exception handling, special character handling, etc. Test cases include the verification of the transliteration effects of common Western languages, Greek, Russian, Japanese, Chinese, and other multilingual characters, as well as the coverage of error handling branches. Support doctest to automatically verify the example code in the README document.

7. Packaging and Installation: The project includes a complete `setup.py` that supports pip installation, declares Python version requirements and type hint support. Provide a `console_scripts` entry so that the `unidecode` command can be used directly after installation. Include a `unidecode/py.typed` file to support type checking tools.

8. Examples and Usage Demonstration: The README and test cases provide rich examples demonstrating how to perform Unicode to ASCII transliteration through the API and command-line tools. Examples include the invocation methods of multiple languages, special symbols, and different error handling strategies.

9. Design Suggestions for Test Python Files: Test the basic functions and all error handling branches of `unidecode()`, `unidecode_expect_ascii()`, and `unidecode_expect_nonascii()`. Test scenarios such as file input, standard input, command-line parameter input, different encodings, and base64 input of the command-line tool. Test the triggering and handling of exceptions and warnings. Cover the transliteration effects of multilingual and multi-block characters. Test type hints and API compatibility. Refer to the unit tests and doctest in the `tests/` directory to design test cases.

10. Requirements for Core Files: The project must include a complete `setup.py` file, which should configure the project as an installable package (supporting `pip install`) and declare a complete list of dependencies (such as setuptools>=40.0.0, typing-extensions>=3.7.4, pytest>=6.0.0, tox>=3.20.0, etc., the actual core libraries used). `setup.py` should ensure that all core functional modules can work properly. The project needs to include `unidecode/__init__.py` as the unified API entry, exporting core functions and classes such as `unidecode`, `unidecode_expect_ascii`, `unidecode_expect_nonascii`, and `UnidecodeError`, so that users can access all main functions through a simple `from unidecode import *` statement.

---

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
cachetools        6.1.0
chardet           5.2.0
colorama          0.4.6
coverage          7.10.4
distlib           0.4.0
exceptiongroup    1.3.0
filelock          3.19.1
iniconfig         2.1.0
mypy              1.17.1
mypy_extensions   1.1.0
packaging         25.0
pathspec          0.12.1
pip               23.0.1
platformdirs      4.3.8
pluggy            1.6.0
Pygments          2.19.2
pyproject-api     1.9.1
pytest            8.4.1
pytest-cov        6.2.1
pytest-mypy       1.0.1
setuptools        65.5.1
tomli             2.2.1
tox               4.28.4
typing_extensions 4.14.1
virtualenv        20.34.0
wheel             0.40.0
```

## Unidecode Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .coveragerc
├── .gitignore
├── ChangeLog
├── LICENSE
├── MANIFEST.in
├── README.rst
├── benchmark.py
├── perl2python.pl
├── setup.cfg
├── setup.py
└── unidecode
    ├── __init__.py
    ├── __main__.py
    ├── py.typed
    ├── util.py
    ├── x000.py
    ├── x001.py
    ├── x002.py
    ├── x003.py
    ├── x004.py
    ├── x005.py
    ├── x006.py
    ├── x007.py
    ├── x009.py
    ├── x00a.py
    ├── x00b.py
    ├── x00c.py
    ├── x00d.py
    ├── x00e.py
    ├── x00f.py
    ├── x010.py
    ├── x011.py
    ├── x012.py
    ├── x013.py
    ├── x014.py
    ├── x015.py
    ├── x016.py
    ├── x017.py
    ├── x018.py
    ├── x01d.py
    ├── x01e.py
    ├── x01f.py
    ├── x020.py
    ├── x021.py
    ├── x022.py
    ├── x023.py
    ├── x024.py
    ├── x025.py
    ├── x026.py
    ├── x027.py
    ├── x028.py
    ├── x029.py
    ├── x02a.py
    ├── x02c.py
    ├── x02e.py
    ├── x02f.py
    ├── x030.py
    ├── x031.py
    ├── x032.py
    ├── x033.py
    ├── x04d.py
    ├── x04e.py
    ├── x04f.py
    ├── x050.py
    ├── x051.py
    ├── x052.py
    ├── x053.py
    ├── x054.py
    ├── x055.py
    ├── x056.py
    ├── x057.py
    ├── x058.py
    ├── x059.py
    ├── x05a.py
    ├── x05b.py
    ├── x05c.py
    ├── x05d.py
    ├── x05e.py
    ├── x05f.py
    ├── x060.py
    ├── x061.py
    ├── x062.py
    ├── x063.py
    ├── x064.py
    ├── x065.py
    ├── x066.py
    ├── x067.py
    ├── x068.py
    ├── x069.py
    ├── x06a.py
    ├── x06b.py
    ├── x06c.py
    ├── x06d.py
    ├── x06e.py
    ├── x06f.py
    ├── x070.py
    ├── x071.py
    ├── x072.py
    ├── x073.py
    ├── x074.py
    ├── x075.py
    ├── x076.py
    ├── x077.py
    ├── x078.py
    ├── x079.py
    ├── x07a.py
    ├── x07b.py
    ├── x07c.py
    ├── x07d.py
    ├── x07e.py
    ├── x07f.py
    ├── x080.py
    ├── x081.py
    ├── x082.py
    ├── x083.py
    ├── x084.py
    ├── x085.py
    ├── x086.py
    ├── x087.py
    ├── x088.py
    ├── x089.py
    ├── x08a.py
    ├── x08b.py
    ├── x08c.py
    ├── x08d.py
    ├── x08e.py
    ├── x08f.py
    ├── x090.py
    ├── x091.py
    ├── x092.py
    ├── x093.py
    ├── x094.py
    ├── x095.py
    ├── x096.py
    ├── x097.py
    ├── x098.py
    ├── x099.py
    ├── x09a.py
    ├── x09b.py
    ├── x09c.py
    ├── x09d.py
    ├── x09e.py
    ├── x09f.py
    ├── x0a0.py
    ├── x0a1.py
    ├── x0a2.py
    ├── x0a3.py
    ├── x0a4.py
    ├── x0ac.py
    ├── x0ad.py
    ├── x0ae.py
    ├── x0af.py
    ├── x0b0.py
    ├── x0b1.py
    ├── x0b2.py
    ├── x0b3.py
    ├── x0b4.py
    ├── x0b5.py
    ├── x0b6.py
    ├── x0b7.py
    ├── x0b8.py
    ├── x0b9.py
    ├── x0ba.py
    ├── x0bb.py
    ├── x0bc.py
    ├── x0bd.py
    ├── x0be.py
    ├── x0bf.py
    ├── x0c0.py
    ├── x0c1.py
    ├── x0c2.py
    ├── x0c3.py
    ├── x0c4.py
    ├── x0c5.py
    ├── x0c6.py
    ├── x0c7.py
    ├── x0c8.py
    ├── x0c9.py
    ├── x0ca.py
    ├── x0cb.py
    ├── x0cc.py
    ├── x0cd.py
    ├── x0ce.py
    ├── x0cf.py
    ├── x0d0.py
    ├── x0d1.py
    ├── x0d2.py
    ├── x0d3.py
    ├── x0d4.py
    ├── x0d5.py
    ├── x0d6.py
    ├── x0d7.py
    ├── x0f9.py
    ├── x0fa.py
    ├── x0fb.py
    ├── x0fc.py
    ├── x0fd.py
    ├── x0fe.py
    ├── x0ff.py
    ├── x1d4.py
    ├── x1d5.py
    ├── x1d6.py
    ├── x1d7.py
    ├── x1f1.py
    └── x1f6.py

```

### Core Functional Modules

```Plain
# Main functional module descriptions

## Core conversion module (unidecode/__init__.py)
- unidecode(): Main conversion function, supporting multiple error handling modes
- unidecode_expect_ascii(): Conversion function optimized for ASCII strings
- unidecode_expect_nonascii(): Conversion function optimized for non-ASCII strings
- UnidecodeError: Custom exception class

## Command-line tool (unidecode/util.py)
- main(): Command-line entry function
- Supports file input, standard input, and command-line parameter input
- Supports multiple encoding formats and base64 decoding

## Character mapping tables (unidecode/x*.py)
- Character mapping tables organized by Unicode code point ranges
- Each file contains mapping data for 256 characters
- Supports the Unicode character range from 0x0000 to 0x1F6FF

## Testing framework (tests/)
- Comprehensive unit test coverage
- Supports testing with multiple Python versions
- Includes performance benchmark testing
```

---

## API Usage Guide

### Core API

#### 1. Module Import

```python
from unidecode import (
    unidecode, unidecode_expect_ascii, unidecode_expect_nonascii, UnidecodeError
)
```

#### 2. unidecode() Function - Unicode to ASCII Conversion

**Function**: Convert a Unicode string to an ASCII string. This is the main conversion function of the library.

**Implementation**: `unidecode` is an alias for `unidecode_expect_ascii`:
```python
unidecode = unidecode_expect_ascii
```

For detailed documentation, parameters, and usage examples, please refer to Section 3 below (`unidecode_expect_ascii`).

**Example**:
```python
from unidecode import unidecode

result = unidecode('kožušček')
print(result)  # Output: 'kozuscek'

result = unidecode('北京')
print(result)  # Output: 'Bei Jing '
```

#### 3. unidecode_expect_ascii() Function - ASCII-Optimized Conversion

**Function**: Convert a Unicode string to an ASCII string. This function is optimized for strings that are expected to contain mostly ASCII characters, providing better performance in such cases.

**Function Signature**:
```python
def unidecode_expect_ascii(
    string: str,
    errors: str = "ignore",
    replace_str: str = "?"
) -> str:
```

**Parameter Description**:
- `string` (str): The Unicode string to be converted.
- `errors` (str): Error handling strategy when encountering unmappable characters:
  - `"ignore"` (default): Ignore unmappable characters and return an empty string for them.
  - `"strict"`: Raise an `UnidecodeError` exception when encountering unmappable characters.
  - `"replace"`: Replace unmappable characters with the string specified by `replace_str`.
  - `"preserve"`: Preserve the original characters (note: the result may contain non-ASCII characters).
- `replace_str` (str): The replacement string used when `errors='replace'`, default is `'?'`.

**Return Value**: The converted ASCII string.

**Performance Characteristics**:
- For ASCII strings: About 5 times faster than `unidecode_expect_nonascii`.
- For non-ASCII strings: Slightly slower than `unidecode_expect_nonascii`.
- Recommended when the input is known to be primarily ASCII characters.

**Usage Example**:
```python
from unidecode import unidecode_expect_ascii

# Basic usage - mostly ASCII text
result = unidecode_expect_ascii('Hello, World!')
print(result)  # Output: 'Hello, World!'

# Mixed ASCII and Unicode
result = unidecode_expect_ascii('Hello, 世界!')
print(result)  # Output: 'Hello, Shi Jie !'

# Multilingual conversion
result = unidecode_expect_ascii('kožušček')
print(result)  # Output: 'kozuscek'

result = unidecode_expect_ascii('Κνωσός')
print(result)  # Output: 'Knosos'

# Error handling examples
try:
    result = unidecode_expect_ascii('\ue000', errors='strict')
except UnidecodeError as e:
    print(f"Error: {e}")  # Raises exception for unmappable character

result = unidecode_expect_ascii('\ue000', errors='replace', replace_str='*')
print(result)  # Output: '*'

result = unidecode_expect_ascii('\ue000', errors='preserve')
print(result)  # Output: '\ue000' (preserved)

# Batch processing of ASCII-heavy text
texts = ['Hello', 'World', 'Python', 'Programming']
results = [unidecode_expect_ascii(text) for text in texts]
```

#### 4. unidecode_expect_nonascii() Function - Non-ASCII-Optimized Conversion

**Function**: A conversion function optimized for non-ASCII strings. It has consistent performance for both ASCII and non-ASCII input.

**Function Signature**:
```python
def unidecode_expect_nonascii(
    string: str,
    errors: str = "ignore",
    replace_str: str = "?"
) -> str:
```

**Parameter Description**:
- `string` (str): The Unicode string to be converted.
- `errors` (str): Error handling strategy, same as `unidecode()`.
- `replace_str` (str): Replacement string, same as `unidecode()`.

**Return Value**: The converted ASCII string.

**Performance Characteristics**:
- The processing time for ASCII and non-ASCII strings is similar.
- Slightly faster than `unidecode_expect_ascii` for non-ASCII strings.
- Suitable for processing text containing mixed characters.

**Usage Example**:
```python
from unidecode import unidecode_expect_nonascii

# Suitable for processing text containing various characters
result = unidecode_expect_nonascii('Hello, 世界!')
result = unidecode_expect_nonascii('こんにちは世界')
result = unidecode_expect_nonascii('Привет мир!')

# Processing text containing symbols
result = unidecode_expect_nonascii('30 km/h ± 5%')
```

#### 5. UnidecodeError Exception Class

**Function**: A custom exception class for the Unidecode library, used to handle errors during the conversion process.

**Class Definition**:
```python
class UnidecodeError(ValueError):
    def __init__(self, message: str, index: Optional[int] = None) -> None
```

**Attributes**:
- `index` (Optional[int]): The position of the character causing the error in the string.

**Usage Example**:
```python
from unidecode import unidecode, UnidecodeError

try:
    result = unidecode('\ue000', errors='strict')
except UnidecodeError as e:
    print(f"Conversion error: {e}")
    print(f"Error position: {e.index}")

# Catching exceptions during batch processing
texts = ['Hello', '\ue000', 'World']
results = []
for i, text in enumerate(texts):
    try:
        result = unidecode(text, errors='strict')
        results.append(result)
    except UnidecodeError as e:
        print(f"Text {i} conversion failed: {e} at position {e.index}")
        results.append('')
```

---

## Detailed Function Implementation Nodes

### Node 1: ASCII Character Self-Conversion Test

**Function Description**: Verify that ASCII characters (0 - 127) remain unchanged during the conversion process.

**Input-Output Example**:

```python
from unidecode import unidecode, unidecode_expect_ascii, unidecode_expect_nonascii

# ASCII character self-conversion test
for n in range(0, 128):
    char = chr(n)
    result = unidecode(char)
    assert result == char
    assert type(result) == str

# Test cases
input_chars = ['A', 'Z', 'a', 'z', '0', '9', '!', '@', '#', '$']
for char in input_chars:
    result = unidecode(char)
    print(f"Input: {char} -> Output: {result}")  # The output should be the same as the input
```

**Data Types**:

- Input: `str` (single ASCII character)
- Output: `str` (the same character as the input)
- Test Range: Unicode code points 0x0000 - 0x007F

### Node 2: Unicode to ASCII Conversion Test

**Function Description**: Verify that all Unicode characters can be correctly converted to ASCII characters.

**Input-Output Example**:

```python
from unidecode import unidecode

# Basic Unicode conversion test
test_cases = [
    ('Hello, World!', "Hello, World!"),
    ('\'"\r\n', "'\"\r\n"),
    ('ČŽŠčžš', "CZSczs"),
    ('ア', "a"),
    ('α', "a"),
    ('а', "a"),
    ('château', "chateau"),
    ('viñedos', "vinedos"),
    ('北京', "Bei Jing "),
    ('Efﬁcient', "Efficient"),
]

for input_text, expected_output in test_cases:
    result = unidecode(input_text)
    print(f"Input: {input_text} -> Output: {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (Unicode string)
- Output: `str` (ASCII string)
- Test Range: Unicode code points 0x0000 - 0x1FFFF

### Node 3: Surrogate Character Handling Test

**Function Description**: Verify the correct handling of surrogate pairs.

**Input-Output Example**:

```python
from unidecode import unidecode

# Surrogate character test
for n in range(0xd800, 0xe000):
    char = chr(n)
    result = unidecode(char)
    assert result == ''  # Surrogate characters should be converted to an empty string

# Non-BMP character test (requires a wide build)
if sys.maxunicode >= 0x10000:
    # Single non-BMP character
    char = '\U0001d4e3'
    result = unidecode(char)
    assert result == 'T'

    # Surrogate pair representation
    surrogate_pair = '\ud835' + '\udce3'
    result = unidecode(surrogate_pair)
    assert result == 'T'
```

**Data Types**:

- Input: `str` (surrogate pair or surrogate character)
- Output: `str` (empty string or conversion result)
- Test Range: Unicode code points 0xD800 - 0xDFFF

### Node 4: Space Character Handling Test

**Function Description**: Verify the correct conversion of space characters.

**Input-Output Example**:

```python
from unidecode import unidecode

# Space character test
for n in range(0x80, 0x10000):
    char = chr(n)
    if char.isspace():
        result = unidecode(char)
        # The result should be an empty string or an ASCII space
        assert result == '' or result.isspace()

# Test cases
space_chars = [' ', '\t', '\n', '\r', '\u00A0', '\u2000']
for char in space_chars:
    result = unidecode(char)
    print(f"Space character: {repr(char)} -> {repr(result)}")
```

**Data Types**:

- Input: `str` (Unicode space character)
- Output: `str` (empty string or ASCII space)
- Test Range: Unicode code points 0x0080 - 0xFFFF

### Node 5: Circled Latin Letter Conversion Test

**Function Description**: Verify the correct conversion of circled Latin letters.

**Input-Output Example**:

```python
from unidecode import unidecode

# Circled Latin letter test
for n in range(26):
    ascii_char = chr(ord('a') + n)
    circled_char = chr(0x24d0 + n)
    result = unidecode(circled_char)
    assert result == ascii_char

# Test cases
test_cases = [
    ('ⓐ', 'a'), ('ⓑ', 'b'), ('ⓒ', 'c'), ('ⓓ', 'd'), ('ⓔ', 'e'),
    ('ⓕ', 'f'), ('ⓖ', 'g'), ('ⓗ', 'h'), ('ⓘ', 'i'), ('ⓙ', 'j'),
    ('ⓚ', 'k'), ('ⓛ', 'l'), ('ⓜ', 'm'), ('ⓝ', 'n'), ('ⓞ', 'o'),
    ('ⓟ', 'p'), ('ⓠ', 'q'), ('ⓡ', 'r'), ('ⓢ', 's'), ('ⓣ', 't'),
    ('ⓤ', 'u'), ('ⓥ', 'v'), ('ⓦ', 'w'), ('ⓧ', 'x'), ('ⓨ', 'y'), ('ⓩ', 'z')
]

for input_char, expected_output in test_cases:
    result = unidecode(input_char)
    print(f"Circled letter: {input_char} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (circled Latin letter)
- Output: `str` (corresponding lowercase Latin letter)
- Test Range: Unicode code points 0x24D0 - 0x24E9

### Node 6: Mathematical Latin Letter Conversion Test

**Function Description**: Verify the correct conversion of mathematical Latin letters (requires a wide build).

**Input-Output Example**:

```python
from unidecode import unidecode

# Mathematical Latin letter test (requires a wide build)
if sys.maxunicode >= 0x10000:
    # 13 consecutive A - Z, a - z sequences
    empty_count = 0
    for n in range(0x1d400, 0x1d6a4):
        if n % 52 < 26:
            expected = chr(ord('A') + n % 26)
        else:
            expected = chr(ord('a') + n % 26)

        char = chr(n)
        result = unidecode(char)

        if not result:
            empty_count += 1
        else:
            assert result == expected

    assert empty_count == 24  # There should be 24 undefined code points

# Test cases
test_cases = [
    ('𝐀', 'A'), ('𝐁', 'B'), ('𝐂', 'C'), ('𝐚', 'a'), ('𝐛', 'b'), ('𝐜', 'c'),
    ('𝒜', 'A'), ('ℬ', 'B'), ('𝒞', 'C'), ('𝒶', 'a'), ('𝒷', 'b'), ('𝒸', 'c')
]

for input_char, expected_output in test_cases:
    result = unidecode(input_char)
    print(f"Mathematical letter: {input_char} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (mathematical Latin letter)
- Output: `str` (corresponding Latin letter)
- Test Range: Unicode code points 0x1D400 - 0x1D6A3

### Node 7: Mathematical Digit Conversion Test

**Function Description**: Verify the correct conversion of mathematical digits (requires a wide build).

**Input-Output Example**:

```python
from unidecode import unidecode

# Mathematical digit test (requires a wide build)
if sys.maxunicode >= 0x10000:
    # 5 consecutive 0 - 9 sequences
    for n in range(0x1d7ce, 0x1d800):
        expected = chr(ord('0') + (n - 0x1d7ce) % 10)
        char = chr(n)
        result = unidecode(char)
        assert result == expected

# Test cases
test_cases = [
    ('𝟎', '0'), ('𝟏', '1'), ('𝟐', '2'), ('𝟑', '3'), ('𝟒', '4'),
    ('𝟓', '5'), ('𝟔', '6'), ('𝟕', '7'), ('𝟖', '8'), ('𝟗', '9')
]

for input_char, expected_output in test_cases:
    result = unidecode(input_char)
    print(f"Mathematical digit: {input_char} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (mathematical digit)
- Output: `str` (corresponding ASCII digit)
- Test Range: Unicode code points 0x1D7CE - 0x1D7FF

### Node 8: Ignore Error Mode Test

**Function Description**: Verify the error handling in the `errors='ignore'` mode.

**Input-Output Example**:

```python
from unidecode import unidecode

# Ignore error mode test
test_cases = [
    ("test \U000f0000 test", 'test  test'),  # Private use area characters
    ("Hello \ue000 World", "Hello  World"),   # Private use area characters
]

for input_text, expected_output in test_cases:
    result = unidecode(input_text, errors='ignore')
    print(f"Ignore mode: {input_text} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (string containing unmappable characters)
- Output: `str` (result after ignoring unmappable characters)
- Error Handling: `errors='ignore'`

### Node 9: Replace Error Mode Test

**Function Description**: Verify the error handling in the `errors='replace'` mode.

**Input-Output Example**:

```python
from unidecode import unidecode

# Replace error mode test
test_cases = [
    ("test \U000f0000 test", 'test ? test'),           # Default replacement character
    ("Hello \ue000 World", "Hello ? World"),            # Default replacement character
    ("test \U000f0000 test", 'test [UNK] test', '[UNK]'),  # Custom replacement character
]

for input_text, expected_output, *replace_args in test_cases:
    if replace_args:
        result = unidecode(input_text, errors='replace', replace_str=replace_args[0])
    else:
        result = unidecode(input_text, errors='replace')
    print(f"Replace mode: {input_text} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (string containing unmappable characters)
- Output: `str` (result after replacing unmappable characters with the specified character)
- Error Handling: `errors='replace'`
- Replacement Character: `replace_str='?'` (default)

### Node 10: Strict Error Mode Test

**Function Description**: Verify the error handling in the `errors='strict'` mode.

**Input-Output Example**:

```python
from unidecode import unidecode, UnidecodeError

# Strict error mode test
test_cases = [
    "test \U000f0000 test",  # Private use area characters
    "Hello \ue000 World",    # Private use area characters
]

for input_text in test_cases:
    try:
        result = unidecode(input_text, errors='strict')
        print(f"Strict mode success: {input_text} -> {result}")
    except UnidecodeError as e:
        print(f"Strict mode exception: {input_text} -> Position {e.index}: {e}")
        assert e.index is not None
```

**Data Types**:

- Input: `str` (string containing unmappable characters)
- Output: `UnidecodeError` exception
- Error Handling: `errors='strict'`
- Exception Attributes: `index` (error position), `message` (error message)

### Node 11: Preserve Error Mode Test

**Function Description**: Verify the error handling in the `errors='preserve'` mode.

**Input-Output Example**:

```python
from unidecode import unidecode

# Preserve error mode test
test_cases = [
    ("test \U000f0000 test", "test \U000f0000 test"),  # Preserve the original characters
    ("Hello \ue000 World", "Hello \ue000 World"),      # Preserve the original characters
]

for input_text, expected_output in test_cases:
    result = unidecode(input_text, errors='preserve')
    print(f"Preserve mode: {input_text} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (string containing unmappable characters)
- Output: `str` (result after preserving unmappable characters)
- Error Handling: `errors='preserve'`

### Node 12: File Encoding Error Handling Test

**Function Description**: Verify the handling of file encoding errors by the command-line tool.

**Input-Output Example**:

```python
import subprocess
import tempfile
import os

# File encoding error test
def test_encoding_error():
    # Create a temporary file containing non-UTF-8 encoded content
    with tempfile.NamedTemporaryFile(delete=False, mode='wb') as f:
        f.write('革'.encode('sjis'))
        temp_file = f.name

    try:
        # Read the file with the wrong encoding
        cmd = ['unidecode', '-e', 'utf8', temp_file]
        result = subprocess.run(cmd, capture_output=True, text=True)

        print(f"Return code: {result.returncode}")
        print(f"Error output: {result.stderr}")

        # Should return error code 1
        assert result.returncode == 1
        assert "Unable to decode input line" in result.stderr
    finally:
        os.unlink(temp_file)

# Test case
test_encoding_error()
```

**Data Types**:

- Input: File path + incorrect encoding parameter
- Output: Error message + return code 1
- Error Handling: Display decoding error information

### Node 13: Specified Encoding File Processing Test

**Function Description**: Verify that the command-line tool can process files with the specified encoding.

**Input-Output Example**:

```python
import subprocess
import tempfile
import os

# Specified encoding file processing test
def test_specified_encoding():
    # Create a temporary file containing SJIS-encoded content
    with tempfile.NamedTemporaryFile(delete=False, mode='wb') as f:
        f.write('革'.encode('sjis'))
        temp_file = f.name

    try:
        # Read the file with the correct encoding
        cmd = ['unidecode', '-e', 'sjis', temp_file]
        result = subprocess.run(cmd, capture_output=True, text=True)

        print(f"Return code: {result.returncode}")
        print(f"Output: {result.stdout}")

        # Should be successfully converted
        assert result.returncode == 0
        assert result.stdout == 'Ge '
    finally:
        os.unlink(temp_file)

# Test case
test_specified_encoding()
```

**Data Types**:

- Input: File path + correct encoding parameter
- Output: Converted ASCII text + return code 0
- Encoding Handling: Use the specified encoding to read the file

### Node 14: Default Encoding File Processing Test

**Function Description**: Verify that the command-line tool can process files using the system's default encoding.

**Input-Output Example**:

```python
import subprocess
import tempfile
import os
import locale

# Default encoding file processing test
def test_default_encoding():
    # Create a file using the system's default encoding
    default_encoding = locale.getpreferredencoding()

    with tempfile.NamedTemporaryFile(delete=False, mode='wb') as f:
        f.write('革'.encode(default_encoding))
        temp_file = f.name

    try:
        # Do not specify the encoding and use the default encoding
        cmd = ['unidecode', temp_file]
        result = subprocess.run(cmd, capture_output=True, text=True)

        print(f"Return code: {result.returncode}")
        print(f"Output: {result.stdout}")

        # Should be successfully converted
        assert result.returncode == 0
        assert result.stdout == 'Ge '
    finally:
        os.unlink(temp_file)

# Test case
test_default_encoding()
```

**Data Types**:

- Input: File path (without specifying the encoding)
- Output: Converted ASCII text + return code 0
- Encoding Handling: Use the system's default encoding

### Node 15: Standard Input Processing Test

**Function Description**: Verify that the command-line tool can handle standard input.

**Input-Output Example**:

```python
import subprocess
import locale

# Standard input processing test
def test_stdin_processing():
    # Prepare input data
    input_text = '革'
    input_bytes = input_text.encode(locale.getpreferredencoding())

    # Pass data through standard input
    cmd = ['unidecode']
    result = subprocess.run(cmd, input=input_bytes, capture_output=True, text=True)

    print(f"Return code: {result.returncode}")
    print(f"Output: {result.stdout}")

    # Should be successfully converted
    assert result.returncode == 0
    assert result.stdout == 'Ge '

# Test case
test_stdin_processing()
```

**Data Types**:

- Input: Byte data in the standard input stream
- Output: Converted ASCII text + return code 0
- Encoding Handling: Use the system's default encoding

### Node 16: ASCII-Optimized Function Performance Test

**Function Description**: Verify the performance characteristics of the `unidecode_expect_ascii` function.

**Input-Output Example**:

```python
import timeit
from unidecode import unidecode_expect_ascii, unidecode_expect_nonascii

# ASCII-optimized function performance test
def benchmark_ascii_optimization():
    # ASCII string test
    ascii_text = "Hello, World! This is a test string."

    # Test the performance of unidecode_expect_ascii on ASCII text
    ascii_time = timeit.timeit(
        lambda: unidecode_expect_ascii(ascii_text),
        number=10000
    )

    # Test the performance of unidecode_expect_nonascii on ASCII text
    nonascii_time = timeit.timeit(
        lambda: unidecode_expect_nonascii(ascii_text),
        number=10000
    )

    print(f"ASCII text - unidecode_expect_ascii: {ascii_time:.4f}s")
    print(f"ASCII text - unidecode_expect_nonascii: {nonascii_time:.4f}s")

    # unidecode_expect_ascii should be faster
    assert ascii_time < nonascii_time

# Test case
benchmark_ascii_optimization()
```

**Data Types**:

- Input: `str` (ASCII string)
- Output: `str` (conversion result) + execution time
- Performance Characteristics: About 5 times faster than `unidecode_expect_nonascii` on ASCII text

### Node 17: Non-ASCII-Optimized Function Performance Test

**Function Description**: Verify the performance characteristics of the `unidecode_expect_nonascii` function.

**Input-Output Example**:

```python
import timeit
from unidecode import unidecode_expect_ascii, unidecode_expect_nonascii

# Non-ASCII-optimized function performance test
def benchmark_nonascii_optimization():
    # Unicode string test
    unicode_text = "Hello, 世界! こんにちは Привет мир!"

    # Test the performance of unidecode_expect_ascii on Unicode text
    ascii_time = timeit.timeit(
        lambda: unidecode_expect_ascii(unicode_text),
        number=10000
    )

    # Test the performance of unidecode_expect_nonascii on Unicode text
    nonascii_time = timeit.timeit(
        lambda: unidecode_expect_nonascii(unicode_text),
        number=10000
    )

    print(f"Unicode text - unidecode_expect_ascii: {ascii_time:.4f}s")
    print(f"Unicode text - unidecode_expect_nonascii: {nonascii_time:.4f}s")

    # unidecode_expect_nonascii should be slightly faster or similar
    # Note: The actual performance may vary depending on the system

# Test case
benchmark_nonascii_optimization()
```

**Data Types**:

- Input: `str` (Unicode string)
- Output: `str` (conversion result) + execution time
- Performance Characteristics: Consistent performance on Unicode text

### Node 18: WordPress Accent Removal Test

**Function Description**: Verify the compatibility with the WordPress `remove_accents` function.

**Input-Output Example**:

```python
from unidecode import unidecode

# WordPress accent removal test
wordpress_tests = {
    # Latin-1 Supplement
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
    'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
    'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
    'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
    'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
    'ý': 'y', 'ÿ': 'y',

    # Latin Extended-A
    'Ā': 'A', 'ā': 'a', 'Ă': 'A', 'ă': 'a',
    'Ć': 'C', 'ć': 'c', 'Ĉ': 'C', 'ĉ': 'c',
    'Ď': 'D', 'ď': 'd', 'Đ': 'D', 'đ': 'd',
    'Ē': 'E', 'ē': 'e', 'Ĕ': 'E', 'ĕ': 'e',
    'Ė': 'E', 'ė': 'e', 'Ę': 'E', 'ę': 'e',
}

for input_char, expected_output in wordpress_tests.items():
    result = unidecode(input_char)
    print(f"WordPress test: {input_char} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (Latin character with accents)
- Output: `str` (corresponding accent-free character)
- Compatibility: Consistent with the result of the WordPress `remove_accents` function

### Node 19: Unicode Text Converter Test

**Function Description**: Verify the conversion of various Unicode variants.

**Input-Output Example**:

```python
from unidecode import unidecode

# Unicode text converter test
unicode_variants = {
    # Fullwidth characters
    'ｔｈｅ ｑｕｉｃｋ ｂｒｏｗｎ ｆｏｘ': 'the quick brown fox',

    # Double-struck characters
    '𝕥𝕙𝕖 𝕢𝕦𝕚𝕔𝕜 𝕓𝕣𝕠𝕨𝕟 𝕗𝕠𝕩': 'the quick brown fox',

    # Bold characters
    '𝐭𝐡𝐞 𝐪𝐮𝐢𝐜𝐤 𝐛𝐫𝐨𝐰𝐧 𝐟𝐨𝐱': 'the quick brown fox',

    # Bold italic characters
    '𝒕𝒉𝒆 𝒒𝒖𝒊𝒄𝒌 𝒃𝒓𝒐𝒘𝒏 𝒇𝒐𝒙': 'the quick brown fox',

    # Fraktur characters
    '𝔱𝔥𝔢 𝔮𝔲𝔦𝔠𝔨 𝔟𝔯𝔬𝔴𝔫 𝔣𝔬𝔵': 'the quick brown fox',
}

for input_text, expected_output in unicode_variants.items():
    result = unidecode(input_text)
    print(f"Unicode variant: {input_text} -> {result}")
    assert result == expected_output
```

**Data Types**:

- Input: `str` (various Unicode variant characters)
- Output: `str` (standard ASCII characters)
- Test Range: Fullwidth, Double-struck, Bold, Bold italic, Fraktur, etc.

### Node 20: Enclosed Alphanumeric Test

**Function Description**: Verify the conversion of enclosed alphanumeric characters.

**Input-Output Example**:

```python
from unidecode import unidecode

# Enclosed alphanumeric test
# This test verifies various enclosed alphanumeric characters
full_enclosed = 'ⓐⒶ⑳⒇⒛⓴⓾⓿'
result = unidecode(full_enclosed)
expected = 'aA20(20)20.20100'
print(f"Enclosed characters: {full_enclosed} -> {result}")
assert result == expected
```

**Data Types**:

- Input: `str` (enclosed alphanumeric character)
- Output: `str` (corresponding ASCII character or digit)
- Test Range: Circled, parenthesized, dotted, etc. enclosed characters

### Node 21: Fahrenheit and Celsius Symbol Test

**Function Description**: Verify the correct conversion of temperature unit symbols.

**Input-Output Example**:

```python
from unidecode import unidecode

# Temperature unit symbol test
temperature_tests = {
    '\u2109': '\u00b0F',  # Fahrenheit symbol
    '\u2103': '\u00b0C',  # Celsius symbol
}

for input_char, expected_output in temperature_tests.items():
    result = unidecode(input_char)
    expected_result = unidecode(expected_output)
    print(f"Temperature symbol: {input_char} -> {result}")
    print(f"Expected result: {expected_output} -> {expected_result}")
    assert result == expected_result

# Test cases
print(f"Fahrenheit symbol: {unidecode('℉')}")  # Should output: °F
print(f"Celsius symbol: {unidecode('℃')}")  # Should output: °C
```

**Data Types**:

- Input: `str` (temperature unit symbol)
- Output: `str` (converted temperature unit representation)
- Test Range: Fahrenheit and Celsius symbols