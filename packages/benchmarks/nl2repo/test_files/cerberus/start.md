## Project Introduction and Goals

**Cerberus** is a lightweight and extensible Python data validation library specifically designed to validate Python dictionary data structures. The project aims to provide a simple, efficient, and extensible data validation solution with the following capabilities: 1. **Lightweight Validation**: Implement dependency-free core data validation functions, including type checking, pattern validation, and other basic features. 2. **Extensibility**: Designed with a non-blocking and easily extensible architecture, allowing developers to add custom validation rules and type definitions. 3. **Compatibility**: Support all Python 3.7+ versions, including CPython and PyPy implementations. 4. **Production-Quality**: Ensure code quality and stability through a comprehensive test suite, supporting semantic versioning. 5. **Simplified Development**: Provide a concise API interface to make data validation simple and user-friendly


## Natural Language Instructions (Prompt)

Create a Python project named Cerberus that implements a lightweight and extensible data validation library. The project should include the following features:

1. Core Validators: Implement Validator and BareValidator classes to provide document validation and normalization functions, supporting multiple validation rules (required, nullable, type, min, max, regex, etc.), including all _validate_* methods for processing validation rules, _normalize_* methods for data normalization, and core methods like validate(), validated(), normalized(), etc.

2. Schema Definition System: Implement DefinitionSchema, SchemaError, UnvalidatedSchema and other classes to handle schema definition and parsing, supporting complex validation schema definitions including nested structures, logical operators (anyof, allof, oneof, noneof), and schema references.

3. Error Handling Mechanism: Implement ValidationError, ErrorList, DocumentErrorTree, SchemaErrorTree and other classes to provide an error handling system, supporting error collection, error tree structures, and multiple error formatting methods including BasicErrorHandler and custom error handlers.

4. Utility Functions and Extensibility: Implement TypeDefinition, validator_factory, compare_paths_lt and other utility functions, supporting custom validation rules and type definitions, providing schema registry and ruleset registry functionality, and supporting dynamic creation of validator classes.

5. Platform Compatibility: Implement importlib_metadata to handle version detection and platform compatibility, supporting all Python 3.7+ versions including CPython and PyPy implementations, and handling import differences across Python versions.

6. Core File Requirements: The project must include a comprehensive pyproject.toml file that not only configures the project as an installable package (supporting pip install) but also declares a complete dependency list (including pytest and other testing frameworks). The pyproject.toml should be able to verify that all functional modules work properly. Additionally, provide cerberus/__init__.py as a unified API entry point, importing core components such as Validator, DocumentError, SchemaError, errors, schema_registry, rules_set_registry, TypeDefinition from validator, schema, errors, utils, and platform modules, and providing version information. This allows users to access all main functions through simple statements like "from cerberus import Validator, errors". In validator.py, there should be BareValidator and Validator classes implementing core validation functionality, including all _validate_* methods for processing validation rules, _normalize_* methods for data normalization, and core methods like validate(), validated(), normalized(), etc. In schema.py, there should be DefinitionSchema, SchemaError, UnvalidatedSchema and other classes for handling schema definition and parsing. In errors.py, there should be ValidationError, ErrorList, DocumentErrorTree, SchemaErrorTree and other classes providing the error handling system. In utils.py, there should be TypeDefinition, validator_factory, compare_paths_lt and other utility functions. In platform.py, there should be importlib_metadata for handling version detection and platform compatibility. Create test files such as test_validation.py, test_schema.py, test_normalization.py, test_errors.py, test_customization.py, test_registries.py, test_utils.py, test_assorted.py, etc. Each test file should contain appropriate import statements to ensure correct import and testing of all core functional modules.

To satisfy the repo structure, the content of file "__init__.py" in folder "benchmarks" should be 
```python
from pathlib import Path


DOCUMENTS_PATH = Path(__file__).parent / "documents"
```

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
alabaster                     0.7.13
Babel                         2.14.0
beautifulsoup4                4.13.4
black                         23.3.0
cachetools                    5.5.2
certifi                       2025.7.14
cfgv                          3.3.1
chardet                       5.2.0
charset-normalizer            3.4.2
click                         8.1.8
colorama                      0.4.6
distlib                       0.4.0
docutils                      0.19
exceptiongroup                1.3.0
filelock                      3.12.2
flake8                        5.0.4
furo                          2023.3.27
identify                      2.5.24
idna                          3.10
imagesize                     1.4.1
importlib-metadata            6.7.0
iniconfig                     2.0.0
jinja2                        3.1.6
MarkupSafe                    2.1.5
mccabe                        0.7.0
mypy-extensions               1.0.0
nodeenv                       1.9.1
packaging                     24.0
pathspec                      0.11.2
pip                           21.0.1
platformdirs                  4.0.0
pluggy                        1.2.0
pre-commit                    2.21.0
py-cpuinfo                    9.0.0
pycodestyle                   2.9.1
pyflakes                      2.5.0
pygments                      2.17.2
pyproject-api                 1.5.3
pytest                        7.4.4
pytest-benchmark              4.0.0
pytz                          2025.2
PyYAML                        6.0.1
requests                      2.31.0
setuptools                    53.0.0
snowballstemmer               3.0.1
soupsieve                     2.4.1
sphinx                        5.3.0
sphinx-basic-ng               1.0.0b2
sphinxcontrib-applehelp       1.0.2
sphinxcontrib-devhelp         1.0.2
sphinxcontrib-htmlhelp        2.0.0
sphinxcontrib-jsmath          1.0.1
sphinxcontrib-qthelp          1.0.3
sphinxcontrib-serializinghtml 1.1.5
tomli                         2.0.1
tox                           4.8.0
typed-ast                     1.5.5
typing-extensions             4.7.1
urllib3                       2.0.7
virtualenv                    20.26.6
wheel                         0.36.2
zipp                          3.15.0
```

## Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .linting-config.yaml
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── AUTHORS
├── CHANGES.rst
├── LICENSE
├── MANIFEST.in
├── README.rst
├── UPGRADING.rst
├── artwork
│   ├── cerberus.png
├── cerberus
│   ├── __init__.py
│   ├── benchmarks
│   │   ├── __init__.py
│   │   ├── documents
│   │   │   ├── overall_documents_1.json
│   │   │   ├── overall_documents_2.json
│   │   ├── schemas
│   │   │   ├── overalll_schema_2.py
│   ├── errors.py
│   ├── platform.py
│   ├── schema.py
│   ├── utils.py
│   ├── validator.py
├── pyproject.toml
└── tox.ini

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from cerberus import (
    Validator, DocumentError, SchemaError, 
    schema_registry, rules_set_registry, TypeDefinition
)

from cerberus.errors import ValidationError
```

#### 2. Validator Class - Core Validator

**Function**: Validates and normalizes Python dictionary data structures. This class should be callable.

**Class Definition**:
```python
Validator = InspectedValidator('Validator', (BareValidator,), {})
```

#### 3. _SchemaRuleTypeError Class

**Function**: Raises an exception if the schema is not a dictionary.

**Class Definition**:
```python
class _SchemaRuleTypeError(Exception):
    """
    Raised when a schema (list) validation encounters a mapping.
    Not supposed to be used outside this module.
    """
    pass
```

#### 4. readonly_classproperty Class

**Function**: A class property that is readonly.
**Class Definition**:
```python

class readonly_classproperty(property):
    def __get__(self, instance, owner):
        return super(readonly_classproperty, self).__get__(owner)

    def __set__(self, instance, value):
        raise RuntimeError('This is a readonly class property.')

    def __delete__(self, instance):
        raise RuntimeError('This is a readonly class property.')
```

#### 5. ErrorTreeNode Class

**Function**: A tree node that contains errors and descendants.
**Class Definition**:
```python
class ErrorTreeNode(MutableMapping):
    __slots__ = ('descendants', 'errors', 'parent_node', 'path', 'tree_root')

    def __init__(self, path, parent_node):
        self.parent_node = parent_node
        self.tree_root = self.parent_node.tree_root
        self.path = path[: self.parent_node.depth + 1]
        self.errors = ErrorList()
        self.descendants = {}

    def __contains__(self, item):
        """
        Check if the item is in the errors or descendants.
        Args:
            item: The item to check.
        Returns:
            True if the item is in the errors or descendants, False otherwise.
        """

    def __delitem__(self, key):
        del self.descendants[key]

    def __iter__(self):
        return iter(self.errors)

    def __getitem__(self, item):
        """
        Get the item from the errors or descendants.
        Args:
            item: The item to get.
        Returns:
            The item from the errors or descendants.
        """

    def __len__(self):
        """
        Get the length of the errors.
        Returns:
            The length of the errors.
        """

    def __repr__(self):
        return self.__str__()

    def __setitem__(self, key, value):
        """
        Set the item in the descendants.
        Args:
            key: The key to set.
            value: The value to set.
        """

    def __str__(self):
        return str(self.errors) + ',' + str(self.descendants)

    @property
    def depth(self):
        return len(self.path)

    @property
    def tree_type(self):
        return self.tree_root.tree_type

    def add(self, error):
        """
        Add an error to the tree node.
        Args:
            error: The error to add.
        Returns:
            None.
        """

    def _path_of_(self, error):
        return getattr(error, self.tree_type + '_path')
```

#### 6. BaseErrorHandler Class

**Function**: A base class for all error handlers.
**Class Definition**:
```python
class BaseErrorHandler(object):
    """Base class for all error handlers.
    Subclasses are identified as error-handlers with an instance-test."""

    def __init__(self, *args, **kwargs):
        """Optionally initialize a new instance."""
        pass

    def __call__(self, errors):
        """
        Returns errors in a handler-specific format.

        :param errors: An object containing the errors.
        :type errors: :term:`iterable` of
                      :class:`~cerberus.errors.ValidationError` instances or a
                      :class:`~cerberus.Validator` instance
        """
        raise NotImplementedError

    def __iter__(self):
        """Be a superhero and implement an iterator over errors."""
        raise NotImplementedError

    def add(self, error):
        """
        Add an error to the errors' container object of a handler.

        :param error: The error to add.
        :type error: :class:`~cerberus.errors.ValidationError`
        """
        raise NotImplementedError

    def emit(self, error):
        """
        Optionally emits an error in the handler's format to a stream. Or light a LED,
        or even shut down a power plant.

        :param error: The error to emit.
        :type error: :class:`~cerberus.errors.ValidationError`
        """
        pass

    def end(self, validator):
        """
        Gets called when a validation ends.

        :param validator: The calling validator.
        :type validator: :class:`~cerberus.Validator`
        """
        pass

    def extend(self, errors):
        """
        Adds all errors to the handler's container object.

        :param errors: The errors to add.
        :type errors: :term:`iterable` of
                      :class:`~cerberus.errors.ValidationError` instances
        """

    def start(self, validator):
        """
        Gets called when a validation starts.

        :param validator: The calling validator.
        :type validator: :class:`~cerberus.Validator`
        """
        pass
```

#### 7. ToyErrorHandler Class

**Function**: A toy error handler that raises an error.
**Class Definition**:
```python
class ToyErrorHandler(BaseErrorHandler):
    def __call__(self, *args, **kwargs):
        raise RuntimeError('This is not supposed to happen.')

    def clear(self):
        pass
```

#### 8. SchemaErrorHandler Class

**Function**: A schema error handler that raises an error.

**Class Definition**:
```python
class SchemaErrorHandler(BasicErrorHandler):
    messages = BasicErrorHandler.messages.copy()
    messages[0x03] = "unknown rule"
```

#### 9. _Abort Class

**Function**: A class that raises an error.
**Class Definition**:
```python
class _Abort(Exception):
    pass
```

#### 10. SchemaValidationSchema Class

**Function**: A schema validation schema that is a dictionary.

**Class Definition**:
```python
class SchemaValidationSchema(UnvalidatedSchema):
    def __init__(self, validator):
        self.schema = {
            'allow_unknown': False,
            'schema': validator.rules,
            'type': 'dict',
        }
```

#### 11. SchemaValidatorMixin Class

**Function**: A schema validator mixin that provides mechanics to validate schemas passed to a Cerberus validator.
**Class Definition**:
```python
class SchemaValidatorMixin(object):
    """
    This validator mixin provides mechanics to validate schemas passed to a Cerberus
    validator.
    """

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('known_rules_set_refs', set())
        kwargs.setdefault('known_schema_refs', set())
        super(SchemaValidatorMixin, self).__init__(*args, **kwargs)

    @property
    def known_rules_set_refs(self):
        """The encountered references to rules set registry items."""
        return self._config['known_rules_set_refs']

    @property
    def known_schema_refs(self):
        """The encountered references to schema registry items."""
        return self._config['known_schema_refs']

    @property
    def target_schema(self):
        """The schema that is being validated."""
        return self._config['target_schema']

    @property
    def target_validator(self):
        """The validator whose schema is being validated."""
        return self._config['target_validator']

    def _check_with_bulk_schema(self, field, value):
        """
        Resolve schema registry reference.
        Args:
            field: The field to resolve.
            value: The value to resolve.
        Returns:
            None.
        """

    def _check_with_dependencies(self, field, value):
        """
        Resolve dependencies.
        Args:
            field: The field to resolve.
            value: The value to resolve.
        Returns:
            None.
        """

    def _check_with_items(self, field, value):
        for i, schema in enumerate(value):
            self._check_with_bulk_schema((field, i), schema)

    def _check_with_schema(self, field, value):
        """
        Resolve schema.
        Args:
            field: The field to resolve.
            value: The value to resolve.
        Returns:
            None.
        """

    def _check_with_type(self, field, value):
        """
        Resolve type.
        Args:
            field: The field to resolve.
            value: The value to resolve.
        Returns:
            None.
        """

    def _expand_rules_set_refs(self, schema):
        """
        Expand rules set refs.
        Args:
            schema: The schema to expand.
        Returns:
            The expanded schema.
        """

    def _handle_schema_reference_for_validator(self, field, value):
        """
        Handle schema reference for validator.
        Args:
            field: The field to handle.
            value: The value to handle.
        Returns:
            The handled value.
        """

    def _validate_logical(self, rule, field, value):
        """{'allowed': ('allof', 'anyof', 'noneof', 'oneof')}
        Args:
            rule: The rule to validate.
            field: The field to validate.
            value: The value to validate.
        Returns:
            None.
        """
```

#### 12. SchemaRegistry Class

**Function**: A schema registry that stores schemas.

**Class Definition**:
```python
class SchemaRegistry(Registry):
    @classmethod
    def _expand_definition(cls, definition):
        return DefinitionSchema.expand(definition)
```

#### 13. RulesSetRegistry Class

**Function**: A rules set registry that stores rules sets.

**Class Definition**:
```python
class RulesSetRegistry(Registry):
    @classmethod
    def _expand_definition(cls, definition):
        return DefinitionSchema.expand({0: definition})[0]
```
#### 14. dummy_for_rule_validation() Function

**Function**: A dummy method for rule validation.

**Method Signature**:
```python
def dummy_for_rule_validation(rule_constraints):
    def dummy(self, constraint, field, value):
        raise RuntimeError(
            'Dummy method called. Its purpose is to hold just'
            'validation constraints for a rule in its '
            'docstring.'
        )

```

**Parameters**:
- `rule_constraints`: The rule constraints to validate.

**Returns**: A dummy method for rule validation.

#### 15. drop_item_from_tuple() Function

**Function**: A function that drops an item from a tuple.

**Method Signature**:
```python
def drop_item_from_tuple(t, i):

```

**Parameters**:
- `t`: The tuple to drop the item from.
- `i`: The index of the item to drop.

**Returns**: A tuple with the item dropped.

#### 16. get_Validator_class() Function

**Function**: A function that returns the Validator class.

**Method Signature**:
```python
def get_Validator_class():
```

**Returns**: The Validator class.

#### 17. mapping_hash() Function

**Function**: A function that returns the hash of a schema.

**Method Signature**:
```python
def mapping_hash(schema):
```

**Parameters**:
- `schema`: The schema to hash.

**Returns**: The hash of the schema.

#### 18. quote_string() Function

**Function**: A function that quotes a string.

**Method Signature**:
```python
def quote_string(value):
```

**Parameters**:
- `value`: The value to quote.

**Returns**: The quoted string.

#### 19. encode_unicode() Function

**Function**: A function that encodes a unicode string into a binary utf-8 string.

**Method Signature**:
```python
def encode_unicode(f):
    """Cerberus error messages expect regular binary strings.
    If unicode is used in a ValidationError message can't be printed.

    This decorator ensures that if legacy Python is used unicode
    strings are encoded before passing to a function.
    """

    @wraps(f)
    def wrapped(obj, error):
        """
        Helper encoding unicode strings into binary utf-8
        Args:
            obj: The object to encode.
            error: The error to encode.
        Returns:
            The encoded function.
        """
        def _encode(value):
            """Helper encoding unicode strings into binary utf-8
            Args:
                value: The value to encode.
            Returns:
                The encoded value.
            """
```

**Parameters**:
- `f`: The function to encode.

**Returns**: The encoded function.

#### 20. mapping_to_frozenset() Function

**Function**: A function that converts a mapping to a frozenset.

**Method Signature**:
```python
def mapping_to_frozenset(mapping):
    """
    Be aware that this treats any sequence type with the equal members as equal. As it
    is used to identify equality of schemas, this can be considered okay as definitions
    are semantically equal regardless the container type.
    """
```

**Parameters**:
- `mapping`: The mapping to convert to a frozenset.

**Returns**: A frozenset of the mapping.

#### 21. schema_1_field_3_allow_unknown_check_with() Function

**Function**: A function that validates the allow unknown check with.

**Method Signature**:
```python
def schema_1_field_3_allow_unknown_check_with(field, value, error):
```

**Parameters**:
- `field`: The field to validate.
- `value`: The value to validate.
- `error`: The error to validate.

**Returns**: None.

#### 22. init_validator() Function

**Function**: A function that initializes a validator.

**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_1 import init_validator
def init_validator():
    class TestValidator(Validator):
        types_mapping = {
            **Validator.types_mapping,
            "path": TypeDefinition("path", (Path,), ()),
        }

    return TestValidator(schema_1, purge_unknown=True)
```

**Parameters**:
None.

**Returns**: A validator.

#### 23. init_validator() Function

**Function**: A function that initializes a validator.
**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_2 import init_validator
def init_validator():
    return Validator(product_schema, purge_unknown=True)
```

**Parameters**:
None.

**Returns**: A validator.

#### 24. load_documents() Function

**Function**: A function that loads documents.

**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_1 import load_documents
def load_documents():
    with (DOCUMENTS_PATH / "overall_documents_1.json").open() as f:
        documents = json.load(f)
    return documents
```

**Parameters**:
None.

**Returns**: A list of documents.

#### 25. load_documents() Function

**Function**: A function that loads documents.
**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_2 import load_documents

def load_documents():
    with (DOCUMENTS_PATH / "overall_documents_2.json").open() as f:
        documents = json.load(f)
    return documents
```

**Parameters**:
None.

**Returns**: A list of documents.

#### 26. validate_documents() Function

**Function**: A function that validates documents.
**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_1 import validate_documents
def validate_documents(init_validator: Callable, documents: List[dict]):
    doc_count = failed_count = 0
    error_paths = Counter()
    validator = init_validator()

    def count_errors(errors):
        """
        Count errors.
        Args:
            errors: The errors to count.
        Returns:
            None.
        """
    for document in documents:
        if validator.validated(document) is None:
            failed_count += 1
            count_errors(validator._errors)
        doc_count += 1

    print(
        f"{failed_count} out of {doc_count} documents failed with "
        f"{len(error_paths)} different error leafs."
    )
    print("Top 3 errors, excluding container errors:")
    for path, count in error_paths.most_common(3):
        print(f"{count}: {path}")
```

**Parameters**:
- `init_validator`: The validator to use.
- `documents`: The documents to validate.

**Returns**: None.

#### 27. validate_documents() Function

**Function**: A function that validates documents.
**Method Signature**:
```python
from cerberus.benchmarks.test_overall_performance_2 import validate_documents
def validate_documents(init_validator: Callable, documents: List[dict]) -> None:
    doc_count = failed_count = 0
    error_paths: CounterType[tuple] = Counter()
    validator = init_validator()

    def count_errors(errors):
        """
        Count errors.
        Args:
            errors: The errors to count.
        Returns:
            None.
        """

    for document in documents:
        if validator.validated(document) is None:
            failed_count += 1
            count_errors(validator._errors)
        doc_count += 1

    print(
        f"{failed_count} out of {doc_count} documents failed with "
        f"{len(error_paths)} different error leafs."
    )
    print("Top 3 errors, excluding container errors:")
    for path, count in error_paths.most_common(3):
        print(f"{count}: {path}")
```

**Parameters**:
- `init_validator`: The validator to use.
- `documents`: The documents to validate.

**Returns**: None.

#### 28. generate_sample_document_1() Function

**Function**: A function that generates a sample document.

**Method Signature**:
```python
def generate_sample_document_1() -> dict:
```

**Parameters**:
None.

**Returns**: A sample document.

#### 29. generate_document_1_field_1() Function

**Function**: A function that generates a document field 1.

**Method Signature**:
```python
def generate_document_1_field_1() -> dict:
```

**Parameters**:
None.

**Returns**: A document field 1.

#### 30. generate_document_1_field_2() Function

**Function**: A function that generates a document field 2.

**Method Signature**:
```python
def generate_document_1_field_2() -> dict:
```

**Parameters**:
None.

**Returns**: A document field 2.

#### 31. generate_document_1_field_3() Function

**Function**: A function that generates a document field 3.

**Method Signature**:
```python
def generate_document_1_field_3() -> dict:
```

**Parameters**:
None.

**Returns**: A document field 3.

#### 32. generate_document_1_field_4() Function

**Function**: A function that generates a document field 4.

**Method Signature**:
```python
def generate_document_1_field_4():
```

**Parameters**:
None.

**Returns**: A document field 4.

#### 33. generate_document_1_field_5() Function

**Function**: A function that generates a document field 5.

**Method Signature**:
```python
def generate_document_1_field_5():
```

**Parameters**:
None.

**Returns**: None.

#### 34. write_sample_documents() Function

**Function**: A function that writes sample documents.

**Method Signature**:
```python
def write_sample_documents():
```

**Parameters**:
None.

**Returns**: None.

#### 35. to_bool() Function

**Function**: A function that converts a value to a boolean.

**Method Signature**:
```python
def to_bool(value):
```

**Parameters**:
- `value`: The value to convert to a boolean.

**Returns**: A boolean.

#### 36. allowed_tax() Function

**Function**: A function that returns the allowed tax.

**Method Signature**:
```python
def allowed_tax(value):
```

**Parameters**:
- `value`: The value to convert to a boolean.

**Returns**: A boolean.

#### 37. allowed_types() Function

**Function**: A function that returns the allowed types.

**Method Signature**:
```python
def allowed_types(value):
```

**Parameters**:
- `value`: The value to convert to a boolean.

**Returns**: A boolean.

#### 38. none_to_zero() Function

**Function**: A function that returns the none to zero.

**Method Signature**:
```python
def none_to_zero(value):
```

**Parameters**:
- `value`: The value to convert to a boolean.

**Returns**: A boolean.

#### 39. empty_str_to_null() Function

**Function**: A function that returns the empty string to null.

**Method Signature**:
```python
def empty_str_to_null(value):
```

**Parameters**:
- `value`: The value to convert to a boolean.

**Returns**: A boolean.

#### 40. Constants && Type Aliases

```python
# In Validator.py
RULE_SCHEMA_SEPARATOR = "The rule's arguments are validated against this schema:"

# In errors.py
CUSTOM = ErrorDefinition(0x00, None)
DOCUMENT_MISSING = ErrorDefinition(0x01, None)  # issues/141
DOCUMENT_MISSING = "document is missing"
UNKNOWN_FIELD = ErrorDefinition(0x03, None)
DEPENDENCIES_FIELD = ErrorDefinition(0x04, 'dependencies')
DEPENDENCIES_FIELD_VALUE = ErrorDefinition(0x05, 'dependencies')
EXCLUDES_FIELD = ErrorDefinition(0x06, 'excludes')

DOCUMENT_FORMAT = ErrorDefinition(0x21, None)  # issues/141
DOCUMENT_FORMAT = "'{0}' is not a document, must be a dict"
EMPTY_NOT_ALLOWED = ErrorDefinition(0x22, 'empty')
NOT_NULLABLE = ErrorDefinition(0x23, 'nullable')
BAD_TYPE = ErrorDefinition(0x24, 'type')
BAD_TYPE_FOR_SCHEMA = ErrorDefinition(0x25, 'schema')
ITEMS_LENGTH = ErrorDefinition(0x26, 'items')
MIN_LENGTH = ErrorDefinition(0x27, 'minlength')
MAX_LENGTH = ErrorDefinition(0x28, 'maxlength')

REGEX_MISMATCH = ErrorDefinition(0x41, 'regex')
MIN_VALUE = ErrorDefinition(0x42, 'min')
MAX_VALUE = ErrorDefinition(0x43, 'max')
UNALLOWED_VALUE = ErrorDefinition(0x44, 'allowed')
UNALLOWED_VALUES = ErrorDefinition(0x45, 'allowed')
FORBIDDEN_VALUE = ErrorDefinition(0x46, 'forbidden')
FORBIDDEN_VALUES = ErrorDefinition(0x47, 'forbidden')
MISSING_MEMBERS = ErrorDefinition(0x48, 'contains')

NORMALIZATION = ErrorDefinition(0x60, None)
COERCION_FAILED = ErrorDefinition(0x61, 'coerce')
RENAMING_FAILED = ErrorDefinition(0x62, 'rename_handler')
READONLY_FIELD = ErrorDefinition(0x63, 'readonly')
SETTING_DEFAULT_FAILED = ErrorDefinition(0x64, 'default_setter')
ERROR_GROUP = ErrorDefinition(0x80, None)
MAPPING_SCHEMA = ErrorDefinition(0x81, 'schema')
SEQUENCE_SCHEMA = ErrorDefinition(0x82, 'schema')
KEYSRULES = KEYSCHEMA = ErrorDefinition(0x83, 'keysrules')
VALUESRULES = VALUESCHEMA = ErrorDefinition(0x84, 'valuesrules')
BAD_ITEMS = ErrorDefinition(0x8F, 'items')
LOGICAL = ErrorDefinition(0x90, None)
NONEOF = ErrorDefinition(0x91, 'noneof')
ONEOF = ErrorDefinition(0x92, 'oneof')
ANYOF = ErrorDefinition(0x93, 'anyof')
ALLOF = ErrorDefinition(0x94, 'allof')
SCHEMA_ERROR_DEFINITION_TYPE = "schema definition for field '{0}' must be a dict"
SCHEMA_ERROR_MISSING = "validation schema missing"

# In overall_schema_2.py
P_TYPES = ['ONE', 'TWO']
T_TYPES = ['NO', 'V20']

# In _init_.py
__all__ = [
    DocumentError.__name__,
    SchemaError.__name__,
    TypeDefinition.__name__,
    Validator.__name__,
    "schema_registry",
    "rules_set_registry",
    "__version__",
]

# In platform.py
__all__ = (
    "_int_types",
    "_str_type",
    "importlib_metadata",
    Callable.__name__,
    Container.__name__,
    Hashable.__name__,
    Iterable.__name__,
    Mapping.__name__,
    MutableMapping.__name__,
    Sequence.__name__,
    Set.__name__,
    Sized.__name__,
)
```
### Practical Usage Patterns

#### Basic Validation

```python
from cerberus import Validator

# Define validation schema
schema = {
    'name': {'type': 'string', 'required': True},
    'age': {'type': 'integer', 'min': 0, 'max': 150},
    'email': {'type': 'string', 'regex': r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'}
}

# Create validator
validator = Validator(schema)

# Validate document
document = {
    'name': 'John Doe',
    'age': 30,
    'email': 'john@example.com'
}

if validator.validate(document):
    print("Validation successful")
else:
    print("Validation failed:", validator.errors)
```

#### Normalization

```python
# Define schema with normalization rules
schema = {
    'name': {'type': 'string', 'coerce': str.upper},
    'age': {'type': 'integer', 'coerce': int, 'default': 18},
    'email': {'type': 'string', 'regex': r'^[^@]+@[^@]+\.[^@]+$'}
}

validator = Validator(schema)

# Normalize document
document = {
    'name': 'john doe',
    'email': 'john@example.com'
}

normalized_doc = validator.normalized(document)
print(normalized_doc)  # {'name': 'JOHN DOE', 'age': 18, 'email': 'john@example.com'}
```

#### Nested Structure Validation

```python
schema = {
    'user': {
        'type': 'dict',
        'schema': {
            'name': {'type': 'string', 'required': True},
            'address': {
                'type': 'dict',
                'schema': {
                    'street': {'type': 'string'},
                    'city': {'type': 'string'},
                    'zip': {'type': 'string', 'regex': r'^\d{5}$'}
                }
            }
        }
    },
    'roles': {
        'type': 'list',
        'schema': {'type': 'string', 'allowed': ['admin', 'user', 'guest']}
    }
}

validator = Validator(schema)

document = {
    'user': {
        'name': 'John Doe',
        'address': {
            'street': '123 Main St',
            'city': 'Anytown',
            'zip': '12345'
        }
    },
    'roles': ['user', 'admin']
}

if validator.validate(document):
    print("Nested structure validation successful")
```

#### Custom Validation Rules

```python
class CustomValidator(Validator):
    def _validate_is_even(self, is_even, field, value):
        """Custom validation rule: checks if value is even"""
        if is_even and value % 2 != 0:
            self._error(field, 'must be even')

schema = {
    'number': {'type': 'integer', 'is_even': True}
}

validator = CustomValidator(schema)
document = {'number': 4}

if validator.validate(document):
    print("Custom validation successful")
```

#### Error Handling

```python
from cerberus import Validator, errors

# Custom error handler
class CustomErrorHandler(errors.BasicErrorHandler):
    def __init__(self, tree=None):
        super(CustomErrorHandler, self).__init__(tree)
        self.messages[errors.REQUIRED_FIELD.code] = 'Field {0} is required'

schema = {'name': {'type': 'string', 'required': True}}
validator = Validator(schema, error_handler=CustomErrorHandler)

document = {}
if not validator.validate(document):
    print(validator.errors)  # Display error messages in English
```

### Supported Validation Rules

#### Basic Type Rules
- `type`: Data type validation
- `nullable`: Whether None values are allowed
- `required`: Whether the field is required
- `empty`: Whether empty values are allowed

#### Numeric Rules
- `min`: Minimum value
- `max`: Maximum value
- `minlength`: Minimum length
- `maxlength`: Maximum length

#### String Rules
- `regex`: Regular expression matching
- `allowed`: List of allowed values
- `forbidden`: List of forbidden values

#### Container Rules
- `items`: List item validation
- `schema`: Dictionary structure validation
- `keysrules`: Key validation rules
- `valuesrules`: Value validation rules

#### Logical Rules
- `anyof`: Satisfies any of the conditions
- `allof`: Satisfies all conditions
- `oneof`: Satisfies exactly one condition
- `noneof`: Satisfies none of the conditions

#### Dependency Rules
- `dependencies`: Field dependencies
- `excludes`: Field exclusion

#### Normalization Rules
- `coerce`: Type conversion
- `default`: Default value
- `default_setter`: Dynamic default value
- `rename`: Field renaming
- `rename_handler`: Dynamic renaming

### Important Notes

1. **Error Collection**: Cerberus doesn't stop at the first error; it collects all errors
2. **Normalization Order**: Normalization is performed before validation
3. **Schema Caching**: Validation schemas are cached for better performance
4. **Sub-validators**: Nested structures create sub-validator instances
5. **Error Paths**: Error messages include complete document and schema paths
6. **Thread Safety**: Validator instances are not thread-safe
7. **Extensibility**: Custom validation rules can be added by subclassing the Validator class


## Detailed Implementation Nodes

### Node 1: Basic Type Validation

**Functionality**: Validates basic data types of document fields, including strings, integers, floats, booleans, datetime, etc.

**Core Algorithms**:
- Type checking: Verifies if field values match the specified data types
- Null value handling: Processes None values and empty containers
- Type mapping: Supports custom type definitions

**Input/Output Examples**:

```python
from cerberus import Validator

# String type validation
schema = {'name': {'type': 'string'}}
validator = Validator(schema)

# Success case
document = {'name': 'John Doe'}
result = validator.validate(document)
print(result)  # True

# Failure case
document = {'name': 123}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'name': ['must be of string type']}

# Integer type validation
schema = {'age': {'type': 'integer', 'min': 0, 'max': 150}}
validator = Validator(schema)

document = {'age': 25}
result = validator.validate(document)
print(result)  # True

document = {'age': 200}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'age': ['max value is 150']}

# Float type validation
schema = {'price': {'type': 'float', 'min': 0.0}}
validator = Validator(schema)

document = {'price': 19.99}
result = validator.validate(document)
print(result)  # True

# Boolean type validation
schema = {'active': {'type': 'boolean'}}
validator = Validator(schema)

document = {'active': True}
result = validator.validate(document)
print(result)  # True

# Datetime type validation
schema = {'created_at': {'type': 'datetime'}}
validator = Validator(schema)

from datetime import datetime
document = {'created_at': datetime.now()}
result = validator.validate(document)
print(result)  # True

# Test validation
assert validator.validate({'name': 'John'}) == True
assert validator.validate({'name': 123}) == False
assert 'must be of string type' in str(validator.errors)
```

### Node 2: Container Type Validation

**Functionality**: Validates container type data structures such as lists, dictionaries, and sets.

**Core Algorithms**:
- List validation: Validates list length, element types, and structure
- Dictionary validation: Validates dictionary key-value pairs and nested structures
- Set validation: Validates set element types and size

**Input/Output Examples**:

```python
from cerberus import Validator

# List type validation
schema = {
    'numbers': {
        'type': 'list',
        'schema': {'type': 'integer'},
        'minlength': 1,
        'maxlength': 5
    }
}
validator = Validator(schema)

# Success case
document = {'numbers': [1, 2, 3]}
result = validator.validate(document)
print(result)  # True

# Failure case - invalid element type
document = {'numbers': [1, 'two', 3]}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'numbers': [{1: ['must be of integer type']}]}

# Dictionary type validation
schema = {
    'user': {
        'type': 'dict',
        'schema': {
            'name': {'type': 'string', 'required': True},
            'age': {'type': 'integer', 'min': 0}
        }
    }
}
validator = Validator(schema)

# Success case
document = {'user': {'name': 'John', 'age': 25}}
result = validator.validate(document)
print(result)  # True

# Failure case - missing required field
document = {'user': {'age': 25}}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'user': [{'name': ['required field']}]}

# Set type validation
schema = {'tags': {'type': 'set', 'schema': {'type': 'string'}}}
validator = Validator(schema)

document = {'tags': {'python', 'validation', 'cerberus'}}
result = validator.validate(document)
print(result)  # True

# Test validation
assert validator.validate({'numbers': [1, 2, 3]}) == True
assert validator.validate({'numbers': [1, 'two']}) == False
assert 'must be of integer type' in str(validator.errors)
```

### Node 3: String Validation Rules

**Functionality**: Validates string length, format, regex patterns, and other string-specific rules.

**Core Algorithms**:
- Length validation: Checks for minimum and maximum length constraints
- Regular expressions: Validates string patterns using regex
- Allowed values: Verifies if string is in the allowed list
- Forbidden values: Checks if string is in the forbidden list

**Input/Output Examples**:

```python
from cerberus import Validator

# String length validation
schema = {
    'username': {
        'type': 'string',
        'minlength': 3,
        'maxlength': 20,
        'regex': r'^[a-zA-Z0-9_]+$'
    }
}
validator = Validator(schema)

# Success case
document = {'username': 'john_doe'}
result = validator.validate(document)
print(result)  # True

# Failure case - length too short
document = {'username': 'jo'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'username': ['min length is 3']}

# Failure case - regex pattern mismatch
document = {'username': 'john@doe'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'username': ["value does not match regex '^[a-zA-Z0-9_]+$'"]}

# Allowed values validation
schema = {'status': {'type': 'string', 'allowed': ['active', 'inactive', 'pending']}}
validator = Validator(schema)

document = {'status': 'active'}
result = validator.validate(document)
print(result)  # True

document = {'status': 'unknown'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'status': ['unallowed value unknown']}

# Forbidden values validation
schema = {'role': {'type': 'string', 'forbidden': ['admin', 'root']}}
validator = Validator(schema)

document = {'role': 'user'}
result = validator.validate(document)
print(result)  # True

document = {'role': 'admin'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'role': ['forbidden value admin']}

# Test validation
assert validator.validate({'username': 'john_doe'}) == True
assert validator.validate({'username': 'jo'}) == False
assert 'min length is 3' in str(validator.errors)
```

### Node 4: Numeric Validation Rules

**Functionality**: Validates numeric values against minimum, maximum, and range constraints.

**Core Algorithms**:
- Minimum value validation: Ensures the number is greater than or equal to the specified minimum
- Maximum value validation: Ensures the number is less than or equal to the specified maximum
- Range validation: Verifies that the number falls within a specified range

**Input/Output Examples**:

```python
from cerberus import Validator

# Integer range validation
schema = {
    'age': {
        'type': 'integer',
        'min': 0,
        'max': 150
    }
}
validator = Validator(schema)

# Success case
document = {'age': 25}
result = validator.validate(document)
print(result)  # True

# Failure case - value out of range
document = {'age': 200}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'age': ['max value is 150']}

# Float validation
schema = {
    'price': {
        'type': 'float',
        'min': 0.0,
        'max': 1000.0
    }
}
validator = Validator(schema)

document = {'price': 19.99}
result = validator.validate(document)
print(result)  # True

document = {'price': -5.0}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'price': ['min value is 0.0']}

# Test validation
assert validator.validate({'age': 25}) == True
assert validator.validate({'age': 200}) == False
assert 'max value is 150' in str(validator.errors)
```
### Node 5: Required Field Validation

**Functionality**: Verifies that all required fields are present in the document.

**Core Algorithms**:
- Required field check: Validates the presence of all fields marked as required
- Nested field validation: Recursively checks required fields within nested structures
- Conditional requirements: Validates conditionally required fields based on dependencies

**Input/Output Examples**:

```python
from cerberus import Validator

# Basic required field validation
schema = {
    'name': {'type': 'string', 'required': True},
    'email': {'type': 'string', 'required': True},
    'age': {'type': 'integer', 'required': False}
}
validator = Validator(schema)

# Success case
document = {'name': 'John', 'email': 'john@example.com'}
result = validator.validate(document)
print(result)  # True

# Failure case - missing required field
document = {'name': 'John'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'email': ['required field']}

# Nested required field validation
schema = {
    'user': {
        'type': 'dict',
        'required': True,
        'schema': {
            'name': {'type': 'string', 'required': True},
            'address': {
                'type': 'dict',
                'schema': {
                    'street': {'type': 'string', 'required': True},
                    'city': {'type': 'string', 'required': True}
                }
            }
        }
    }
}
validator = Validator(schema)

# Success case
document = {
    'user': {
        'name': 'John',
        'address': {
            'street': '123 Main St',
            'city': 'Anytown'
        }
    }
}
result = validator.validate(document)
print(result)  # True

# Failure case - missing nested field
document = {
    'user': {
        'name': 'John',
        'address': {
            'street': '123 Main St'
        }
    }
}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'user': [{'address': [{'city': ['required field']}]}]}

# Test validation
assert validator.validate({'name': 'John', 'email': 'john@example.com'}) == True
assert validator.validate({'name': 'John'}) == False
assert 'required field' in str(validator.errors)
```

### Node 6: Nullable Field Handling

**Functionality**: Handles null values in fields, allowing or disallowing None values.

**Core Algorithms**:
- Nullable check: Validates if a field can be None
- Skip validation for nulls: Skips other validation rules for nullable fields when null
- Type validation: Performs type checking on non-nullable fields

**Input/Output Examples**:

```python
from cerberus import Validator

# Nullable field validation
schema = {
    'name': {'type': 'string', 'required': True},
    'description': {'type': 'string', 'nullable': True},
    'age': {'type': 'integer', 'nullable': False}
}
validator = Validator(schema)

# Success case - nullable字段为None
document = {'name': 'John', 'description': None}
result = validator.validate(document)
print(result)  # True

# Success case - nullable field has a value
document = {'name': 'John', 'description': 'Some description'}
result = validator.validate(document)
print(result)  # True

# Failure case - non-nullable field is None
document = {'name': 'John', 'age': None}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'age': ['null value not allowed']}

# Nullable fields skip other validations
schema = {
    'email': {
        'type': 'string',
        'nullable': True,
        'regex': r'^[^@]+@[^@]+\.[^@]+$'
    }
}
validator = Validator(schema)

# Success case - skips regex validation when nullable field is None
document = {'email': None}
result = validator.validate(document)
print(result)  # True

# Test validation
assert validator.validate({'name': 'John', 'description': None}) == True
assert validator.validate({'name': 'John', 'age': None}) == False
assert 'null value not allowed' in str(validator.errors)
```


### Node 7: Readonly Field Handling

**Functionality**: Handles read-only fields to prevent modification of their values during validation.

**Core Algorithms**:
- Read-only check: Validates if read-only fields have been modified
- Normalization handling: Processes read-only fields during normalization
- Error collection: Gathers error information for read-only fields

**Input/Output Examples**:

```python
from cerberus import Validator

# Read-only field validation
schema = {
    'id': {'type': 'integer', 'readonly': True},
    'name': {'type': 'string', 'required': True},
    'created_at': {'type': 'string', 'readonly': True, 'default': '2023-01-01'}
}
validator = Validator(schema)

# Success case - Does not include read-only fields
document = {'name': 'John'}
result = validator.validate(document)
print(result)  # True

# Failure case - includes read-only field
document = {'name': 'John', 'id': 123}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'id': ['field is read-only']}

# Read-only field with default value
schema = {
    'created_at': {
        'type': 'string',
        'readonly': True,
        'default': '2023-01-01'
    },
    'modified_at': {
        'type': 'string',
        'readonly': True,
        'default_setter': lambda doc: doc['created_at']
    }
}
validator = Validator(schema)

# Success case - Read only fields use default values
document = {}
result = validator.validate(document)
print(result)  # True
print(validator.document)  # {'created_at': '2023-01-01', 'modified_at': '2023-01-01'}

# Test validation
assert validator.validate({'name': 'John'}) == True
assert validator.validate({'name': 'John', 'id': 123}) == False
assert 'field is read-only' in str(validator.errors)
```

### Node 8: Data Normalization

**Functionality**: Performs normalization on input data including type conversion, default value setting, and field renaming.

**Core Algorithms**:
- Type conversion: Uses coerce rules for type conversion
- Default value setting: Sets default values for missing fields
- Field renaming: Renames fields using rename rules
- Chained transformations: Supports chaining multiple transformation functions

**Input/Output Examples**:

```python
from cerberus import Validator

# Type conversion normalization
schema = {
    'amount': {'type': 'integer', 'coerce': int},
    'price': {'type': 'float', 'coerce': float},
    'name': {'type': 'string', 'coerce': str.upper}
}
validator = Validator(schema)

# Input document
document = {'amount': '123', 'price': '19.99', 'name': 'john'}
result = validator.normalized(document)
print(result)  # {'amount': 123, 'price': 19.99, 'name': 'JOHN'}

# Chained transformations
schema = {
    'hex_value': {
        'type': 'string',
        'coerce': [hex, lambda x: x[2:], str.upper]
    }
}
validator = Validator(schema)

document = {'hex_value': 15}
result = validator.normalized(document)
print(result)  # {'hex_value': 'F'}

# Default value setting
schema = {
    'name': {'type': 'string', 'required': True},
    'age': {'type': 'integer', 'default': 18},
    'status': {'type': 'string', 'default_setter': lambda doc: 'active'}
}
validator = Validator(schema)

document = {'name': 'John'}
result = validator.normalized(document)
print(result)  # {'name': 'John', 'age': 18, 'status': 'active'}

# Field renaming
schema = {
    'first_name': {'type': 'string', 'rename': 'firstName'},
    'last_name': {'type': 'string', 'rename': 'lastName'}
}
validator = Validator(schema)

document = {'first_name': 'John', 'last_name': 'Doe'}
result = validator.normalized(document)
print(result)  # {'firstName': 'John', 'lastName': 'Doe'}

# Test validation
assert validator.normalized({'amount': '123'}) == {'amount': 123}
assert validator.normalized({'name': 'John'}) == {'name': 'John', 'age': 18, 'status': 'active'}
```

### Node 9: Dependency Validation

**Functionality**: Validates dependencies between fields to ensure related fields exist and have appropriate values.

**Core Algorithms**:
- Field dependencies: Checks if dependent fields exist
- Value dependencies: Verifies if dependent field values meet conditions
- Nested dependencies: Handles dependencies in nested structures

**Input/Output Examples**:

```python
from cerberus import Validator

# Field dependency validation
schema = {
    'email': {'type': 'string', 'required': True},
    'password': {'type': 'string', 'required': True},
    'confirm_password': {
        'type': 'string',
        'dependencies': ['password']
    }
}
validator = Validator(schema)

# Success case - Include dependent fields
document = {'email': 'john@example.com', 'password': 'secret', 'confirm_password': 'secret'}
result = validator.validate(document)
print(result)  # True

# Failure case - missing dependent field
document = {'email': 'john@example.com', 'confirm_password': 'secret'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {"confirm_password": ["field 'password' is required"]}

# Value dependency validation
schema = {
    'payment_method': {'type': 'string', 'allowed': ['credit_card', 'bank_transfer']},
    'card_number': {
        'type': 'string',
        'dependencies': {
            'payment_method': 'credit_card'
        }
    }
}
validator = Validator(schema)

# Success case - Satisfy value dependency
document = {'payment_method': 'credit_card', 'card_number': '1234567890'}
result = validator.validate(document)
print(result)  # True

# Failure case - doesn't satisfy value dependency
document = {'payment_method': 'bank_transfer', 'card_number': '1234567890'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'card_number': ['depends on these values: credit_card']}

# Test validation
assert validator.validate({'email': 'john@example.com', 'password': 'secret', 'confirm_password': 'secret'}) == True
assert validator.validate({'email': 'john@example.com', 'confirm_password': 'secret'}) == False
assert 'field password is required' in str(validator.errors)
```

### Node 10: Exclusion Validation

**Functionality**: Validates mutually exclusive fields to ensure certain fields cannot coexist.

**Core Algorithms**:
- Exclusion check: Verifies if mutually exclusive fields exist simultaneously
- Required exclusions: Handles mutually exclusive required fields
- Error collection: Gathers error information for exclusion violations

**Input/Output Examples**:

```python
from cerberus import Validator

# Basic exclusion validation
schema = {
    'email': {'type': 'string'},
    'phone': {'type': 'string'},
    'contact_method': {
        'type': 'string',
        'excludes': ['email', 'phone']
    }
}
validator = Validator(schema)

# Success case - Only one field
document = {'email': 'john@example.com'}
result = validator.validate(document)
print(result)  # True

# Failure case - mutually exclusive fields coexist
document = {'email': 'john@example.com', 'contact_method': 'mail'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'contact_method': ["email must not be present with 'contact_method'"]}

# Required exclusion validation
schema = {
    'username': {'type': 'string', 'required': True},
    'email': {'type': 'string', 'required': True},
    'phone': {
        'type': 'string',
        'required': True,
        'excludes': ['email']
    }
}
validator = Validator(schema)

# Failure case - required fields are mutually exclusive
document = {'username': 'john', 'email': 'john@example.com', 'phone': '1234567890'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'phone': ["email must not be present with 'phone'"]}

# Test validation
assert validator.validate({'email': 'john@example.com'}) == True
assert validator.validate({'email': 'john@example.com', 'contact_method': 'mail'}) == False
assert "must not be present with" in str(validator.errors)
```

### Node 11: Logical Rules Validation

**Functionality**: Performs complex conditional validation using logical operators (anyof, allof, oneof, noneof).

**Core Algorithms**:
- anyof: Passes if any condition is met
- allof: Requires all conditions to be met
- oneof: Must satisfy exactly one condition
- noneof: Must not satisfy any condition

**Input/Output Examples**:

```python
from cerberus import Validator

# anyof validation - pass if any condition is met
schema = {
    'contact': {
        'anyof': [
            {'type': 'string', 'regex': r'^[^@]+@[^@]+\.[^@]+$'},
            {'type': 'string', 'regex': r'^\d{10}$'}
        ]
    }
}
validator = Validator(schema)

# Success case - meets first condition
document = {'contact': 'john@example.com'}
result = validator.validate(document)
print(result)  # True

# Success case - meets second condition
document = {'contact': '1234567890'}
result = validator.validate(document)
print(result)  # True

# Failure case - no conditions met
document = {'contact': 'invalid'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'contact': ["no definitions validate"]}

# allof validation - all conditions must be met
schema = {
    'password': {
        'allof': [
            {'type': 'string', 'minlength': 8},
            {'regex': r'[A-Z]'},
            {'regex': r'[a-z]'},
            {'regex': r'\d'}
        ]
    }
}
validator = Validator(schema)

# Success case - meets all conditions
document = {'password': 'Secure123'}
result = validator.validate(document)
print(result)  # True

# Failure case - does not meet all conditions
document = {'password': 'weak'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {"password": ["one or more definitions don't validate"]}

# oneof validation - exactly one condition must be met
schema = {
    'number': {
        'oneof': [
            {'type': 'integer', 'min': 0, 'max': 10},
            {'type': 'integer', 'min': 20, 'max': 30}
        ]
    }
}
validator = Validator(schema)
# Success case - meets first condition
document = {'number': 5}
result = validator.validate(document)
print(result)  # True

# Failure case - meets multiple conditions
document = {'number': 15}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'number': ['none or more than one rule validate']}

# Test validation
assert validator.validate({'contact': 'john@example.com'}) == True
assert validator.validate({'contact': 'invalid'}) == False
assert 'no definitions validate' in str(validator.errors)
```

### Node 12: Custom Validation Rules

**Functionality**: Adds custom validation rules by extending the Validator class.

**Core Algorithms**:
- Method naming: Custom methods start with _validate_
- Parameter handling: Receives constraints, field name, and value
- Error reporting: Uses _error method to report validation errors

**Input/Output Examples**：

```python
from cerberus import Validator

# Custom validator
class CustomValidator(Validator):
    def _validate_is_even(self, is_even, field, value):
        """Validate whether the field is an even number"""
        if is_even and value % 2 != 0:
            self._error(field, 'must be even')
    
    def _validate_is_odd(self, is_odd, field, value):
        """Validate whether the field is an odd number"""
        if is_odd and value % 2 == 0:
            self._error(field, 'must be odd')
    
    def _validate_type_objectid(self, value):
        """Custom ObjectId type validation"""
        import re
        pattern = r'^[0-9a-fA-F]{24}$'
        if not re.match(pattern, str(value)):
            return False
        return True

# Use the custom validator
schema = {
    'number': {'type': 'integer', 'is_even': True},
    'id': {'type': 'objectid'}
}
validator = CustomValidator(schema)
# Success case
document = {'number': 4, 'id': '507f1f77bcf86cd799439011'}
result = validator.validate(document)
print(result)  # True

# Failure case - even validation fails
document = {'number': 3, 'id': '507f1f77bcf86cd799439011'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'number': ['must be even']}

# Failure case - ObjectId validation fails
document = {'number': 4, 'id': 'invalid-id'}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'id': ['must be of objectid type']}

# Custom coerce function
class MyNormalizer(Validator):
    def __init__(self, multiplier, *args, **kwargs):
        super(MyNormalizer, self).__init__(*args, **kwargs)
        self.multiplier = multiplier
    
    def _normalize_coerce_multiply(self, value):
        return value * self.multiplier

# Custom normalization method
validator = MyNormalizer(2, {'foo': {'coerce': 'multiply'}})
result = validator.normalized({'foo': 3})
print(result)  # {'foo': 6}

# Test validation
assert validator.validate({'number': 4, 'id': '507f1f77bcf86cd799439011'}) == True
assert validator.validate({'number': 3, 'id': '507f1f77bcf86cd799439011'}) == False
assert 'must be even' in str(validator.errors)
```
### Node 13: Registry System

**Functionality**: Manages reusable schemas and rule sets using a registry.

**Core Algorithms**:
- Schema Registration: Register validation schemas to schema_registry
- Ruleset Registration: Register rule sets to rules_set_registry
- Reference Resolution: Resolve registry references in schemas

**Input/Output Examples**:

```python
from cerberus import Validator, schema_registry, rules_set_registry

# Register schema
schema_registry.add('user_schema', {
    'name': {'type': 'string', 'required': True},
    'email': {'type': 'string', 'regex': r'^[^@]+@[^@]+\.[^@]+$'}
})

# Use registered schema
schema = {
    'admin': {'schema': 'user_schema'},
    'user': {'schema': 'user_schema'}
}
validator = Validator(schema)

# Success case
document = {
    'admin': {'name': 'Admin', 'email': 'admin@example.com'},
    'user': {'name': 'User', 'email': 'user@example.com'}
}
result = validator.validate(document)
print(result)  # True

# Register ruleset
rules_set_registry.add('integer_positive', {
    'type': 'integer',
    'min': 0
})

# Use registered ruleset
schema = {
    'age': 'integer_positive',
    'score': 'integer_positive'
}
validator = Validator(schema)

# Success case
document = {'age': 25, 'score': 100}
result = validator.validate(document)
print(result)  # True

# Failure case
document = {'age': -5, 'score': 100}
result = validator.validate(document)
print(result)  # False
print(validator.errors)  # {'age': ['min value is 0']}

# Recursive reference
rules_set_registry.add('self', {
    'type': 'dict',
    'allow_unknown': 'self'
})
validator = Validator(allow_unknown='self')

# Success case - recursive structure
document = {0: {1: {2: {}}}}
result = validator.validate(document)
print(result)  # True

# Test validation
assert validator.validate({'admin': {'name': 'Admin', 'email': 'admin@example.com'}}) == True
assert validator.validate({'age': 25, 'score': 100}) == True
assert validator.validate({'age': -5, 'score': 100}) == False
assert 'min value is 0' in str(validator.errors)
```

### Node 14: Error Handling and Reporting

**Functionality**: Collects, formats, and reports validation errors.

**Core Algorithms**:
- Error Collection: Gather all validation errors
- Error Tree Construction: Build error trees for documents and schemas
- Error Formatting: Format error messages using error handlers

**Input/Output Examples**:

```python
from cerberus import Validator, errors

# Basic error handling
schema = {
    'name': {'type': 'string', 'required': True},
    'age': {'type': 'integer', 'min': 0, 'max': 150},
    'email': {'type': 'string', 'regex': r'^[^@]+@[^@]+\.[^@]+$'}
}
validator = Validator(schema)

# Document containing multiple errors
document = {
    'age': 200,
    'email': 'invalid-email'
}
result = validator.validate(document)
print(result)  # False
print(validator.errors)
# Output:
# {
#     'name': ['required field'],
#     'age': ['max value is 150'],
#     "email": ["value does not match regex '^[^@]+@[^@]+\\.[^@]+$'"]
# }

# Error tree query
document = {
    'user': {
        'name': 123,  # Should be a string
        'address': {
            'street': None  # None not allowed
        }
    }
}
schema = {
    'user': {
        'type': 'dict',
        'schema': {
            'name': {'type': 'string'},
            'address': {
                'type': 'dict',
                'schema': {
                    'street': {'type': 'string', 'nullable': False}
                }
            }
        }
    }
}
validator = Validator(schema)
result = validator.validate(document)

# Query document error tree
doc_errors = validator.document_error_tree
print('user' in doc_errors)  # True
print('name' in doc_errors['user'])  # True
print('address' in doc_errors['user'])  # True

# Query schema error tree
schema_errors = validator.schema_error_tree
print('user' in schema_errors)  # True
print('schema' in schema_errors['user'])  # True

# Custom error handler
class CustomErrorHandler(errors.BasicErrorHandler):
    def __init__(self, tree=None):
        super(CustomErrorHandler, self).__init__(tree)
        self.messages[errors.REQUIRED_FIELD.code] = 'Field {0} is required'
        self.messages[errors.BAD_TYPE.code] = 'Field {0} must be {1} type'

# Using the custom error handler
validator = Validator(schema, error_handler=CustomErrorHandler)
document = {'name': 123}
result = validator.validate(document)
print(validator.errors)  # {'name': ['Field name must be string type']}

# Test validation
assert validator.validate({'name': 'John', 'age': 25, 'email': 'john@example.com'}) == True
assert validator.validate({'age': 200, 'email': 'invalid'}) == False
assert 'required field' in str(validator.errors)
assert 'max value is 150' in str(validator.errors)
```

### Node 15: Performance Optimization and Caching

**Functionality**: Improves validation performance through caching and optimization.

**Core Algorithms**:
- Schema Caching: Cache validated schemas
- Cache Cleanup: Remove expired cache entries
- Performance Monitoring: Monitor validation performance

**Input/Output Examples**:

```python
from cerberus import Validator

# Schema cache test
validator = Validator({'foo': {'type': 'string'}})
initial_cache_size = len(validator._valid_schemas)

# Using the same schema
validator2 = Validator({'foo': {'type': 'string'}})
cache_size_after_same = len(validator2._valid_schemas)
print(cache_size_after_same == initial_cache_size)  # True

# Using a different schema
validator3 = Validator({'bar': {'type': 'integer'}})
cache_size_after_different = len(validator3._valid_schemas)
print(cache_size_after_different == initial_cache_size + 1)  # True

# Clear cache
validator.clear_caches()
print(len(validator._valid_schemas))  # 0

# 性能测试
import time

# Complex schema
complex_schema = {
    'user': {
        'type': 'dict',
        'schema': {
            'name': {'type': 'string', 'required': True},
            'email': {'type': 'string', 'regex': r'^[^@]+@[^@]+\.[^@]+$'},
            'age': {'type': 'integer', 'min': 0, 'max': 150},
            'address': {
                'type': 'dict',
                'schema': {
                    'street': {'type': 'string'},
                    'city': {'type': 'string'},
                    'zip': {'type': 'string', 'regex': r'^\d{5}$'}
                }
            },
            'roles': {
                'type': 'list',
                'schema': {'type': 'string', 'allowed': ['admin', 'user', 'guest']}
            }
        }
    }
}

# Test document
test_document = {
    'user': {
        'name': 'John Doe',
        'email': 'john@example.com',
        'age': 30,
        'address': {
            'street': '123 Main St',
            'city': 'Anytown',
            'zip': '12345'
        },
        'roles': ['user', 'admin']
    }
}

# 性能测试
validator = Validator(complex_schema)
start_time = time.time()
for _ in range(1000):
    validator.validate(test_document)
end_time = time.time()

print(f"1000 validations took: {end_time - start_time:.4f} seconds")

# Test validation
assert len(validator._valid_schemas) > 0
validator.clear_caches()
assert len(validator._valid_schemas) == 0
```

These functional nodes cover all core features of the Cerberus project, including basic validation, normalization, error handling, and custom extensions. Each node provides detailed input/output examples and test interfaces, demonstrating practical usage scenarios and validation results.
