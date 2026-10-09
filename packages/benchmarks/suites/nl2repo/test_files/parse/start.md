## Parse Project Introduction and Goals

Parse is a Python library **for string parsing and pattern matching** that can parse formatted strings (supporting Python format() syntax and custom patterns) and extract structured data. This tool performs excellently in string processing and data extraction scenarios, achieving "the highest parsing accuracy and optimal performance." Its core functions include: parsing formatted strings (automatically recognizing and parsing Python format() syntax or custom parsing patterns), **type conversion and equivalence checking** (supporting various data type conversions and pattern matching validations), and intelligent handling of special expressions such as named fields, alignment formats, and precision control. In short, Parse aims to provide a robust string parsing system for extracting structured data from formatted text (e.g., converting formatted strings to structured data via parse() and searching for matching patterns in text via the search() function).

## Natural Language Instructions (Prompt)

Please create a Python project named Parse to implement a string parsing and pattern matching library. The project should include the following functions:

1. Parsing Engine: Extract and parse structured data from the input formatted string, supporting the reverse operation of Python format() syntax, including the parsing of anonymous fields, named fields, and formatted fields. The parsing result should be a Result object or an equivalent comparable form, including fixed-position fields, named fields, type conversion results, etc. It should support multiple parsing modes (parse, search, findall, compile), pattern pre-compilation, and a type conversion system (from strings to various Python types).

2. Format Syntax Processor: Implement functions to parse and process parsing patterns based on Python format() syntax, including field name processing, format specification parsing, alignment and padding processing, precision and width control, etc. It should support format string syntax parsing, field type recognition, alignment operator processing, and special character escaping. Functions include Parser API management, format specification parsing, field type conversion, alignment formatting processing, precision and width control, special character handling, format validation, and syntax error handling.

3. Type Conversion System: Manage built-in and custom type conversions, including special handling of numerical types (integers, floating-point numbers, binary, octal, hexadecimal), date and time types (ISO 8601, RFC2822, global formats, US formats, etc.), string types (letters, numbers, whitespace characters, etc.). Functions include type converter management, custom type registration, pattern matching validation, type validation, conversion error handling, default value processing, and type inference.

4. Interface Design: Design independent function interfaces for each functional module (such as the parsing engine, format processing, type conversion, result management, pattern compilation, etc.), supporting multiple calling methods. Each module should define clear input and output formats. Core interfaces include parse(), search(), findall(), compile(), with_pattern(), etc.

5. Examples and Evaluation Scripts: Provide sample code and test cases to demonstrate how to use the parse() and search() functions for string parsing and pattern matching (e.g., parse("It's {}, I love it!", "It's spam, I love it!") should return a Result object containing the parsing result). The above functions need to be combined to build a complete string parsing and pattern matching toolkit. The project should ultimately include modules such as the parsing engine, format processing, type conversion, result management, and pattern compilation, along with typical test cases, forming a reproducible development process.

6. Core File Requirements: The project must include a complete pyproject.toml file, which should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as setuptools). The pyproject.toml can verify whether all functional modules work properly. Additionally, a parse.py file is required as the unified API entry, importing core functions from each module and exporting core functions such as parse, search, findall, compile, with_pattern, and providing version information, allowing users to access all major functions through a simple from parse import parse, search, findall statement. In parse.py, core classes such as Parser, Result, and Match are needed to manage string parsing and pattern matching using various strategies.
The project should become a fully functional, high-performance, and easy-to-use string parsing and pattern matching library, providing powerful text processing capabilities for Python developers.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.4

### Core Dependency Library Versions

```Plain
coverage   7.10.4
iniconfig  2.1.0
packaging  25.0
parse      1.20.2
pip        25.1.1
pluggy     1.6.0
Pygments   2.19.2
pytest     8.4.1
pytest-cov 6.2.1
```

## Parse Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .git-blame-ignore-revs
├── .gitignore
├── .pytest.ini
├── LICENSE
├── README.rst
├── parse.py
└── pyproject.toml

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from parse import parse, search, findall, compile, with_pattern
```

#### 2. parse() Function - String Parsing

**Function**: Extract values from the target string using a format string. The format must exactly match the string content.

**Function Signature**:
```python
def parse(format, string, extra_types=None, evaluate_result=True, case_sensitive=False):
    """Using "format" attempt to pull values from "string".

    The format must match the string contents exactly. If the value
    you're looking for is instead just a part of the string use
    search().

    If ``evaluate_result`` is True the return value will be an Result instance with two attributes:

     .fixed - tuple of fixed-position values from the string
     .named - dict of named values from the string

    If ``evaluate_result`` is False the return value will be a Match instance with one method:

     .evaluate_result() - This will return a Result instance like you would get
                          with ``evaluate_result`` set to True

    The default behaviour is to match strings case insensitively. You may match with
    case by specifying case_sensitive=True.

    If the format is invalid a ValueError will be raised.

    See the module documentation for the use of "extra_types".

    In the case there is no match parse() will return None.
    """
```

**Parameter Description**:
- `format` (str): Format string using Python format() syntax
- `string` (str): String to be parsed
- `extra_types` (dict): Dictionary of custom type converters
- `evaluate_result` (bool): Whether to evaluate the result immediately, default is True
- `case_sensitive` (bool): Whether to be case-sensitive, default is False

**Return Value**:
- If `evaluate_result=True`: Returns a Result instance or None
- If `evaluate_result=False`: Returns a Match instance or None
- Returns None if there is no match

#### 3. search() Function - String Search

**Function**: Search for the first occurrence of the format in the string. The format can appear anywhere in the string.

**Function Signature**:
```python
def search(
    format,
    string,
    pos=0,
    endpos=None,
    extra_types=None,
    evaluate_result=True,
    case_sensitive=False,
):
    """Search "string" for the first occurrence of "format".

    The format may occur anywhere within the string. If
    instead you wish for the format to exactly match the string
    use parse().

    Optionally start the search at "pos" character index and limit the search
    to a maximum index of endpos - equivalent to search(string[:endpos]).

    If ``evaluate_result`` is True the return value will be an Result instance with two attributes:

     .fixed - tuple of fixed-position values from the string
     .named - dict of named values from the string

    If ``evaluate_result`` is False the return value will be a Match instance with one method:

     .evaluate_result() - This will return a Result instance like you would get
                          with ``evaluate_result`` set to True

    The default behaviour is to match strings case insensitively. You may match with
    case by specifying case_sensitive=True.

    If the format is invalid a ValueError will be raised.

    See the module documentation for the use of "extra_types".

    In the case there is no match parse() will return None.
    """
```

**Parameter Description**:
- `format` (str): Format string
- `string` (str): String to be searched
- `pos` (int): Starting position of the search, default is 0
- `endpos` (int): Ending position of the search, default is None (to the end of the string)
- `extra_types` (dict): Dictionary of custom type converters
- `evaluate_result` (bool): Whether to evaluate the result immediately, default is True
- `case_sensitive` (bool): Whether to be case-sensitive, default is False

**Return Value**:
- If `evaluate_result=True`: Returns a Result instance or None
- If `evaluate_result=False`: Returns a Match instance or None
- Returns None if there is no match

#### 4. findall() Function - Find All Matches

**Function**: Search for all occurrences of the format in the string and return an iterator containing Result instances for each format match.

**Function Signature**:
```python
def findall(
    format,
    string,
    pos=0,
    endpos=None,
    extra_types=None,
    evaluate_result=True,
    case_sensitive=False,
):
    """Search "string" for all occurrences of "format".

    You will be returned an iterator that holds Result instances
    for each format match found.

    Optionally start the search at "pos" character index and limit the search
    to a maximum index of endpos - equivalent to search(string[:endpos]).

    If ``evaluate_result`` is True each returned Result instance has two attributes:

     .fixed - tuple of fixed-position values from the string
     .named - dict of named values from the string

    If ``evaluate_result`` is False each returned value is a Match instance with one method:

     .evaluate_result() - This will return a Result instance like you would get
                          with ``evaluate_result`` set to True

    The default behaviour is to match strings case insensitively. You may match with
    case by specifying case_sensitive=True.

    If the format is invalid a ValueError will be raised.

    See the module documentation for the use of "extra_types".
    """
```

**Parameter Description**:
- `format` (str): Format string
- `string` (str): String to be searched
- `pos` (int): Starting position of the search, default is 0
- `endpos` (int): Ending position of the search, default is None
- `extra_types` (dict): Dictionary of custom type converters
- `evaluate_result` (bool): Whether to evaluate the result immediately, default is True
- `case_sensitive` (bool): Whether to be case-sensitive, default is False

**Return Value**:
- If `evaluate_result=True`: Returns an iterator containing Result instances
- If `evaluate_result=False`: Returns an iterator containing Match instances

#### 5. compile() Function - Precompile Parser

**Function**: Create a Parser instance to parse the format string. It is recommended to use this function if you plan to parse multiple strings with the same format.

**Function Signature**:
```python
def compile(format, extra_types=None, case_sensitive=False):
    """Create a Parser instance to parse "format".

    The resultant Parser has a method .parse(string) which
    behaves in the same manner as parse(format, string).

    The default behaviour is to match strings case insensitively. You may match with
    case by specifying case_sensitive=True.

    Use this function if you intend to parse many strings
    with the same format.

    See the module documentation for the use of "extra_types".

    Returns a Parser instance.
    """
```

**Parameter Description**:
- `format` (str): Format string
- `extra_types` (dict): Dictionary of custom type converters
- `case_sensitive` (bool): Whether to be case-sensitive, default is False

**Return Value**: Returns a Parser instance.

#### 6. with_pattern() Decorator - Custom Type Pattern

**Function**: Attach a regular expression pattern matcher to the custom type converter function. This annotates the type converter with the pattern attribute.

**Function Signature**:
```python
def with_pattern(pattern, regex_group_count=None):
    r"""Attach a regular expression pattern matcher to a custom type converter
    function.

    This annotates the type converter with the :attr:`pattern` attribute.

    EXAMPLE:
        >>> import parse
        >>> @parse.with_pattern(r"\d+")
        ... def parse_number(text):
        ...     return int(text)

    is equivalent to:

        >>> def parse_number(text):
        ...     return int(text)
        >>> parse_number.pattern = r"\d+"

    :param pattern: regular expression pattern (as text)
    :param regex_group_count: Indicates how many regex-groups are in pattern.
    :return: wrapped function
    """

    def decorator(func):
        """Attach a regular expression pattern matcher to a custom type converter function.
        Args:
            func: The function to attach the pattern to.
        Returns:
            The function with the pattern attached.
        """

```

**Parameter Description**:
- `pattern` (str): Regular expression pattern (as text)
- `regex_group_count` (int): Indicates how many regular expression groups are in the pattern, default is None

**Return Value**: Returns a decorator function.

**Example**:
```python
@with_pattern(r"\d+")
def parse_number(text):
    return int(text)
```

#### 7. percentage() Function - Percentage Type Converter

**Function**: Convert a percentage string to a float value.

**Function Signature**:
```python
def percentage(string, match):
```

**Parameter Description**:
- `string` (str): String to be converted
- `match` (Match): Match object

**Return Value**: Returns a float value.

#### 8. date_convert() Function - Date/Time Conversion

**Function**: Convert a string containing date/time information to a datetime instance.

**Function Signature**:
```python
def date_convert(
    string,
    match,
    ymd=None,
    mdy=None,
    dmy=None,
    d_m_y=None,
    hms=None,
    am=None,
    tz=None,
    mm=None,
    dd=None,
):
    """Convert the incoming string containing some date / time info into a
    datetime instance.
    """
```

**Parameter Description**:
- `string` (str): String to be converted
- `match` (Match): Match object
- `ymd` (int): Year-month-day format
- `mdy` (int): Month-day-year format
- `dmy` (int): Day-month-year format
- `d_m_y` (int): Day-month-year format
- `hms` (int): Hour-minute-second format
- `am` (int): AM/PM format
- `tz` (int): Timezone format
- `mm` (int): Month format
- `dd` (int): Day format

**Return Value**: Returns a datetime instance.

#### 9. strf_date_convert() Function - String Format Date Conversion

**Function**: Convert a string containing date/time information to a datetime instance using a string format.

**Function Signature**:
```python
def strf_date_convert(x, _, type):
```

**Parameter Description**:
- `x` (str): String to be converted
- `_` (Match): Match object
- `type` (str): String format

**Return Value**: Returns a datetime instance.

#### 10. get_regex_for_datetime_format() Function - Get Regex for Datetime Format

**Function**: Generate a regex pattern for a given datetime format string.

**Function Signature**:
```python
def get_regex_for_datetime_format(format_):
    """
    Generate a regex pattern for a given datetime format string.

    Parameters:
        format_ (str): The datetime format string.

    Returns:
        str: A regex pattern corresponding to the datetime format string.
    """
    # Replace all format symbols with their regex patterns.
```

**Parameter Description**:
- `format_` (str): The datetime format string.

**Return Value**: Returns a regex pattern.

#### 11. extract_format() Function - Extract Format

**Function**: Extract the format from a string.

**Function Signature**:
```python
def extract_format(format, extra_types):
    """Pull apart the format [[fill]align][sign][0][width][.precision][type]"""
```

**Parameter Description**:
- `format` (str): Format string
- `extra_types` (dict): Dictionary of custom type converters

**Return Value**: Returns a dictionary containing the extracted format.

#### 12. int_convert Class

**Function**: Convert a string to an integer.

**Class Definition**:
```python
class int_convert:
    """Convert a string to an integer.

    The string may start with a sign.

    It may be of a base other than 2, 8, 10 or 16.

    If base isn't specified, it will be detected automatically based
    on a string format. When string starts with a base indicator, 0#nnnn,
    it overrides the default base of 10.

    It may also have other non-numeric characters that we can ignore.
    """

    CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"

    def __init__(self, base=None):
        self.base = base

    def __call__(self, string, match):
        """Convert a string to an integer.
        Args:
            string (str): The string to convert.
            match (Match): The match object.
        Returns:
            int: The converted integer.
        """
```

#### 13. convert_first Class 

**Function**: Convert the first element of a pair.

**Class Definition**:
```python
class convert_first:
    """Convert the first element of a pair.
    This equivalent to lambda s,m: converter(s). But unlike a lambda function, it can be pickled
    """

    def __init__(self, converter):
        self.converter = converter

    def __call__(self, string, match):
        """Convert the first element of a pair.
        Args:
            string (str): The string to convert.
            match (Match): The match object.
        Returns:
            The converted value.
        """
```

#### 14. FixedTzOffset Class

**Function**: Fixed offset in minutes east from UTC.

**Class Definition**:
```python
class FixedTzOffset(tzinfo):
    """Fixed offset in minutes east from UTC."""

    ZERO = timedelta(0)

    def __init__(self, offset, name):
        self._offset = timedelta(minutes=offset)
        self._name = name

    def __repr__(self):
        return "<%s %s %s>" % (self.__class__.__name__, self._name, self._offset)

    def utcoffset(self, dt):
        return self._offset

    def tzname(self, dt):
        return self._name

    def dst(self, dt):
        return self.ZERO

    def __eq__(self, other):
        if not isinstance(other, FixedTzOffset):
            return NotImplemented
        return self._name == other._name and self._offset == other._offset
```

#### 15. TooManyFields Class

**Function**: Too many fields.

**Class Definition**:
```python
class TooManyFields(ValueError):
    pass
```

#### 16. RepeatedNameError Class

**Function**: Repeated name error.

**Class Definition**:
```python
class RepeatedNameError(ValueError):
    pass
```

#### 17. ResultIterator Class

**Function**: The result of a findall() operation.

**Class Definition**:
```python
class ResultIterator(object):
    """The result of a findall() operation.

    Each element is a Result instance.
    """

    def __init__(self, parser, string, pos, endpos, evaluate_result=True):
        self.parser = parser
        self.string = string
        self.pos = pos
        self.endpos = endpos
        self.evaluate_result = evaluate_result

    def __iter__(self):
        return self

    def __next__(self):
        """The result of a findall() operation.
        Returns:
            The next result of the search.
        """

    # pre-py3k compat
    next = __next__
```

#### 18. Constants and Type Aliases

```python
# In parse.py
MONTHS_MAP = {
    "Jan": 1,
    "January": 1,
    "Feb": 2,
    "February": 2,
    "Mar": 3,
    "March": 3,
    "Apr": 4,
    "April": 4,
    "May": 5,
    "Jun": 6,
    "June": 6,
    "Jul": 7,
    "July": 7,
    "Aug": 8,
    "August": 8,
    "Sep": 9,
    "September": 9,
    "Oct": 10,
    "October": 10,
    "Nov": 11,
    "November": 11,
    "Dec": 12,
    "December": 12,
}
DAYS_PAT = r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun)"
MONTHS_PAT = r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
ALL_MONTHS_PAT = r"(%s)" % "|".join(MONTHS_MAP)
TIME_PAT = r"(\d{1,2}:\d{1,2}(:\d{1,2}(\.\d+)?)?)"
AM_PAT = r"(\s+[AP]M)"
TZ_PAT = r"(\s+[-+]\d\d?:?\d\d)"
# note: {} are handled separately
REGEX_SAFETY = re.compile(r"([?\\.[\]()*+^$!|])")

# allowed field types
ALLOWED_TYPES = set(list("nbox%fFegwWdDsSl") + ["t" + c for c in "ieahgcts"])
PARSE_RE = re.compile(r"({{|}}|{[\w-]*(?:\.[\w-]+|\[[^]]+])*(?::[^}]+)?})")

__version__ = "1.20.2"
__all__ = ["parse", "search", "findall", "with_pattern"]
```
### Practical Usage Patterns

#### Basic Usage

```python
from parse import parse, search, findall

# Simple parsing - Fixed position fields
result = parse("Hello, {}!", "Hello, World!")
print(result.fixed)  # ('World!',)

# Named fields
result = parse("Name: {name}, Age: {age:d}", "Name: Alice, Age: 25")
print(result.named)  # {'name': 'Alice', 'age': 25}
print(result['name'])  # 'Alice'

# Search for a match - Find the format in the string
result = search("Age: {:d}", "Name: Bob\nAge: 30\nCity: NYC")
print(result.fixed)  # (30,)

# Find all matches
results = findall("{}", "a b c")
for r in results:
    print(r[0])  # 'a', 'b', 'c'

# Precompile for better performance
parser = compile("User: {name}, Score: {score:d}")
result = parser.parse("User: John, Score: 95")
print(result.named)  # {'name': 'John', 'score': 95}
```

#### Advanced Usage

```python
from parse import parse, compile, with_pattern

# Custom type converter
@with_pattern(r'\d+')
def parse_number(text):
    return int(text)

result = parse("Answer: {number:Number}", "Answer: 42", 
               extra_types={"Number": parse_number})
print(result.named)  # {'number': 42}

# Alignment and formatting
result = parse("with {:>} herring", "with     a herring")
print(result.fixed)  # ('a',)

result = parse("spam {:^} spam", "spam    lovely     spam")
print(result.fixed)  # ('lovely',)

# Delayed evaluation
match = parse("Age: {:d}", "Age: 25", evaluate_result=False)
if match:
    result = match.evaluate_result()
    print(result.fixed)  # (25,)

# Case-sensitive matching
result = parse("Hello, {}!", "hello, world!", case_sensitive=True)
print(result)  # None (because of the case mismatch)
```

#### Complex Pattern Matching

```python
from parse import parse, search

# Dot-separated field names
result = parse("User: {user.name}, Role: {user.role}", 
               "User: admin, Role: administrator")
print(result.named)  # {'user.name': 'admin', 'user.role': 'administrator'}

# Dictionary-style fields
result = parse("Quest: {quest[name]}", 
               "Quest: to seek the holy grail!")
print(result.named)  # {'quest': {'name': 'to seek the holy grail!'}}

# Repeated field names
result = parse("Value: {val}, Value: {val}", 
               "Value: 42, Value: 42")
print(result.named)  # {'val': '42'}

# Mixed field types
# Note: unnamed fields go to `fixed`, named fields go to `named`.
result = parse("ID: {:d}, Name: {name}, Active: {active}", 
               "ID: 123, Name: Test, Active: true")
print(result.fixed)  # (123,)
print(result.named)  # {'name': 'Test', 'active': 'true'}

# Width and precision control
result = parse("Code: {:4}{:4}", "Code: ABCD1234")
print(result.fixed)  # ('ABCD', '1234')

result = parse("Price: {:.2}", "Price: 19.99")
print(result.fixed)  # ('19.99',)
```

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Return Value Check**: Returns None if the parsing fails. It is recommended to always check the return value.
- **Exception Throwing**: Throws a ValueError exception for invalid formats.
- **Type Conversion Failure**: Returns None if the type does not match, without throwing an exception.
- **Security Assurance**: All parsing operations are rigorously tested and will not cause the program to crash.

### Important Notes

1. **Case Sensitivity**: By default, it is not case-sensitive. You can enable it by setting `case_sensitive=True`.
2. **Field Priority**: The parser will match the shortest string that meets the requirements.
3. **Type Conversion**: Built-in type converters will automatically handle format prefixes (e.g., 0x, 0b, 0o).
4. **Performance Consideration**: It is recommended to use `compile()` for precompilation when using the same pattern repeatedly.
5. **Error Handling**: Returns None if the parsing fails. Always check the return value.
6. **Field Naming**: Supports dot-separated field names and dictionary-style field names.
7. **Alignment Handling**: Supports left alignment `<`, right alignment `>`, and center alignment `^`.
8. **Precision Control**: Supports width and precision control, such as `{:4}` and `{:.2}`.
9. **Format Validation**: Throws a ValueError exception for invalid formats.
10. **Delayed Evaluation**: You can delay the result evaluation by using `evaluate_result=False`.

## Detailed Function Implementation Nodes

### Node 1: Basic Parsing Function (Basic Parsing)

**Function Description**: Extract values from the target string using a format string. The format must exactly match the string content. Supports the parsing of fixed position fields, named fields, and formatted fields.

**Core Algorithm**:
- Syntax parsing of the format string
- Field identification and extraction
- Type conversion processing
- Result object construction

**Input/Output Example**:

```python
from parse import parse

# Simple parsing - Fixed position fields
result = parse("Hello, {}!", "Hello, World!")
print(result.fixed)  # ('World!',)

# Named field parsing
result = parse("Name: {name}, Age: {age:d}", "Name: Alice, Age: 25")
print(result.named)  # {'name': 'Alice', 'age': 25}
print(result['name'])  # 'Alice'

# Mixed field types
result = parse("ID: {id:d}, Name: {name}, Active: {active}", 
               "ID: 123, Name: Test, Active: true")
print(result.fixed)  # (123,)
print(result.named)  # {'name': 'Test', 'active': 'true'}

# No match
result = parse("Hello, {}!", "Goodbye, World!")
print(result)  # None
```

### Node 2: String Search Function (String Search)

**Function Description**: Search for the first occurrence of the format in the string. The format can appear anywhere in the string. Supports specifying the starting and ending positions of the search.

**Core Algorithm**:
- Regular expression pattern generation
- String search and matching
- Matching position recording
- Delayed evaluation mechanism

**Input/Output Example**:

```python
from parse import search

# Basic search
result = search("a {} c", " a b c ")
print(result.fixed)  # ('b',)

# Multi-line search
result = search("age: {:d}\n", "name: Rufus\nage: 42\ncolor: red\n")
print(result.fixed)  # (42,)

# Specify the search position
result = search("a {} c", " a b c ", 2)
print(result)  # None (no match when starting the search from position 2)

# Delayed evaluation
match = search("age: {:d}\n", "name: Rufus\nage: 42\ncolor: red\n", 
               evaluate_result=False)
result = match.evaluate_result()
print(result.fixed)  # (42,)
```

### Node 3: Find All Matches Function (Find All Matches)

**Function Description**: Search for all occurrences of the format in the string and return an iterator containing Result instances for each format match. Supports global search and range search.

**Core Algorithm**:
- Iterative search mechanism
- Non-overlapping match processing
- Result iterator generation
- Memory optimization strategy

**Input/Output Example**:

```python
from parse import findall

# Find all matches
results = findall(">{}<", "<p>some <b>bold</b> text</p>")
text = "".join(r.fixed[0] for r in results)
print(text)  # "some bold text"

# Delayed evaluation
matches = findall(">{}<", "<p>some <b>bold</b> text</p>", evaluate_result=False)
text = "".join(m.evaluate_result().fixed[0] for m in matches)
print(text)  # "some bold text"

# Case sensitivity
results = findall("x({})x", "X(hi)X")
print([r.fixed[0] for r in results])  # ['hi'] (not case-sensitive by default)

results = findall("x({})x", "X(hi)X", case_sensitive=True)
print([r.fixed[0] for r in results])  # [] (case-sensitive, no match)
```

### Node 4: Precompiled Parser Function (Precompiled Parser)

**Function Description**: Create a Parser instance to parse the format string, improving performance when used repeatedly. Supports custom types and case sensitivity settings.

**Core Advantages**:
- Performance optimization: Compile once and use multiple times
- Resource reuse: Avoid repeated parsing of the same format
- Centralized configuration: Manage parsing configurations uniformly
- Consistent interface: Behaves the same as the parse function

**Input/Output Example**:

```python
from parse import compile

# Precompiled parser
user_parser = compile("User: {name}, Age: {age:d}")

# Use the same parser multiple times
result1 = user_parser.parse("User: John, Age: 25")
result2 = user_parser.parse("User: Alice, Age: 30")

print(result1.named)  # {'name': 'John', 'age': 25}
print(result2.named)  # {'name': 'Alice', 'age': 30}

# Batch processing
log_parser = compile("Time: {time:ti}, Level: {level}, Message: {message}")
log_entries = [
    "Time: 2023-11-23T10:30:00, Level: INFO, Message: Server started",
    "Time: 2023-11-23T10:31:00, Level: ERROR, Message: Connection failed"
]

for entry in log_entries:
    result = log_parser.parse(entry)
    if result:
        print(f"{result.named['time']} - {result.named['level']}: {result.named['message']}")
```

### Node 5: Custom Type Converters (Custom Type Converters)

**Function Description**: Attach a regular expression pattern matcher to the custom type converter function via the with_pattern decorator, expanding the type processing capabilities of the parsing library.

**Implementation Mechanism**:
- Pattern annotation: Attach a regular expression via the decorator
- Type registration: Add custom types to the parser
- Value conversion: Call the converter function after matching
- Group capture: Supports multi-group regular expression capture

**Input/Output Example**:

```python
from parse import parse, with_pattern

# Custom type converter
@with_pattern(r'\d+')
def parse_number(text):
    return int(text)

@with_pattern(r'(meter|kilometer)', regex_group_count=1)
def parse_unit(text):
    return text.strip()

# Use custom types
result = parse("Distance: {value:Number} {unit:Unit}", 
               "Distance: 5 kilometer",
               extra_types={"Number": parse_number, "Unit": parse_unit})
print(result.named)  # {'value': 5, 'unit': 'kilometer'}

# Custom type with regular expression groups
@with_pattern(r'(\d+)-(\d+)-(\d+)', regex_group_count=3)
def parse_date(text):
    year, month, day = text.split('-')
    return (int(year), int(month), int(day))

result = parse("Date: {date:Date}", "Date: 2023-11-23", 
               extra_types={"Date": parse_date})
print(result.named)  # {'date': (2023, 11, 23)}
```

### Node 6: Complex Field Pattern Processing (Complex Field Patterns)

**Function Description**: Supports complex patterns such as dot-separated fields, dictionary-style fields, and repeated fields, enhancing the flexibility and expressiveness of the parsing library.

**Supported Patterns**:
- Dot-separated fields: `{user.name}`
- Dictionary-style fields: `{quest[name]}`
- Repeated field names: `{val}, {val}`
- Field name conflict handling: Distinguish by special characters

**Input/Output Example**:

```python
from parse import parse

# Dot-separated fields
result = parse("User: {user.name}, Role: {user.role}", 
               "User: admin, Role: administrator")
print(result.named)  # {'user.name': 'admin', 'user.role': 'administrator'}

# Dictionary-style fields
result = parse("Quest: {quest[name]}", 
               "Quest: to seek the holy grail!")
print(result.named)  # {'quest': {'name': 'to seek the holy grail!'}}

# Repeated field names
result = parse("Value: {val}, Value: {val}", 
               "Value: 42, Value: 42")
print(result.named)  # {'val': '42'}

# Field name conflict handling
result = parse("{a_.b}_{a__b}_{a._b}_{a___b}", "a_b_c_d")
print(result.named)  # {'a_.b': 'a', 'a__b': 'b', 'a._b': 'c', 'a___b': 'd'}
```