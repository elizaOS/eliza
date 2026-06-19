## Introduction and Goals of the Humanize Project

Humanize is a Python library **aimed at humanizing data display**, capable of converting data such as numbers, times, and file sizes into human-readable and friendly formats. This tool performs excellently in scenarios such as data presentation, user interfaces, and logging, achieving "the most intuitive data display and the optimal user experience." Its core functions include: number humanization (automatically converting large numbers into forms with thousands separators or in word form), **time and date humanization** (converting time differences into natural language expressions like "3 minutes ago" or "yesterday"), file size humanization (converting byte counts into readable formats like "1.5 MB" or "2.3 GB"), and list humanization (converting arrays into natural language lists like "apples, bananas, and oranges"). In short, Humanize is dedicated to providing a comprehensive data humanization system for converting machine data into human-friendly display formats (for example, adding thousands separators to numbers through `intcomma()`, converting time differences into relative time descriptions through `naturaltime()`, and converting byte counts into readable file sizes through `naturalsize()`).

## Natural Language Instructions (Prompt)

Please create a Python project named Humanize to implement a data humanization display library. This project should include the following functions:

1. Number Humanization Module: Capable of converting numbers into human-readable formats, including thousands separators (e.g., 1,234,567), word forms (e.g., 1.2 million), ordinal numbers (e.g., 1st, 2nd, 3rd), fractional representations (e.g., 1/3), scientific notation (e.g., 3.00 x 10²), etc. It should support the automatic conversion and formatting of large numbers.

2. Time Humanization Module: Implement functions to convert time differences into natural language descriptions, including relative time (e.g., "3 minutes ago", "2 hours ago", "yesterday", "tomorrow"), precise time differences (e.g., "2 days, 1 hour, and 33 seconds"), natural dates (e.g., "today", "yesterday", "Jun 05"), etc. It should support the intelligent selection of different time units and localization.

3. File Size Humanization Module: Convert byte counts into human-readable file size formats, supporting decimal (e.g., 1.5 MB) and binary (e.g., 1.5 MiB) representations, as well as GNU-style (e.g., 2.9K) formats. It should support the full range from bytes to QB (quettabyte).

4. List Humanization Module: Convert arrays into natural language lists, automatically adding commas and the conjunction "and" (e.g., "apples, bananas, and oranges"). It should support the intelligent processing of lists of different lengths.

5. Internationalization Support: Provide multi-language localization support, including more than 30 languages such as Arabic, Chinese, English, French, German, Japanese, Korean, etc. It should support runtime language switching and custom translation paths.

6. Interface Design: Design independent function interfaces for each functional module, supporting multiple input formats (numbers, strings, datetime objects, etc.). Each module should define clear input and output formats and error handling.

7. Examples and Usage Scripts: Provide sample code and usage cases to demonstrate how to use core functions such as `intcomma()` to add thousands separators, `naturaltime()` to convert relative time, `naturalsize()` to format file sizes, and `natural_list()` to process lists.

8. Core File Requirements: The project must include a complete `pyproject.toml` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare the complete list of dependencies (including core libraries such as `hatch-vcs==1.0.0`, `hatchling==1.27.0`, `Python>=3.9`, `gettext==0.19.8.1`, `pytest==7.4.2`, `pytest-cov==4.1.0`, `freezegun==1.3.0`). Additionally, the `pyproject.toml` file must configure version information retrieval from the version control system (VCS) using `hatch-vcs`, with settings specifying the version source as "vcs", generating a version file (e.g., `src/humanize/_version.py`), and defining versioning rules such as local scheme handling. The `pyproject.toml` file can verify whether all functional modules work properly. Additionally, it is necessary to provide `src/humanize/__init__.py` as a unified API entry, importing core functions and classes such as `intcomma`, `naturaltime`, `naturalsize`, `natural_list` and `activate`, and providing version information (imported from the generated version file), allowing users to access all major functions through simple statements like "import humanize" and "from humanize import *". In `number.py`, functions such as `intcomma()`, `intword()`, `ordinal()`, `fractional()`, and `scientific()` are required to handle various number humanization needs; in `time.py`, functions such as `naturaltime()`, `naturaldelta()`, `naturalday()`, `naturaldate()`, `_date_and_delta()`,and `precisedelta()`  are required to handle time humanization needs; in `filesize.py`, the `naturalsize()` function is required to handle file size humanization needs; in `lists.py`, the `natural_list()` function is required to handle list humanization needs; in `i18n.py`, functions such as `activate()` , `deactivate()` and `_gettext()` are required to handle internationalization needs.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
babel                          2.17.0
backrefs                       5.9
bracex                         2.6
certifi                        2025.8.3
charset-normalizer             3.4.3
click                          8.2.1
colorama                       0.4.6
coverage                       7.10.3
exceptiongroup                 1.3.0
freezegun                      1.5.5
ghp-import                     2.1.0
griffe                         1.11.0
hatch-vcs                      0.5.0
hatchling                      1.27.0
idna                           3.10
iniconfig                      2.1.0
Jinja2                         3.1.6
Markdown                       3.8.2
MarkupSafe                     3.0.2
mergedeep                      1.3.4
mkdocs                         1.6.1
mkdocs-autorefs                1.4.2
mkdocs-get-deps                0.2.0
mkdocs-include-markdown-plugin 7.1.6
mkdocs-material                9.6.16
mkdocs-material-extensions     1.3.1
mkdocstrings                   0.30.0
mkdocstrings-python            1.16.12
mypy                           1.17.1
mypy_extensions                1.1.0
packaging                      25.0
paginate                       0.5.7
pathspec                       0.12.1
pip                            23.0.1
platformdirs                   4.3.8
pluggy                         1.6.0
Pygments                       2.19.2
pymdown-extensions             10.16.1
pyproject-fmt                  2.6.0
pytest                         8.4.1
pytest-cov                     6.2.1
python-dateutil                2.9.0.post0
PyYAML                         6.0.2
pyyaml_env_tag                 1.1
requests                       2.32.4
ruff                           0.12.8
setuptools                     65.5.1
setuptools-scm                 8.3.1
six                            1.17.0
toml-fmt-common                1.0.1
tomli                          2.2.1
trove-classifiers              2025.8.6.13
types-freezegun                1.1.10
types-setuptools               80.9.0.20250809
typing_extensions              4.14.1
urllib3                        2.5.0
watchdog                       6.0.0
wcmatch                        10.1
wheel                          0.40.0
```

## Humanize Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yml
├── .yamlfmt.yaml
├── LICENCE
├── README.md
├── RELEASING.md
├── mkdocs.yml
├── pyproject.toml
├── requirements-mypy.txt
├── scripts
│   ├── generate-translation-binaries.sh
│   ├── update-translations.sh
├── src
│   ├── humanize
│   │   ├── __init__.py
│   │   ├── filesize.py
│   │   ├── i18n.py
│   │   ├── lists.py
│   │   ├── locale
│   │   │   ├── ar
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── bn_BD
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── ca_ES
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── da_DK
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── de_DE
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── el_GR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── eo
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── es_ES
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── eu
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── fa_IR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── fi_FI
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── fr_FR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── he_IL
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── hu_HU
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── id_ID
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── it_IT
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── ja_JP
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── ko_KR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── nb
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── nl_NL
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── pl_PL
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── pt_BR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── pt_PT
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── ru_RU
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── sk_SK
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── sl_SI
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── sv_SE
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── tlh
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── tr_TR
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── uk_UA
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── vi_VN
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── zh_CN
│   │   │   │   ├── LC_MESSAGES
│   │   │   │   │   └── humanize.po
│   │   │   ├── zh_HK
│   │   │   │   └── LC_MESSAGES
│   │   │   │       └── humanize.po
│   │   ├── number.py
│   │   ├── py.typed
│   │   └── time.py
└── tox.ini

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
import humanize
from humanize import (
    intcomma, intword, ordinal, fractional, scientific, clamp, metric,
    naturaltime, naturaldelta, naturalday, naturaldate, precisedelta,
    naturalsize, natural_list,
    activate, deactivate, decimal_separator, thousands_separator
)
```

#### 2. `intcomma()` Function - Number Thousands Separator Formatting

**Function**: Convert a number into a string format with thousands separators.

**Function Signature**:
```python
def intcomma(value: NumberOrString, ndigits: int | None = None) -> str:
```

**Parameter Description**:
- `value (int, float, str)`: The number to be converted, supporting integers, floats, or strings.
- `ndigits (int | None)`: The precision of decimal places. `None` means no limit.

**Return Value**: A string with thousands separators.

**Usage Example**:
```python
intcomma(1000)                    # '1,000'
intcomma(1234567.25)              # '1,234,567.25'
intcomma(1234.5454545, 2)         # '1,234.55'
```

#### 3. `intword()` Function - Large Number Wordification

**Function**: Convert large numbers into friendly text representations.

**Function Signature**:
```python
def intword(value: NumberOrString, format: str = "%.1f") -> str:
```

**Parameter Description**:
- `value (int, float, str)`: The number to be converted.
- `format (str)`: The formatting string, with the default being "%.1f".

**Return Value**: A string representing the number in word form.

**Usage Example**:
```python
intword(1000000)                  # '1.0 million'
intword(1200000)                  # '1.2 million'
intword(1200000000)               # '1.2 billion'
```

#### 4. `ordinal()` Function - Ordinal Number Conversion

**Function**: Convert an integer into an ordinal number form.

**Function Signature**:
```python
def ordinal(value: NumberOrString, gender: str = "male") -> str:
```

**Parameter Description**:
- `value (int, float, str)`: The number to be converted.
- `gender (str)`: The gender, supporting "male" or "female".

**Return Value**: A string representing the ordinal number.

**Usage Example**:
```python
ordinal(1)                        # '1st'
ordinal(2)                        # '2nd'
ordinal(3)                        # '3rd'
ordinal(4)                        # '4th'
ordinal(1002)                     # '1002nd'
```

#### 5. `fractional()` Function - Fractional Representation

**Function**: Convert a decimal into a fractional representation.

**Function Signature**:
```python
def fractional(value: NumberOrString) -> str:
```

**Parameter Description**:
- `value (int, float, str)`: The number to be converted.

**Return Value**: A string representing the fraction.

**Usage Example**:
```python
fractional(1/3)                   # '1/3'
fractional(1.5)                   # '1 1/2'
fractional(0.3)                   # '3/10'
fractional(0.333)                 # '333/1000'
```

#### 6. `scientific()` Function - Scientific Notation

**Function**: Convert a number into scientific notation.

**Function Signature**:
```python
def scientific(value: NumberOrString, precision: int = 2) -> str:
```

**Parameter Description**:
- `value (int, float, str)`: The number to be converted.
- `precision (int)`: The number of precision digits, with the default being 2.

**Return Value**: A string representing the scientific notation.

**Usage Example**:
```python
scientific(0.3)                   # '3.00 x 10⁻¹'
scientific(500)                   # '5.00 x 10²'
scientific("20000")               # '2.00 x 10⁴'
scientific(1**10, precision=1)    # '1.0 x 10⁰'
```

#### 7. `naturaltime()` Function - Natural Time Representation

**Function**: Convert a time difference into a natural language description.

**Function Signature**:
```python
def naturaltime(
    value: dt.datetime | dt.timedelta | float,
    future: bool = False,
    months: bool = True,
    minimum_unit: str = "seconds",
    when: dt.datetime | None = None,
) -> str:
```

**Parameter Description**:
- `value`: The time value, which can be a `datetime`, `timedelta`, or the number of seconds.
- `future (bool)`: Whether it is a future time, with the default being `False`.
- `months (bool)`: Whether to use months, with the default being `True`.
- `minimum_unit (str)`: The minimum time unit, with the default being "seconds".
- `when (datetime)`: The reference time point, with the default being the current time.

**Return Value**: A natural language description of the time.

**Usage Example**:
```python
import datetime as dt

naturaltime(dt.timedelta(seconds=1001))     # '16 minutes ago'
naturaltime(dt.timedelta(seconds=3600))     # 'an hour ago'
naturaltime(dt.datetime.now() - dt.timedelta(days=1))  # 'a day ago'
```

#### 8. `naturaldelta()` Function - Natural Representation of Time Difference

**Function**: Convert a time difference into a natural language description (without tense).

**Function Signature**:
```python
def naturaldelta(
    value: dt.timedelta | float,
    months: bool = True,
    minimum_unit: str = "seconds",
) -> str:
```

**Parameter Description**:
- `value`: The time difference, which can be a `timedelta` or the number of seconds.
- `months (bool)`: Whether to use months, with the default being `True`.
- `minimum_unit (str)`: The minimum time unit, with the default being "seconds".

**Return Value**: A natural language description of the time difference.

**Usage Example**:
```python
import datetime as dt

naturaldelta(dt.timedelta(seconds=1001))    # '16 minutes'
naturaldelta(dt.timedelta(days=2, hours=1)) # '2 days, 1 hour'
```

#### 9. `naturalday()` Function - Natural Date Representation

**Function**: Convert a date into a natural language description.

**Function Signature**:
```python
def naturalday(value: dt.date | dt.datetime, format: str = "%b %d") -> str:
```

**Parameter Description**:
- `value`: The date object.
- `format (str)`: The formatting string, with the default being "%b %d".

**Return Value**: A natural language description of the date.

**Usage Example**:
```python
import datetime as dt

naturalday(dt.date.today())                 # 'today'
naturalday(dt.date.today() + dt.timedelta(days=1))  # 'tomorrow'
naturalday(dt.date.today() - dt.timedelta(days=1))  # 'yesterday'
```

#### 10. `naturalsize()` Function - File Size Humanization

**Function**: Convert a byte count into a human-readable file size format.

**Function Signature**:
```python
def naturalsize(
    value: float | str,
    binary: bool = False,
    gnu: bool = False,
    format: str = "%.1f",
) -> str:
```

**Parameter Description**:
- `value (float | str)`: The byte count.
- `binary (bool)`: Whether to use binary units, with the default being `False`.
- `gnu (bool)`: Whether to use the GNU style, with the default being `False`.
- `format (str)`: The formatting string, with the default being "%.1f".

**Return Value**: A human-readable string representing the file size.

**Usage Example**:
```python
naturalsize(3000000)              # '3.0 MB'
naturalsize(3000, True)           # '2.9 KiB'
naturalsize(3000, False, True)    # '2.9K'
naturalsize(10**28)               # '10.0 RB'
```

#### 11. `natural_list()` Function - List Humanization

**Function**: Convert an array into a natural language list.

**Function Signature**:
```python
def natural_list(items: list[Any]) -> str:
```

**Parameter Description**:
- `items (list)`: The list to be converted.

**Return Value**: A natural language list string.

**Usage Example**:
```python
natural_list(["one", "two", "three"])      # 'one, two and three'
natural_list(["one", "two"])               # 'one and two'
natural_list(["one"])                      # 'one'
```





#### 12 Localization and Internationalization Functions

##### 1. `_get_default_locale_path()` Function - Default Locale Path

**Function**: Get the default path to the `locale` directory within the current package.

**Function Signature**:
```python
def _get_default_locale_path() -> pathlib.Path | None:
```

**Return Value**:  
- `pathlib.Path | None`: The path to the `locale` directory if found, otherwise `None`.

---

##### 2. `get_translation()` Function - Get Active Translation

**Function**: Retrieve the active translation object for the current locale.

**Function Signature**:
```python
def get_translation() -> gettext_module.NullTranslations:
```

**Return Value**:  
- `gettext_module.NullTranslations`: The translation object for the active locale, or the default if none is active.

---

##### 3. `activate()` Function - Activate Locale

**Function**: Activate internationalisation for a given locale.

**Function Signature**:
```python
def activate(locale: str | None, path: str | os.PathLike[str] | None = None) -> gettext_module.NullTranslations:
```

**Parameter Description**:
- `locale (str | None)`: Language code (e.g., `"en_GB"`). `None` deactivates translation.
- `path (str | pathlib.Path | None)`: Path to search for locale files. Defaults to the package locale folder.

**Return Value**:  
- `gettext_module.NullTranslations`: The translation object for the activated locale.

**Raises**:  
- `Exception`: If the locale folder cannot be determined or found.

**Usage Example**:
```python
activate("zh_CN")                  # Activate Simplified Chinese
activate("en_US")                  # Activate English
activate(None)                     # Deactivate translation
```
---

##### 4. `deactivate()` Function - Deactivate Locale

**Function**: Deactivate the current translation and reset to default (no translation).

**Function Signature**:
```python
def deactivate() -> None:
```

**Return Value**:  
- `None`

---

##### 5. `_gettext()` Function - Get Translation

**Function**: Translate a given message into the active locale.

**Function Signature**:
```python
def _gettext(message: str) -> str:
```

**Parameter Description**:
- `message (str)`: The text to translate.

**Return Value**:  
- `str`: The translated text.

---

##### 6. `_pgettext()` Function - Contextual Translation

**Function**: Translate a message with context support.

**Function Signature**:
```python
def _pgettext(msgctxt: str, message: str) -> str:
```

**Parameter Description**:
- `msgctxt (str)`: Context for the translation (e.g., UI label vs technical term).
- `message (str)`: The text to translate.

**Return Value**:  
- `str`: The translated text.

---

##### 7. `_ngettext()` Function - Plural Translation

**Function**: Translate a message with pluralization support.

**Function Signature**:
```python
def _ngettext(message: str, plural: str, num: int) -> str:
```

**Parameter Description**:
- `message (str)`: Singular form.
- `plural (str)`: Plural form.
- `num (int)`: Number used to determine singular vs plural.

**Return Value**:  
- `str`: The correctly pluralized translation.

---

##### 8. `_gettext_noop()` Function - Mark Translation Without Translating

**Function**: Mark a string for future translation but return it unchanged.

**Function Signature**:
```python
def _gettext_noop(message: str) -> str:
```

**Parameter Description**:
- `message (str)`: Text to be translated later.

**Return Value**:  
- `str`: The original text.

**Usage Example**:
```python
CONSTANTS = [_gettext_noop('first'), _gettext_noop('second')]
def num_name(n):
    return _gettext(CONSTANTS[n])
```

---

##### 9. `_ngettext_noop()` Function - Mark Plural Translation Without Translating

**Function**: Mark two strings for plural translation in the future.

**Function Signature**:
```python
def _ngettext_noop(singular: str, plural: str) -> tuple[str, str]:
```

**Parameter Description**:
- `singular (str)`: Singular form.
- `plural (str)`: Plural form.

**Return Value**:  
- `tuple[str, str]`: A tuple containing the original singular and plural strings.

**Usage Example**:
```python
CONSTANTS = [ngettext_noop('first', 'firsts'), ngettext_noop('second', 'seconds')]
def num_name(n):
    return _ngettext(*CONSTANTS[n])
```

---

##### 10. `thousands_separator()` Function - Locale Thousands Separator

**Function**: Get the thousands separator for the active locale (defaults to `,`).

**Function Signature**:
```python
def thousands_separator() -> str:
```

**Return Value**:  
- `str`: The thousands separator.

---

##### 11. `decimal_separator()` Function - Locale Decimal Separator

**Function**: Get the decimal separator for the active locale (defaults to `.`).

**Function Signature**:
```python
def decimal_separator() -> str:
```

**Return Value**:  
- `str`: The decimal separator.



#### 13 `Unit` Enum Class - Time Units

**Class**: Represents different units of time, ordered from the smallest to the largest.

**Class Signature**:
```python
class Unit(Enum):
    MICROSECONDS = 0
    MILLISECONDS = 1
    SECONDS = 2
    MINUTES = 3
    HOURS = 4
    DAYS = 5
    MONTHS = 6
    YEARS = 7

    def __lt__(self, other: Any) -> Any:
        if self.__class__ is other.__class__:
            return self.value < other.value
        return NotImplemented
```

**Members**:
- `MICROSECONDS (0)`: Microseconds.
- `MILLISECONDS (1)`: Milliseconds.
- `SECONDS (2)`: Seconds.
- `MINUTES (3)`: Minutes.
- `HOURS (4)`: Hours.
- `DAYS (5)`: Days.
- `MONTHS (6)`: Months.
- `YEARS (7)`: Years.

**Special Methods**:
- `__lt__(self, other: Any) -> Any`: Defines ordering (`<`) between units based on their numeric value.  
  Returns `NotImplemented` if the comparison is made with a different type.

**Usage Example**:
```python
Unit.SECONDS < Unit.MINUTES   # True
Unit.HOURS < Unit.SECONDS     # False
Unit.DAYS < "string"          # NotImplemented
```

#### 14. `apnumber()` Function - Convert Number to AP Style

**Function**: Convert a number to its Associated Press (AP) style representation.  
For numbers 0–9, the function returns the spelled-out word (e.g., `5` → `"five"`).  
For numbers ≥10 or invalid inputs, it returns the string form of the value.

**Function Signature**:
```python
def apnumber(value: NumberOrString) -> str:
```

**Parameter Description**:
- `value (int | float | str)`: The number or string to convert.  
  - If `int`/`float` between 0–9 → spelled-out AP style.  
  - If ≥10 → string representation.  
  - If invalid or `None` → `str(value)`.

**Return Value**:  
- `str`: AP style string representation of the number.

**Usage Example**:
```python
print(apnumber(0))    # 'zero'
print(apnumber(5))    # 'five'
print(apnumber(10))   # '10'
print(apnumber("7"))  # 'seven'
print(apnumber("foo")) # 'foo'
print(apnumber(None)) # 'None'

```


#### 15. `clamp()` Function - Clamp and Format Numbers

**Function**: Returns a number formatted with the specified format, clamped between optional floor and ceiling values.  
If the input value is outside the given range, it will be replaced by the respective bound and prefixed with a token indicating the clamping.

**Function Signature**:
```python
def clamp(
    value: float,
    format: str = "{:}",
    floor: float | None = None,
    ceil: float | None = None,
    floor_token: str = "<",
    ceil_token: str = ">",
) -> str:
```

**Parameter Description**:
- `value (int | float)`: Input number to be formatted and clamped.  
- `format (str | callable)`: Either a formatting string (e.g., `"{:.2f}"`) or a callable function that takes the value and returns a string.  
- `floor (int | float | None)`: Minimum bound for clamping. If `None`, no lower bound is enforced.  
- `ceil (int | float | None)`: Maximum bound for clamping. If `None`, no upper bound is enforced.  
- `floor_token (str)`: Prefix used when the value is clamped to the floor.  
- `ceil_token (str)`: Prefix used when the value is clamped to the ceiling.  

**Return Value**:  
- `str`: Formatted string representation of the value, clamped within the provided bounds. If clamped, the result is prefixed with the corresponding token.

**Usage Example**:
```python
print(clamp(123.456))  
# '123.456'

print(clamp(0.0001, floor=0.01))  
# '<0.01'

print(clamp(0.99, format="{:.0%}", ceil=0.99))  
# '99%'

print(clamp(0.999, format="{:.0%}", ceil=0.99))  
# '>99%'

print(clamp(1, format=intword, floor=1e6, floor_token="under "))  
# 'under 1.0 million'

print(clamp(None) is None)  
# True
```



### Actual Usage Patterns

#### Basic Usage
```python
from humanize import intcomma, naturaltime, naturalsize, natural_list
import datetime as dt

# Number formatting
print(intcomma(1234567))          # '1,234,567'

# Time humanization
print(naturaltime(dt.timedelta(seconds=3600)))  # 'an hour ago'

# File size formatting
print(naturalsize(1024*1024))     # '1.0 MB'

# List humanization
print(natural_list(["apple", "banana", "orange"]))  # 'apple, banana and orange'
```

#### Internationalization Usage
```python
from humanize import activate, naturaltime
import datetime as dt

# Activate Chinese
activate("zh_CN")
print(naturaltime(dt.timedelta(seconds=3600)))  # '1 hour ago'

# Activate English
activate("en_US")
print(naturaltime(dt.timedelta(seconds=3600)))  # 'an hour ago'

# Deactivate translation
activate(None)
```

#### Advanced Configuration Usage
```python
from humanize import naturalsize, naturaltime, intcomma
import datetime as dt

# Custom file size format
print(naturalsize(1024*1024, binary=True))      # '1.0 MiB'
print(naturalsize(1024*1024, gnu=True))         # '1.0M'

# Custom time format
print(naturaltime(dt.timedelta(seconds=3600), minimum_unit="minutes"))  # '60 minutes ago'

# Custom number format
print(intcomma(1234.567, 2))      # '1,234.57'
```

### Supported Expression Types

**Number Types**: Integers, floats, large numbers, scientific notation.
**Time Types**: `datetime` objects, `timedelta` objects, the number of seconds.
**File Size**: Byte counts (supporting up to the QB level).
**List Types**: Lists of any type.
**Internationalization**: Support for more than 30 languages.

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Type Tolerance**: Automatically handle inputs of different types.
- **Format Tolerance**: Automatically fix common format errors.
- **Exception Capture**: Gracefully handle parsing failures.
- **Default Values**: Provide reasonable default behaviors.

### Important Notes

**Internationalization Priority**: The `activate()` function will change the output language of all subsequent functions.
**Thread Safety**: Internationalization functions need to pay attention to thread-local storage in a multi-threaded environment.
**Performance Consideration**: The `intword()` function for large numbers may take more time when processing extremely large numbers.
**Format Consistency**: The `binary` and `gnu` parameters of the `naturalsize()` function will affect the output format.

## Detailed Function Implementation Nodes

### Node 1: Number Format Normalization
**Function Description**: Handle various numerical representation formats and standardize them into comparable numerical forms. Support complex scenarios such as thousands separators, decimal point variants, currency symbols, and unit conversions.

**Core Algorithm**:
- Recognition and removal of thousands separators.
- Conversion between European and American decimal points.
- Filtering of currency symbols and units.
- Standardization of scientific notation.

**Input and Output Examples**:
```python
from humanize import intcomma, intword, ordinal, fractional, scientific

# Thousands separator processing
intcomma(1234567)                    # '1,234,567'
intcomma("1234567.25")               # '1,234,567.25'
intcomma(1234.5454545, 2)           # '1,234.55'

# Large number wordification
intword(1000000)                     # '1.0 million'
intword(1200000000)                  # '1.2 billion'
intword(10**15)                      # '1.0 quadrillion'
intword(3500000000000000000000)      # '3.5 sextillion'
intword(math.inf)                    #('+Inf')


# Ordinal number conversion
ordinal(1)                           # '1st'
ordinal(2)                           # '2nd'
ordinal(3)                           # '3rd'
ordinal(1002)                        # '1002nd'
ordinal(math.inf)                    # '+inf'
ordinal("nan")                       # 'NAN'
ordinal("-inf")                       # '-Inf'
# Fractional representation
fractional(1/3)                      # '1/3'
fractional(1.5)                      # '1 1/2'
fractional(0.3)                      # '3/10'

# Scientific notation
scientific(0.3)                      # '3.00 x 10⁻¹'
scientific(500)                      # '5.00 x 10²'
scientific("20000")                  # '2.00 x 10⁴'
```

### Node 2: Time Delta Natural Language Conversion
**Function Description**: Convert time differences into human-readable natural language descriptions, supporting relative time, precise time differences, and intelligent unit selection.

**Core Algorithm**:
- Intelligent selection of time units.
- Judgment of relative tense.
- Calculation of precise time differences.
- Localized time expression.

**Input and Output Examples**:
```python
from humanize import naturaltime, naturaldelta, precisedelta
import datetime as dt

# Relative time description
# Relative time description
naturaldelta(dt.timedelta(seconds=1))       # 'a second'
naturaldelta(dt.timedelta(hours=23, minutes=50, seconds=50)) # '23 hours'
naturaldelta(dt.timedelta(days=1))          # 'a day'
naturaldelta(dt.timedelta(days=500))        # '1 year, 4 months'

# Time difference description (without tense)
naturaldelta(dt.timedelta(microseconds=13)) # 'a moment'
naturaldelta(dt.timedelta(days=365 + 35))   # '1 year, 1 month'

# Relative time with tense (using naturaltime)
naturaltime(NOW)                            # 'now'
naturaltime(NOW - dt.timedelta(seconds=1))  # 'a second ago'
naturaltime(NOW - dt.timedelta(days=17))    # '17 days ago'
naturaltime(NOW - dt.timedelta(days=500))   # '1 year, 135 days ago'
naturaltime(NOW + dt.timedelta(seconds=1))  # 'a second from now'
naturaltime(NOW + dt.timedelta(days=500))   # '1 year, 135 days from now'




# Precise time difference
precisedelta(dt.timedelta(days=2, hours=1, minutes=30))  # '2 days, 1 hour and 30 minutes'
precisedelta(dt.timedelta(seconds=3633), minimum_unit="microseconds")  # '1 hour, 33 seconds and 123 milliseconds'
```

### Node 3: Date Natural Language Conversion
**Function Description**: Convert dates into natural language descriptions, supporting relative date expressions such as today, yesterday, and tomorrow.

**Core Algorithm**:
- Judgment of relative dates.
- Date formatting.
- Localized date expression.
- Intelligent display of the year.

**Input and Output Examples**:
```python
from humanize import naturalday, naturaldate
import datetime as dt

# Natural date
naturalday(dt.date.today())                 # 'today'
naturalday(dt.date.today() + dt.timedelta(days=1))  # 'tomorrow'
naturalday(dt.date.today() - dt.timedelta(days=1))  # 'yesterday'

# Date with year
naturaldate(dt.date(2023, 6, 15))          # 'Jun 15 2023'
naturaldate(dt.date(2024, 1, 1))           # 'Jan 01 2024'
```

### Node 4: File Size Humanization
**Function Description**: Convert byte counts into human-readable file size formats, supporting multiple representation methods such as decimal, binary, and GNU style.  When using the binary representation, sizes are calculated based on powers of 1024 instead of 1000.

**Core Algorithm**:
- Logarithmic calculation of byte counts.
- Automatic selection of units.
- Control of formatting precision.
- Support for multiple standards.

**Input and Output Examples**:
```python
from humanize import naturalsize

# Decimal format
naturalsize(3000000)                        # '3.0 MB'
naturalsize(1024*1024)                      # '1.0 MB'
naturalsize(10**28)                         # '10.0 RB'
naturalsize(10)                          # '10 Bytes'
naturalsize(300)                         # '300 Bytes'
# Binary format
naturalsize(3000, True)                     # '2.9 KiB'
naturalsize(1024*1024, True)               # '1.0 MiB'
naturalsize(10, False, True)             # '10B'
naturalsize(300, False, True)            # '300B'



# GNU style
naturalsize(3000, False, True)              # '2.9K'
naturalsize(1024*1024, False, True)        # '1.0M'
naturalsize(10, True)                    # '10 Bytes'
naturalsize(300, True)                   # '300 Bytes'
```

### Node 5: List Natural Language Conversion
**Function Description**: Convert an array into a natural language list, automatically adding commas and the conjunction "and".

**Core Algorithm**:
- Judgment of list length.
- Intelligent addition of conjunctions.
- String formatting.
- Handling of multiple elements.

**Input and Output Examples**:
```python
from humanize import natural_list

# Multi-element list
natural_list(["one", "two", "three"])       # 'one, two and three'
natural_list(["apple", "banana", "orange"]) # 'apple, banana and orange'

# Two-element list
natural_list(["one", "two"])                # 'one and two'
natural_list(["red", "blue"])               # 'red and blue'

# Single-element list
natural_list(["one"])                       # 'one'
natural_list(["apple"])                     # 'apple'
```

### Node 6: Internationalization Activation
**Function Description**: Activate internationalization support for a specified language to achieve multi-language localization.

**Core Algorithm**:
- Parsing of language codes.
- Loading of translation files.
- Thread-local storage.
- Management of translation caches.

**Input and Output Examples**:
```python
from humanize import activate, naturaltime
import datetime as dt

# Activate Chinese
activate("zh_CN")
naturaltime(dt.timedelta(seconds=3600))     # '1 hour ago'

# Activate English
activate("en_US")
naturaltime(dt.timedelta(seconds=3600))     # 'an hour ago'

# Activate French
activate("fr_FR")
naturaltime(dt.timedelta(seconds=3600))     # 'il y a 1 heure'

# Deactivate translation
activate(None)
naturaltime(dt.timedelta(seconds=3600))     # 'an hour ago'
```

### Node 7: Number Range Clamping
**Function Description**: Limit a number to a specified range, supporting custom formats and boundary markers.

**Core Algorithm**:
- Checking of the numerical range.
- Handling of boundary values.
- Formatted output.
- Addition of marker symbols.

**Input and Output Examples**:
```python
from humanize import clamp

# Basic range clamping
clamp(150, floor=100, ceil=200)            # '150'
clamp(50, floor=100, ceil=200)             # '<100'
clamp(250, floor=100, ceil=200)            # '>200'

# Custom format
clamp(150, format="{:.1f}", floor=100, ceil=200)  # '150.0'
clamp(50, format="{:.1f}", floor=100, ceil=200)   # '<100.0'
```

### Node 8: Metric Unit Conversion
**Function Description**: Convert a numerical value into a formatted string with metric units.

**Core Algorithm**:
- Handling of unit strings.
- Control of precision.
- Formatted output.
- Verification of units.

**Input and Output Examples**:
```python
from humanize import metric

# Basic metric conversion
metric(1234.567, "m")                       # '1.235 km'
metric(0.001, "kg")                         # '1.000 g'
metric(1000, "Hz")                          # '1.000 kHz'

# Custom precision
metric(1234.567, "m", precision=1)         # '1.2 km'
metric(0.001, "kg", precision=0)           # '1 g'
```

### Node 9: Time Unit Intelligent Selection
**Function Description**: Intelligently select an appropriate time unit for display based on the time difference.

**Core Algorithm**:
- Analysis of the time difference.
- Sorting of unit priorities.
- Control of precision.
- Limitation of the minimum unit.

**Input and Output Examples**:
```python
from humanize import naturaltime, naturaldelta
import datetime as dt

# Intelligent unit selection
naturaltime(dt.timedelta(seconds=30))       # '30 seconds ago'
naturaltime(dt.timedelta(seconds=3600))     # 'an hour ago'
naturaltime(dt.timedelta(days=365))         # 'a year ago'

# Minimum unit limitation
naturaltime(dt.timedelta(seconds=3600), minimum_unit="minutes")  # '60 minutes ago'
naturaltime(dt.timedelta(milliseconds=100), minimum_unit="milliseconds")  # '100 milliseconds ago'
```

### Node 10: Number Precision Control
**Function Description**: Control the precision of numerical display, supporting precision settings for different formats.

**Core Algorithm**:
- Formatting of floating-point numbers.
- Control of the number of precision digits.
- Application of rounding rules.
- Handling of format strings.

**Input and Output Examples**:
```python
from humanize import intcomma, scientific, naturalsize

# Thousands separator precision control
intcomma(1234.567, 2)                      # '1,234.57'
intcomma(1234.567, 0)                      # '1,235'

# Scientific notation precision
scientific(0.3, precision=1)               # '3.0 x 10⁻¹'
scientific(500, precision=3)               # '5.000 x 10²'

# File size precision
naturalsize(1024*1024, format="%.3f")     # '1.000 MB'
naturalsize(1024*1024, format="%.0f")     # '1 MB'
```

### Node 11: Timezone-Aware Time Processing
**Function Description**: Process time objects with timezone information and convert them to local time for display.

**Core Algorithm**:
- Detection of timezone information.
- Conversion of timestamps.
- Calculation of local time.
- Handling of timezone offsets.

**Input and Output Examples**:
```python
from humanize import naturaltime
import datetime as dt

# Timezone-aware time
aware_time = dt.datetime.now(dt.timezone.utc)
naturaltime(aware_time)                     # 'now' (converted to local time)

# Timezone conversion
local_time = dt.datetime.now()
naturaltime(local_time)                     # 'now'
```

### Node 12: Plural Form Processing
**Function Description**: Intelligently select the singular or plural form based on the quantity, supporting plural rules in multiple languages.

**Core Algorithm**:
- Judgment of quantity.
- Application of plural rules.
- Language-specific processing.
- Selection of translation strings.

**Input and Output Examples**:
```python
from humanize import naturaldelta
import datetime as dt

# English plural processing
naturaldelta(dt.timedelta(seconds=1))      # '1 second'
naturaldelta(dt.timedelta(seconds=2))      # '2 seconds'
naturaldelta(dt.timedelta(days=1))         # '1 day'
naturaldelta(dt.timedelta(days=2))         # '2 days'

# Plural processing after activating Chinese
from humanize import activate
activate("zh_CN")
naturaldelta(dt.timedelta(seconds=1))      # '1 second'
naturaldelta(dt.timedelta(seconds=2))      # '2 seconds'
```

### Node 13: Large Number Wordification Algorithm
**Function Description**: Convert extremely large numbers into word forms, supporting numbers up to the googol level.

**Core Algorithm**:
- Logarithmic calculation of numbers.
- Lookup of word mappings.
- Application of formatting strings.
- Control of precision.

**Input and Output Examples**:
```python
from humanize import intword

# Million level
intword(1000000)                           # '1.0 million'
intword(1200000)                           # '1.2 million'

# Billion level
intword(1200000000)                        # '1.2 billion'
intword(1000000000000)                     # '1.0 trillion'

# Extremely large numbers
intword(10**15)                            # '1.0 quadrillion'
intword(10**33)                            # '1.0 decillion'
intword(10**100)                           # '1.0 googol'
```
**Constants
- When constructing intword,please pre_definethe following constant:
```python
from .i18n import _ngettext_noop as NS_
human_powers = (
    NS_("thousand", "thousand"),
    NS_("million", "million"),
    NS_("billion", "billion"),
    NS_("trillion", "trillion"),
    NS_("quadrillion", "quadrillion"),
    NS_("quintillion", "quintillion"),
    NS_("sextillion", "sextillion"),
    NS_("septillion", "septillion"),
    NS_("octillion", "octillion"),
    NS_("nonillion", "nonillion"),
    NS_("decillion", "decillion"),
    NS_("googol", "googol"),
)
```

### Node 14: Fraction Conversion Algorithm
**Function Description**: Convert decimals into fractional representations, supporting exact fractions and approximate fractions.

**Core Algorithm**:
- Analysis of decimals.
- Calculation of approximate fractions.
- Simplification of the simplest fractions.
- Control of precision.

**Input and Output Examples**:
```python
from humanize import fractional

# Exact fractions
fractional(1/3)                            # '1/3'
fractional(1/4)                            # '1/4'
fractional(1/2)                            # '1/2'

# Approximate fractions
fractional(0.3)                            # '3/10'
fractional(0.333)                          # '333/1000'
fractional(0.25)                           # '1/4'

# With an integer part
fractional(1.5)                            # '1 1/2'
fractional(2.25)                           # '2 1/4'
```

### Node 15: Scientific Notation Formatting
**Function Description**: Convert a number into scientific notation, supporting custom precision and superscript display.

**Core Algorithm**:
- Calculation of exponents.
- Mapping of superscript characters.
- Precision formatting.
- Handling of special values.

**Input and Output Examples**:
```python
from humanize import scientific

# Positive exponents
scientific(500)                            # '5.00 x 10²'
scientific(20000)                          # '2.00 x 10⁴'
scientific(1000000)                        # '1.00 x 10⁶'

# Negative exponents
scientific(0.3)                            # '3.00 x 10⁻¹'
scientific(0.001)                          # '1.00 x 10⁻³'

# Custom precision
scientific(500, precision=1)               # '5.0 x 10²'
scientific(500, precision=0)               # '5 x 10²'
```

### Node 16: File Size Unit Calculation
**Function Description**: Calculate an appropriate unit for the file size, supporting multiple standards and formats.

**Core Algorithm**:
- Logarithmic calculation.
- Selection of units.
- Application of formatting.
- Handling of boundaries.

**Input and Output Examples**:
```python
from humanize import naturalsize

# Byte level
naturalsize(1023)                          # '1023 Bytes'
naturalsize(1)                             # '1 Byte'

# KB level
naturalsize(1024)                          # '1.0 kB'
naturalsize(1024*1024-1)                  # '1024.0 kB'

# MB level
naturalsize(1024*1024)                    # '1.0 MB'
naturalsize(1024*1024*1024)               # '1.0 GB'

# Extremely large files
naturalsize(10**28)                        # '10.0 RB'
naturalsize(10**34)                        # '10.0 QB'
```

### Node 17: List Conjunction Intelligent Processing
**Function Description**: Intelligently add conjunctions based on the list length and language to achieve a natural language list.

**Core Algorithm**:
- Judgment of list length.
- Selection of conjunctions.
- String concatenation.
- Language adaptation.

**Input and Output Examples**:
```python
from humanize import natural_list

# Single element
natural_list(["apple"])                    # 'apple'

# Two elements
natural_list(["apple", "banana"])          # 'apple and banana'

# Multi-elements
natural_list(["apple", "banana", "orange"]) # 'apple, banana and orange'
natural_list(["red", "green", "blue", "yellow"]) # 'red, green, blue and yellow'

# Number list
natural_list([1, 2, 3])                   # '1, 2 and 3'
natural_list([1, 2])                      # '1 and 2'
```

### Node 18: Internationalization Translation Cache Management
**Function Description**: Manage the cache and loading of multi-language translations, supporting dynamic language switching.

**Core Algorithm**:
- Caching of translation files.
- Thread-local storage.
- Handling of language switching.
- Error recovery mechanism.

**Input and Output Examples**:
```python
from humanize import activate, naturaltime
import datetime as dt

# Cache management example
activate("zh_CN")                          # Load Chinese translation
naturaltime(dt.timedelta(seconds=3600))    # '1 hour ago'

activate("fr_FR")                          # Switch to French
naturaltime(dt.timedelta(seconds=3600))    # 'il y a 1 heure'

activate("de_DE")                          # Switch to German
naturaltime(dt.timedelta(seconds=3600))    # 'vor 1 Stunde'

activate(None)                             # Deactivate translation
naturaltime(dt.timedelta(seconds=3600))    # 'an hour ago'
```

### Node 19: Timestamp Natural Language Conversion
**Function Description**: Convert a timestamp into a natural language description, supporting relative time and absolute time expressions.

**Core Algorithm**:
- Parsing of timestamps.
- Calculation of relative time.
- Formatting of absolute time.
- Localized time expression.

**Input and Output Examples**:
```python
from humanize import naturaltime
import datetime as dt

# Timestamp conversion
naturaltime(dt.datetime.now().timestamp())  # 'now'
naturaltime((dt.datetime.now() - dt.timedelta(days=1)).timestamp())  # 'a day ago'
```

### Node 20: Number Range Formatting
**Function Description**: Format a number range into a natural language description, supporting custom formats and boundary markers.

**Core Algorithm**:
- Checking of the numerical range.
- Handling of boundary values.
- Formatted output.
- Addition of marker symbols.

**Input and Output Examples**:
```python
from humanize import clamp

# Basic range formatting
clamp(150, floor=100, ceil=200)            # '150'
clamp(50, floor=100, ceil=200)             # '<100'
clamp(250, floor=100, ceil=200)            # '>200'

# Custom format
clamp(150, format="{:.1f}", floor=100, ceil=200)  # '150.0'
clamp(50, format="{:.1f}", floor=100, ceil=200)   # '<100.0'
```

### Node 21: Time Delta Precise Calculation
**Function Description**: Calculate the time difference precisely, supporting multiple time units and precision settings.

**Core Algorithm**:
- Intelligent selection of time units.
- Control of precision.
- Formatted output.
- Limitation of the minimum unit.

**Input and Output Examples**:
```python
from humanize import precisedelta
import datetime as dt

# Precise time difference
precisedelta(dt.timedelta(days=2, hours=1, minutes=30))  # '2 days, 1 hour and 30 minutes'
precisedelta(dt.timedelta(seconds=3633), minimum_unit="microseconds")  # '1 hour, 33 seconds and 123 milliseconds'
```

### Node 22: File Size Binary Formatting
**Function Description**: Convert a byte count into a formatted string of the file size in binary units.

**Core Algorithm**:
- Logarithmic calculation of byte counts.
- Automatic selection of units.
- Control of formatting precision.
- Support for binary units.

**Input and Output Examples**:
```python
from humanize import naturalsize

# Binary format
naturalsize(3000, binary=True)             # '2.9 KiB'
naturalsize(1024*1024, binary=True)        # '1.0 MiB'
```

### Node 23: Time Delta Relative Description
**Function Description**: Convert a time difference into a relative time description, supporting multiple languages and tenses.

**Core Algorithm**:
- Analysis of the time difference.
- Judgment of relative tense.
- Localized time expression.
- Intelligent selection of tense.

**Input and Output Examples**:
```python
from humanize import naturaltime
import datetime as dt

# Relative time description
naturaltime(dt.timedelta(seconds=1001))     # '16 minutes ago'
naturaltime(dt.timedelta(seconds=3600))     # 'an hour ago'
naturaltime(dt.timedelta(days=1))           # 'a day ago'
```

### Node 24: Number Formatting Precision Control
**Function Description**: Control the precision of numerical formatting, supporting precision settings for different formats.

**Core Algorithm**:
- Formatting of floating-point numbers.
- Control of the number of precision digits.
- Application of rounding rules.
- Handling of format strings.

**Input and Output Examples**:
```python
from humanize import intcomma, scientific, naturalsize

# Thousands separator precision control
intcomma(1234.567, 2)                      # '1,234.57'
intcomma(1234.567, 0)                      # '1,235'

# Scientific notation precision
scientific(0.3, precision=1)               # '3.0 x 10⁻¹'
scientific(500, precision=3)               # '5.000 x 10²'

# File size precision
naturalsize(1024*1024, format="%.3f")     # '1.000 MB'
naturalsize(1024*1024, format="%.0f")     # '1 MB'
```

### Node 25: Internationalization Language Dynamic Switching
**Function Description**: Dynamically switch the currently used language, supporting a multi-language environment.

**Core Algorithm**:
- Parsing of language codes.
- Loading of translation files.
- Thread-local storage.
- Dynamic language switching.

**Input and Output Examples**:
```python
from humanize import activate, naturaltime
import datetime as dt

# Dynamic language switching
activate("zh_CN")                          # Switch to Chinese
naturaltime(dt.timedelta(seconds=3600))    # '1 hour ago'

activate("en_US")                          # Switch to English
naturaltime(dt.timedelta(seconds=3600))    # 'an hour ago'

activate("fr_FR")                          # Switch to French
naturaltime(dt.timedelta(seconds=3600))    # 'il y a 1 heure'
```


#### Node26: Date and Delta Conversion

**Function Description**:  
Convert an input value into a `datetime` object and a corresponding `timedelta` representing how long ago it was.  
If conversion is not possible, returns `(None, value)`.

**Core Algorithm**:
- If the input is a `datetime`, compute the delta as `now - value`.
- If the input is a `timedelta`, compute the date as `now - value`.
- Otherwise, try to interpret the input as seconds and build a `timedelta`.
- If parsing fails, return `(None, value)`.

**Function Signature**:
```python
def _date_and_delta(
    value: Any, *, now: dt.datetime | None = None, precise: bool = False
) -> tuple[Any, Any]:
```

**Parameters**:
- `value (Any)`: Input value, can be `datetime`, `timedelta`, or numeric (seconds).
- `now (datetime | None)`: The reference current time. Defaults to `_now()` if `None`.
- `precise (bool)`: Whether to keep the value as-is (`True`) or cast to `int` (`False`).

**Return Value**:
- `tuple[datetime | None, timedelta | Any]`:  
  - A tuple containing the resolved date and delta.  
  - If conversion fails, returns `(None, value)`.

**Input and Output Examples**:
```python
import datetime as dt

# Case 1: Input is datetime
now = dt.datetime(2025, 1, 1, 12, 0, 0)
date, delta = _date_and_delta(dt.datetime(2025, 1, 1, 10, 0, 0), now=now)
# date = 2025-01-01 10:00:00
# delta = 2:00:00

# Case 2: Input is timedelta
date, delta = _date_and_delta(dt.timedelta(hours=5), now=now)
# date = 2025-01-01 07:00:00
# delta = 5:00:00

# Case 3: Input is integer (seconds)
date, delta = _date_and_delta(3600, now=now)
# date = 2025-01-01 11:00:00
# delta = 1:00:00

# Case 4: Invalid input
date, delta = _date_and_delta("invalid", now=now)
# date = None
# delta = "invalid"
```

#### Node27: Rounding by Format

**Function Description**:  
Round a number according to the provided printf-style string format.  
The output type depends on the format used:
- Integer formats (`"%d"`, `"%i"`) return an `int`.
- Floating-point formats (`"%.2f"`, `"%.0f"`) return a `float`.

**Core Algorithm**:
- Apply printf-style formatting with the given format string.
- Attempt to cast the result to `int`; if that fails, cast to `float`.

**Function Signature**:
```python
def _rounding_by_fmt(format: str, value: float) -> float | int:
```
**Parameters**

- format (str): A printf-style format string.
- value (float): The number to format and round.

**Return Value**

- float | int: The rounded value, type depends on the format.

**Input and Output Examples**
```python
_rounding_by_fmt("%d", 3.7)       # 3   (int)
_rounding_by_fmt("%i", 9.99)      # 9   (int)
_rounding_by_fmt("%.2f", 3.14159) # 3.14 (float)
_rounding_by_fmt("%.0f", 3.8)     # 4.0 (float)
```

---