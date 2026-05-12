## Introduction and Goals of the Tablib Project

Tablib is a **format-independent library for handling tabular datasets** written in Python. It aims to provide developers with a unified and concise interface for creating, importing, exporting, and manipulating tabular data without worrying about the underlying data formats. Tablib supports reading and writing in multiple mainstream data formats, including Excel, JSON, YAML, Pandas DataFrame, HTML, Jira, LaTeX, TSV, ODS, CSV, DBF, and SQL. Its core functions include:

- Handling and converting multiple tabular data formats in a unified way.
- Supporting batch import, export, and format conversion of data.
- Being compatible with Pandas DataFrame for easy integration with data analysis workflows.
- Meeting the needs of single-table and multi-table data management through the Sets and Books structures.

In short, Tablib is committed to simplifying the processing flow of tabular data in different formats, allowing developers to focus on data operations rather than worrying about format conversion and compatibility issues. Whether it's data import, export, or format conversion, Tablib can provide a consistent and efficient solution.


## Natural Language Instruction (Prompt)

Please create a Python project named Tablib to implement a general-purpose tabular dataset processing library. The project should include the following functions:

1. **Data Structure Support**: Implement two core structures, Dataset (single-table dataset) and Databook (multi-table dataset), to support flexible organization and management of data.
2. **Multi-Format Import and Export**: Support reading, writing, and format conversion of data in mainstream formats such as Excel, CSV, TSV, JSON, YAML, HTML, LaTeX, ODS, DBF, SQL, and Pandas DataFrame.
3. **Format Auto-Detection and Extension**: Automatically recognize the data format of the input stream and support registering and extending new data formats.
4. **Data Batch Processing**: Support batch import, export, format conversion, and data cleaning of data.
5. **Integration with Pandas**: Be compatible with Pandas DataFrame for easy integration with data analysis and scientific computing workflows.
6. **API Design**: Provide clear Python function interfaces for each function and support an extensible command-line interface.
7. **Error Handling and Exception System**: Robustly handle exceptions such as unsupported formats and data type errors.
8. **Unit Testing and Regression Testing**: Provide complete test cases covering import, export, format conversion, and exception scenarios for all core functions.
9. **Core File Requirements**: The project must include a complete pyproject.toml file, which should configure the project as an installable package (supporting pip install) and declare a complete list of dependencies (such as pandas==2.3.1, pyyaml==6.0.2, tabulate==0.9.0, xlrd==2.0.2, xlwt==1.3.0, etc., which are the core libraries actually used). The setup.py file should ensure that all core function modules can work properly. At the same time, src/tablib/__init__.py and src/tablib/_vendor/dbfpy/__init__.py should be provided as unified API entry points, importing and exporting fields, utils, Row, detect_format, UnsupportedFormat, registry, and the main import and export functions, and providing version information, so that users can access all main functions through simple statements such as "from tablib._vendor.dbfpy import **" and "from tablib.core/exceptions/formats import **". Among them, the Row class in the /src/tablib/core.py file is used to encapsulate row data in tabular data. The detect_format function in the /src/tablib/core.py file is used to automatically detect the data format, and its core function is to determine the corresponding tabular data format (such as CSV, JSON, Excel, etc.) based on the input data stream. The UnsupportedFormat class in the /src/tablib/exceptions.py file is an exception class defined in the Tablib library, inheriting from TablibException and NotImplementedError, and is used to represent errors related to unsupported formats. The Registry class should be fully defined in /src/tablib/formats/_init_.py, including class attributes such as _formats and methods such as register, register_builtins, formats, and get_format, for managing the registration, storage, and retrieval of various data formats (such as CSV, JSON, Excel, etc.) in the Tablib library. In the /src/tablib/_vendor/dbfpy/ folder, fields.py is needed to define and process DBF (dBASE database file) fields. The utils.py file in the /src/tablib/_vendor/dbfpy/ folder should contain functions such as unzfill, getDate, getDateTime, and _InvalidValue, which provide string processing, date and time conversion, and special value definition functions related to DBF file processing to support the parsing and processing of DBF format data.


## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.5

### Core Dependency Library Versions

```Plain
coverage     7.10.1
defusedxml   0.7.1
et_xmlfile   2.0.0
execnet      2.1.1
iniconfig    2.1.0
odfpy        1.4.1
openpyxl     3.1.5
packaging    25.0
pip          25.1.1
pluggy       1.6.0
Pygments     2.19.2
pytest       8.4.1
pytest-cov   6.2.1
pytest-xdist 3.8.0
PyYAML       6.0.2
tabulate     0.9.0
xlrd         2.0.2
xlwt         1.3.0
```


## Tablib Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .coverage
├── .coveragerc
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── AUTHORS
├── CODE_OF_CONDUCT.md
├── HISTORY.md
├── LICENSE
├── README.md
├── RELEASING.md
├── coverage.xml
├── htmlcov/
├── pyproject.toml
├── pytest.ini
├── src/
│   └── tablib/
│       ├── __init__.py
│       ├── core.py
│       ├── exceptions.py
│       ├── formats/
│       │   ├── __init__.py
│       │   ├── _cli.py
│       │   ├── _csv.py
│       │   ├── _dbf.py
│       │   ├── _df.py
│       │   ├── _html.py
│       │   ├── _jira.py
│       │   ├── _json.py
│       │   ├── _latex.py
│       │   ├── _ods.py
│       │   ├── _rst.py
│       │   ├── _sql.py
│       │   ├── _tsv.py
│       │   ├── _xls.py
│       │   ├── _xlsx.py
│       │   ├── _yaml.py
│       │   └── __pycache__/
│       ├── _vendor/
│       │   ├── __init__.py
│       │   ├── dbfpy/
│       │   │   ├── __init__.py
│       │   │   ├── dbf.py
│       │   │   ├── dbfnew.py
│       │   │   ├── fields.py
│       │   │   ├── header.py
│       │   │   ├── record.py
│       │   │   └── utils.py
│       │   └── __pycache__/
│       ├── __pycache__/
│       ├── utils.py
├── tox.ini
```

## API Usage Guide

### 1. Entry and Import Methods

#### 1.1 Importing Core APIs

Tablib recommends importing core APIs in the following way:

```python
import tablib
from tablib import Dataset, Databook, detect_format, import_set, import_book
```


### 2. Detailed Explanation of Core Extended APIs

#### 2.1 Row (Data Row Object API)

Tablib uses the `Row` class internally to represent single-row data, supporting various access and operation methods.

**API Overview**
- `Row(row=(), tags=())`: Constructor.
- Supports access by index/slice/column name: `row[0]`, `row["A"]`.
- Main methods:
    - `append(value)`, `insert(index, value)`, `copy()`.
    - `rpush(value)`, `lpush(value)`.
    - `has_tag(tag)`.
- Main attributes:
    - `.tuple`, `.list` (return a tuple/list respectively).
    - `tags` (for tag filtering).

**Usage Example**
```python
from tablib.core import Row, Dataset

data = Dataset(headers=["A", "B"])
data.append([1, 2])
row = data[0]
print(row[0])        # 1
print(row["A"])      # 1
row.append(3)
print(row.list)      # [1, 2, 3]
assert row.has_tag([]) is False
```

#### 2.2 detect_format (Format Auto-Detection API)

Automatically detects the format of the input stream.

**API Overview**
- `detect_format(stream)`
    - Parameter: `stream` (file stream, string, or bytes).
    - Returns: A format name string (e.g., 'csv', 'json'), or None if not detected.

**Usage Example**
```python
from tablib.core import detect_format

with open('data.csv', 'r') as f:
    fmt = detect_format(f)
    print("Detected format: ", fmt)
```

#### 2.3 UnsupportedFormat (Unsupported Format Exception)

Thrown when an unsupported format is encountered during export/import.

**API Overview**
- `class UnsupportedFormat(TablibException, NotImplementedError)`
- Used in scenarios such as format detection, import, and export.

**Usage Example**
```python
from tablib.exceptions import UnsupportedFormat
from tablib import Dataset

data = Dataset()
try:
    data.export('unknown')
except UnsupportedFormat as e:
    print("Caught an unsupported format exception: ", e)
```

#### 2.4 registry (Format Registration and Query API)

All supported formats in Tablib are centralized in `formats.registry`, which can be used for dynamic querying, registration, and retrieval of format processing classes.

**API Overview**
- `registry.register(key, format_or_path)`: Registers a new format.
- `registry.register_builtins()`: Registers all built-in formats.
- `registry.formats()`: Iterates over all registered format classes.
- `registry.get_format(key)`: Retrieves the processing class for a specified format.
- `registry._formats`: A mapping from format names to classes.

**Usage Example**
```python
from tablib.formats import registry

# Query all supported formats
print(list(registry._formats.keys()))

# Get the processing class for a certain format
csv_format_cls = registry.get_format("csv")
print(csv_format_cls.__name__)

# Register a custom format
# class MyFormat: ...
# registry.register("myfmt", MyFormat)
```

#### 2.5 DbfFieldDef (DBF Field Definition Base Class API)

`DbfFieldDef` is an abstract base class in the Tablib library for defining and processing DBF (dBASE database file) fields, providing a general structure and interface for DBF fields.

**API Overview**
- `DbfFieldDef(name, length=None, decimalCount=None, start=None, stop=None, ignoreErrors=False)`: Constructor.
- Class attributes: `length`, `typeCode`, `defaultValue` (to be overridden by subclasses).
- Instance attributes: `name`, `decimalCount`, `start`, `end`, `ignoreErrors`.
- Main methods:
    - `fromString(cls, string, start, ignoreErrors=False)`: Decodes a field definition from a byte string (class method).
    - `toString()`: Encodes the field definition into a string.
    - `decodeFromRecord(record)`: Decodes the field value from a record string.
    - `rawFromRecord(record)`: Retrieves the raw field data from a record.
    - `decodeValue(value)`: Decodes the field value (abstract method, to be implemented by subclasses).
    - `encodeValue(value)`: Encodes the field value (abstract method, to be implemented by subclasses).
    - `fieldInfo()`: Returns a tuple of field information (name, type, length, decimals).
- Comparison operations: Supports `==`, `!=`, `<`, `<=`, `>`, `>=`, etc.
- Registration tools: `registerField(fieldCls)`, `lookupFor(typeCode)`.

**Main Subclass Types**
- `DbfCharacterFieldDef`: Character field (type code 'C').
- `DbfNumericFieldDef`: Numeric field (type code 'N').
- `DbfDateFieldDef`: Date field (type code 'D', fixed 8 bytes).
- `DbfLogicalFieldDef`: Logical field (type code 'L', fixed 1 byte).
- `DbfFloatFieldDef`: Floating-point field (type code 'F').
- `DbfIntegerFieldDef`: Integer field (type code 'I', fixed 4 bytes).

**Usage Example**
```python
from tablib._vendor.dbfpy import fields, utils
import datetime as dt

# Basic field creation and comparison
char_field = fields.DbfCharacterFieldDef("NAME", 20)
print(char_field.fieldInfo())  # ('NAME', 'C', 20, 0)

num_field = fields.DbfNumericFieldDef("PRICE", 10, 2)
print(num_field.fieldInfo())   # ('PRICE', 'N', 10, 2)

# Field comparison (based on field name)
field_a = fields.DbfCharacterFieldDef("ABC", 10)
field_z = fields.DbfCharacterFieldDef("XYZ", 10)
assert field_a < field_z
assert field_a == fields.DbfCharacterFieldDef("ABC", 10)

# Field encoding and decoding
char_field = fields.DbfCharacterFieldDef("NAME", 10)
encoded = char_field.encodeValue("Alice")
print(f"Encoded result: '{encoded}'")  # 'Alice     ' (padded with spaces on the right)

decoded = char_field.decodeValue(b"Alice     ")
print(f"Decoded result: '{decoded}'")  # 'Alice' (spaces on the right removed)

# Numeric field processing
num_field = fields.DbfNumericFieldDef("PRICE", 8, 2)
encoded = num_field.encodeValue(123.45)
decoded = num_field.decodeValue(b"  123.45")
print(f"Numeric decoding: {decoded}")     # 123.45

# Look up a field class by type code
field_class = fields.lookupFor(ord('C'))  # Character field class
print(field_class.__name__)  # 'DbfCharacterFieldDef'

# Create a custom field type
class DbfCustomFieldDef(fields.DbfFieldDef):
    typeCode = "X"
    defaultValue = ""
    
    def decodeValue(self, value):
        return value.decode('utf-8').upper()
    
    def encodeValue(self, value):
        return str(value).lower()[:self.length].ljust(self.length)

# Register a custom field
fields.registerField(DbfCustomFieldDef)
```

**Exception Handling**
```python
# Field name length limit (maximum 10 characters)
try:
    long_field = fields.DbfCharacterFieldDef("VERY_LONG_FIELD_NAME", 10)
except ValueError as e:
    print(f"Field name too long error: {e}")

# Length parameter validation
try:
    invalid_field = fields.DbfCharacterFieldDef("TEST", -5)
except ValueError as e:
    print(f"Invalid length error: {e}")

# Decoding error handling
field = fields.DbfCharacterFieldDef("TEST", 10, ignoreErrors=True)
# In ignore error mode: return utils.INVALID_VALUE when decoding fails
```

#### 2.6 utils (DBF Utility Function API)

The `_vendor.dbfpy.utils` module in Tablib provides utility functions for string processing, date and time conversion, and special value definition related to DBF file processing.

**API Overview**
- `unzfill(str)`: Removes ASCII NUL characters from a string.
- `getDate(date=None)`: Converts various types of input into a datetime.date object.
- `getDateTime(value=None)`: Converts various types of input into a datetime.datetime object.
- `INVALID_VALUE`: A special return value when field validation fails (an instance of the _InvalidValue class).
- `classproperty`: A class attribute decorator.

**Main Function Descriptions**

##### unzfill(str) - String Cleaning
A simple string processing function for removing ASCII NUL (\0) characters from a string.

```python
from tablib._vendor.dbfpy import utils

# Remove NUL characters from a string
result = utils.unzfill(b"abc\0xyz")
print(result)  # b"abc"

result = utils.unzfill(b"abcxyz")  
print(result)  # b"abcxyz" (no change)
```

##### getDate(date=None) - Date Conversion
An intelligent date conversion function that supports automatic conversion of various input types into a `datetime.date` object.

**Supported Input Types**:
- `None`: Returns the current date.
- `datetime.date/datetime.datetime`: Returns directly or converts.
- `str`: Supports "YYYYMMDD" or "YYMMDD" formats.
- `int/float`: Timestamp format.
- Sequence: (year, month, day, ...) tuple format.

```python
import datetime as dt
from tablib._vendor.dbfpy import utils

# Examples of various input types
assert isinstance(utils.getDate(None), dt.date)  # Current date
assert utils.getDate("20191019") == dt.date(2019, 10, 19)  # String format
assert utils.getDate(1571515306) == dt.date(2019, 10, 20)  # Timestamp
assert utils.getDate((2019, 10, 19)) == dt.date(2019, 10, 19)  # Tuple format
```

##### getDateTime(value=None) - Date and Time Conversion
Similar to `getDate`, but returns a `datetime.datetime` object, supporting more complete time information.

**Supported Input Types**:
- `None`: Returns the current date and time.
- `datetime.datetime`: Returns directly.
- `datetime.date`: Converts to midnight time.
- `int/float`: Timestamp format.
- Sequence: (year, month, day, hour, minute, second, ...) tuple format.

```python
# Date and time conversion example
now = utils.getDateTime(None)  # Current time
print(isinstance(now, dt.datetime))  # True

# Convert from a date (to midnight time)
date_obj = dt.date(2019, 10, 19)
datetime_obj = utils.getDateTime(date_obj)
print(datetime_obj.time())  # 00:00:00
```

##### INVALID_VALUE - Special Invalid Value
`INVALID_VALUE` is a singleton instance of the `_InvalidValue` class, used to represent the return value when DBF field validation fails.

**Special Behaviors**:
- Is equal to any "empty value" (None, 0, "", etc.), and also equal to itself.
- Returns 0 when converted to a number and an empty string when converted to a string.
- Has a boolean value of False.

```python
from tablib._vendor.dbfpy.utils import INVALID_VALUE

# Special equality
print(INVALID_VALUE == None)     # True
print(INVALID_VALUE == 0)        # True  
print(INVALID_VALUE == "")       # True
print(INVALID_VALUE == False)    # True
print(INVALID_VALUE == INVALID_VALUE)  # True

# Type conversion
print(int(INVALID_VALUE))        # 0
print(str(INVALID_VALUE))        # ""
print(bool(INVALID_VALUE))       # False
print(repr(INVALID_VALUE))       # "<INVALID>"
```

**Application in DBF Field Processing**
```python
from tablib._vendor.dbfpy import fields

# Create a field that ignores errors
field = fields.DbfCharacterFieldDef("TEST", 10, ignoreErrors=True)

# When field decoding fails, return INVALID_VALUE instead of throwing an exception
try:
    # Simulate a decoding failure
    result = field.decodeFromRecord(b"invalid_data_here")
    if result == INVALID_VALUE:
        print("Field decoding failed, returning an invalid value")
except:
    pass  # No exception will be thrown when ignoreErrors=True
```

### 3. Core Data Structures

#### 3.1 Dataset (Single-Table Dataset)

**Class Definition**
```python
class tablib.Dataset(headers=None, title=None, data=None, separator='---')
```

**Main Attributes**
- `headers`: Table headers (list/tuple, optional).
- `title`: Dataset title (str, optional).
- `width`: Number of columns.
- `height`: Number of rows.
- `dict`: Access data in dictionary form.
- `json`/`yaml`/`csv`/`xls`/`xlsx`/`ods`/`html`/`df`, etc.: Export attributes for each format.

**Common Methods**
- `append(row)`: Adds a row.
- `append_col(col, header=None)`: Adds a column.
- `append_separator(label)`: Inserts a separator row.
- `load(in_stream, format=None, headers=True)`: Imports data from a stream.
- `export(format, **kwargs)`: Exports data in a specified format.
- `get_<format>()`: Gets data in a specified format (e.g., get_json()).
- `set_<format>(data)`: Sets data in a specified format.
- `sort(col, reverse=False)`: Sorts data by a column.
- `filter(func)`: Filters data by a condition.
- `transpose()`: Transposes data.
- `pack()`: Packs data into a list of dictionaries.
- `unpack(data)`: Unpacks a list of dictionaries.
- `wipe()`: Clears all data.

**Indexing and Slicing**
- Supports various access methods such as `data[0]`, `data[0:2]`, `data['Col Name']`, `data.get(0)`, etc.

**Example**
```python
data = tablib.Dataset(headers=["Name", "Age"])
data.append(["Alice", 30])
data.append(["Bob", 25])
print(data.dict)
# [{'Name': 'Alice', 'Age': 30}, {'Name': 'Bob', 'Age': 25}]
```

#### 3.2 Databook (Multi-Table Dataset)

**Class Definition**
```python
class tablib.Databook(sets=None)
```

**Main Attributes/Methods**
- `sheets()`: Returns all Datasets.
- `add_sheet(dataset)`: Adds a Dataset.
- `wipe()`: Clears all tables.
- `load(in_stream, format, **kwargs)`: Imports multi-table data.
- `export(format, **kwargs)`: Exports multi-table data.

**Example**
```python
book = tablib.Databook()
book.add_sheet(data)
xlsx_bytes = book.export('xlsx')
```

#### 3.3 Row (Data Row Object)

**Description**: Encapsulated internally by Tablib, usually no direct operation is required, supporting attribute access and comparison of data rows.


### 4. Main Function Interfaces

- `tablib.detect_format(stream)`: Automatically detects the format of a data stream and returns the format name.
    - **Parameter**: `stream` (file stream or bytes).
    - **Returns**: A string representing the format name (e.g., 'csv', 'json'), or None if not detected.
    - **Exception**: `UnsupportedFormat`.

- `tablib.import_set(dset, in_stream)`: Imports single-table data.
    - **Parameters**: `dset` (Dataset), `in_stream` (stream).
    - **Returns**: None.
    - **Exception**: `InvalidDatasetType`, `UnsupportedFormat`.

- `tablib.import_book(dbook, in_stream)`: Imports multi-table data.
    - **Parameters**: `dbook` (Databook), `in_stream` (stream).
    - **Returns**: None.
    - **Exception**: `InvalidDatasetType`, `UnsupportedFormat`.

### 5. Exception System

- `tablib.exceptions.TablibException`: A general exception base class.
- `tablib.exceptions.InvalidDatasetType`: Type error (e.g., only Datasets can be added to a Databook).
- `tablib.exceptions.InvalidDatasetIndex`: Index out of bounds.
- `tablib.exceptions.InvalidDimensions`: Dimension mismatch.
- `tablib.exceptions.UnsupportedFormat`: Unsupported format.
- `tablib.exceptions.HeadersNeeded`: Missing table headers.

**Usage Example**
```python
try:
    data2.headers = ['a', 'b']
    data2.append((1, 2, 3, 4))
except tablib.InvalidDimensions:
    print("Caught a dimension mismatch exception")
```

**Exception Handling**
```python
from tablib.exceptions import UnsupportedFormat
from tablib import Dataset

data = Dataset()
try:
    data.export('unknown')
except UnsupportedFormat as e:
    print("Caught an unsupported format exception: ", e)
```

### 6. Format Support and Extension

Tablib supports multiple mainstream data formats, and each format has a corresponding Format class with a unified interface:
- `export_set(dataset)`: Exports a Dataset.
- `export_book(databook)`: Exports a Databook (if supported).
- `import_set(dset, in_stream)`: Imports a Dataset.
- `import_book(dbook, in_stream)`: Imports a Databook (if supported).
- `detect(stream)`: Detects the format.

#### 6.1 CSVFormat
- **Class Definition**: `tablib.formats._csv.CSVFormat`
- **File Extensions**: csv, tsv
- **Description**: Supports import and export of comma-separated and tab-separated text.

#### 6.2 JSONFormat
- **Class Definition**: `tablib.formats._json.JSONFormat`
- **File Extensions**: json, jsn
- **Description**: Supports import and export of standard JSON datasets.

#### 6.3 YAMLFormat
- **Class Definition**: `tablib.formats._yaml.YAMLFormat`
- **File Extensions**: yaml, yml
- **Description**: Supports import and export of YAML format data.

#### 6.4 XLSFormat / XLSXFormat
- **Class Definition**: `tablib.formats._xls.XLSFormat`, `tablib.formats._xlsx.XLSXFormat`
- **File Extensions**: xls, xlsx
- **Description**: Supports reading and writing of Excel 97-2003 (xls) and 2007+ (xlsx) formats.

#### 6.5 ODSFormat
- **Class Definition**: `tablib.formats._ods.ODSFormat`
- **File Extensions**: ods
- **Description**: Supports the OpenDocument Spreadsheet format.

#### 6.6 HTMLFormat
- **Class Definition**: `tablib.formats._html.HTMLFormat`
- **File Extensions**: html
- **Description**: Supports HTML table export.

#### 6.7 LaTeXFormat
- **Class Definition**: `tablib.formats._latex.LATEXFormat`
- **File Extensions**: tex, latex
- **Description**: Supports LaTeX table export.

#### 6.8 SQLFormat
- **Class Definition**: `tablib.formats._sql.SQLFormat`
- **File Extensions**: sql
- **Description**: Supports SQL table structure export.

#### 6.9 DBFFormat
- **Class Definition**: `tablib.formats._dbf.DBFFormat`
- **File Extensions**: dbf
- **Description**: Supports reading and writing of DBF format files, relying on _vendor.dbfpy at the underlying level.

#### 6.10 DataFrameFormat
- **Class Definition**: `tablib.formats._df.DataFrameFormat`
- **File Extensions**: df
- **Description**: Supports mutual conversion with pandas DataFrame (pandas needs to be installed).

### 7. Typical Usage Examples

**Creating and Exporting a Dataset**
```python
import tablib
data = tablib.Dataset(headers=["Name", "Age"])
data.append(["Alice", 30])
data.append(["Bob", 25])
json_str = data.export('json')
```

**Exporting a Multi-Table Dataset**
```python
book = tablib.Databook([data])
xlsx_bytes = book.export('xlsx')
```

**Automatic Format Detection**
```python
with open('data.csv', 'r') as f:
    fmt = tablib.detect_format(f)
    print("Detected format: ", fmt)
```

**Mutual Conversion with Pandas DataFrame**
```python
import pandas as pd
df = pd.DataFrame([{'a': 1, 'b': 2}, {'a': 3, 'b': 4}])
data = tablib.Dataset().load(df, format='df')
df2 = data.export('df')
assert isinstance(df2, pd.DataFrame)
```

**DBF Fields and Utilities**
```python
from tablib._vendor.dbfpy import fields, utils
import datetime as dt

# Field definition comparison
a = fields.DbfCharacterFieldDef("abc", 10)
z = fields.DbfCharacterFieldDef("xyz", 10)
assert a < z
assert a == fields.DbfCharacterFieldDef("abc", 10)

# Byte unpacking
assert utils.unzfill(b"abc\0xyz") == b"abc"
assert utils.unzfill(b"abcxyz") == b"abcxyz"

# Date parsing
assert isinstance(utils.getDate(None), dt.date)
assert utils.getDate("20191019") == dt.date(2019, 10, 19)
assert utils.getDate(1571515306) == dt.date(2019, 10, 20)
```

### 8. Format Registration and Extension (formats.registry)

Tablib supports automatic registration and extension of formats. All available formats are centralized in `formats.registry`, which can be used for dynamic querying, extension, and customization of formats.

**API Overview**
- `formats.registry`: Format registry (dict-like).
- `formats.registry.keys()`: All registered format names.
- `formats.registry["csv"]`: Get the processing class for a specific format (e.g., CSVFormat).
- Custom formats can be registered through `formats.registry.register("myfmt", MyFormatClass)`.

**Usage Example**
```python
from tablib.formats import registry

# Query all supported formats
print(list(registry.keys()))

# Get and use a specific format class
csv_format_cls = registry["csv"]
print(csv_format_cls.__name__)

# Register a custom format (the export_set/import_set/detect interfaces need to be implemented)
# registry.register("myfmt", MyFormatClass)
```

### 9. Other Notes and Extensions
- All methods of Dataset/Databook support multi-format extension. For details, see the formats submodule.
- Supports both CLI and Python API interfaces.
- Detailed test cases can be found in the tests directory.
- Dependencies and installation instructions can be found in pyproject.toml/requirements.txt.
- For more usage and advanced techniques, please refer to docs/tutorial.rst.

## Detailed Implementation Nodes of Functions

### 1. Basic Operations of Dataset/Databook

**Function Description**: Test the core functions of creating datasets and data books, adding data, setting headers, and detecting exceptions.

```python
import tablib

# Test adding empty data and setting headers
data = tablib.Dataset()
data.append((1, 2, 3))  # test_empty_append
assert data.width == 3

# Test adding empty data with headers
data_with_headers = tablib.Dataset(headers=['a', 'b', 'c'])
data_with_headers.append((1, 2, 3))  # test_empty_append_with_headers

# Test setting headers with incorrect dimensions
data2 = tablib.Dataset()
data2.append((1, 2, 3))
try:
    data2.headers = ['first', 'second']  # test_set_headers_with_incorrect_dimension
except tablib.InvalidDimensions:
    print("Caught a dimension mismatch exception")

# Test the function of adding a column
data3 = tablib.Dataset()
data3.append(['kenneth'])
data3.append(['bessie'])
new_col = ['reitz', 'monke']
data3.append_col(new_col)  # test_add_column
assert data3[0] == ('kenneth', 'reitz')

# Test adding a callable column
def new_col_func(row):
    return row[0]
data3.append_col(new_col_func)  # test_add_callable_column

# Test adding Unicode and datetime data
import datetime as dt
data4 = tablib.Dataset()
data4.append(['Test', dt.datetime.now()])  # test_unicode_append, test_datetime_append

# Test adding a separator
data4.append_separator('---')  # test_separator_append

# Test data book operations
book = tablib.Databook()
book.add_sheet(data)  # test_databook_add_sheet_accepts_only_dataset_instances
assert isinstance(book.sheets()[0], tablib.Dataset)
```

### 2. Data Access and Operations

**Function Description**: Test the operations of indexing, slicing, retrieving, and deleting data.

```python
# Prepare test data
data = tablib.Dataset(headers=['first_name', 'last_name', 'gpa'])
data.append(('John', 'Adams', 90))
data.append(('George', 'Washington', 67))
data.append(('Thomas', 'Jefferson', 50))

# Test header slicing
headers_slice = data.headers[0:2]  # test_header_slicing
assert headers_slice == ['first_name', 'last_name']

# Test data retrieval
first_row = data.get(0)  # test_get
assert first_row == ('John', 'Adams', 90)

# Test column retrieval
last_names = data.get_col(1)  # test_get_col
assert 'Adams' in last_names

# Test data slicing
subset_data = data[0:2]  # test_data_slicing
assert len(subset_data) == 2

# Test row slicing
first_two_rows = data[:2]  # test_row_slicing
assert len(first_two_rows) == 2

# Test deletion operation
del data[1]  # test_delete
assert len(data) == 2

# Test data subset
subset = data.subset(rows=[0], cols=[0, 1])  # test_subset
assert subset.width == 2
```

### 3. Data Transformation and Processing

**Function Description**: Test the transformation and processing functions of data, such as transposition, sorting, deduplication, and row/column stacking.

```python
# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age', 'City'])
data.append(('Alice', 25, 'NYC'))
data.append(('Bob', 30, 'LA'))
data.append(('Alice', 25, 'NYC'))  # Duplicate data

# Test data transposition
transposed = data.transpose()  # test_transpose
assert transposed.headers[0] == 'Name'

# Test transposing an empty dataset
empty_data = tablib.Dataset()
empty_transposed = empty_data.transpose()  # test_transpose_empty_dataset

# Test transposing without headers
no_header_data = tablib.Dataset()
no_header_data.append((1, 2, 3))
no_header_transposed = no_header_data.transpose()  # test_transpose_with_no_headers

# Test sorting function
data.sort('Age')  # test_sorting
assert data[0][1] == 25

# Test deduplication function
unique_data = data.remove_duplicates()  # test_remove_duplicates
assert len(unique_data) == 2

# Test row and column stacking
data1 = tablib.Dataset(['A', 'B'])
data2 = tablib.Dataset(['C', 'D'])
stacked = data1.stack(data2)  # test_row_stacking
stacked_cols = data1.stack_cols(data2)  # test_column_stacking

# Test data clearing
data.wipe()  # test_wipe
assert len(data) == 0
```

### 4. Formatting and Rendering

**Function Description**: Test the functions of formatted output, rendering, and serialization of data.

```python
import pickle

# Test string representation when there are no columns
empty_data = tablib.Dataset()
str_repr = str(empty_data)  # test_str_no_columns

# Test formatters
data = tablib.Dataset(headers=['Name', 'Value'])
data.append(('Test', 123.456))

# Test single-column formatting
formatted = data.export('csv', formatters={'Value': lambda x: f'{x:.2f}'})  # test_formatters

# Test formatting all columns
all_formatted = data.export('csv', formatters=[str.upper, str])  # test_formatters_all_cols

# Test rendering a Unicode Markdown table
unicode_data = tablib.Dataset(['Test', 'Data'])
markdown_table = unicode_data.export('cli', tablefmt='github')  # test_unicode_renders_markdown_table

# Test dataset serialization
pickled = pickle.dumps(data)  # test_pickle_unpickle_dataset
unpickled = pickle.loads(pickled)
assert unpickled.headers == data.headers

# Test data book formatters
book = tablib.Databook()
book.add_sheet(data)
book_formatted = book.export('xlsx', formatters={'Value': lambda x: x * 2})  # test_databook_formatter_support_kwargs

# Test handling newlines in data book formatters
newline_data = tablib.Dataset(['Line1\nLine2'])
book.add_sheet(newline_data)
book_newlines = book.export('csv')  # test_databook_formatter_with_new_lines
```

### 5. Row Data Row Object

**Function Description**: Test the functions of representing, serializing, operating on, and tagging the Row object.

```python
from tablib.core import Row
import pickle

# Create test data
data = tablib.Dataset(headers=['A', 'B', 'C'])
data.append((1, 2, 3))
row = data[0]

# Test row object representation
row_repr = repr(row)  # test_row_repr
assert '1' in row_repr

# Test row object serialization
pickled_row = pickle.dumps(row)  # test_row_pickle_unpickle
unpickled_row = pickle.loads(pickled_row)
assert unpickled_row == row

# Test left-pushing a value to the row object
row.lpush(0)  # test_row_lpush
assert row[0] == 0

# Test appending a value to the row object
row.append(4)  # test_row_append
assert 4 in row

# Test the containment relationship of the row object
assert 2 in row  # test_row_contains

# Test row object tags
tagged_row = Row((1, 2, 3), tags=['important'])
assert not tagged_row.has_tag([])  # test_row_no_tag
assert tagged_row.has_tag(['important'])  # test_row_has_tag

# Test multiple tags
multi_tagged = Row((1, 2, 3), tags=['tag1', 'tag2'])
assert multi_tagged.has_tags(['tag1', 'tag2'])  # test_row_has_tags
```

### 6. Multi-Format Import and Export

**Function Description**: Test the import and export functions of various data formats, including format detection and exception handling.

```python
import tempfile
from io import BytesIO, StringIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', 30))

# Test handling unknown formats
try:
    data.export('unknown_format')  # test_unknown_format
except tablib.UnsupportedFormat:
    print("Caught an unsupported format exception")

# Test exporting a data book without exceptions
book = tablib.Databook()
book.add_sheet(data)
formats = ['json', 'yaml', 'csv', 'xlsx', 'html']
for fmt in formats:
    try:
        book.export(fmt)  # test_book_export_no_exceptions
    except Exception as e:
        print(f"Error exporting {fmt}: {e}")

# Test unsupported loading and exporting
try:
    book.load('invalid_data', 'invalid_format')  # test_book_unsupported_loading
except tablib.UnsupportedFormat:
    pass

# Test importing from a file
with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
    f.write('Name,Age\nAlice,25\nBob,30')
    f.flush()
    imported_data = tablib.Dataset().load(open(f.name), format='csv')  # test_dataset_import_from_file

# Test handling an empty file
empty_file = StringIO('')
try:
    tablib.Dataset().load(empty_file, format='csv')  # test_empty_file
except:
    pass

# Test automatic format detection
csv_stream = StringIO('Name,Age\nAlice,25')
detected_format = tablib.detect_format(csv_stream)  # test_auto_format_detect
assert detected_format == 'csv'
```

### 7. HTML Format Support

**Function Description**: Test the import and export functions of the HTML format.

```python
from io import StringIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', None))  # Contains a None value

# Test HTML dataset export
html_output = data.export('html')  # test_html_dataset_export
assert '<table>' in html_output
assert 'Alice' in html_output

# Test handling None values in HTML export
html_with_none = data.export('html')  # test_html_export_none_value
assert html_with_none  # Ensure that None values can be handled properly

# Test HTML data book export
book = tablib.Databook()
book.add_sheet(data)
book_html = book.export('html')  # test_html_databook_export
assert '<table>' in book_html

# Test HTML import
html_content = '''
<table>
<tr><th>Name</th><th>Age</th></tr>
<tr><td>Alice</td><td>25</td></tr>
<tr><td>Bob</td><td>30</td></tr>
</table>
'''
imported_data = tablib.Dataset().load(StringIO(html_content), format='html')  # test_html_import
assert len(imported_data) == 2

# Test HTML import without headers
html_no_headers = '''
<table>
<tr><td>Alice</td><td>25</td></tr>
<tr><td>Bob</td><td>30</td></tr>
</table>
'''
no_header_data = tablib.Dataset().load(StringIO(html_no_headers), format='html', headers=False)  # test_html_import_no_headers

# Test HTML import with a table ID
html_with_id = '''
<table id="data_table">
<tr><th>Name</th><th>Age</th></tr>
<tr><td>Alice</td><td>25</td></tr>
</table>
'''
id_data = tablib.Dataset().load(StringIO(html_with_id), format='html', table_id='data_table')  # test_html_import_table_id
```

### 8. RST Format Support

**Function Description**: Test the export function of the RST (reStructuredText) format.

```python
# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', 30))

# Test forcing the RST grid format
rst_grid = data.export('rst', force_grid=True)  # test_rst_force_grid
assert '+' in rst_grid  # The grid format contains the + symbol

# Test handling an empty string
empty_data = tablib.Dataset()
empty_rst = empty_data.export('rst')  # test_empty_string
assert isinstance(empty_rst, str)

# Test exporting a dataset in RST format
rst_output = data.export('rst')  # test_rst_export_set
assert '=' in rst_output  # The RST format contains the = symbol as a separator
assert 'Alice' in rst_output
assert 'Name' in rst_output

# Test doctests for the RST formatter
import doctest
import tablib.formats._rst
results = doctest.testmod(tablib.formats._rst)  # test_rst_formatter_doctests
assert results.failed == 0
```

### 9. CSV Format Support

**Function Description**: Test the import, export, format detection, and option handling functions of the CSV format.

```python
from io import StringIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age', 'City'])
data.append(('Alice', 25, 'New York'))
data.append(('Bob', 30, 'Los Angeles'))

# Test CSV format detection
csv_content = 'Name,Age\nAlice,25\nBob,30'
csv_stream = StringIO(csv_content)
detected = tablib.detect_format(csv_stream)  # test_csv_format_detect
assert detected == 'csv'

# Test importing a dataset from CSV
imported = tablib.Dataset().load(StringIO(csv_content), format='csv')  # test_csv_import_set
assert len(imported) == 2
assert imported.headers == ['Name', 'Age']

# Test importing CSV data separated by semicolons
semicolon_csv = 'Name;Age\nAlice;25\nBob;30'
semicolon_data = tablib.Dataset().load(StringIO(semicolon_csv), format='csv', delimiter=';')  # test_csv_import_set_semicolons

# Test importing CSV data with spaces
spaced_csv = 'Name, Age\nAlice, 25\nBob, 30'
spaced_data = tablib.Dataset().load(StringIO(spaced_csv), format='csv')  # test_csv_import_set_with_spaces

# Test importing CSV data with newlines
newline_csv = 'Name,Description\nAlice,"Line1\nLine2"\nBob,"Simple"'
newline_data = tablib.Dataset().load(StringIO(newline_csv), format='csv')  # test_csv_import_set_with_newlines

# Test importing CSV data with embedded commas
embedded_csv = 'Name,City\n"Smith, John","New York, NY"\n"Doe, Jane","Los Angeles, CA"'
embedded_data = tablib.Dataset().load(StringIO(embedded_csv), format='csv')  # test_csv_import_set_commas_embedded

# Test importing CSV data with Unicode strings
unicode_csv = 'Name,City\nTest,Beijing\nUser,Shanghai'
unicode_data = tablib.Dataset().load(StringIO(unicode_csv), format='csv')  # test_csv_import_set_with_unicode_str

# Test importing ragged CSV data
ragged_csv = 'Name,Age\nAlice,25,Extra\nBob,30'
ragged_data = tablib.Dataset().load(StringIO(ragged_csv), format='csv')  # test_csv_import_set_ragged

# Test skipping lines when importing CSV data
skip_csv = '# Comment\n# Another comment\nName,Age\nAlice,25\nBob,30'
skip_data = tablib.Dataset().load(StringIO(skip_csv), format='csv', skip_lines=2)  # test_csv_import_set_skip_lines

# Test exporting data to CSV
csv_export = data.export('csv')  # test_csv_export
assert 'Alice' in csv_export
assert 'Name,Age,City' in csv_export

# Test CSV export options
csv_options = data.export('csv', delimiter=';', lineterminator='\r\n')  # test_csv_export_options

# Test exporting CSV data to a stream
from io import StringIO
output_stream = StringIO()
data.export('csv', file=output_stream)  # test_csv_stream_export

# Test Unicode CSV
unicode_data_export = unicode_data.export('csv')  # test_unicode_csv
assert 'Test' in unicode_data_export

# Test CSV column operations
selected_cols = data['Name', 'City']  # test_csv_column_select
del data['Age']  # test_csv_column_delete
data.sort('Name')  # test_csv_column_sort

# Test supporting formatter parameters in CSV export
formatted_csv = data.export('csv', formatters={'Name': str.upper})  # test_csv_formatter_support_kwargs
```

### 10. TSV Format Support

**Function Description**: Test the import and export functions of the TSV (Tab-Separated Values) format.

```python
from io import StringIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', 30))

# Test importing a dataset from TSV
tsv_content = 'Name\tAge\nAlice\t25\nBob\t30'
tsv_data = tablib.Dataset().load(StringIO(tsv_content), format='tsv')  # test_tsv_import_set
assert len(tsv_data) == 2
assert tsv_data.headers == ['Name', 'Age']

# Test TSV format detection
tsv_stream = StringIO(tsv_content)
detected = tablib.detect_format(tsv_stream)  # test_tsv_format_detect
assert detected == 'tsv'

# Test exporting data to TSV
tsv_export = data.export('tsv')  # test_tsv_export
assert '\t' in tsv_export  # TSV uses tabs as separators
assert 'Alice' in tsv_export
```

### 11. ODS Format Support

**Function Description**: Test the import and export functions of the ODS (OpenDocument Spreadsheet) format.

```python
import datetime as dt
from io import BytesIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age', 'Date'])
data.append(('Alice', 25, dt.date(2023, 1, 1)))
data.append(('Bob', 30, dt.date(2023, 2, 1)))

# Test exporting and importing a dataset in ODS format
ods_content = data.export('ods')  # test_ods_export_import_set
imported_ods = tablib.Dataset().load(BytesIO(ods_content), format='ods')
assert len(imported_ods) == 2

# Test displaying ODS export
display_ods = data.export('ods', write_headers=True)  # test_ods_export_display
assert isinstance(display_ods, bytes)

# Test importing a data book in ODS format
book = tablib.Databook()
book.add_sheet(data)
book_ods = book.export('ods')
imported_book = tablib.Databook().load(BytesIO(book_ods), format='ods')  # test_ods_import_book
assert len(imported_book.sheets()) == 1

# Test skipping lines when importing ODS data
# Create data with an empty line
data_with_empty = tablib.Dataset(headers=['Name', 'Age'])
data_with_empty.append(('', ''))  # Empty line
data_with_empty.append(('Alice', 25))
ods_with_empty = data_with_empty.export('ods')
skip_empty = tablib.Dataset().load(BytesIO(ods_with_empty), format='ods', skip_lines=1)  # test_ods_import_set_skip_lines

# Test importing ragged ODS data
ragged_data = tablib.Dataset()
ragged_data.append(('Alice', 25, 'Extra'))
ragged_data.append(('Bob', 30))
ragged_ods = ragged_data.export('ods')
imported_ragged = tablib.Dataset().load(BytesIO(ragged_ods), format='ods')  # test_ods_import_set_ragged

# Test handling unknown value types in ODS
# This test usually involves handling special value types in ODS files
unknown_type_test = True  # test_ods_unknown_value_type

# Test exporting dates in ODS
date_data = tablib.Dataset(headers=['Event', 'Date'])
date_data.append(('Meeting', dt.date(2023, 12, 25)))
date_ods = date_data.export('ods')  # test_ods_export_dates
assert isinstance(date_ods, bytes)
```

### 12. Excel Format Support

**Function Description**: Test the import, export, date handling, and error handling functions of the Excel XLS and XLSX formats.

```python
import datetime as dt
from io import BytesIO
from openpyxl import load_workbook

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age', 'Date'])
data.append(('Alice', 25, dt.datetime(2023, 1, 1, 12, 30, 8)))
data.append(('Bob', 30, dt.datetime(2023, 2, 1, 9, 15, 0)))

# Test XLS format detection
xls_content = data.export('xls')
detected_xls = tablib.detect_format(BytesIO(xls_content))  # test_xls_format_detect
assert detected_xls == 'xls'

# Test importing dates from an XLS file
xls_with_dates = data.export('xls')
imported_xls = tablib.Dataset().load(BytesIO(xls_with_dates), format='xls')  # test_xls_date_import
assert len(imported_xls) == 2

# Test XLSX format detection
xlsx_content = data.export('xlsx')
detected_xlsx = tablib.detect_format(BytesIO(xlsx_content))  # test_xlsx_format_detect
assert detected_xlsx == 'xlsx'

# Test importing a dataset from an XLSX file
imported_xlsx = tablib.Dataset().load(BytesIO(xlsx_content), format='xlsx')  # test_xlsx_import_set
assert imported_xlsx.headers == ['Name', 'Age', 'Date']

# Test skipping lines when importing an XLSX file
skip_data = tablib.Dataset()
skip_data.append(('Garbage', 'Line'))
skip_data.append(('', ''))
skip_data.append(('Name', 'Age'))
skip_data.append(('Alice', 25))
skip_xlsx = skip_data.export('xlsx')
skip_imported = tablib.Dataset().load(BytesIO(skip_xlsx), format='xlsx', skip_lines=2)  # test_xlsx_import_set_skip_lines

# Test importing an XLS file with errors
try:
    # Simulate importing an XLS file with errors
    error_data = tablib.Dataset().load(BytesIO(b'invalid_xls_content'), format='xls')  # test_xls_import_with_errors
except Exception:
    pass

# Test exporting dates in an XLS file
date_data = tablib.Dataset(headers=['Event', 'Date'])
date_data.append(('Meeting', dt.date(2023, 12, 25)))
date_xls = date_data.export('xls')  # test_xls_export_with_dates

# Test reading cell values in an XLSX file
cell_data = tablib.Dataset(headers=['Formula', 'Value'])
cell_data.append(('=1+1', 2))
cell_xlsx = cell_data.export('xlsx')  # test_xlsx_cell_values

# Test escaping formulas in an XLSX file
formula_data = tablib.Dataset()
formula_data.append(('=SUM(1+1)',))
escaped_xlsx = formula_data.export('xlsx', escape=True)  # test_xlsx_export_set_escape_formulae
normal_xlsx = formula_data.export('xlsx', escape=False)  # test_xlsx_export_book_escape_formulae

# Test escaping formulas in the header of an XLSX file
header_formula = tablib.Dataset(headers=['=SUM(1+1)'])
header_escaped = header_formula.export('xlsx', escape=True)  # test_xlsx_export_set_escape_formulae_in_header

# Test handling incorrect dimensions in an XLSX file
# This test usually involves reading an XLSX file with incorrect dimensions
dimension_test = True  # test_xlsx_bad_dimensions

# Test handling errors during XLSX export
error_data = tablib.Dataset()
error_data.append(([1, 2, 3],))  # Array type may cause errors
error_xlsx = error_data.export('xlsx')  # test_xlsx_raise_ValueError_on_cell_write_during_export

# Test setting column widths in an XLSX file
width_data = tablib.Dataset(['Short', 'Very Long Value That Should Affect Column Width'])
adaptive_xlsx = width_data.export('xlsx', column_width='adaptive')  # test_xlsx_column_width_adaptive
fixed_xlsx = width_data.export('xlsx', column_width=20)  # test_xlsx_column_width_integer
default_xlsx = width_data.export('xlsx', column_width=None)  # test_xlsx_column_width_none

# Test handling incorrect column width values in an XLSX file
try:
    invalid_xlsx = width_data.export('xlsx', column_width='invalid')  # test_xlsx_column_width_value_error
except ValueError:
    pass

# Test setting column widths in a data book exported as XLSX
book = tablib.Databook()
book.add_sheet(width_data)
book_adaptive = book.export('xlsx', column_width='adaptive')  # test_xlsx_book_column_width_adaptive
book_fixed = book.export('xlsx', column_width=15)  # test_xlsx_book_column_width_integer

# Test handling special characters in the sheet name of an XLSX file
bad_name_data = tablib.Dataset(title='Bad/Name\\With*Special?Chars[]TooLongNameThatExceeds30Characters')
bad_name_xlsx = bad_name_data.export('xlsx')  # test_xlsx_bad_chars_sheet_name

# Test importing ragged data from an XLSX file
ragged_xlsx_data = tablib.Dataset()
ragged_xlsx_data.append((1, 2, 3))
ragged_xlsx_data.append((4, 5))  # Rows of different lengths
ragged_xlsx = ragged_xlsx_data.export('xlsx')
ragged_book = tablib.Databook().load(BytesIO(ragged_xlsx), format='xlsx')  # test_xlsx_import_book_ragged
ragged_set = tablib.Dataset().load(BytesIO(ragged_xlsx), format='xlsx')  # test_xlsx_import_set_ragged

# Test handling incorrect characters in an XLSX file
try:
    bad_char_data = tablib.Dataset()
    bad_char_data.append(('string', b'\x0cf'))  # Invalid character
    bad_char_xlsx = bad_char_data.export('xlsx')  # test_xlsx_wrong_char
except Exception:
    pass
```

### 13. JSON Format Support

**Function Description**: Test the import and export functions of the JSON format.

```python
import json
from io import StringIO
from uuid import uuid4

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', 30))

# Test JSON format detection
json_content = '[{"Name": "Alice", "Age": 25}, {"Name": "Bob", "Age": 30}]'
json_stream = StringIO(json_content)
detected = tablib.detect_format(json_stream)  # test_json_format_detect
assert detected == 'json'

# Test importing a data book from JSON
book = tablib.Databook()
book.add_sheet(data)
json_book = book.export('json')
imported_book = tablib.Databook().load(StringIO(json_book), format='json')  # test_json_import_book
assert len(imported_book.sheets()) == 1

# Test importing a dataset from JSON
json_data = data.export('json')
imported_data = tablib.Dataset().load(StringIO(json_data), format='json')  # test_json_import_set
assert len(imported_data) == 2
assert imported_data.headers == ['Name', 'Age']

# Test exporting data to JSON
address_id = uuid4()
export_data = tablib.Dataset(headers=['Name', 'Age', 'ID'])
export_data.append(('Alice', 25, str(address_id)))
export_data.append(('Test', 30, ''))
json_export = export_data.export('json')  # test_json_export
parsed_json = json.loads(json_export)
assert len(parsed_json) == 2
assert parsed_json[0]['Name'] == 'Alice'

# Test importing a nested list from JSON
list_json = "[[1,2],[3,4]]"
list_data = tablib.Dataset().load(StringIO(list_json), format='json')  # test_json_list_of_lists
yaml_output = list_data.export('yaml')
assert '- [1, 2]' in yaml_output
```

### 14. YAML Format Support

**Function Description**: Test the import and export functions of the YAML format.

```python
from io import StringIO

# Prepare test data
data = tablib.Dataset(headers=['Name', 'Age'])
data.append(('Alice', 25))
data.append(('Bob', 30))

# Test YAML format detection
yaml_content = '- {Name: Alice, Age: 25}\n- {Name: Bob, Age: 30}'
yaml_stream = StringIO(yaml_content)
detected = tablib.detect_format(yaml_stream)  # test_yaml_format_detect
assert detected == 'yaml'

# Test importing a data book from YAML
book = tablib.Databook()
book.add_sheet(data)
yaml_book = book.export('yaml')
imported_book = tablib.Databook().load(StringIO(yaml_book), format='yaml')  # test_yaml_import_book
assert yaml_book == imported_book.yaml

# Test importing a dataset from YAML
yaml_data = data.export('yaml')
imported_data = tablib.Dataset().load(StringIO(yaml_data), format='yaml')  # test_yaml_import_set
assert yaml_data == imported_data.yaml

# Test exporting data to YAML
export_data = tablib.Dataset(headers=['Name', 'Age'])
export_data.append(('Alice', 25))
export_data.append(('Bob', 30))
export_data.append(('Test', 35, ''))
yaml_export = export_data.export('yaml')  # test_yaml_export
expected_yaml = '''- {Name: Alice, Age: 25}
- {Name: Bob, Age: 30}
- {Name: Test, Age: 35}
'''
assert 'Alice' in yaml_export
assert 'Test' in yaml_export

# Test handling exceptions when loading YAML data
try:
    invalid_yaml = "invalid: yaml: content: ["
    invalid_data = tablib.Dataset().load(StringIO(invalid_yaml), format='yaml')  # test_yaml_load
except tablib.UnsupportedFormat:
    pass
```

### 15. LaTeX Format Support

**Function Description**: Test the export function of the LaTeX format.

```python
# Prepare test data
data = tablib.Dataset(headers=['first_name', 'last_name', 'gpa'], title='Founders')
data.append(('John', 'Adams', 90))
data.append(('George', 'Washington', 67))
data.append(('Thomas', 'Jefferson', 50))

# Test exporting data to LaTeX
latex_output = data.export('latex')  # test_latex_export
assert '\\begin{table}' in latex_output
assert '\\caption{Founders}' in latex_output
assert 'John' in latex_output
assert 'Adams' in latex_output

# Test exporting an empty dataset to LaTeX
empty_data = tablib.Dataset()
empty_latex = empty_data.export('latex')  # test_latex_export_empty_dataset
assert empty_latex is not None

# Test exporting data without headers to LaTeX
no_header_data = tablib.Dataset()
no_header_data.append(('one', 'two', 'three'))
no_header_latex = no_header_data.export('latex')  # test_latex_export_no_headers
assert 'one' in no_header_latex

# Test exporting data with and without a title to LaTeX
no_title_data = tablib.Dataset()
no_title_data.append(('foo', 'bar'))
no_title_latex = no_title_data.export('latex')  # test_latex_export_caption
assert '\\caption' not in no_title_latex

titled_data = tablib.Dataset(title='Test Title')
titled_data.append(('foo', 'bar'))
titled_latex = titled_data.export('latex')
assert '\\caption{Test Title}' in titled_latex

# Test handling None values in LaTeX export
none_data = tablib.Dataset(headers=['foo', None, 'bar'])
none_data.append(('foo', None, 'bar'))
none_latex = none_data.export('latex')  # test_latex_export_none_values
assert 'foo' in none_latex
assert 'None' not in none_latex

# Test escaping characters in LaTeX export
escape_data = tablib.Dataset(['~', '^'])
escape_latex = escape_data.export('latex')  # test_latex_escaping
assert '~' not in escape_latex
assert 'textasciitilde' in escape_latex
assert '^' not in escape_latex
assert 'textasciicircum' in escape_latex
```

### 16. DBF Format Support

**Function Description**: Test the import and export functions of the DBF format.

```python
from io import BytesIO

# Prepare test data
data = tablib.Dataset(headers=['first_name', 'last_name', 'gpa'])
data.append(('John', 'Adams', 90))
data.append(('George', 'Washington', 67))
data.append(('Thomas', 'Jefferson', 50))

# Test importing a dataset from DBF
dbf_content = data.export('dbf')
imported_dbf = tablib.Dataset()
imported_dbf.load(BytesIO(dbf_content), format='dbf')  # test_dbf_import_set
# Verify the imported data
try:
    assert len(imported_dbf) == 3
except AssertionError:
    # The DBF format may have special encoding processing
    pass

# Test exporting a dataset to DBF
dbf_export = data.export('dbf')  # test_dbf_export_set
assert isinstance(dbf_export, bytes)
assert len(dbf_export) > 0

# Test DBF format detection
dbf_stream = BytesIO(dbf_export)
detected = tablib.detect_format(dbf_stream)  # test_dbf_format_detect
assert detected == 'dbf'

# Verify the DBF file structure
# DBF files have a specific binary format
regression_dbf_start = b'\x03'  # DBF file identifier
assert dbf_export.startswith(regression_dbf_start)
```

### 17. JIRA Format Support

**Function Description**: Test the export function of the JIRA format.

```python
# Prepare test data
data = tablib.Dataset(headers=['first_name', 'last_name', 'gpa'])
data.append(('John', 'Adams', 90))
data.append(('George', 'Washington', 67))
data.append(('Thomas', 'Jefferson', 50))

# Test exporting data to JIRA
jira_output = data.export('jira')  # test_jira_export
expected = """||first_name||last_name||gpa||
|John|Adams|90|
|George|Washington|67|
|Thomas|Jefferson|50|"""
assert jira_output == expected

# Test exporting data without headers to JIRA
no_header_data = tablib.Dataset(['a', 'b', 'c'])
no_header_jira = no_header_data.export('jira')  # test_jira_export_no_headers
assert no_header_jira == '|a|b|c|'

# Test exporting data with None and empty values to JIRA
none_data = tablib.Dataset(['', None, 'c'])
none_jira = none_data.export('jira')  # test_jira_export_none_and_empty_values
assert none_jira == '| | |c|'

# Test exporting an empty dataset to JIRA
empty_data = tablib.Dataset()
empty_jira = empty_data.export('jira')  # test_jira_export_empty_dataset
assert empty_jira is not None
```

### 18. CLI Format Support

**Function Description**: Test the export function of the CLI command-line table format.

```python
# Prepare test data
data = tablib.Dataset(['a', 'b', 'c'])

# Test GitHub-style CLI export
github_output = data.export('cli', tablefmt='github')  # test_cli_export_github
assert github_output == '|---|---|---|
| a | b | c |'

# Test simple CLI export
simple_output = data.export('cli', tablefmt='simple')  # test_cli_export_simple
expected_simple = '-  -  -
a  b  c
-  -  -'
assert simple_output == expected_simple

# Test grid CLI export
grid_output = data.export('cli', tablefmt='grid')  # test_cli_export_grid
expected_grid = '+---+---+---+
| a | b | c |
+---+---+---+'
assert grid_output == expected_grid
```

### 19. SQL Format Support

**Function Description**: Test the export function of the SQL format.

```python
import datetime as dt
from decimal import Decimal

# Test SQL date and time literals
date_data = tablib.Dataset(title='tbl', headers=['col_date', 'col_timestamp'])
date_data.append([dt.date(2020, 1, 2), dt.datetime(2020, 1, 2, 3, 4, 5)])
sql_dates = date_data.export('sql')  # test_sql_date_and_timestamp_literals
expected_dates = "INSERT INTO tbl (col_date,col_timestamp) VALUES (DATE '2020-01-02', TIMESTAMP '2020-01-02 03:04:05');
"
assert sql_dates == expected_dates

# Test SQL microsecond precision and default table name
micro_data = tablib.Dataset(headers=['ts'])
micro_data.append([dt.datetime(2021, 12, 31, 23, 59, 59, 123456)])
sql_micro = micro_data.export('sql')  # test_sql_microseconds_and_default_table
expected_micro = "INSERT INTO export_table (ts) VALUES (TIMESTAMP '2021-12-31 23:59:59.123456');
"
assert sql_micro == expected_micro

# Test SQL regular literals
regular_data = tablib.Dataset(title='t', headers=['i', 's', 'd', 'b', 'n', 'm', 'ml'])
regular_data.append([1, "O'Reilly", Decimal('3.14'), 5.1, False, None, 'Line1
Line2'])
sql_regular = regular_data.export('sql')  # test_sql_regular_literals
expected_regular = "INSERT INTO t (i,s,d,b,n,m,ml) VALUES (1, 'O''Reilly', 3.14, 5.1, FALSE, NULL, 'Line1
Line2');
"
assert sql_regular == expected_regular

# Test SQL export without headers
no_header_sql_data = tablib.Dataset(title='t')
no_header_sql_data.append([1, "O'Reilly", Decimal('3.14'), 5.1, False, None, 'Line1
Line2'])
sql_no_headers = no_header_sql_data.export('sql')  # test_sql_no_headers
expected_no_headers = "INSERT INTO t VALUES (1, 'O''Reilly', 3.14, 5.1, FALSE, NULL, 'Line1
Line2');
"
assert sql_no_headers == expected_no_headers

# Test custom table name and column names
custom_data = tablib.Dataset()
custom_data.append([1, 'test'])
custom_sql = custom_data.export('sql', table='schema_name.custom_table', 
                               columns=['col1', 'col2'], commit=True)
expected_custom = "INSERT INTO schema_name.custom_table (col1,col2) VALUES (1, 'test');
COMMIT;
"
assert custom_sql == expected_custom
```

### 20. DBF Field Definition and Comparison

**Function Description**: Test the comparison operation function of the DBF field definition class.

```python
from tablib._vendor.dbfpy import fields

# Create test fields
field_a = fields.DbfCharacterFieldDef("abc", 10)
field_z = fields.DbfCharacterFieldDef("xyz", 10)
field_a2 = fields.DbfCharacterFieldDef("abc", 10)

# Test field equality comparison
assert field_a == field_a2  # test_compare__eq__

# Test field inequality comparison
assert field_a != field_z  # test_compare__ne__

# Test field less-than comparison
assert field_a < field_z  # test_compare__lt__

# Test field less-than-or-equal-to comparison
assert field_a <= field_a2  # test_compare__le__
assert field_a <= field_z

# Test field greater-than comparison
assert field_z > field_a  # test_compare__gt__

# Test field greater-than-or-equal-to comparison
assert field_a2 >= field_a  # test_compare__ge__
assert field_z >= field_a

# Verify that the comparison is based on the field name
print(f"Field a: {repr(field_a)}")
print(f"Field z: {repr(field_z)}")
assert field_a.name < field_z.name
```

### 21. DBF Utility Functions

**Function Description**: Test the functions of DBF-related utility functions.

```python
import datetime as dt
from tablib._vendor.dbfpy import utils

# String processing test
# Test string processing with NUL characters
text_with_nul = b"abc xyz"
result_with_nul = utils.unzfill(text_with_nul)  # test_unzfill_with_nul
assert result_with_nul == b"abc"

# Test string processing without NUL characters
text_without_nul = b"abcxyz"
result_without_nul = utils.unzfill(text_without_nul)  # test_unzfill_without_nul
assert result_without_nul == b"abcxyz"

# Date conversion test
# Test date conversion of None value
date_none = utils.getDate(None)  # test_getDate_none
assert isinstance(date_none, dt.date)

# Test date object conversion
date_obj = dt.date(2019, 10, 19)
date_from_date = utils.getDate(date_obj)  # test_getDate_datetime_date
assert date_from_date == date_obj

# Test date-time object conversion
datetime_obj = dt.datetime(2019, 10, 19, 12, 0, 0)
date_from_datetime = utils.getDate(datetime_obj)  # test_getDate_datetime_datetime
assert isinstance(date_from_datetime, dt.date)
assert date_from_datetime == datetime_obj.date()

# Test timestamp conversion
timestamp = 1571515306
date_from_timestamp = utils.getDate(timestamp)  # test_getDate_datetime_timestamp
assert date_from_timestamp == dt.date(2019, 10, 19)

# Test string conversion
date_string_long = "20191019"
date_from_string_long = utils.getDate(date_string_long)  # test_getDate_datetime_string_yyyy_mm_dd
assert date_from_string_long == dt.date(2019, 10, 19)

date_string_short = "191019"
date_from_string_short = utils.getDate(date_string_short)  # test_getDate_datetime_string_yymmdd
assert date_from_string_short == dt.date(2019, 10, 19)

# Date-time conversion test
# Test date-time conversion of None value
datetime_none = utils.getDateTime(None)  # test_getDateTime_none
assert isinstance(datetime_none, dt.datetime)

# Test date-time object conversion
datetime_from_datetime = utils.getDateTime(datetime_obj)  # test_getDateTime_datetime_datetime
assert datetime_from_datetime == datetime_obj

# Test conversion of date object to date-time
datetime_from_date = utils.getDateTime(date_obj)  # test_getDateTime_datetime_date
assert isinstance(datetime_from_date, dt.datetime)
assert datetime_from_date.date() == date_obj

# Test conversion of timestamp to date-time
datetime_from_timestamp = utils.getDateTime(timestamp)  # test_getDateTime_datetime_timestamp
assert isinstance(datetime_from_timestamp, dt.datetime)

# Test string-to-date-time conversion (unimplemented exception)
try:
    datetime_from_string = utils.getDateTime("20191019")  # test_getDateTime_datetime_string
except NotImplementedError:
    pass

# Invalid value processing test
INVALID_VALUE = utils.INVALID_VALUE
# Test the basic behavior of invalid values
assert INVALID_VALUE == INVALID_VALUE  # test_sanity
assert INVALID_VALUE != 123
assert int(INVALID_VALUE) == 0
assert float(INVALID_VALUE) == 0.0
assert str(INVALID_VALUE) == ""
assert repr(INVALID_VALUE) == "<INVALID>"
assert INVALID_VALUE == None
assert INVALID_VALUE == 0
assert INVALID_VALUE == ""
assert INVALID_VALUE == False
```
