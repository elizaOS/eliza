## Schema Project Introduction and Goals

Schema is a lightweight library **for Python data structure validation**. It can parse and validate various data formats (supporting Python native data structures such as dictionaries, lists, tuples, and sets) and ensure that the data conforms to a predefined schema. This tool performs excellently in scenarios such as data validation and API interface validation, achieving "the highest validation accuracy and the best error reporting." Its core functions include: parsing data structures (automatically identifying and validating complex nested structures like dictionaries, lists, and tuples), **type and value validation** (supporting type checking, regular expression matching, and custom validation functions), and intelligent handling of special requirements such as optional fields, forbidden fields, and default values. In short, Schema aims to provide a robust Python data structure validation system to ensure the correctness and consistency of data formats (for example, defining a validation schema through Schema() and determining whether the data meets the requirements through the validate() function).

## Natural Language Instruction (Prompt)

Please create a Python project named Schema to implement a data structure validation library. The project should include the following functions:

1. Data structure validator: It can validate the format and content of the input Python data structure, supporting complex nested structures such as dictionaries, lists, tuples, and sets. The validation result should be a boolean value or a converted data object, supporting type checking and value validation.

2. Schema matching system: Implement functions (or classes) to compare whether the data structure conforms to a predefined schema, including type matching, value range checking, regular expression validation, etc. It should support logical combinations of And and Or, as well as custom validation functions.

3. Special validation handling: Specifically handle optional fields, forbidden fields, default values, constant values, etc. For example, Optional("field") represents an optional field, Forbidden("field") represents a forbidden field, and Use(int) represents type conversion.

4. Interface design: Design independent class interfaces for each functional module (such as the Schema class, And class, Or class, Regex class, Use class, etc.), supporting chained calls and error handling. Each module should define clear input and output formats.

5. Examples and validation scripts: Provide example code and validation cases to demonstrate how to use the Schema() and validate() functions for data structure validation (for example, Schema({"name": str, "age": And(int, lambda n: 0 <= n <= 150)}).validate({"name": "John", "age": 30}) should return the validated data). The above functions need to be combined to build a complete data validation toolkit. The project should ultimately include modules such as validators, comparators, and overall validation, along with typical validation cases, to form a reproducible validation process.

6. Core file requirements: The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including libraries such as contextlib2>=0.5.5, pytest>=8.0.0, pytest-cov>=4.0.0, coverage>=7.0.0, mock>=5.0.0, pre-commit>=3.0.0). The pyproject.toml can verify whether all functional modules work properly. At the same time, it is necessary to provide schema/__init__.py as a unified API entry, importing core classes such as Schema, And, Or, Regex, Use, Optional, Forbidden, Const, Literal, SchemaError, SchemaWrongKeyError, SchemaMissingKeyError, SchemaForbiddenKeyError, SchemaUnexpectedTypeError, SchemaOnlyOneAllowedError from each validation module, and providing version information, allowing users to access all major functions through a simple "from schema import *" statement. In __init__.py, there needs to be a Schema class as the main validation entry, using various strategies to validate whether the Python data structure conforms to a predefined schema.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
cfgv              3.4.0
contextlib2       21.6.0
coverage          7.10.3
distlib           0.4.0
exceptiongroup    1.3.0
filelock          3.18.0
identify          2.6.13
iniconfig         2.1.0
mock              5.2.0
nodeenv           1.9.1
packaging         25.0
pip               23.0.1
platformdirs      4.3.8
pluggy            1.6.0
pre_commit        4.3.0
Pygments          2.19.2
pytest            8.4.1
pytest-cov        6.2.1
PyYAML            6.0.2
ruff              0.12.8
setuptools        65.5.1
tomli             2.2.1
typing_extensions 4.14.1
virtualenv        20.33.1
wheel             0.40.0
```

## Schema Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .editorconfig
├── .gitchangelog.rc
├── .gitignore
├── .pre-commit-config.yaml
├── .travis.yml
├── CHANGELOG.md
├── LICENSE-MIT
├── MANIFEST.in
├── README.rst
├── pyproject.toml
├── schema
│   ├── __init__.py
│   ├── py.typed
└── tox.ini


```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from schema import (
    Schema, And, Or, Regex, Use, Optional, Forbidden, Const, Literal,
    SchemaError, SchemaWrongKeyError, SchemaMissingKeyError, 
    SchemaForbiddenKeyError, SchemaUnexpectedTypeError, SchemaOnlyOneAllowedError
)
```

#### 2. Module Constants

**__version__**: Current version of the schema library
```python
from schema import __version__
print(__version__)  # Returns "0.7.7"
```

**__all__**: List of all public APIs exported by the module
```python
from schema import __all__
print(__all__)  # Returns list of exported classes and functions
```

#### 3. Schema() Class - Data Structure Validator

**Function**: Define a data structure validation schema and validate whether a Python data structure conforms to a predefined schema.

**Import**:
```python
from schema import (
    Schema, And, Or, Regex, Use, Optional, Forbidden, Const, Literal,
    SchemaError, SchemaWrongKeyError, SchemaMissingKeyError, 
    SchemaForbiddenKeyError, SchemaUnexpectedTypeError, SchemaOnlyOneAllowedError
)
```

**Class Signature**:
```python
class Schema:
    def __init__(
        self,
        schema: Any,
        error: Union[str, None] = None,
        ignore_extra_keys: bool = False,
        name: Union[str, None] = None,
        description: Union[str, None] = None,
        as_reference: bool = False,
    ) -> None:
```

**Parameter Description**:
- `schema (Any)`: Definition of the validation schema, which can be a type, value, dictionary, list, etc.
- `error (str, None)`: Custom error message
- `ignore_extra_keys (bool)`: Whether to ignore extra keys in the dictionary, default is False
- `name (str, None)`: Schema name for error reporting
- `description (str, None)`: Schema description
- `as_reference (bool)`: Whether to use it as a JSON Schema reference, default is False

**Properties**:
- `schema`: Return the internal schema object
- `description`: Return the schema description
- `name`: Return the schema name  
- `ignore_extra_keys`: Return ignore_extra_keys setting

**Main Methods**:
- `validate(data: Any, **kwargs: Dict[str, Any]) -> Any`: Validate the data and return the validated data
- `is_valid(data: Any, **kwargs: Dict[str, Any]) -> bool`: Check whether the data is valid and return a boolean value
- `json_schema(schema_id: str, use_refs: bool = False, **kwargs: Any) -> Dict[str, Any]`: Generate a JSON Schema

**Static Methods**:
- `_dict_key_priority(s)`: Return priority for a given key object in dictionary validation
- `_is_optional_type(s)`: Return True if the given key is optional (Optional or Hook type)

**Private Methods**:
- `_prepend_schema_name(message)`: Prepend schema name to error message if name is defined

#### 4. And() Class - Logical AND Validation

**Function**: Combine multiple validation conditions, and all conditions must be met.

**Import**:
```python
from schema import Schema, And, Or, Use
```

**Class Signature**:
```python
class And(Generic[TSchema]):
    def __init__(
        self,
        *args: Union[TSchema, Callable[..., Any]],
        error: Union[str, None] = None,
        ignore_extra_keys: bool = False,
        schema: Union[Type[TSchema], None] = None,
    ) -> None:
```

**Parameter Description**:
- `*args`: Multiple validation conditions, which can be types, values, functions, etc.
- `error (str, None)`: Custom error message
- `ignore_extra_keys (bool)`: Whether to ignore extra keys
- `schema (Type[TSchema], None)`: Schema type

**Properties**:
- `args`: Returns the tuple of provided validation arguments

**Methods**:
- `validate(data, **kwargs)`: Validate data ensuring all conditions are met
- `_build_schemas()`: Build list of Schema objects from arguments
- `_build_schema(arg)`: Convert a single argument to Schema object

#### 5. Or() Class - Logical OR Validation

**Function**: Combine multiple validation conditions, and any one of the conditions can be met.

**Import**:
```python
from schema import Schema, And, Or, Use, Optional
```

**Class Signature**:
```python
class Or(And[TSchema]):
    def __init__(
        self,
        *args: Union[TSchema, Callable[..., Any]],
        only_one: bool = False,
        **kwargs: Any,
    ) -> None:
```

**Parameter Description**:
- `*args`: Multiple validation conditions
- `only_one (bool)`: Whether to allow only one condition to match, default is False
- `**kwargs`: Other parameters

**Properties**:
- `only_one`: Boolean flag indicating exclusive matching
- `match_count`: Number of successful matches during validation

**Methods**:
- `validate(data, **kwargs)`: Validate data ensuring at least one condition is met
- `reset()`: Reset match count and raise error if multiple matches occurred in only_one mode

#### 6. Regex() Class - Regular Expression Validation

**Function**: Use regular expressions to validate strings.

**Import**:
```python
from schema import Schema, And, Regex, Use
```

**Class Signature**:
```python
class Regex:
    def __init__(
        self, 
        pattern_str: str, 
        flags: int = 0, 
        error: Union[str, None] = None
    ) -> None:
```

**Parameter Description**:
- `pattern_str (str)`: Regular expression pattern
- `flags (int)`: Regular expression flags
- `error (str, None)`: Custom error message

#### 7. Use() Class - Type Conversion Validation

**Function**: Convert the data type during the validation process.

**Import**:
```python
from schema import Schema, And, Use, Optional
```

**Class Signature**:
```python
class Use:
    def __init__(
        self, 
        callable_: Callable[[Any], Any], 
        error: Union[str, None] = None
    ) -> None:
```

**Parameter Description**:
- `callable_ (Callable)`: Conversion function
- `error (str, None)`: Custom error message

#### 8. Optional() Class - Optional Field Validation

**Function**: Mark optional fields in a dictionary.

**Import**:
```python
from schema import Schema, And, Use, Optional, Forbidden
```

**Class Signature**:
```python
class Optional(Schema):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
```

**Parameter Description**:
- `*args`: Field names and validation conditions
- `**kwargs`: Other parameters, including default, etc.

**Properties**:
- `default`: Default value for optional field (if specified)
- `key`: String representation of schema when default is provided

**Methods**:
- `__hash__()`: Return hash value based on schema
- `__eq__(other)`: Compare equality with another Optional instance
- `reset()`: Reset nested schema if it has a reset method

#### 9. Forbidden() Class - Forbidden Field Validation

**Function**: Mark fields that are not allowed to appear in a dictionary.

**Import**:
```python
from schema import Schema, Optional, Forbidden, Hook
```

**Base Class**: Hook - Schema hook for field validation

**Class Signature**:
```python
class Hook(Schema):
    def __init__(self, *args: Any, **kwargs: Any) -> None:

class Forbidden(Hook):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
```

**Hook Properties**:
- `handler`: Callable function for handling hook validation
- `key`: Schema key reference

**Forbidden Methods**:
- `_default_function(nkey, data, error)`: Static method that raises SchemaForbiddenKeyError when forbidden key is encountered

#### 10. Const() Class - Constant Value Validation

**Function**: Validate whether the data is equal to a specified constant.

**Import**:
```python
from schema import Schema, And, Or, Const, Literal
```

**Class Signature**:
```python
class Const(Schema):
    def validate(self, data: Any, **kwargs: Any) -> Any:
```

#### 11. Literal() Class - Literal Validation

**Function**: Validate whether the data is equal to a specified literal value.

**Import**:
```python
from schema import Schema, Optional, Literal, Const
```

**Class Signature**:
```python
class Literal:
    def __init__(
        self,
        value: Any,
        description: Union[str, None] = None,
        title: Union[str, None] = None,
    ) -> None:
```

**Properties**:
- `description`: Optional description text for the literal
- `title`: Optional title for the literal
- `schema`: The underlying value of the literal

**Methods**:
- `__str__()`: Return string representation of the schema value
- `__repr__()`: Return detailed representation including description

### Utility Functions

#### 12. `_priority()` Function - Schema Priority Calculation

**Function**: Calculate the priority of a schema object for validation ordering.

**Note**: This is an internal function used by the Schema library and should not be imported directly by external code.

**Imports**:
```python
from typing import Any
```

**Function Signature**:
```python
def _priority(s: Any) -> int
```

**Parameters**:
- `s (Any)`: Schema object to evaluate

**Returns**: Integer priority value (0-5) representing the validation priority

#### 13. `_invoke_with_optional_kwargs()` Function - Flexible Function Invocation

**Function**: Invoke a function with optional keyword arguments based on its signature.

**Note**: This is an internal function used by the Schema library and should not be imported directly by external code.

**Imports**:
```python
from typing import Callable, Any
```

**Function Signature**:
```python
def _invoke_with_optional_kwargs(f: Callable[..., Any], **kwargs: Any) -> Any
```

**Parameters**:
- `f (Callable)`: Function to invoke
- `**kwargs`: Optional keyword arguments

**Returns**: Result of function invocation

#### 14. `_callable_str()` Function - Callable String Representation

**Function**: Get a string representation of a callable object.

**Note**: This is an internal function used by the Schema library and should not be imported directly by external code.

**Imports**:
```python
from typing import Callable, Any
```

**Function Signature**:
```python
def _callable_str(callable_: Callable[..., Any]) -> str
```

**Parameters**:
- `callable_ (Callable)`: Callable object to convert to string

**Returns**: String representation of the callable

#### 15. `_plural_s()` Function - Pluralization Helper

**Function**: Return 's' for plural forms based on collection size.

**Note**: This is an internal function used by the Schema library and should not be imported directly by external code.

**Imports**:
```python
from typing import Sized
```

**Function Signature**:
```python
def _plural_s(sized: Sized) -> str
```

**Parameters**:
- `sized (Sized)`: Any sized object

**Returns**: Empty string if size is 1, otherwise 's'



### Detailed Description of Exception Classes

#### 1. SchemaError - Basic Validation Exception

**Function**: The base class for all Schema validation exceptions

**Import**:
```python

# Or with specific exception types
from schema import (
    Schema, SchemaError, SchemaWrongKeyError, SchemaMissingKeyError,
    SchemaForbiddenKeyError, SchemaUnexpectedTypeError, SchemaOnlyOneAllowedError
)


**Constructor**:
```python
def __init__(
    self,
    autos: Union[Sequence[Union[str, None]], None],
    errors: Union[List, str, None] = None,
) -> None
```

**Parameters**:
- `autos`: Automatically generated error messages or None
- `errors`: Custom error messages, can be a list or string

**Properties**:
- `autos`: List of automatically generated error messages
- `errors`: List of custom error messages
- `code`: Combined error message property that removes duplicates and merges error lists

**Methods**:
- `code.uniq(seq)`: Utility function within code property to remove duplicates while preserving order

#### 2. SchemaWrongKeyError - Wrong Key Exception

**Function**: Thrown when an unexpected key is detected

**Import**:
```python
# Common dictionary validation with exception handling
from schema import Schema, SchemaError, SchemaWrongKeyError
```

#### 3. SchemaMissingKeyError - Missing Key Exception

**Function**: Thrown when a required key is not found

**Import**:
```python
from schema import Schema, SchemaError, SchemaMissingKeyError
```

#### 4. SchemaForbiddenKeyError - Forbidden Key Exception

**Function**: Thrown when a forbidden key is found

**Import**:
```python
from schema import Schema, Forbidden, SchemaForbiddenKeyError
```

#### 5. SchemaUnexpectedTypeError - Type Error Exception

**Function**: Thrown when the data type does not match

**Import**:
```python
from schema import Schema, SchemaError, SchemaUnexpectedTypeError
```

#### 6. SchemaOnlyOneAllowedError - Only One Allowed Exception

**Function**: Thrown when there are multiple matches in the only_one mode

**Import**:
```python
from schema import Schema, Or, SchemaOnlyOneAllowedError
```

### Actual Usage Patterns

#### Basic Usage

```python
from schema import Schema, And, Or, Regex, Use, Optional, Forbidden

# Simple type validation
schema = Schema(int)
result = schema.validate(123)  # Returns 123
is_valid = schema.is_valid(123)  # Returns True

# Dictionary validation
user_schema = Schema({
    "name": str,
    "age": And(int, lambda n: 0 <= n <= 150),
    Optional("email"): Regex(r"^[^@]+@[^@]+\.[^@]+$"),
    Forbidden("password"): str
})

user_data = {
    "name": "John",
    "age": 30,
    "email": "john@example.com"
}

validated_data = user_schema.validate(user_data)
```

#### Configurable Usage

```python
from schema import Schema, And, Or, Use, Optional

# Complex validation schema
complex_schema = Schema({
    "id": And(int, lambda x: x > 0),
    "name": And(str, lambda s: len(s) > 0),
    "scores": [And(int, lambda x: 0 <= x <= 100)],
    "status": Or("active", "inactive", "pending"),
    Optional("metadata", default={}): dict,
    Optional("tags", default=[]): [str]
})

# Use configuration for validation
data = {
    "id": 1,
    "name": "Test User",
    "scores": [85, 92, 78],
    "status": "active",
    "tags": ["important", "urgent"]
}

result = complex_schema.validate(data)
```

#### Type Conversion Usage

```python
from schema import Schema, Use

# Automatic type conversion
schema = Schema({
    "age": Use(int),  # Automatically convert string to integer
    "height": Use(float),  # Automatically convert string to float
    "active": Use(bool)  # Automatically convert string to boolean
})

data = {
    "age": "25",
    "height": "175.5",
    "active": "true"
}

result = schema.validate(data)
# Result: {"age": 25, "height": 175.5, "active": True}
```

#### Custom Validation Function

```python
from schema import Schema, And, Use

def validate_email(email):
    if "@" not in email or "." not in email:
        raise ValueError("Invalid email format")
    return email.lower()

def validate_age(age):
    if not isinstance(age, int) or age < 0 or age > 150:
        raise ValueError("Age must be between 0 and 150")
    return age

# Use a custom validation function
schema = Schema({
    "email": Use(validate_email),
    "age": Use(validate_age),
    "name": And(str, lambda s: len(s.strip()) > 0)
})

data = {
    "email": "USER@EXAMPLE.COM",
    "age": 25,
    "name": "John Doe"
}

result = schema.validate(data)
```

#### JSON Schema Generation

```python
from schema import Schema, Optional

# Define a schema
schema = Schema({
    "name": str,
    "age": int,
    Optional("email"): str
})

# Generate a JSON Schema
json_schema = schema.json_schema("https://example.com/user-schema.json")
print(json_schema)
```

### Supported Expression Types

- **Numeric Types**: Integers, floating-point numbers, complex numbers
- **String Types**: Ordinary strings, byte strings, regular expressions
- **Container Types**: Lists, tuples, dictionaries, sets, frozen sets
- **Boolean Types**: True, False
- **Null Value Type**: None
- **Custom Types**: Any callable validation function

### Error Handling

The system provides a complete error handling mechanism:
- **Exception Catching**: Catch and handle various validation exceptions
- **Error Messages**: Provide detailed custom error messages
- **Error Aggregation**: Collect all validation errors instead of stopping at the first error
- **Error Context**: Provide context information about where the error occurred

### Important Notes

1. **Function Asymmetry**: The parameter order of the validate() function is important. The first parameter is the validation schema, and the second parameter is the data to be validated.
2. **Thread Safety**: The Schema library supports a multi-threaded environment, but it is recommended to avoid sharing Schema instances in multi-threaded scenarios.
3. **Configuration Priority**: Different validation conditions have different priorities. Hook > ordinary keys > Optional.
4. **Strict Mode**: By default, strict type checking is performed. More flexible validation can be achieved through custom validation functions.


## Detailed Implementation Nodes of Functions

### Node 1: SchemaError Class

**Function Description**: Error during Schema validation.

**Core Algorithm**:
- Initialization with autos and errors parameters
- Automatic list conversion for single values
- Duplicate removal in error messages via uniq utility function
- Combined message generation through code property

**Input/Output Example**:

```python
class SchemaError(Exception):
    """Error during Schema validation."""

    def __init__(
        self,
        autos: Union[Sequence[Union[str, None]], None],
        errors: Union[List, str, None] = None,
    ):
        self.autos = autos if isinstance(autos, List) else [autos]
        self.errors = errors if isinstance(errors, List) else [errors]
        Exception.__init__(self, self.code)
```

### Node 2: And Class

**Function Description**: Utility function to combine validation directives in AND Boolean fashion.

**Core Algorithm**:
- Stores validation arguments in tuple
- Schema building for each argument via _build_schemas method
- Sequential validation of all sub-schemas
- Error message propagation through SchemaError handling

**Input/Output Example**:

```python
class And(Generic[TSchema]):
    """
    Utility function to combine validation directives in AND Boolean fashion.
    """

    def validate(self, data: Any, **kwargs: Any) -> Any:
        """
        Validate data using defined sub schema/expressions ensuring all
        values are valid.
        :param data: Data to be validated with sub defined schemas.
        :return: Returns validated data.
        """
        for sub_schema in self._build_schemas():
            data = sub_schema.validate(data, **kwargs)
        return data
```

### Node 3: Or Class

**Function Description**: Utility function to combine validation directives in a OR Boolean fashion.

**Core Algorithm**:
- Inherits from And class with only_one flag support
- Match counting for XOR-style validation
- Reset mechanism for reusable validation
- First-match validation with comprehensive error collection

**Input/Output Example**:

```python
class Or(And[TSchema]):
    """Utility function to combine validation directives in a OR Boolean
    fashion.

    If one wants to make an xor, one can provide only_one=True optional argument
    to the constructor of this object."""

    def validate(self, data: Any, **kwargs: Any) -> Any:
        """
        Validate data using sub defined schema/expressions ensuring at least
        one value is valid.
        :param data: data to be validated by provided schema.
        :return: return validated data if not validation
        """
        autos: List[str] = []
        errors: List[Union[str, None]] = []
        for sub_schema in self._build_schemas():
            try:
                validation: Any = sub_schema.validate(data, **kwargs)
                self.match_count += 1
                if self.match_count > 1 and self.only_one:
                    break
                return validation
            except SchemaError as _x:
                autos += _x.autos
                errors += _x.errors
```

### Node 4: Regex Class

**Function Description**: Enables schema.py to validate string using regular expressions.

**Core Algorithm**:
- Regular expression pattern compilation with flags
- Pattern string search validation
- Type error handling for non-string inputs
- Custom error message formatting

**Input/Output Example**:

```python
class Regex:
    """
    Enables schema.py to validate string using regular expressions.
    """

    def validate(self, data: str, **kwargs: Any) -> str:
        """
        Validates data using the defined regex.
        :param data: Data to be validated.
        :return: Returns validated data.
        """
        try:
            if self._pattern.search(data):
                return data
            else:
                error_message = (
                    e.format(data)
                    if e
                    else f"{data!r} does not match {self._pattern_str!r}"
                )
                raise SchemaError(error_message)
        except TypeError:
            error_message = (
                e.format(data) if e else f"{data!r} is not string nor buffer"
            )
            raise SchemaError(error_message)
```

### Node 5: Use Class

**Function Description**: For more general use cases, you can use the Use class to transform the data while it is being validated.

**Core Algorithm**:
- Callable validation and storage
- Callable delegation through __call__ method
- SchemaError propagation with error message formatting
- Exception handling for general callable errors

**Input/Output Example**:

```python
class Use:
    """
    For more general use cases, you can use the Use class to transform
    the data while it is being validated.
    """

    def validate(self, data: Any, **kwargs: Any) -> Any:
        try:
            return self._callable(data)
        except SchemaError as x:
            raise SchemaError(
                [None] + x.autos,
                [self._error.format(data) if e else None] + x.errors,
            )
        except BaseException as x:
            f = _callable_str(self._callable)
            raise SchemaError(
                "%s(%r) raised %r" % (f, data, x),
                self._error.format(data) if e else None,
            )
```

### Node 6: Schema.validate Method

**Function Description**: Main validation method that processes data according to schema flavor and type.

**Core Algorithm**:
- Priority-based flavor detection via _priority function
- Type-specific validation for ITERABLE, DICT, TYPE, VALIDATOR, CALLABLE, and COMPARABLE
- Dictionary key validation with coverage tracking
- Optional key handling with default values
- Error message customization with schema name prepending

**Input/Output Example**:

```python
def validate(self, data: Any, **kwargs: Dict[str, Any]) -> Any:
    Schema = self.__class__
    s: Any = self._schema
    e: Union[str, None] = self._error
    i: bool = self._ignore_extra_keys

    if isinstance(s, Literal):
        s = s.schema

    flavor = _priority(s)
    if flavor == ITERABLE:
        data = Schema(type(s), error=e).validate(data, **kwargs)
        o: Or = Or(*s, error=e, schema=Schema, ignore_extra_keys=i)
        return type(data)(o.validate(d, **kwargs) for d in data)
```

### Node 7: Schema.json_schema Method

**Function Description**: Generate a draft-07 JSON schema dict representing the Schema.

**Core Algorithm**:
- Recursive schema traversal with reference tracking
- Type mapping from Python to JSON schema types
- Schema composition for And/Or validators
- Pattern translation for Regex validators
- Definition collection for reusable schemas

**Input/Output Example**:

```python
def json_schema(
    self, schema_id: str, use_refs: bool = False, **kwargs: Any
) -> Dict[str, Any]:
    """Generate a draft-07 JSON schema dict representing the Schema.
    This method must be called with a schema_id.

    :param schema_id: The value of the $id on the main schema
    :param use_refs: Enable reusing object references in the resulting JSON schema.
    """
```

### Node 8: Optional Class

**Function Description**: Marker for an optional part of the validation Schema.

**Core Algorithm**:
- Default value storage and validation
- Hash and equality implementation for dictionary key usage
- Simple value requirement for default-enabled optionals
- Reset method delegation to underlying schema

**Input/Output Example**:

```python
class Optional(Schema):
    """Marker for an optional part of the validation Schema."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        default: Any = kwargs.pop("default", self._MARKER)
        super(Optional, self).__init__(*args, **kwargs)
        if default is not self._MARKER:
            if _priority(self._schema) != COMPARABLE:
                raise TypeError(
                    "Optional keys with defaults must have simple, "
                    "predictable values, like literal strings or ints."
                )
            self.default = default
            self.key = str(self._schema)
```

### Node 9: Forbidden Class

**Function Description**: Hook-based validator that raises SchemaForbiddenKeyError when forbidden keys are encountered.

**Core Algorithm**:
- Inherits from Hook class with default handler setup
- Automatic SchemaForbiddenKeyError raising on key match
- Integration with dictionary validation flow
- Error message formatting with key and data context

**Input/Output Example**:

```python
class Forbidden(Hook):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["handler"] = self._default_function
        super(Forbidden, self).__init__(*args, **kwargs)

    @staticmethod
    def _default_function(nkey: Any, data: Any, error: Any) -> NoReturn:
        raise SchemaForbiddenKeyError(
            f"Forbidden key encountered: {nkey!r} in {data!r}", error
        )
```

### Node 10: _priority Function

**Function Description**: Return priority for a given object to determine validation flavor.

**Core Algorithm**:
- Type-based priority assignment for different schema flavors
- Validator detection via validate method presence
- Callable detection through callable() function
- Default COMPARABLE priority for literal values

**Input/Output Example**:

```python
def _priority(s: Any) -> int:
    """Return priority for a given object."""
    if type(s) in (list, tuple, set, frozenset):
        return ITERABLE
    if isinstance(s, dict):
        return DICT
    if issubclass(type(s), type):
        return TYPE
    if isinstance(s, Literal):
        return COMPARABLE
    if hasattr(s, "validate"):
        return VALIDATOR
    if callable(s):
        return CALLABLE
    else:
        return COMPARABLE
```
