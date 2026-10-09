## Introduction and Goals of the pysonDB-v2 Project
### Project Introduction

- **pysonDB-v2** allows you to perform Create, Read, Update, and Delete (CRUD) operations directly on local JSON files, just like operating a database, without relying on traditional database servers.
- It is suitable for scenarios such as small projects, prototype development, script automation, and configuration storage.

### Main Features

1. **Data Storage**  
   - Uses JSON files as the storage medium, with a simple and intuitive data structure.
2. **Basic Operations**  
   - Supports common database operations such as adding (add), querying (get), updating (update), and deleting (delete).
3. **Command-Line Interface (CLI)**  
   - Provides a command-line interface to directly manage and operate database files through the command line.
4. **Batch Operations**  
   - Supports batch addition, batch query, batch update, and batch deletion of data.
5. **Data Query**  
   - Supports querying by ID, querying by conditions, and paginated query.
6. **Data Export**  
   - Can export the database content to a CSV file for easy data analysis and migration.
7. **Database Merging**  
   - Supports merging multiple database files with the same key structure.
8. **Database Migration**  
   - Supports migrating the old version of the database (v1) to the new version (v2) to maintain data compatibility.
9. **Database Clearing**  
   - Provides the function to clear the database, deleting all data but retaining the database structure.


---

## Natural Language Instruction (Prompt)
Please create a Python project named pysonDB-v2 to implement a JSON database. The project should include the following functions and meet the following requirements:
1. Basic Database Operations
    - Create a database (JSON file)
    - Add a single data record to the database (add)
    - Add multiple data records to the database in batch (add_many)
    - Query all data (get_all)
    - Query data by ID (get_by_id)
    - Query data by conditions (get_by_query)
    - Update data with a specified ID (update_by_id)
    - Batch update data by conditions (update_by_query)
    - Delete data with a specified ID (delete_by_id)
    - Batch delete data by conditions (delete_by_query)
    - Clear the database (purge)

2. Database Structure and Type Support
    - Support dynamically adding new fields
    - Support automatically generating unique IDs
    - Support data type validation

3. Command-Line Interface (CLI) Functions
    - Create a database file through the command line
    - Add, query, update, and delete data through the command line
    - Display the database content through the command line (show)
    - Export the database to a CSV file through the command line (tocsv)
    - Merge databases through the command line (merge)
    - Clear the database through the command line (purge)
    - Migrate the old version of the database through the command line (migrate)

4. Error Handling and Prompting
    - Provide clear exceptions and prompts for illegal operations, non-existent files, and data format errors.

5. Utility Functions and Auxiliary Features
    - ID generator
    - Data validation tool

6. Interface Design: The code implementation should have a good design. Each functional module (such as database initialization, complex queries, batch operations, database management, enabling high-performance mode, error handling, data validation, data export and conversion, concurrency, and database backup and recovery) should design function interfaces and define clear input and output formats.

7. Examples and Test Scripts: Provide example code and test cases to demonstrate how to initialize the database using the PysonDB() function and how to perform data operations using other APIs (such as db.add()). The above functions need to be combined to construct a complete example code demonstrating database initialization, CRUD operations, data export, and backup, as well as corresponding test cases.

8. Core File Requirements: The project must include a complete setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as ujson==5.2.0, prettytable==3.3.0, pytest==8.4.1, pytest-mock==3.14.1, and python>=3.7.0). The setup.py file can verify whether all functional modules work properly.

---

## Environment Configuration
### Core Dependency Library Versions
```bash
# Python version
python>=3.7.0

# JSON dependency library (high-performance JSON parsing)
ujson==5.2.0

# Visualization dependency library (for CLI table display)
prettytable==3.3.0

# Testing framework
pytest==8.4.1 # Unit testing framework
pytest-mock==3.14.1 # Mock support for pytest

# Code formatting tool
black==23.12.1 # Used to automatically format Python code to maintain a consistent style
```

### Installation Instructions
```bash
# Install the project (in development mode, supporting modifications)
pip install -e .

# Install only runtime dependencies
pip install -r requirements.txt

# Install development dependencies (including testing tools)
pip install -r requirements-dev.txt

# Run tests
pytest

# Build distribution packages
python setup.py sdist bdist_wheel
```

## pysonDB-v2 Project Architecture
### Project Directory Structure

```markdown
pysonDB-v2/
├── pysondb/                  # Main package directory, storing core code
│   ├── __init__.py
│   ├── __main__.py           # Supports running with python -m pysondb
│   ├── cli.py                # Command-line tool implementation
│   ├── db.py                 # Database core operations
│   ├── db_types.py           # Type definitions
│   ├── errors.py             # Custom exceptions
│   └── utils.py              # Utility functions
│
├── docs/                     # Project documentation
│   └── docs.md
│
├── README.md                 # Project description
├── LICENSE                   # License
├── requirements.txt          # Runtime dependencies
├── requirements-dev.txt      # Development/testing dependencies
├── setup.py                  # Installation script
├── setup.cfg                 # Configuration file
├── py.typed                  # Type hint marker
└── tox.ini                   # Test automation configuration
```


## API Usage Guide
### Core API
#### 1. Module Import
```python
# Basic import
from pysondb import PysonDB

# Type definition import

from pysondb.db_types import {
    DBSchemaType,
    IdGeneratorType,
    NewKeyValidTypes,
    SingleDataType,
    ReturnWithIdType,
    QueryType
}

# Error type import
from pysondb.errors import (
    IdDoesNotExistError,
    UnknownKeyError,
    SchemaTypeError
)

# Utility function import
from pysondb.utils import (
    migrate,
    print_db_as_table,
    merge_n_db,
    purge_db
)
```

#### 2. PysonDB() Constructor - Database Initialization

**Function**: Creates a database instance, supporting automatic updates and custom configurations.

**Function Signature**:
```python
def __init__(
    filename: str,
    auto_update: bool = True,
    indent: int = 4
) -> None:
        self.filename = filename
        self.auto_update = auto_update
        self._au_memory: DBSchemaType = {'version': 2, 'keys': [], 'data': {}}
        self.indent = indent
        self._id_generator = self._gen_id
        self.lock = Lock()
        self._gen_db_file()

try:
    import ujson
    UJSON = True
except ImportError:
    UJSON = False
```

**Parameter Description**:
- `filename` (str): Path to the database file
- `auto_update` (bool): Whether to automatically update the file, default is True
- `indent` (int): Indentation of the JSON file, default is 4

**Return Value**: No return value, initializes the database instance

**Example**:
```python
from pysondb import PysonDB

# Basic initialization
db = PysonDB('database.json')

# Custom configuration initialization
db = PysonDB('database.json', auto_update=False, indent=2)
```

#### 3. add() Function - Single Data Addition

**Function**: Adds a single data record to the database, automatically generating a unique ID and maintaining field structure consistency.

**Function Signature**:
```python
def add(
    data: object
) -> str:
```

**Parameter Description**:
- `data` (object): The data object to be added, must be a serializable Python object (such as a dictionary)

**Return Value**: The generated data ID (an 18-character string)

**Exceptions**:
- `TypeError`: When `data` is not a dictionary type
- `UnknownKeyError`: When the data contains unknown fields or is missing required fields in the database

**Example**:
```python
from pysondb import PysonDB
from pysondb.errors import UnknownKeyError

# Add data
id = db.add({
   'name': 'Zhang San',
   'age': 25,
   'city': 'Beijing'
})
print(id)  # Output: 123456789012345678

# Error handling
try:
    result = db.add({'age': 4, 'name': 'fredy', 'place': 'GB'})
except UnknownKeyError as e:
    print(f"Field error: {e}")  # Unrecognized / missing key(s) {'place'}
```

#### 4. add_many() Function - Batch Data Addition

**Function**: Adds multiple data records to the database in batch, supporting an optional mode to return the addition results.

**Function Signature**:
```python
def add_many(
    data: object,
    json_response: bool = False
) -> Union[SingleDataType, None]:
```

**Parameter Description**:
- `data` (object): A list of data objects, each object must be a serializable Python object (such as a dictionary)
- `json_response` (bool): Whether to return the added data, default is False

**Return Value**:
- If `json_response=True`, returns a dictionary of `{id: data}`
- If `json_response=False`, returns `None`
- If the input is empty, returns `None`

**Exceptions**:
- `TypeError`: When `data` is not a list type or the elements in the list are not dictionary types, a `TypeError` exception is thrown.
- `UnknownKeyError`: When the data contains unknown fields or is missing required fields in the database

**Example**:
```python
# Do not return data
db.add_many([
   {'name': 'Li Si', 'age': 30, 'city': 'Shanghai'},
   {'name': 'Wang Wu', 'age': 28, 'city': 'Guangzhou'}
])

# Return the added data
result = db.add_many([
   {'name': 'Zhao Liu', 'age': 32, 'city': 'Shenzhen'},
   {'name': 'Qian Qi', 'age': 26, 'city': 'Hangzhou'}
], json_response=True)
print(result)
# Output: {'123456789012345679': {'name': 'Zhao Liu', 'age': 32, 'city': 'Shenzhen'}, ...}
```

#### 5. get_all() Function - Full Data Query

**Function**: Retrieves all data records in the database.

**Function Signature**:
```python
def get_all() -> ReturnWithIdType:
```

**Parameter Description**: No parameters

**Return Value**: A dictionary containing all data, in the format of `{id: data}`

**Example**:
```python
all_data = db.get_all()
print(all_data)
# Output: {'123456789012345678': {'name': 'Zhang San', 'age': 25, 'city': 'Beijing'}, ...}
```

#### 6. get_by_id() Function - ID Query

**Function**: Retrieves a specific record based on the data ID, providing precise data retrieval.

**Function Signature**:
```python
def get_by_id(
    id: str
) -> ReturnWithIdType:
```

**Parameter Description**:
- `id` (str): The data ID

**Return Value**: A dictionary containing the ID and the corresponding data, in the format of `{id: data}`

**Exceptions**:
- `IdDoesNotExistError`: Thrown when the specified ID does not exist
- `TypeError`: When `id` is not a string type
- `SchemaTypeError`: When the data is not a dictionary type

**Example**:
```python
from pysondb.errors import IdDoesNotExistError

# Normal query
data = db.get_by_id('123456789012345678')
print(data)  # Output: {'id': '123456789012345678', 'name': 'Zhang San', 'age': 25, 'city': 'Beijing'}

# Error handling
try:
    data = db.get_by_id('non_existent_id')
except IdDoesNotExistError as e:
    print(f"ID does not exist: {e}")  # 'non_existent_id' does not exists in the DB
```

#### 7. get_by_query() Function - Conditional Query

**Function**: Retrieves matching data records based on query conditions, supporting complex filtering logic.

**Function Signature**:
```python
def get_by_query(
    query: QueryType
) -> ReturnWithIdType:
```

**Parameter Description**:
- `query` (QueryType): A query function that takes a data dictionary as a parameter and returns a boolean value

**Return Value**: A dictionary of data that meets the conditions, in the format of `{id: data}`

**Exceptions**:
- `TypeError`: When `query` is not a callable object

**Example**:
```python
# Query by age condition
result = db.get_by_query(lambda x: x['age'] >= 25)
print(result)

# Query by composite conditions
result = db.get_by_query(lambda x: x['age'] >= 25 and x['city'] == 'Beijing')
print(result)

# Fuzzy string query
result = db.get_by_query(lambda x: 'Zhang' in x['name'])
print(result)
```

#### 8. get_all_select_keys() Function - Selective Field Query

**Function**: Retrieves all data but only returns the specified fields, optimizing memory usage and network transmission.

**Function Signature**:
```python
def get_all_select_keys(
    keys: list
) -> ReturnWithIdType:
```

**Parameter Description**:
- `keys` (list): A list of field names to be returned

**Return Value**: A dictionary containing the ID and the specified fields

**Exceptions**:
- `UnknownKeyError`: Thrown when the specified fields do not exist
- `SchemaTypeError`: Thrown when `keys` is not a list type

**Example**:
```python
# Only get the name and age
result = db.get_all_select_keys(['name', 'age'])
print(result)
# Output: {'123456789012345678': {'id': '123456789012345678', 'name': 'Zhang San', 'age': 25}, ...}

# Error handling
try:
    result = db.get_all_select_keys(['wrong_key'])
except UnknownKeyError as e:
    print(f"Field error: {e}")  # Unrecognized key(s) {'wrong_key'}
```

#### 9. update_by_id() Function - ID Update

**Function**: Updates a specific record based on the data ID, supporting partial field updates.

**Function Signature**:
```python
def update_by_id(
    id: str,
    new_data: object
) -> SingleDataType:
```

**Parameter Description**:
- `id` (str): The data ID
- `new_data` (object): The data object to be updated

**Return Value**: The complete updated data

**Exceptions**:
- `IdDoesNotExistError`: Thrown when the specified ID does not exist
- `UnknownKeyError`: Thrown when the fields to be updated do not exist
- `TypeError`: Thrown when `new_data` is not a dictionary type
- `SchemaTypeError`: Thrown when the fields within the data are not dictionary types

#### 10. update_by_query() Function - Conditional Batch Update

**Function**: Batch updates data based on query conditions, supporting fixed-value replacement.

**Function Signature**:
```python
def update_by_query(
    query: QueryType, 
    new_data: object
) -> list:
```

**Parameter Description**:
- `query` (QueryType): A query function
- `new_data` (object): The data object to be updated (a fixed value, does not support dynamic calculation)

**Return Value**: A list of IDs of the updated data

**Exceptions**:
- `TypeError`: When `query` is not a callable object or `new_data` is not a dictionary type
- `UnknownKeyError`: Thrown when the fields to be updated do not exist
- `SchemaTypeError`: Thrown when the fields within the data are not dictionary types

**Example**:
```python
# Set the age of all people in Beijing to 30
updated_ids = db.update_by_query(lambda x: x['city'] == 'Beijing', {'age': 30})
print(updated_ids)  # Output: ['123456789012345678', ...]

# Mark all people under 25 as young
young_ids = db.update_by_query(lambda x: x['age'] < 25, {'status': 'young'})
print(young_ids)
```

#### 11. delete_by_id() Function - ID Deletion

**Function**: Deletes a specific record based on the data ID, providing precise data removal.

**Function Signature**:
```python
def delete_by_id(
    id: str
) -> None:
```

**Parameter Description**:
- `id` (str): The data ID

**Exceptions**:
- `IdDoesNotExistError`: Thrown when the specified ID does not exist

**Example**:
```python
# Normal deletion
db.delete_by_id('123456789012345678')

# Error handling
try:
    db.delete_by_id('non_existent_id')
except IdDoesNotExistError as e:
    print(f"ID {id!r} does not exists in the DB: {e}")
```

#### 12. delete_by_query() Function - Conditional Batch Deletion

**Function**: Batch deletes data based on query conditions, returning a list of IDs of the deleted data.

**Function Signature**:
```python
def delete_by_query(
    query: QueryType
) -> list:
```

**Parameter Description**:
- `query` (QueryType): A query function

**Return Value**: A list of IDs of the deleted data

**Exceptions**:
- `TypeError`: When `query` is not a callable object
- `SchemaTypeError`: Thrown when the fields within the data are not dictionary types

**Example**:
```python
# Delete all people under 25
deleted_ids = db.delete_by_query(lambda x: x['age'] < 25)
print(deleted_ids)  # Output: ['123456789012345679', ...]

# Delete all inactive users
inactive_ids = db.delete_by_query(lambda x: not x.get('active', False))
print(inactive_ids)
```

#### 13. purge() Function - Database Clearing

**Function**: Clears all data in the entire database, resetting it to the initial state.

**Function Signature**:
```python
def purge() -> None:
```

**Parameter Description**: No parameters

**Return Value**: No return value

**Example**:
```python
# Clear the database
db.purge()  # Clears all data
```

#### 14. add_new_key() Function - New Field Addition

**Function**: Adds a new field to the database, setting a default value for all existing records.

**Function Signature**:
```python
def add_new_key(
    key: str,
    default: Optional[NewKeyValidTypes] = None
) -> None:
```

**Parameter Description**:
- `key` (str): The name of the new field, must be a string type
- `default` (optional): The default value of the new field

**Exceptions**:
- `TypeError`: Thrown when the default value type is incorrect

**Example**:
```python
# Add a new field 'salary' with a default value of 0
db.add_new_key('salary', 0)

# Add a new field 'hobbies' with a default value of an empty list
db.add_new_key('hobbies', [])

# Add a new field 'is_active' with a default value of True
db.add_new_key('is_active', True)
```

#### 15. set_id_generator() Function - ID Generator Setting

**Function**: Sets a custom ID generation function, supporting different ID generation strategies.

**Function Signature**:
```python
def set_id_generator(
    fn: IdGeneratorType
) -> None:
```

**Parameter Description**:
- `fn` (IdGeneratorType): An ID generation function that must return a string

**Example**:
```python
def get_nums(n):
    yield str(n)
    yield from get_nums(n + 1)
nums = get_nums(1)
db.set_id_generator(lambda: next(nums))

# Add data using a custom generator
id = db.add({'name': 'test', 'age': 25})
print(id)  # Output: A string in a format similar to a UUID
```
#### 16. _gen_id() Function - ID Generator

**Function**: Generates a random 18-digit UUID as the data ID.

**Function Signature**:
```python
def _gen_id(self) -> str:
        # generates a random 18 digit uuid
        return str(uuid.uuid4())[:18]
```

#### 17. force_load() Function - Forced Loading

**Function**: Forces data to be loaded from the file (used when `auto_update=False`).

**Function Signature**:
```python
def force_load() -> None:
```

**Parameter Description**: No parameters

**Return Value**: No return value

**Example**:
```python
db = PysonDB('test.json', auto_update=False)
# ... Other operations
db.force_load()  # Forces the latest data to be loaded from the file
```

#### 18. commit() Function - Data Commit

**Function**: Commits the data in memory to the file (used when `auto_update=False`).

**Function Signature**:
```python
def commit() -> None:
```

**Parameter Description**: No parameters

**Return Value**: No return value

**Example**:
```python
db = PysonDB('test.json', auto_update=False)
# ... Data operations
db.commit()  # Commits to the file
```

#### 19. _dump_file() Function - File Writing

**Function**: Writes the database data to a file, ensuring persistent data storage.

**Function Signature**:
```python
    def _dump_file(self, data: DBSchemaType) -> None:
```

**Parameter Description**:
- `data` (DBSchemaType): The database data, in the format of `Dict[str, Any]`

**Return Value**: No return value

**Exceptions**: No explicit exceptions are thrown

**Example**:
```python
# Assume db is a PysonDB instance
db._dump_file(db.data)  # Writes the current data to the file
```

#### 20. _load_file() Function - File Reading

**Function**: Reads the database data from the file, ensuring the data is loaded into memory.

**Function Signature**:
```python
    def _load_file(self) -> DBSchemaType:
```

**Parameter Description**: No parameters

**Return Value**: The database data, in the format of `Dict[str, Any]`

**Exceptions**: No explicit exceptions are thrown

**Example**:
```python
# Assume db is a PysonDB instance
db_data = db._load_file()  # Loads data from the file
print(db_data)  # Output: The database data dictionary
```

#### 21. _gen_db_file() Function - Database File Generation

**Function**: Generates an empty database file, initializing the database structure.

**Function Signature**:
```python
    def _gen_db_file(self) -> None:
```

**Parameter Description**: No parameters

**Return Value**: No return value

**Exceptions**: No explicit exceptions are thrown

**Example**:
```python
# Assume db is a PysonDB instance
db._gen_db_file()  # Generates an empty database file
```

#### 22. migrate() Function - Database Migration

**Function**: Migrates the old version of the database data format to the new version format, supporting the conversion of the data structure from v1 to v2.

**Function Signature**:
```python
try:
    from prettytable import PrettyTable
    PRETTYTABLE = True
except ImportError:
    PRETTYTABLE = False
def migrate(old_db_data: OldDataType) -> NewDataType:
```

**Parameter Description**:
- `old_db_data` (OldDataType): The old version of the database data, in the format of `Dict[str, List[Dict[str, Any]]]`
- In utils.py, the PRETTYTABLE variable needs to be provided to determine whether the prettytable library is installed and provide a reference

**Return Value**: The new version of the database data, in the format of `NewDataType`

**Exceptions**: No explicit exceptions are thrown

**Example**:
```python
from pysondb.utils import migrate

# Old version data format
old_data = {
    'data': [
        {'id': 1, 'name': 'Zhang San', 'age': 25},
        {'id': 2, 'name': 'Li Si', 'age': 30}
    ]
}

# Migrate to the new version
new_data = migrate(old_data)
print(new_data)
# Output: {
#     'version': 2,
#     'keys': ['name', 'age'],
#     'data': {
#         '1': {'name': 'Zhang San', 'age': 25},
#         '2': {'name': 'Li Si', 'age': 30}
#     }
# }
```
#### 23. print_db_as_table() Function - Display Database in Table Format

**Functionality:** Format and output the database content in a table format, providing a more intuitive way to view data.

**Function Signature:**
```python
def print_db_as_table(data: NewDataType) -> Tuple[str, int]:
```

**Parameter Description:**
- `data` (NewDataType): New version database data

**Return Value:** Tuple `(str, int)`, containing the formatted table string and the status code
- A status code of 0 indicates success
- A status code of 1 indicates failure, and the string contains error information

**Exception:** No explicit exceptions are thrown. Error information is passed through the return value.

**Example:**
```python
from pysondb.utils import print_db_as_table

# Database data
db_data = {
    'version': 2,
    'keys': ['name', 'age'],
    'data': {
        '1': {'name': 'Zhang San', 'age': 25},
        '2': {'name': 'Li Si', 'age': 30}
    }
}

# Format as a table
table_str, status = print_db_as_table(db_data)
if status == 0:
    print(table_str)
    # Output table:
    # +----+------+-----+
    # | id | name | age |
    # +----+------+-----+
    # | 1  | Zhang San |  25 |
    # | 2  | Li Si |  30 |
    # +----+------+-----+
```

**Errors:**
- If the database version is not 2, return a status code of 1 and the error message "install prettytable (pip3 install prettytable) to run the following command".
- If the prettytable library is not installed, return a status code of 1 and the error message "the DB must be a v2 DB, you can use the migrate command to the convert your DB".

#### 24. merge_n_db() Function - Merge Multiple Databases

**Functionality:** Merge multiple databases with the same key structure, integrating all data into one database.

**Function Signature:**
```python
def merge_n_db(*dbs: DBSchemaType) -> Tuple[DBSchemaType, str, int]:
```

**Parameter Description:**
- `*dbs` (DBSchemaType): A variable number of database objects, each database must have the same key structure

**Return Value:** Tuple `(DBSchemaType, str, int)`, containing:
1. The merged database object
2. A status message string. If the merge is successful, it is "DB's merged successfully". If it fails, it contains the error information "All the DB's must have the same keys".
3. A status code (0 indicates success, 1 indicates failure)

**Exception:** No explicit exceptions are thrown. Error information is passed through the return value.

**Example:**
```python
from pysondb.utils import merge_n_db

# First database
db1 = {
    'version': 2,
    'keys': ['name', 'age'],
    'data': {
        '1': {'name': 'Zhang San', 'age': 25},
        '2': {'name': 'Li Si', 'age': 30}
    }
}

# Second database
db2 = {
    'version': 2,
    'keys': ['name', 'age'],
    'data': {
        '3': {'name': 'Wang Wu', 'age': 28},
        '4': {'name': 'Zhao Liu', 'age': 32}
    }
}

# Merge databases
merged_db, message, status = merge_n_db(db1, db2)
if status == 0:
    print("Merge successful!")
    print(merged_db)
    # Output: {
    #     'version': 2,
    #     'keys': ['name', 'age'],
    #     'data': {
    #         '1': {'name': 'Zhang San', 'age': 25},
    #         '2': {'name': 'Li Si', 'age': 30},
    #         '3': {'name': 'Wang Wu', 'age': 28},
    #         '4': {'name': 'Zhao Liu', 'age': 32}
    #     }
    # }
else:
    print(f"Merge failed: {message}")
```

#### 25. purge_db() Function - Empty the Database

**Functionality:** Create an empty database structure, used to empty an existing database or initialize a new database.

**Function Signature:**
```python
def purge_db(_: Any) -> DBSchemaType:
```

**Parameter Description:**
- `_` (Any): An unused parameter, can pass any value

**Return Value:** An empty database object, in the format of `DBSchemaType`

**Exception:** No explicit exceptions are thrown.

**Example:**
```python
from pysondb.utils import purge_db

# Create an empty database
empty_db = purge_db(None)
print(empty_db)
# Output: {
#     'version': 2,
#     'keys': [],
#     'data': {}
# }

# Can be used to reset an existing database
current_db = {
    'version': 2,
    'keys': ['name', 'age'],
    'data': {
        '1': {'name': 'Zhang San', 'age': 25},
        '2': {'name': 'Li Si', 'age': 30}
    }
}

# Empty the database
reset_db = purge_db(current_db)
print(reset_db)
# Output: {
#     'version': 2,
#     'keys': [],
#     'data': {}
# }
```

#### 26. CLI Functionality

**Functionality:** Provide a command-line interface to handle various database operation commands input by the user.

**Function Signature:**
```python
def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
    import ujson as json  # type:ignore  # noqa: F811
except ImportError:
    import json
```

**Parameter Description:**
- `argv` (Optional[Sequence[str]]): A list of command-line parameters. When the default is None, sys.argv is used.

**Return Value:** An integer status code
- 0: Operation successful
- Non-zero: Operation failed, and the specific value depends on the error type

**Exception:** File operation-related exceptions may be thrown, such as FileNotFoundError, PermissionError, etc.

**Supported Commands:**

##### 1.1 --info Command - Display Version Information

Display the PysonDB version and information about the JSON parser used.

**Usage:**
```bash
python -m pysondb --info
```

**Example:**
```python
# Output example
PysonDB - 2.0.0
using 'ujson' JSON parser # If the ujson library is installed
using builtin JSON parser # If the ujson library is not installed
```

##### 1.2 migrate Command - Database Migration

Migrate a v1 version database to the v2 version format.

**Usage:**
```bash
python -m pysondb migrate <Old Database Path> <New Database Path> [--indent Indentation Value]
```

**Parameter Description:**
- `Old Database Path`: The file path of the v1 version database
- `New Database Path`: The save path of the migrated v2 version database
- `--indent`: Optional, set the indentation value of the output JSON, default is 4

**Example:**
```bash
python -m pysondb migrate old_db.json new_db.json --indent 2
```

##### 1.3 show Command - Display Database in Table Format

Display the database content in a table format, providing an intuitive way to view data.

**Usage:**
```bash
python -m pysondb show <Database Path>
```

**Parameter Description:**
- `Database Path`: The file path of the database to be displayed

**Example:**
```bash
python -m pysondb show data.json
```

##### 1.4 merge Command - Merge Databases

Merge multiple database files with the same key structure.

**Usage:**
```bash
python -m pysondb merge <Database 1> <Database 2> ... --output <Output File>
```

**Parameter Description:**
- `Database 1, Database 2, ...`: A list of file paths of the databases to be merged
- `--output, -o`: Required, the file path of the merged output

**Example:**
```bash
python -m pysondb merge db1.json db2.json db3.json --output merged_db.json
'DB's merged successfully'
```

##### 1.5 tocsv Command - Convert to CSV

Convert the database content to a CSV format file.

**Usage:**
```bash
python -m pysondb tocsv <Database File> [--output <Output CSV File>]
```

**Parameter Description:**
- `Database File`: The file path of the database to be converted
- `--output, -o`: Optional, the file path of the output CSV file. If not specified, the database name is used by default.

**Example:**
```bash
python -m pysondb tocsv data.json --output data.csv
```

##### 1.6 purge Command - Empty the Database

Empty all the content of the specified database and create an empty database structure.

**Usage:**
```bash
python -m pysondb purge <Database File>
```

**Parameter Description:**
- `Database File`: The file path of the database to be emptied

**Example:**
```bash
python -m pysondb purge data.json
```

---

### Usage Examples

#### Complete Workflow Example

```bash
# 1. View version information
python -m pysondb --info

# 2. Migrate the old version database
python -m pysondb migrate v1_data.json v2_data.json

# 3. View the migrated database
python -m pysondb show v2_data.json

# 4. Merge multiple databases
python -m pysondb merge v2_data.json additional_data.json --output combined.json

# 5. Convert to CSV format
python -m pysondb tocsv combined.json --output data.csv

# 6. Empty the test database
python -m pysondb purge test_db.json
```

### Database Structure Description

PysonDB-V2 stores data using the following JSON structure: 
**Note**: The fields field does not directly store the id.

```json
{
   "version": 2,
   "keys": ["field1", "field2", "field3"],
   "data": {
       "123456789012345678": {
           "field1": "value1",
           "field2": "value2",
           "field3": "value3"
       }
   }
}
```

### Key Sorting Behavior Description

PysonDB-V2 adopts a unified key sorting strategy in different methods:

#### add Method - Alphabetical Sorting
- **Behavior**: The `add` method sorts all keys alphabetically.
- **Reason**: Ensure the consistency of key order when adding a single record.
- **Example**:
```python
# Add a record, the field order is name -> age
db.add({"name": "test", "age": 3})
# Result: keys = ["age", "name"] (alphabetical sorting)

# Add a record, the field order is age -> name  
db.add({"age": 3, "name": "test"})
# Result: keys = ["age", "name"] (alphabetical sorting)
```

#### add_many Method - Alphabetical Sorting
- **Behavior**: The `add_many` method also sorts all keys alphabetically.
- **Reason**: Ensure the consistency of key order when adding multiple records in batches.
- **Example**:
```python
# Add multiple records in batches, the field order of the first record is name -> age
db.add_many([
    {"name": "test1", "age": 3},
    {"name": "test2", "age": 25}
])
# Result: keys = ["age", "name"] (alphabetical sorting)

# Add multiple records in batches, the field order of the first record is age -> name
db.add_many([
    {"age": 3, "name": "test1"},
    {"age": 25, "name": "test2"}
])
# Result: keys = ["age", "name"] (alphabetical sorting)
```

#### Technical Implementation
- The key sorting logic is directly implemented in the `add` and `add_many` methods.
- Both methods use the `sorted()` function to sort keys alphabetically.
- When the database is empty, a sorted key list is created based on the keys of the first piece of data.

### Data Type Description

#### DBSchemaType
**Functionality:** Define the database structure type.

**Type:**
```python
Dict[str, Union[int, List[str], Dict[str, Any]]]
```

#### SingleDataType
**Functionality:** Define the type of a single piece of data.

**Type:**
```python
SingleDataType = Dict[
    str, Union[
        int,
        str,
        bool,
        List[SimpleTypeGroup]
    ]
]
```

#### QueryType
**Functionality:** Define the type of the query function.

**Type:**
```python
Callable[[Dict[str, Any]], bool]
```

#### ReturnWithIdType
**Functionality:** Define the type of the return data with an ID.

**Type:**
```python
Dict[
    str, Dict[
        str, SimpleTypeGroup
    ]
]
```

#### IdGeneratorType
**Functionality:** Define the type of the ID generator function, which must return an ID of string type.

**Type:**
```python
Callable[[], str]
```

#### SimpleTypeGroup
**Functionality:** Define a group of simple types.

**Type:**
```python
Union[int, str, bool]
```

#### NewKeyValidTypes
**Functionality:** Define the valid types for new keys.

**Type:**
```python
Union[List, Dict, str, int, bool]
```

#### OldDataType
**Functionality:** Define the old data type (for migration).

**Type:**
```python
Dict[str, List[Dict[str, Any]]]
```

#### NewDataType
**Functionality:** Define the new data type (for migration).

**Type:**
```python
Dict[str, Union[int, str, List[str], Dict[str, Any]]]
```

### Error Handling
The system provides a comprehensive error handling mechanism, providing the following error types to handle specific error situations:

#### IdDoesNotExistError
**Functionality:** Thrown when the specified ID does not exist.

**Usage Scenarios:** get_by_id, update_by_id, delete_by_id

**Example:**
```python
from pysondb.errors import IdDoesNotExistError

try:
    user = db.get_by_id('non_existent_id')
except IdDoesNotExistError as e:
    print(f"ID does not exist: {e}")
```

#### UnknownKeyError
**Functionality:** Thrown when the data contains unknown fields or is missing required fields in the database.

**Usage Scenarios:** add, add_many, update_by_id, update_by_query, get_all_select_keys

**Example:**
```python
from pysondb.errors import UnknownKeyError

# When there are unknown fields
try:
    db.add({'name': 'test', 'unknown_field': 'value'})
except UnknownKeyError as e:
    print(f"Field error: {e}")  # Unrecognized key(s) {'unknown_field'}

# When a required field is missing (assuming the database already has name and age fields)
try:
    db.add({'name': 'test'})  # Missing the age field
except UnknownKeyError as e:
    print(f"Field error: {e}")  # Unrecognized / missing key(s) {'age'}
```

#### SchemaTypeError
**Functionality:** Thrown when the database structure does not meet the expectations.

**Usage Scenarios:** Database structure verification, including:
- The database is not a valid dictionary structure.
- The `keys` field is not a list type.
- The `data` field is not a dictionary type.
- The database is missing required top-level fields.

**Example:**
```python
from pysondb.errors import SchemaTypeError

# When the database structure is corrupted
try:
    # The keys field is not a list
    db = PysonDB('corrupted.json')  # keys: "invalid" instead of a list
except SchemaTypeError as e:
    print(f"Database structure error: {e}")  # Database 'keys' must be a list

# When the database is missing required fields
try:
    db = PysonDB('incomplete.json')  # Missing the version/keys/data fields
except SchemaTypeError as e:
    print(f"Database structure error: {e}")  # Database missing required keys: {'version', 'keys', 'data'}
```

#### TypeError
**Functionality:** Thrown when the parameter type is incorrect.

**Usage Scenarios:** Parameter type verification for all methods.

**Example:**
```python
try:
    db.add([1, 2, 3])  # Passing a list instead of a dictionary
except TypeError as e:
    print(f"Type error: {e}")
```


