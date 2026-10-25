## Introduction and Objectives of the Python-pytest-cases Project

Python-pytest-cases is a Python library **designed for separate management of test cases**. It can separate test code from test data and provides powerful parameterized testing capabilities. This tool performs exceptionally well in large-scale test projects, enabling "optimal test organization structure and maximum maintainability". Its core functions include: separation of test cases (automatically collecting test data from independent case files), **enhanced parameterized testing** (supporting multiple data sources, tag filtering, dynamic generation, etc.), and intelligent management of advanced features such as fixtures, markers, and filtering. In short, Python-pytest-cases aims to provide a powerful test case management framework for building maintainable and extensible test suites (for example, separating test functions from test data through the `@parametrize_with_cases` decorator and providing test data through `case_*` functions).

## Natural Language Instruction (Prompt)

Please create a Python project named Python-pytest-cases to implement a library for separate management of test cases. The project should include the following functions:

1. **Test Case Separator**: It should be able to collect and manage test cases from independent files, supporting multiple naming conventions (such as `case_*`, `data_*`, `user_*`, etc.). The separator should automatically discover test case files (such as `test_foo_cases.py` or `cases_foo.py`) and separate test data from test logic.

2. **Enhanced Parameterized Testing**: Implement the `@parametrize_with_cases` decorator, which can replace the standard `@pytest.mark.parametrize` and provide more powerful parameterized functions. It should support multiple data sources (modules, classes, function lists), tag filtering, regular expression matching, and dynamic test case generation.

3. **Advanced Filtering and Marking System**: Perform intelligent filtering and marking of test cases, supporting a tag system (`@case(tags=...)`), regular expression matching, custom filtering functions, etc. It should provide filtering mechanisms such as `has_tag`, `id_match_regex`, and `CaseFilter`.

4. **Enhanced Fixture Functionality**: Implement enhanced fixture functionality, including fixture unions, lazy values, fixture parametrization, etc. It should support the use of test cases in fixtures and manage complex dependencies between fixtures.

5. **Interface Design**: Design independent interfaces for each functional module (such as case collection, parametrization, filtering, fixture enhancement, etc.), supporting command-line calls and programming interfaces. Each module should define clear input and output formats and provide complete type annotations.

6. **Examples and Test Scripts**: Provide example code and test cases to demonstrate how to use `@parametrize_with_cases` for test case separation (for example, the `@parametrize_with_cases("a,b")` decorator combined with the `case_two_positive_ints()` function should be able to automatically run tests). The above functions need to be combined to build a complete test case management toolkit.

7. **Core File Requirements**: The project must include a well-configured `pyproject.toml` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `pytest>=6.0`, `makefun>=1.15.1`, `decopatch`, `packaging`, etc.). The `pyproject.toml` file can verify whether all functional modules work properly. At the same time, it is necessary to provide `src/pytest_cases/__init__.py` as a unified API entry, importing core functions and classes from each module and exporting core functions such as `parametrize_with_cases`, `case`, and `current_cases`. Among them, `parametrize_with_cases` is a decorator used to parametrize test functions or fixtures, which can automatically collect and filter test cases; the `case` decorator is used to customize the ID, tags, and markers of test cases; the `current_cases` function (or fixture) is used to obtain information about all case parameters of the current test. Users can access all major functions through a simple `from pytest_cases import parametrize_with_cases, case` statement. In the core module, there needs to be a `get_current_cases()` function to obtain detailed information about the current test case, as well as a `CaseFilter` class to implement complex filtering logic.

## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
# Core testing framework
pytest>=6.0                      # Foundation for unit testing framework
makefun>=1.15.1                  # Library for dynamic function generation
decopatch                         # Decorator patch library

# Data processing library  
packaging                         # Python package management tool
setuptools_scm                   # Version management tool

# Development tool library
nox                               # Multi-environment testing tool
mkdocs-material                   # Documentation generation framework
pymdown-extensions               # Markdown extensions

# Code quality tool
flake8                           # Code style checker
pytest-steps                     # Test step management
pytest-harvest                   # Test result collection
pytest-asyncio                   # Asynchronous testing support
```

## Architecture of the Python-pytest-cases Project

### Project Directory Structure

```Plain
workspace/
├── .gitignore         
├── .zenodo.json       
├── LICENSE
├── README.md
├── ci_tools
│   ├── .pylintrc
│   ├── check_python_version.py
│   ├── flake8-requirements.txt
│   ├── github_release.py
│   └── nox_utils.py
├── docs
│   ├── api_reference.md
│   ├── changelog.md
│   ├── examples.md
│   ├── imgs
│   │   ├── 0_bench_plots_example.png
│   │   ├── 0_bench_plots_example2.png
│   │   ├── 0_bench_plots_example3.png
│   │   ├── 0_bench_plots_example4.png
│   │   ├── 0_dummy_bench_results.png
│   │   ├── 1_files_overview.png
│   │   ├── 2_class_overview.png
│   │   ├── 3_fixture_graph_pytest.png
│   │   ├── 4_fixture_graph_pytest_closure.png
│   │   ├── 5_fixture_graph_union.png
│   │   ├── 6_fixture_graph_union_closures.png
│   │   └── source.pptx
│   ├── index.md
│   ├── long_description.md
│   ├── pytest_goodies.md
│   └── unions_theory.md
├── mkdocs.yml
├── noxfile-requirements.txt
├── noxfile.py
├── pyproject.toml
└── src
    └──pytest_cases
        ├── __init__.py
        ├── case_funcs.py
        ├── case_parametrizer_new.py
        ├── common_mini_six.py
        ├── common_others.py
        ├── common_pytest.py
        ├── common_pytest_lazy_values.py
        ├── common_pytest_marks.py
        ├── filters.py
        ├── fixture__creation.py
        ├── fixture_core1_unions.py
        ├── fixture_core2.py
        ├── fixture_parametrize_plus.py
        ├── pep380.py
        ├── pep492.py
        ├── pep525.py
        ├── plugin.py
        └── py.typed
```

## API Usage Guide

### Core API

#### 1. `Folders` - Directory Structure Management

**Description**:
Directory path management class for the project's build system, providing organized access to various project directories.

**Import Statement**:
```python
from noxfile import Folders
```

**Class Signature**:
```python
class Folders:
    root = Path(__file__).parent
    ci_tools = root / "ci_tools"
    runlogs = root / Path(nox.options.envdir or ".nox") / "_runlogs"
    runlogs.mkdir(parents=True, exist_ok=True)
    dist = root / "dist"
    site = root / "site"
    site_reports = site / "reports"
    reports_root = root / "docs" / "reports"
    test_reports = reports_root / "junit"
    test_xml = test_reports / "junit.xml"
    test_html = test_reports / "report.html"
    test_badge = test_reports / "junit-badge.svg"
    coverage_reports = reports_root / "coverage"
    coverage_xml = coverage_reports / "coverage.xml"
    coverage_intermediate_file = root / ".coverage"
    coverage_badge = coverage_reports / "coverage-badge.svg"
    flake8_reports = reports_root / "flake8"
    flake8_intermediate_file = root / "flake8stats.txt"
    flake8_badge = flake8_reports / "flake8-badge.svg"
```

#### 2. `CaseParamValue` - Case Parameter Value Base Class

**Description**:
Abstract base class for case parameter values in test case parametrization.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import CaseParamValue
```

**Class Signature**:
```python
class CaseParamValue(object):
    """Common class for lazy values and fixture refs created from cases"""
    __slots__ = ()

    def get_case_id(self):
        raise NotImplementedError()

    def get_case_function(self, request):
        raise NotImplementedError()
```

**Function Description**:
- `get_case_id()`: Returns the case identifier string.
- `get_case_function(request)`: Retrieves the case function for the given request.

**Parameter Description**:
- `self`: The instance of the case parameter value.
- `request`: The pytest request object containing context for fixture resolution.

#### 3. `_LazyValueCaseParamValue` - Lazy Value Case Parameter Value

**Description**:
Case parameter value implementation using lazy value mechanism.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _LazyValueCaseParamValue
```

**Class Signature**:
```python
class _LazyValueCaseParamValue(LazyValue, CaseParamValue):
    """A case that does not require any fixture is transformed into a `lazy_value` parameter
    when passed to @parametrize.

    We subclass it so that we can easily find back all parameter values that are cases
    """
    def get_case_id(self): ...
    def get_case_function(self, request): ...
    def as_lazy_tuple(self, nb_params): ...
```

**Function Description**:
- `get_case_id()`: Returns the unique case identifier.
- `get_case_function(request)`: Retrieves the case function for the given request object.
- `as_lazy_tuple(nb_params)`: Converts the lazy value case parameter to a lazy tuple.

**Parameter Description**:
- `self`: The instance of the lazy value case parameter value.
- `request`: The pytest request object for fixture resolution.
- `nb_params`: Number of parameters in the lazy tuple.

#### 4. `_LazyTupleCaseParamValue` - Lazy Tuple Case Parameter Value

**Description**:
Case parameter value implementation using lazy tuple mechanism.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _LazyTupleCaseParamValue
```

**Class Signature**:
```python
class _LazyTupleCaseParamValue(LazyTuple, CaseParamValue):
    """A case representing a tuple"""
    def get_case_id(self): ...
    def get_case_function(self, request): ...
   
```

**Function Description**:
- `get_case_id()`: Returns the unique case identifier.
- `get_case_function(request)`: Retrieves the case function for the given request object.

**Parameter Description**:
- `self`: The instance of the lazy tuple case parameter value.
- `request`: The pytest request object for fixture resolution.

#### 5. `_FixtureRefCaseParamValue` - Fixture Reference Case Parameter Value

**Description**:
Case parameter value implementation for fixture references.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _FixtureRefCaseParamValue
```

**Class Signature**:
```python
class _FixtureRefCaseParamValue(fixture_ref, CaseParamValue):
    """A case that requires at least a fixture is transformed into a `fixture_ref` parameter when passed to @parametrize"""

    def get_case_id(self): ...
    def get_case_function(self, request): ...
```

**Function Description**:
- `get_case_id()`: Returns the unique case identifier.
- `get_case_function(request)`: Retrieves the case function for the given request object.

**Parameter Description**:
- `self`: The instance of the fixture reference case parameter value.
- `request`: The pytest request object for fixture resolution.

#### 6. `CasesCollectionWarning` - Cases Collection Warning

**Description**:
Warning raised during test case collection.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import CasesCollectionWarning
```

**Class Signature**:
```python
class CasesCollectionWarning(UserWarning):
    """
    Warning emitted when pytest cases is not able to collect a file or symbol in a module.
    """
    # Note: if we change this, then the symbol MUST be present in __init__ for import, see GH#249
    __module__ = "pytest_cases"
```

#### 7. `ExceptionCheckingError` - Exception Checking Error

**Description**:
Error class for exception checking during test execution.

**Import Statement**:
```python
from pytest_cases.common_others import ExceptionCheckingError
```

**Class Signature**:
```python
class ExceptionCheckingError(AssertionError):
    pass
```

#### 8. `AssertException` - Assert Exception Context Manager

**Description**:
Context manager for asserting exceptions in tests.

**Import Statement**:
```python
from pytest_cases.common_others import AssertException
```

**Class Signature**:
```python
class AssertException(object):
    """ An implementation of the `assert_exception` context manager"""

    __slots__ = ('expected_exception', 'err_type', 'err_ptrn', 'err_inst', 'err_checker')

    def __init__(self, expected_exception): ...
    def __enter__(self): ...
    def __exit__(self, exc_type, exc_val, exc_tb): ...
```

**Function Description**:
- `__init__(expected_exception)`: Initializes the assertion context manager with the expected exception type.
- `__enter__(self)`: Enters the context manager context.
- `__exit__(exc_type, exc_val, exc_tb)`: Exits the context manager and checks if the expected exception was raised.

**Parameter Description**:
- `self`: The instance of the assertion context manager.
- `expected_exception`: The exception type that is expected to be raised.
- `exc_type`: The type of the exception raised, if any.
- `exc_val`: The exception value raised, if any.
- `exc_tb`: The exception traceback raised, if any.

#### 9. `HostNotConstructedYet` - Host Not Constructed Yet

**Description**:
Exception raised when test host module is not yet constructed.

**Import Statement**:
```python
from pytest_cases.common_others import HostNotConstructedYet
```

**Class Signature**:
```python
class HostNotConstructedYet(Exception):
    """Raised by `get_class_that_defined_method` in the situation where the host class is not in the host module yet."""
    pass
```

#### 10. `FakeSession` - Fake Session

**Description**:
Mock session object for testing purposes.

**Import Statement**:
```python
from pytest_cases.common_pytest import FakeSession
```

**Class Signature**:
```python
class FakeSession(object):
      __slots__ = ('_fixturemanager',)

    def __init__(self):
        self._fixturemanager = None
```

**Function Description**:
- `__init__(self)`: Initializes a fake session object for testing.

**Parameter Description**:
- `self`: The instance of the fake session.

#### 11. `MiniFuncDef` - Mini Function Definition

**Description**:
Minimal function definition object for test metadata.

**Import Statement**:
```python
from pytest_cases.common_pytest import MiniFuncDef
```

**Class Signature**:
```python
class MiniFuncDef(object):
    __slots__ = ('nodeid', 'session')

    def __init__(self, nodeid):
        self.nodeid = nodeid
        if PYTEST8_OR_GREATER:
            self.session = FakeSession()
```

**Function Description**:
- `__init__(nodeid)`: Initializes a mini function definition with a node identifier.

**Parameter Description**:
- `self`: The instance of the mini function definition.
- `nodeid`: The pytest node identifier for the function.

#### 12. `MiniMetafunc` - Mini Metafunc

**Description**:
Minimal metafunc object for test parametrization.

**Import Statement**:
```python
from pytest_cases.common_pytest import MiniMetafunc
```

**Class Signature**:
```python
class MiniMetafunc(Metafunc):
    """
    A class to know what pytest *would* do for a given function in terms of callspec.
    It is ONLY used in function `case_to_argvalues` and only the following are read:

    - is_parametrized (bool)
    - requires_fixtures (bool)
    - fixturenames_not_in_sig (declared used fixtures with @pytest.mark.usefixtures)

    Computation of the latter requires

    """
    def __init__(self, func): ...
    @property
    def is_parametrized(self): ...
    @property
    def requires_fixtures(self): ...
    def update_callspecs(self): ...
```

**Function Description**:
- `__init__(func)`: Initializes a mini metafunc object with a function.
- `is_parametrized()`: Checks if the function is parametrized.
- `requires_fixtures`: Returns whether the function requires fixtures.
- `update_callspecs`: Updates the call specifications for the function.

**Parameter Description**:
- `self`: The instance of the mini metafunc.
- `func`: The function object to wrap.

#### 13. `Lazy` - Lazy Value Case Parameter Value

**Description**:
Case parameter value implementation using lazy value mechanism.

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import Lazy
```

**Class Signature**:
```python
class Lazy(object):
    """
    All lazy items should inherit from this for good pytest compliance (ids, marks, etc.)
    """
    __slots__ = ()

    _field_names = ()
    """Subclasses should fill this variable to get an automatic __eq__ and __repr__."""

    def get_id(self): ...
    def get(self, request_or_item): ...
    def __str__(self): ...
    def __eq__(self, other): ...
    def __repr__(self): ...
    @property
    def __name__(self): ...
    @classmethod
    def copy_from(cls, obj): ...
    def clone(self): ...
```

**Function Description**:
- `get_id()`: Returns the identifier for this lazy value.
- `get(request_or_item)`: Resolves and returns the concrete value in the given context.
- `__str__()`: Returns a readable string representation.
- `__eq__(other)`: Compares two lazy values for equality.
- `__repr__()`: Returns the unambiguous representation used for debugging.
- `__name__()`: Returns a display name for the lazy value.
- `copy_from(cls, obj)`: Creates a new lazy wrapper copied from an existing object.
- `clone()`: Returns a clone of this lazy value.

**Parameter Description**:
- `self`: The current lazy value instance.
- `request_or_item`: Pytest request/item context used to resolve the value.
- `other`: The object to compare for equality.
- `obj`: The source object used to create a copy.

#### 14. `_LazyValue` - Lazy Value Case Parameter Value

**Description**:
Case parameter value implementation using lazy value mechanism.

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import _LazyValue
```

**Class Signature**:
```python
class _LazyValue(Lazy):
    """
    A reference to a value getter, to be used in `parametrize`.

    A `lazy_value` is the same thing than a function-scoped fixture, except that the value getter function is not a
    fixture and therefore can neither be parametrized nor depend on fixtures. It should have no mandatory argument.

    The `self.get(request)` method can be used to get the value for the current pytest context. This value will
    be cached so that plugins can call it several time without triggering new calls to the underlying function.
    So the underlying function will be called exactly once per test node.

    See https://github.com/smarie/python-pytest-cases/issues/149
    and https://github.com/smarie/python-pytest-cases/issues/143
    """
    if PYTEST53_OR_GREATER:
        __slots__ = 'valuegetter', '_id', '_marks', 'cached_value_context', 'cached_value'
        _field_names = __slots__
    else:
        # we can not define __slots__ since we'll extend int in a subclass
        # see https://docs.python.org/3/reference/datamodel.html?highlight=__slots__#notes-on-using-slots
        _field_names = 'valuegetter', '_id', '_marks', 'cached_value_context', 'cached_value'
    @classmethod
    def copy_from(cls,
                  obj  # type: _LazyValue
                  ): ...
    def __init__(self,
                 valuegetter,  # type: Callable[[], Any]
                 id=None,      # type: str  # noqa
                 marks=None,   # type: Union[MarkDecorator, Iterable[MarkDecorator]]
                 ): ...
    def __hash__(self): ...
    def get_marks(self,
                  as_decorators=False  # type: bool
                  ): ...
    def get_id(self): ...
    def get(self, request_or_item): ...
    def has_cached_value(self, request_or_item = None, node = None, raise_if_no_context = True): ...
    def as_lazy_tuple(self, nb_params): ...
    def as_lazy_items_list(self, nb_params): ...
```

**Function Description**:
- `copy_from(cls, obj)`: Creates a new `_LazyValue` copied from an object.
- `__init__(valuegetter, id = None, marks = None)`: Builds a lazy value from a getter with optional id and marks.
- `__hash__()`: Returns the hash for dictionary/set usage.
- `get_marks(as_decorators = False)`: Returns the associated pytest marks.
- `get_id()`: Returns the identifier string.
- `get(request_or_item)`: Resolves and returns the concrete value.
- `has_cached_value(request_or_item = None, node = None, raise_if_no_context = True)`: Indicates whether a cached value exists.
- `as_lazy_tuple(nb_params)`: Converts to a lazy tuple of length `nb_params`.
- `as_lazy_items_list(nb_params)`: Converts to a list of lazy items.

**Parameter Description**:
- `self`: The `_LazyValue` instance.
- `obj`: Source object for copying.
- `valuegetter`: Callable used to compute the value lazily.
- `id`: Optional explicit identifier.
- `marks`: Optional pytest marks.
- `as_decorators`: If True, returns marks as decorators.
- `request_or_item`: Pytest context used to resolve the value.
- `node`: Optional pytest node.
- `raise_if_no_context`: If True, raises if no context is available.
- `nb_params`: Number of parameters/size for conversions.

#### 15. `_LazyTupleItem` - Lazy Value Base Class

**Description**:
Base class for lazy loading of values.

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import _LazyTupleItem
```

**Class Signature**:
```python
class _LazyTupleItem(Lazy):
    """
    An item in a Lazy Tuple
    """
    if PYTEST53_OR_GREATER:
        __slots__ = 'host', 'item'
        _field_names = __slots__
    else:
        # we can not define __slots__ since we'll extend int in a subclass
        # see https://docs.python.org/3/reference/datamodel.html?highlight=__slots__#notes-on-using-slots
        _field_names = 'host', 'item'
    @classmethod
    def copy_from(cls,
                  obj  # type: _LazyTupleItem
                  ): ...
    def __init__(self,
                 host,  # type: LazyTuple
                 item   # type: int
                 ): ...
    def __hash__(self): ...
    def __repr__(self): ...
    def get_id(self): ...
    def get(self, request_or_item): ...
```

**Function Description**:
- `copy_from(cls, obj)`: Creates a new `_LazyTupleItem` copied from an object.
- `__init__(host, item)`: Initializes a lazy tuple item with host and item.
- `__hash__()`: Hash support.
- `__repr__()`: Debug representation.
- `get_id()`: Returns the identifier.
- `get(request_or_item)`: Resolves the concrete value.

**Parameter Description**:
- `self`: The `_LazyTupleItem` instance.
- `obj`: Source object for copying.
- `host`: The tuple host.
- `item`: The tuple element.
- `request_or_item`: Pytest context for resolution.

#### 16. `LazyTuple` - Lazy Tuple Case Parameter Value

**Description**:
Case parameter value implementation using lazy tuple mechanism.

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import LazyTuple
```

**Class Signature**:
```python
class LazyTuple(Lazy):
    """
    A wrapper representing a lazy_value used as a tuple = for several argvalues at once.

    Its `.get()` method caches the tuple obtained from the value getter, so that it is not called several times (once
    for each LazyTupleItem)

    It is only used directly by pytest when a lazy_value is used in a @ parametrize to decorate a fixture.
    Indeed in that case pytest does not unpack the tuple, we do it in our custom @fixture.

    In all other cases (when @parametrize is used on a test function), pytest unpacks the tuple so it directly
    manipulates the underlying LazyTupleItem instances.
    """
    __slots__ = '_lazyvalue', 'theoretical_size'
    _field_names = __slots__
    @classmethod
    def copy_from(cls,
                  obj  # type: LazyTuple
                  ): ...
    def __init__(self,
                 valueref,         # type: _LazyValue
                 theoretical_size  # type: int
                 ): ...
    def __hash__(self): ...
    def __len__(self): ...
    def get_id(self): ...
    def get(self, request_or_item): ...
    def has_cached_value(self, request_or_item = None, node = None, raise_if_no_context = True): ...
    @property
    def cached_value(self): ...
    def __getitem__(self, item): ...
    def force_getitem(self, item, request): ...
```

**Function Description**:
- `copy_from(cls, obj)`: Creates a new `LazyTuple` from an object.
- `__init__(valueref, theoretical_size)`: Initializes with a value reference and expected size.
- `__hash__()`: Hash support.
- `__len__()`: Returns tuple length.
- `get_id()`: Identifier for the lazy tuple.
- `get(request_or_item)`: Resolves and returns the tuple value.
- `has_cached_value(request_or_item = None, node = None, raise_if_no_context = True)`: Indicates if a cached value exists.
- `cached_value()`: Returns the cached value when present.
- `__getitem__(item)`: Returns the item at index (property form).
- `force_getitem(item, request)`: Resolves and returns the item at index in the given request.

**Parameter Description**:
- `self`: The `LazyTuple` instance.
- `obj`: Source object for copying.
- `valueref`: Reference enabling lazy resolution of the tuple.
- `theoretical_size`: Expected size for the tuple.
- `request_or_item`: Pytest context for resolution.
- `node`: Optional pytest node.
- `raise_if_no_context`: If True, raises without context.
- `item`: Index to access.
- `request`: Pytest request used to force item resolution.

#### 17. `_ParametrizationMark` - Parametrization Mark

**Description**:
Internal mark object for parametrization.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import _ParametrizationMark
```

**Class Signature**:
```python
class _ParametrizationMark:
    """
    Container for the mark information that we grab from the fixtures (`@fixture`)

    Represents the information required by `@fixture` to work.
    """
    __slots__ = "param_names", "param_values", "param_ids"

    def __init__(self, mark)
```

**Function Description**:
- `__init__(mark)`: Initializes a parametrization mark wrapper.

**Parameter Description**:
- `self`: The `_ParametrizationMark` instance.
- `mark`: The underlying pytest mark.

#### 18. `_LegacyMark` - Legacy Mark

**Description**:
Legacy mark object for backward compatibility.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import _LegacyMark
```

**Class Signature**:
```python
class _LegacyMark:
    __slots__ = "args", "kwargs"

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
```

**Function Description**:
- `__init__(*args, **kwargs)`: Initializes a legacy mark with arbitrary parameters.

**Parameter Description**:
- `self`: The `_LegacyMark` instance.
- `*args`: Positional arguments passed to the legacy mark.
- `**kwargs`: Keyword arguments passed to the legacy mark.

#### 19. `_NotUsed` - Not Used Marker

**Description**:
Marker class for unused fixtures.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import _NotUsed
```

**Class Signature**:
```python
class _NotUsed:
    def __repr__(self):
        return "pytest_cases.NOT_USED"
```

**Function Description**:
- `__repr__()`: Returns a compact representation for debugging.

**Parameter Description**:
- `self`: The `_NotUsed` instance.

#### 20. `_Used` - Not Used Marker

**Description**:
Marker class for unused fixtures.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import _Used
```

**Class Signature**:
```python
class _Used:
    def __repr__(self):
        return "pytest_cases.USED"
```

**Function Description**:
- `__repr__()`: Returns a compact representation for debugging.

**Parameter Description**:
- `self`: The `_Used` instance.

#### 21. `UnionIdMakers` - Union ID Makers

**Description**:
ID generation strategies for union fixtures.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import UnionIdMakers
```

**Class Signature**:
```python
class UnionIdMakers(object):

    """
    The enum defining all possible id styles for union fixture parameters ("alternatives")
    """
    @classmethod
    def nostyle(cls,
                param  # type: UnionFixtureAlternative
                ): ...
    @classmethod
    def compact(cls,
                param  # type: UnionFixtureAlternative
                ): ...
    @classmethod
    def explicit(cls,
                 param  # type: UnionFixtureAlternative
                 ): ...
    @classmethod
    def get(cls, style  # type: Union[str, Callable]
            ): ...
```

**Function Description**:
- `nostyle(param)`: Returns a neutral id string for `param`.
- `compact(param)`: Returns a compact id string for `param`.
- `explicit(param)`: Returns an explicit id string for `param`.
- `get(style)`: Returns the id maker matching `style`.

**Parameter Description**:
- `cls`: The class (classmethod usage).
- `param`: The parameter value to generate an id for.
- `style`: The id style name.

#### 22. `UnionFixtureAlternative` - Union Fixture Alternative

**Description**:
Alternative implementation for union fixtures.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import UnionFixtureAlternative
```

**Class Signature**:
```python
class UnionFixtureAlternative(object):
    """Defines an "alternative", used to parametrize a fixture union"""
    __slots__ = 'union_name', 'alternative_name', 'alternative_index'

    def __init__(self,
                 union_name,        # type: str
                 alternative_name,  # type: str
                 alternative_index  # type: int
                 ): ...
    def get_union_id(self): ...
    def get_alternative_idx(self): ...
    def get_alternative_id(self): ...
    def __str__(self): ...
    def __repr__(self): ...
    @staticmethod
    def to_list_of_fixture_names(alternatives_lst  # type: List[UnionFixtureAlternative]
                                 ): ...
```

**Function Description**:
- `__init__(union_name, alternative_name, alternative_index)`: Builds an alternative for a union fixture.
- `get_union_id()`: Returns the id of the union.
- `get_alternative_idx()`: Returns the index of this alternative.
- `get_alternative_id()`: Returns the id of this alternative.
- `__str__()`: Human-readable string.
- `__repr__()`: Debug representation.
- `to_list_of_fixture_names(alternatives_lst)`: Converts alternatives to a list of fixture names.

**Parameter Description**:
- `self`: The `UnionFixtureAlternative` instance.
- `union_name`: Name of the union fixture.
- `alternative_name`: Name of the alternative.
- `alternative_index`: Index within the union.
- `alternatives_lst`: A list of alternatives.

#### 23. `InvalidParamsList` - Invalid Parameters List

**Description**:
Exception raised when parameter list is invalid.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import InvalidParamsList
```

**Class Signature**:
```python
class InvalidParamsList(Exception):
    """
    Exception raised when users attempt to provide a non-iterable `argvalues` in pytest parametrize.
    See https://docs.pytest.org/en/latest/reference.html#pytest-mark-parametrize-ref
    """
    __slots__ = 'params',

    def __init__(self, params):
        self.params = params

    def __str__(self):
        return "Invalid parameters list (`argvalues`) in pytest parametrize. `list(argvalues)` returned an error. " \
               "Please make sure that `argvalues` is a list, tuple or iterable : %r" % self.params

```

**Function Description**:
- `__init__(params)`: Initializes the error with invalid `params`.
- `__str__()`: Returns the error message.

**Parameter Description**:
- `self`: The exception instance.
- `params`: The invalid parameters.

#### 24. `FixtureParam` - Fixture Parameter

**Description**:
Fixture parameter definition class.

**Import Statement**:
```python
from pytest_cases.fixture_core2 import FixtureParam
```

**Class Signature**:
```python
class FixtureParam(object):
    __slots__ = 'argnames',

    def __init__(self, argnames):
        self.argnames = argnames

    def __repr__(self):
        return "FixtureParam(argnames=%s)" % self.argnames
```

**Function Description**:
- `__init__(argnames)`: Declares a fixture parameter with argument names.
- `__repr__()`: Debug representation of the parameter.

**Parameter Description**:
- `self`: The `FixtureParam` instance.
- `argnames`: Parameter names string/tuple.

#### 25. `CombinedFixtureParamValue` - Combined Fixture Parameter Value

**Description**:
Combined fixture parameter value implementation.

**Import Statement**:
```python
from pytest_cases.fixture_core2 import CombinedFixtureParamValue
```

**Class Signature**:
```python
class CombinedFixtureParamValue(object):
     """Represents a parameter value created when @parametrize is used on a @fixture """
    __slots__ = 'param_defs', 'argvalues',

    def __init__(self,
                 param_defs,  # type: Iterable[FixtureParam]
                 argvalues): ...
    def iterparams(self): ...
    def __repr__(self): ...
```

**Function Description**:
- `__init__(param_defs, argvalues)`: Initializes with parameter definitions and values.
- `iterparams()`: Iterates underlying parameters.
- `__repr__()`: Debug representation.

**Parameter Description**:
- `self`: The instance.
- `param_defs`: Definitions of parameters.
- `argvalues`: Parameter values.

#### 26. `fixture_ref` - Fixture Reference

**Description**:
Reference to a fixture for lazy evaluation.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import fixture_ref
```

**Class Signature**:
```python
class fixture_ref(object):
    """
    A reference to a fixture, to be used in `@parametrize`.
    You can create it from a fixture name or a fixture object (function).
    """
    __slots__ = 'fixture', 'theoretical_size', '_id'

    def __init__(self,
                 fixture,  # type: Union[str, Callable]
                 id=None,  # type: str  # noqa
                 ): ...
    def get_name_for_id(self): ...
    def __str__(self): ...
    def __repr__(self): ...
    def _check_iterable(self): ...
    def __len__(self): ...
    def __getitem__(self, item): ...
```

**Function Description**:
- `__init__(fixture, id = None)`: Wraps a fixture reference, with optional explicit id.
- `get_name_for_id()`: Returns the name used for id generation.
- `__str__()`: Human-readable representation.
- `__repr__()`: Debug representation.
- `_check_iterable()`: Validates that the referenced value is iterable when needed.
- `__len__()`: Returns the number of elements (if iterable).
- `__getitem__(item)`: Indexing support when referencing sequences.

**Parameter Description**:
- `self`: The fixture reference wrapper.
- `fixture`: The referenced fixture or fixture name.
- `id`: Optional explicit id.
- `item`: Item index to retrieve.

#### 27. `FixtureRefItem` - Fixture Reference Item

**Description**:
Item in a fixture reference collection.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import FixtureRefItem
```

**Class Signature**:
```python
class FixtureRefItem(object):
    """An item in a fixture_ref when this fixture_ref is used as a tuple."""
    __slots__ = 'host', 'item'
    def __init__(self,
                 host,  # type: fixture_ref
                 item   # type: int
                 ): ...
    def __repr__(self) :
        return "FixtureRefItem(host=%s, item=%s)" % (self.host, self.item)
```

**Function Description**:
- `__init__(host, item)`: Initializes a reference item with host and item.
- `__repr__()`: Debug representation.

**Parameter Description**:
- `self`: The instance.
- `host`: The collection/host object.
- `item`: The referenced element.

#### 28. `ParamAlternative` - Parameter Alternative

**Description**:
Base class for parameter alternatives.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import ParamAlternative
```

**Class Signature**:
```python
class ParamAlternative(UnionFixtureAlternative):
    """Defines an "alternative", used to parametrize a fixture union in the context of parametrize

    It is similar to a union fixture alternative, except that it also remembers the parameter argnames.
    They are used to generate the test id corresponding to this alternative. See `_get_minimal_id` implementations.
    `ParamIdMakers` overrides some of the idstyles in `UnionIdMakers` so as to adapt them to these `ParamAlternative`
    objects.
    """
    __slots__ = ('argnames', 'decorated')

    def __init__(self,
                 union_name,        # type: str
                 alternative_name,  # type: str
                 param_index,       # type: int
                 argnames,          # type: Sequence[str]
                 decorated          # type: Callable
                 ): ...
    def get_union_id(self): ...
    def get_alternative_idx(self): ...
    def get_alternative_id(self): ...
```

**Function Description**:
- `__init__(union_name, alternative_name, param_index, argnames, decorated)`: Defines a parameter alternative.
- `get_union_id()`: Returns the union id this alternative belongs to.
- `get_alternative_idx()`: Returns the alternative index.
- `get_alternative_id()`: Returns the alternative id string.

**Parameter Description**:
- `self`: The `ParamAlternative` instance.
- `union_name`: The union fixture name.
- `alternative_name`: Alternative name.
- `param_index`: Parameter index associated with the alternative.
- `argnames`: Parameter argument names.
- `decorated`: Whether this alternative is decorated.

#### 29. `SingleParamAlternative` - Parameter Alternative

**Description**:
Base class for parameter alternatives.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import SingleParamAlternative
```

**Class Signature**:
```python
class SingleParamAlternative(ParamAlternative):
    """alternative class for single parameter value"""
    __slots__ = 'argval', 'id'

    def __init__(self,
                 union_name,        # type: str
                 alternative_name,  # type: str
                 param_index,       # type: int
                 argnames,          # type: Sequence[str]
                 argval,            # type: Any
                 id,                # type: Optional[str]
                 decorated          # type: Callable
                 ): ...
    def get_alternative_id(self): ...
    @classmethod
    def create(cls,
               new_fixture_host,   # type: Union[Type, ModuleType]
               test_func,          # type: Callable
               param_union_name,   # type: str
               argnames,           # type: Sequence[str]
               i,                  # type: int
               argvalue,           # type: Any
               id,                 # type: Union[str, Callable]
               scope=None,         # type: str
               hook=None,          # type: Callable
               debug=False         # type: bool
               ): ...
```

**Function Description**:
- `__init__(union_name, alternative_name, param_index, argnames, argval, id, decorated)`: Defines a single parameter alternative.
- `get_alternative_id()`: Returns the unique id for this alternative.
- `create(new_fixture_host, test_func, param_union_name, argnames, i, argvalue, id, scope = None, hook = None, debug = False)`: Factory method to build an alternative.

**Parameter Description**:
- `self`: The `SingleParamAlternative` instance.
- `union_name`: Union fixture name.
- `alternative_name`: Alternative name.
- `param_index`: Parameter index.
- `argnames`: Argument names.
- `argval`: Argument value.
- `id`: Explicit id.
- `decorated`: Decoration flag.
- `new_fixture_host`: Target fixture host.
- `test_func`: Target test function.
- `param_union_name`: Target union name.
- `i`: Index used during creation.
- `argvalue`: Value used during creation.
- `scope`: Fixture scope.
- `hook`: Optional hook.
- `debug`: Debug flag.

#### 30. `MultiParamAlternative` - Parameter Alternative

**Description**:
Base class for parameter alternatives.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import MultiParamAlternative
```

**Class Signature**:
```python
class MultiParamAlternative(ParamAlternative):
    """alternative class for multiple parameter values"""
    __slots__ = 'param_index_from', 'param_index_to'

    def __init__(self,
                 union_name,        # type: str
                 alternative_name,  # type: str
                 argnames,          # type: Sequence[str]
                 param_index_from,  # type: int
                 param_index_to,    # type: int
                 decorated          # type: Callable
                 ): ...
    def __str__(self): ...
    def get_alternative_idx(self): ...
    def get_alternative_id(self): ...
    @classmethod
    def create(cls,
               new_fixture_host,  # type: Union[Type, ModuleType]
               test_func,         # type: Callable
               param_union_name,  # type: str
               argnames,          # type: Sequence[str]
               from_i,            # type: int
               to_i,              # type: int
               argvalues,         # type: Any
               ids,               # type: Union[Sequence[str], Callable]
               scope="function",  # type: str
               hook=None,         # type: Callable
               debug=False        # type: bool
               ): ...
```

**Function Description**:
- `__init__(union_name, alternative_name, argnames, param_index_from, param_index_to, decorated)`: Defines a multi-parameter alternative.
- `__str__()`: String representation.
- `get_alternative_idx()`: Returns the index.
- `get_alternative_id()`: Returns the id.
- `create(new_fixture_host, test_func, param_union_name, argnames, from_i, to_i, argvalues, ids, scope = 'function', hook = None, debug = False)`: Factory method for multi-parameter alternative.

**Parameter Description**:
- `self`: The `MultiParamAlternative` instance.
- `union_name`: Union fixture name.
- `alternative_name`: Alternative name.
- `argnames`: Argument names.
- `param_index_from`: First parameter index.
- `param_index_to`: Last parameter index.
- `decorated`: Decoration flag.
- `new_fixture_host`: Target fixture host.
- `test_func`: Target test function.
- `param_union_name`: Union name.
- `from_i`: Start index.
- `to_i`: End index.
- `argvalues`: Values list.
- `ids`: Ids list.
- `scope`: Fixture scope.
- `hook`: Optional hook.
- `debug`: Debug flag.

#### 31. `FixtureParamAlternative` - Fixture Parameter

**Description**:
Fixture parameter definition class.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import FixtureParamAlternative
```

**Class Signature**:
```python
class FixtureParamAlternative(SingleParamAlternative):
    """alternative class for a single parameter containing a fixture ref"""

    def __init__(self,
                 union_name,   # type: str
                 fixture_ref,  # type: fixture_ref
                 argnames,     # type: Sequence[str]
                 param_index,  # type: int
                 id,           # type: Optional[str]
                 decorated     # type: Callable
                 ): ...
    def get_alternative_idx(self): ...
    def get_alternative_id(self): ...
```

**Function Description**:
- `__init__(union_name, fixture_ref, argnames, param_index, id, decorated)`: Defines an alternative pointing to a fixture.
- `get_alternative_idx()`: Returns index.
- `get_alternative_id()`: Returns id.

**Parameter Description**:
- `self`: The `FixtureParamAlternative` instance.
- `union_name`: Union name.
- `fixture_ref`: Fixture reference.
- `argnames`: Argument names.
- `param_index`: Parameter index.
- `id`: Explicit id.
- `decorated`: Decoration flag.

#### 32. `ProductParamAlternative` - Parameter Alternative

**Description**:
Base class for parameter alternatives.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import ProductParamAlternative
```

**Class Signature**:
```python
class ProductParamAlternative(SingleParamAlternative):
    """alternative class for a single product parameter containing fixture refs"""

    def get_alternative_idx(self): ...
    def get_alternative_id(self): ...

```

**Function Description**:
- `get_alternative_idx()`: Returns index of this alternative.
- `get_alternative_id()`: Returns id of this alternative.

**Parameter Description**:
- `self`: The `ProductParamAlternative` instance.

#### 33. `ParamIdMakers` - Parameter ID Makers

**Description**:
ID generation for parameter alternatives.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import ParamIdMakers
```

**Class Signature**:
```python
class ParamIdMakers(UnionIdMakers):
   """ 'Enum' of id styles for param ids

    It extends UnionIdMakers to adapt to the special fixture alternatives `ParamAlternative` we create
    in @parametrize
    """
    @classmethod
    def nostyle(cls,
                param  # type: ParamAlternative
                ):
        if isinstance(param, MultiParamAlternative):
            # make an empty minimal id since the parameter themselves will appear as ids separately
            # note if the final id is empty it will be dropped by the filter in CallSpec2.id
            return EMPTY_ID
        else:
            return UnionIdMakers.nostyle(param)
```

**Function Description**:
- `nostyle(param)`: Returns neutral id string for a parameter.

**Parameter Description**:
- `cls`: The class (classmethod usage).
- `param`: The parameter to generate an id for.

#### 34. `InvalidIdTemplateException` - Invalid ID Template Exception

**Description**:
Exception raised when ID template is invalid.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import InvalidIdTemplateException
```

**Class Signature**:
```python
class InvalidIdTemplateException(Exception):
    """
    Raised when a string template provided in an `idgen` raises an error
    """
    def __init__(self, idgen, params, caught): ...
    def __str__(self): ...
    def __repr__(self): ...
```

**Function Description**:
- `__init__(idgen, params, caught)`: Builds the exception with context.
- `__str__()`: Error message.
- `__repr__()`: Debug representation.

**Parameter Description**:
- `self`: The exception instance.
- `idgen`: Id generator or template.
- `params`: Parameters that failed.
- `caught`: The caught underlying exception.

#### 35. `ExistingFixtureNameError` - Existing Fixture Name Error

**Description**:
Exception raised when fixture name already exists.

**Import Statement**:
```python
from pytest_cases.fixture__creation import ExistingFixtureNameError
```

**Class Signature**:
```python
class ExistingFixtureNameError(ValueError):
    """
    Raised by `add_fixture_to_callers_module` when a fixture already exists in a module
    """
    def __init__(self, module, name, caller): ...
    def __str__(self): ...
```

**Function Description**:
- `__init__(module, name, caller)`: Creates the error with context info.
- `__str__()`: Error message.

**Parameter Description**:
- `self`: The exception instance.
- `module`: Module object or name.
- `name`: Fixture name in conflict.
- `caller`: Caller information.

#### 36. `FixtureDefsCache` - Fixture Definitions Cache

**Description**:
Cache for fixture definitions.

**Import Statement**:
```python
from pytest_cases.plugin import FixtureDefsCache
```

**Class Signature**:
```python
class FixtureDefsCache(object):
    """
    A 'cache' for fixture definitions obtained from the FixtureManager `fm`, for test node `nodeid`
    """
    __slots__ = 'fm', 'node', 'cached_fix_defs'
    def __init__(self, fm, node): ...

    def get_fixture_defs(self, fixname): ...
```

**Function Description**:
- `__init__(fm, node)`: Initializes the cache with a fixture manager and node.
- `get_fixture_defs(fixname)`: Returns the definitions for the fixture named `fixname`.

**Parameter Description**:
- `self`: The cache instance.
- `fm`: The fixture manager.
- `node`: The pytest collection node.
- `fixname`: The fixture name to look up.

#### 37. `FixtureClosureNode` - Fixture Closure Node

**Description**:
Node in fixture closure graph.

**Import Statement**:
```python
from pytest_cases.plugin import FixtureClosureNode
```

**Class Signature**:
```python
class FixtureClosureNode(object):
    """
    A node in a fixture closure Tree.

     - its `fixture_defs` is a {name: def} ordered dict containing all fixtures AND args that are required at this node
       (*before* a union is required). Note that some of them have def=None when the fixture manager has no definition
       for them (same behaviour than in pytest). `get_all_fixture_names` and `get_all_fixture_defs` helper functions
       allow to either return the full ordered list (equivalent to pytest `fixture_names`) or the dictionary of non-none
       definitions (equivalent to pytest `arg2fixturedefs`)

     - if a union appears at this node, `split_fixture_name` is set to the name of the union fixture, and `children`
       contains an ordered dict of {split_fixture_alternative: node}

    """
    __slots__ = 'parent', 'fixture_defs_mgr', \
                'fixture_defs', 'split_fixture_name', 'split_fixture_alternatives', 'children'

    def __init__(self,
                 fixture_defs_mgr=None,   # type: FixtureDefsCache
                 parent_node=None         # type: FixtureClosureNode
                 ): ...
    def get_leaves(self): ...
    def to_str(self, indent_nb = 0, with_children = True): ...
    def __repr__(self): ...
    def get_all_fixture_names(self, try_to_sort_by_scope = True): ...
    def get_all_fixture_defs(self, drop_fake_fixtures = True, try_to_sort = True): ...
    def gen_all_fixture_defs(self, drop_fake_fixtures = True): ...
    def build_closure(self,
                      initial_fixture_names,  # type: Iterable[str]
                      ignore_args=()
                      ): ...
    def is_closure_built(self): ...
    def already_knows_fixture(self, fixture_name): ...
     def _build_closure(self,
                       fixture_defs_mgr,       # type: FixtureDefsCache
                       initial_fixture_names,  # type: Iterable[str]
                       ignore_args
                       ): ...
    def remove_fixtures(self, fixture_names_to_remove)
    def add_required_fixture(self, new_fixture_name, new_fixture_defs)
    def split_and_build(self,
                        fixture_defs_mgr,           # type: FixtureDefsCache
                        split_fixture_name,         # type: str
                        split_fixture_defs,         # type: Tuple[FixtureDefinition]  # noqa
                        alternative_fixture_names,  # type: List[str]
                        pending_fixtures_list,      #
                        ignore_args
                        ): ...
    def has_split(self): ...
    def get_not_always_used(self): ...
    def gather_all_required(self, include_children = True, include_parents = True)
    def requires(self, fixturename): ...
    def get_alternatives(self): ...
    def _get_alternatives(self): ...
```

**Function Description**:
- `__init__(fixture_defs_mgr = None, parent_node = None)`: Initializes a closure node.
- `get_leaves()`: Returns leaf nodes.
- `to_str(indent_nb = 0, with_children = True)`: Stringifies the closure subtree.
- `get_all_fixture_names(try_to_sort_by_scope = True)`: Returns all fixture names.
- `get_all_fixture_defs(drop_fake_fixtures = True, try_to_sort = True)`: Returns all fixture defs.
- `gen_all_fixture_defs(drop_fake_fixtures = True)`: Generator of fixture defs.
- `build_closure(initial_fixture_names, ignore_args = ())`: Builds the closure from initial names.
- `is_closure_built()`: Indicates if closure is already built.
- `already_knows_fixture(fixture_name)`: Checks if a fixture name is known.
- `_build_closure(fixture_defs_mgr, initial_fixture_names, ignore_args)`: Internal builder.
- `remove_fixtures(fixture_names_to_remove)`: Removes fixtures from closure.
- `add_required_fixture(new_fixture_name, new_fixture_defs)`: Adds required fixture.
- `split_and_build(...)`: Splits and rebuilds part of the closure graph.
- `has_split()`: Returns True if a split occurred.
- `get_not_always_used()`: Returns fixtures not always used.
- `gather_all_required(include_children = True, include_parents = True)`: Returns required fixtures.
- `requires(fixturename)`: Returns the requirements for the given fixture.\
- `get_alternatives()`: Returns alternative fixture names.
- `_get_alternatives()`: Internal method to get alternatives.

**Parameter Description**:
- `self`: The node instance.
- `fixture_defs_mgr`: Fixture definitions manager.
- `parent_node`: Optional parent node.
- `indent_nb`: Indentation in spaces for display.
- `with_children`: Whether to include children in display.
- `try_to_sort_by_scope`: Whether to attempt sorting by scope.
- `drop_fake_fixtures`: If True, remove fake fixtures.
- `try_to_sort`: Whether to try sorting results.
- `initial_fixture_names`: Initial set of fixture names.
- `ignore_args`: Iterable of argument names to ignore.
- `fixture_names_to_remove`: Names to remove.
- `new_fixture_name`: Newly required fixture name.
- `new_fixture_defs`: Newly required fixture definitions.
- `split_fixture_name`: Fixture name to split on.
- `split_fixture_defs`: Fixture definitions used for split.
- `alternative_fixture_names`: Alternative fixture names for split.
- `pending_fixtures_list`: Pending fixtures to process.
- `fixturename`: A fixture name.
- `include_children`: Include children flag.
- `include_parents`: Include parents flag.

#### 38. `SuperClosure` - Super Closure

**Description**:
Super closure implementation for fixture dependencies.

**Import Statement**:
```python
from pytest_cases.plugin import SuperClosure
```

**Class Signature**:
```python
class SuperClosure(MutableSequence):
    """
    A "super closure" is a closure made of several closures, each induced by a fixture union parameter value.
    The number of alternative closures is `self.nb_alternative_closures`

    This object behaves like a list (a mutable sequence), so that we can pass it to pytest in place of the list of
    fixture names that is returned in `getfixtureclosure`.

    In this implementation, it is backed by a fixture closure tree, that we have to preserve in order to get
    parametrization right. In another branch of this project ('super_closure' branch) we tried to forget the tree
    and only keep the partitions, but parametrization order was not as intuitive for the end user as all unions
    appeared as parametrized first (since they induced the partitions).
    """
    __slots__ = 'tree', 'all_fixture_defs'
    def __init__(self,
                 root_node  # type: FixtureClosureNode
                 ): ...
    def _update_fixture_defs(self): ...
    @property
    def nb_alternative_closures(self): ...
    def __repr__(self): ...
    def get_all_fixture_defs(self, drop_fake_fixtures = True): ...
    def __len__(self): ...
    def __getitem__(self, i): ...
    def __setitem__(self, i, o): ...
    def __delitem__(self, i): ...
    def insert(self, index, fixture_name): ...
    def append_all(self, fixture_names): ...
    def remove(self, value): ...
    def remove_all(self, values): ...
```

**Function Description**:
- `__init__(root_node)`: Initializes a super closure from a root node.
- `_update_fixture_defs()`: Refreshes fixture definitions across nodes.
- `nb_alternative_closures()`: Returns number of alternative closures.
- `__repr__()`: Debug representation.
- `get_all_fixture_defs(drop_fake_fixtures = True)`: Returns all fixture defs.
- `__len__()`: Length protocol for sequence.
- `__getitem__(i)`: Indexing protocol.
- `__setitem__(i, o)`: Item assignment protocol.
- `__delitem__(i)`: Item deletion protocol.
- `insert(index, fixture_name)`: Inserts a fixture at position.
- `append_all(fixture_names)`: Appends multiple fixtures.
- `remove(value)`: Removes first occurrence.
- `remove_all(values)`: Removes all listed.

**Parameter Description**:
- `self`: The super closure instance.
- `root_node`: Root node.
- `i`: Index.
- `o`: New value.
- `index`: Insertion index.
- `fixture_name`: Name to insert.
- `fixture_names`: Iterable of names to append.
- `value`: Value to remove.
- `values`: Iterable of values to remove.
- `drop_fake_fixtures`: Whether to drop fake fixtures.

#### 39. `UnionParamz` - Union Parameters

**Description**:
Union parameters implementation.

**Import Statement**:
```python
from pytest_cases.plugin import UnionParamz
```

**Class Signature**:
```python
class UnionParamz(namedtuple('UnionParamz', ['union_fixture_name', 'alternative_names', 'ids', 'scope', 'kwargs'])):
    """ Represents some parametrization to be applied, for a union fixture """

    __slots__ = ()

    def __str__(self):
        return "[UNION] %s=[%s], ids=%s, scope=%s, kwargs=%s" \
               "" % (self.union_fixture_name, ','.join([str(a) for a in self.alternative_names]),
                     self.ids, self.scope, self.kwargs)

```

**Function Description**:
- `__str__()`: Returns a string description for union parameters.

**Parameter Description**:
- `self`: The instance.

#### 40. `NormalParamz` - Normal Parameters

**Description**:
Normal parameters implementation.

**Import Statement**:
```python
from pytest_cases.plugin import NormalParamz
```

**Class Signature**:
```python
class NormalParamz(namedtuple('NormalParamz', ['argnames', 'argvalues', 'indirect', 'ids', 'scope', 'kwargs'])):
    """ Represents some parametrization to be applied """

    __slots__ = ()

    def __str__(self):
        return "[NORMAL] %s=[%s], indirect=%s, ids=%s, scope=%s, kwargs=%s" \
               "" % (self.argnames, self.argvalues, self.indirect, self.ids, self.scope, self.kwargs)

```

**Function Description**:
- `__str__()`: Returns a string description for normal parameters.

**Parameter Description**:
- `self`: The instance.

#### 41. `CallsReactor` - Calls Reactor

**Description**:
Reactor for handling test calls and parametrization.

**Import Statement**:
```python
from pytest_cases.plugin import CallsReactor
```

**Class Signature**:
```python
class CallsReactor(object):
    """
    This object replaces the list of calls that was in `metafunc._calls`.
    It behaves like a list, but it actually builds that list dynamically based on all parametrizations collected
    from the custom `metafunc.parametrize` above.

    There are therefore three steps:

     - when `metafunc.parametrize` is called, this object gets called on `add_union` or `add_param`. A parametrization
     order gets stored in `self._pending`

     - when this object is first read as a list, all parametrization orders in `self._pending` are transformed into a
     tree in `self._tree`, and `self._pending` is discarded. This is done in `create_tree_from_pending_parametrization`.

     - finally, the list is built from the tree using `self._tree.to_call_list()`. This will also be the case in
     subsequent usages of this object.

    """
    __slots__ = 'metafunc', '_pending', '_call_list'

    def __init__(self, metafunc): ...
    def append(self,
               parametrization  # type: Union[UnionParamz, NormalParamz]
               ): ...
    def print_parametrization_list(self): ...
    def __iter__(self): ...
    def __getitem__(self, item): ...
    @property
    def calls_list(self): ...
    def create_call_list_from_pending_parametrizations(self): ...
```

**Function Description**:
- `__init__(metafunc)`: Initializes the reactor with a meta function.
- `append(parametrization)`: Appends a parametrization entry.
- `print_parametrization_list()`: Prints current parametrizations.
- `__iter__()`: Iterates over generated calls.
- `__getitem__(item)`: Returns the call at index.
- `calls_list()`: Returns the internal calls list.
- `create_call_list_from_pending_parametrizations`: Builds the calls list from pending parametrizations.

**Parameter Description**:
- `self`: The reactor instance.
- `metafunc`: Pytest metafunc object.
- `parametrization`: Parametrization entry.
- `item`: Index to retrieve.

#### 1. `publish()` - Function Name

**Function Signature**:
```python
@nox.session(python=PY311)
def publish(session):
    """Deploy the docs+reports on github pages. Note: this rebuilds the docs"""

```

**Import Statement**:
```python
from noxfile import publish
```

**Function**:
Nox session that deploys documentation and reports (e.g., GitHub Pages).

**Parameter Description**:
- `session`: Nox session object.

**Return Value**:
None (runs the deployment workflow).

#### 2. `_build()` - Function Name

**Function Signature**:
```python
def _build(session):
    """Common code used by build and release sessions"""
```

**Import Statement**:
```python
from noxfile import _build
```

**Function**:
Common build routine that prepares distributions and validates versioning.

**Parameter Description**:
- `session`: Nox session object.

**Return Value**:
None (performs build operations).

#### 3. `my_scheme()` - Function Name

**Function Signature**:
```python
def my_scheme(version_)
```

**Import Statement**:
```python
from noxfile import my_scheme
```

**Function**:
It is an internal function of the `_build` function.
Version scheme callback used by setuptools_scm to derive dev/release versions.

**Parameter Description**:
- `version_`: Version string to process.

**Return Value**:
Processed version string for setuptools_scm.

#### 4. `create_or_update_release()` - Function Name

**Function Signature**:
```python
@click.command()
@click.option('-u', '--user', help='GitHub username')
@click.option('-p', '--pwd', help='GitHub password')
@click.option('-s', '--secret', help='GitHub access token')
@click.option('-r', '--repo-slug', help='Repo slug. i.e.: apple/swift')
@click.option('-cf', '--changelog-file', help='Changelog file path')
@click.option('-d', '--doc-url', help='Documentation url')
@click.option('-df', '--data-file', help='Data file to upload', type=Path(exists=True, file_okay=True, dir_okay=False,
                                                                          resolve_path=True))
@click.argument('tag')
def create_or_update_release(user, pwd, secret, repo_slug, changelog_file, doc_url, data_file, tag):
    """
    Creates or updates (TODO)
    a github release corresponding to git tag <TAG>.
    """
```

**Import Statement**:
```python
from ci_tools.github_release import create_or_update_release
```

**Function**:
Creates or updates a GitHub release from a tag and changelog, optionally uploading assets.

**Parameter Description**:
- `user`: GitHub username.
- `pwd`: GitHub password or token.
- `secret`: Additional secret for authentication.
- `repo_slug`: Repository slug (owner/repo).
- `changelog_file`: Path to changelog file.
- `doc_url`: Documentation URL.
- `data_file`: Optional data file.
- `tag`: Git tag for the release.

**Return Value**:
GitHub release object or None.

#### 5. `install_reqs()` - Function Name

**Function Signature**:
```python
def install_reqs(session, setup = False, install = False, tests = False, extras = (), phase = None, phase_reqs = None, versions_dct = None)
```

**Import Statement**:
```python
from ci_tools.nox_utils import install_reqs
```

**Function**:
High-level installer for build/test/doc phases, merging constraints and conda/pip sources.

**Parameter Description**:
- `session`: Nox session object.
- `setup`: Install setup dependencies.
- `install`: Install the package itself.
- `tests`: Install test dependencies.
- `extras`: List of extra dependency groups.
- `phase`: Install phase name.
- `phase_reqs`: Phase-specific requirements.
- `versions_dct`: Dictionary of package versions.

**Return Value**:
None (installs packages).

#### 6. `install_any()` - Function Name

**Function Signature**:
```python
def install_any(session, phase_name: str, pkgs: Sequence[str], use_conda_for: Sequence[str] = (), versions_dct: Dict[str, str] = None): 
    """Install the `pkgs` provided with `session.install(*pkgs)`, except for those present in `use_conda_for`"""

```

**Import Statement**:
```python
from ci_tools.nox_utils import install_any
```

**Function**:
Installs the given package list with pip or conda according to configuration.

**Parameter Description**:
- `session`: Nox session object.
- `phase_name`: Name of the installation phase.
- `pkgs`: List of package names to install.
- `use_conda_for`: Packages to install via conda.
- `versions_dct`: Dictionary mapping package names to versions.

**Return Value**:
None (installs packages).

#### 7. `read_pyproject_toml()` - Function Name

**Function Signature**:
```python
def read_pyproject_toml() -> Union[list, list]:
    """
    Reads the `pyproject.toml` and returns

     - a list of setup requirements from [build-system] requires
     - sub-list of these requirements that should be installed with conda, from [tool.my_conda] conda_packages
    """
```

**Import Statement**:
```python
from ci_tools.nox_utils import read_pyproject_toml
```

**Function**:
Parses pyproject.toml to extract build-system requirements and optional conda packages.

**Parameter Description**:
None

**Return Value**:
A tuple of two lists: (setup_requirements, conda_packages).

#### 8. `read_setuptools_cfg()` - Function Name

**Function Signature**:
```python
def read_setuptools_cfg():
    """
    Reads the `setup.cfg` file and extracts the various requirements lists
    """
```

**Import Statement**:
```python
from ci_tools.nox_utils import read_setuptools_cfg
```

**Function**:
Loads setup.cfg to collect setup, install, tests, and extras requirements.

**Parameter Description**:
None

**Return Value**:
A dictionary containing parsed requirements from setup.cfg.

#### 9. `get_req_pkg_name()` - Function Name

**Function Signature**:
```python
def get_req_pkg_name(r):
    """Return the package name part of a python package requirement.

    For example
    "funcsigs;python<'3.5'" will return "funcsigs"
    "pytest>=3" will return "pytest"
    """
    return r.replace('<', '=').replace('>', '=').replace(';', '=').split("=")[0]

```

**Import Statement**:
```python
from ci_tools.nox_utils import get_req_pkg_name
```

**Function**:
Extracts the base package name from a requirement string (drops markers and specifiers).

**Parameter Description**:
- `r`: Package requirement string (e.g., "pytest>=3", "funcsigs;python<'3.5'").

**Return Value**:
A string containing the clean package name (e.g., "pytest", "funcsigs").

#### 10. `rm_file()` - Function Name

**Function Signature**:
```python
def rm_file(folder: Union[str, Path]):
    """Since on windows Path.unlink throws permission error sometimes, os.remove is preferred."""
 
```

**Import Statement**:
```python
from ci_tools.nox_utils import rm_file
```

**Function**:
Safely removes a file path, using OS removal to avoid Windows permission issues.

**Parameter Description**:
- `folder`: File path to remove (can be string or Path object).

**Return Value**:
None

#### 11. `rm_folder()` - Function Name

**Function Signature**:
```python
def rm_folder(folder: Union[str, Path]):
    """Since on windows Path.unlink throws permission error sometimes, shutil is preferred."""

```

**Import Statement**:
```python
from ci_tools.nox_utils import rm_folder
```

**Function**:
Recursively removes a directory tree, avoiding Path.unlink permission problems.

**Parameter Description**:
- `folder`: Folder path to remove (can be string or Path object).

**Return Value**:
None

#### 12. `_tags_match_query()` - Function Name

**Function Signature**:
```python
def _tags_match_query(tags,    # type: Iterable[str]
                      has_tag  # type: Optional[Union[str, Iterable[str]]]
                      ):
    """Internal routine to determine is all tags in `has_tag` are persent in `tags`
    Note that `has_tag` can be a single tag, or none
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import _tags_match_query
```

**Function**:
Checks whether a set of tags satisfies a tag predicate or query.

**Parameter Description**:
- `tags`: Set of tags to check.
- `has_tag`: Tag predicate function or query.

**Return Value**:
True if the tags match the query, False otherwise.

#### 13. `copy_case_info()` - Function Name

**Function Signature**:
```python

def copy_case_info(from_fun,  # type: Callable
                   to_fun     # type: Callable
                   ):
    """Copy all information from case function `from_fun` to `to_fun`."""
    _CaseInfo.copy_info(from_fun, to_fun)
```

**Import Statement**:
```python
from pytest_cases.case_funcs import copy_case_info
```

**Function**:
Copies case metadata (id, marks, tags) from one function to another.

**Parameter Description**:
- `from_fun`: Source function to copy metadata from.
- `to_fun`: Target function to copy metadata to.

**Return Value**:
None (modifies to_fun in place).

#### 14. `set_case_id()` - Function Name

**Function Signature**:
```python
def set_case_id(id,        # type: str
                case_func  # type: Callable
                ):
    """Set an explicit id on case function `case_func`."""
```

**Import Statement**:
```python
from pytest_cases.case_funcs import set_case_id
```

**Function**:
Assigns an explicit case id to a case function.

**Parameter Description**:
- `id`: Case identifier string.
- `case_func`: Case function to set the id on.

**Return Value**:
None (modifies case_func metadata).

#### 15. `get_case_id()` - Function Name

**Function Signature**:
```python
def get_case_id(case_func,                              # type: Callable
                prefix_for_default_ids=CASE_PREFIX_FUN  # type: str
                ):
    """Return the case id associated with this case function.

    If a custom id is not present, a case id is automatically created from the function name based on removing the
    provided prefix if present at the beginning of the function name. If the resulting case id is empty,
    "<empty_case_id>" will be returned.

    :param case_func: the case function to get a case id for
    :param prefix_for_default_ids: this prefix that will be removed if present on the function name to form the default
        case id.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import get_case_id
```

**Function**:
Computes or retrieves the case identifier, applying a default prefix when needed.

**Parameter Description**:
- `case_func`: Case function to get the id from.
- `prefix_for_default_ids`: Prefix to use when generating default ids.

**Return Value**:
Case identifier string.

#### 16. `get_case_marks()` - Function Name

**Function Signature**:
```python
def get_case_marks(case_func,                         # type: Callable
                   concatenate_with_fun_marks=False,  # type: bool
                   as_decorators=False                # type: bool
                   ):
    # type: (...) -> Union[Tuple[Mark, ...], Tuple[MarkDecorator, ...]]
    """Return the marks that are on the case function.

    There are currently two ways to place a mark on a case function: either with `@pytest.mark.<name>` or in
    `@case(marks=...)`. This function returns a list of marks containing either both (if `concatenate_with_fun_marks` is
    `True`) or only the ones set with `@case` (`concatenate_with_fun_marks` is `False`, default).

    :param case_func: the case function
    :param concatenate_with_fun_marks: if `False` (default) only the marks declared in `@case` will be returned.
        Otherwise a concatenation of marks in `@case` and on the function (for example directly with
        `@pytest.mark.<name>`) will be returned.
    :param as_decorators: when `True`, the marks (`MarkInfo`) will be transformed into `MarkDecorators` before being
        returned. Otherwise (default) the marks are returned as is.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import get_case_marks
```

**Function**:
Collects pytest marks associated with a case function, optionally as decorators.

**Parameter Description**:
- `case_func`: Case function to get marks from.
- `concatenate_with_fun_marks`: Whether to include function-level marks.
- `as_decorators`: Return marks as decorator objects instead of mark info.

**Return Value**:
List of mark info objects or decorators.

#### 17. `get_case_tags()` - Function Name

**Function Signature**:
```python
def get_case_tags(case_func  # type: Callable
                  ):
    """Return the tags on this case function or an empty tuple"""
```

**Import Statement**:
```python
from pytest_cases.case_funcs import get_case_tags
```

**Function**:
Returns the tags attached to a case function.

**Parameter Description**:
- `case_func`: Case function to get tags from.

**Return Value**:
Set of tag strings.

#### 18. `matches_tag_query()` - Function Name

**Function Signature**:
```python
def matches_tag_query(case_fun,      # type: Callable
                      has_tag=None,  # type: Union[str, Iterable[str]]
                      filter=None,   # type: Union[Callable[[Callable], bool], Iterable[Callable[[Callable], bool]]]  # noqa
                      ):
    """
    This function is the one used by `@parametrize_with_cases` to filter the case functions collected. It can be used
    manually for tests/debug.

    Returns True if the case function is selected by the query:

     - if `has_tag` contains one or several tags, they should ALL be present in the tags
       set on `case_fun` (`get_case_tags`)

     - if `filter` contains one or several filter callables, they are all called in sequence and the
       `case_fun` is only selected if ALL of them return a `True` truth value

    :param case_fun: the case function
    :param has_tag: one or several tags that should ALL be present in the tags set on `case_fun` for it to be selected.
    :param filter: one or several filter callables that will be called in sequence. If all of them return a `True`
        truth value, `case_fun` is selected.
    :return: True if the case_fun is selected by the query.
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import matches_tag_query
```

**Function**:
Evaluates a tag query against a case function's tags and optional filters.

**Parameter Description**:
- `case_fun`: Case function to evaluate.
- `has_tag`: Tag predicate function or query.
- `filter`: Additional filter function.

**Return Value**:
True if the case matches the query, False otherwise.

#### 19. `is_case_class()` - Function Name

**Function Signature**:
```python

def is_case_class(cls,                                  # type: Any
                  case_marker_in_name=CASE_PREFIX_CLS,  # type: str
                  check_name=True                       # type: bool
                  ):
    """
    This function is the one used by `@parametrize_with_cases` to collect cases within classes. It can be used manually
    for tests/debug.

    Returns True if the given object is a class and, if `check_name=True` (default), if its name contains
    `case_marker_in_name`.

    :param cls: the object to check
    :param case_marker_in_name: the string that should be present in a class name so that it is selected. Default is
        'Case'.
    :param check_name: a boolean (default True) to enforce that the name contains the word `case_marker_in_name`.
        If False, any class will lead to a `True` result whatever its name.
    :return: True if this is a case class
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import is_case_class
```

**Function**:
Determines if a class should be considered a case container based on naming and markers.

**Parameter Description**:
- `cls`: Class to check.
- `case_marker_in_name`: Prefix expected in class name.
- `check_name`: Whether to validate the class name.

**Return Value**:
True if the class is a case container, False otherwise.

#### 20. `is_case_function()` - Function Name

**Function Signature**:
```python
def is_case_function(f,                       # type: Any
                     prefix=CASE_PREFIX_FUN,  # type: str
                     check_prefix=True        # type: bool
                     ):
    """
    This function is the one used by `@parametrize_with_cases` to collect cases. It can be used manually for
    tests/debug.

    Returns True if the provided object is a function or callable and, if `check_prefix=True` (default), if it starts
    with `prefix`.

    :param f: the object to check
    :param prefix: the string that should be present at the beginning of a function name so that it is selected.
        Default is 'case_'.
    :param check_prefix: if this boolean is True (default), the prefix will be checked. If False, any function will
        lead to a `True` result whatever its name.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_funcs import is_case_function
```

**Function**:
Determines if a function is a case function based on naming rules and checks.

**Parameter Description**:
- `f`: Function to check.
- `prefix`: Expected prefix for case function names.
- `check_prefix`: Whether to validate the prefix.

**Return Value**:
True if the function is a case function, False otherwise.

#### 21. `with_case_tags()` - Function Name

**Function Signature**:
```python
def with_case_tags(*tags):
    """Attach `tags` to all cases defined in the decorated class."""
```

**Import Statement**:
```python
from pytest_cases.case_funcs import with_case_tags
```

**Function**:
Decorator factory adding tags to a case function or class.

**Parameter Description**:
- `*tags`: Variable-length tag names to attach.

**Return Value**:
Decorator function.

#### 22. `_decorator()` - Function Name

**Function Signature**:
```python
def _decorator(cls): ...
```

**Import Statement**:
```python
from pytest_cases.case_funcs import _decorator
```

**Function**:
It is an internal function of the with_case_tags function.
Internal decorator that attaches tags to a case class.

**Parameter Description**:
- `cls`: Case class to decorate.

**Return Value**:
The decorated class.

#### 23. `_apply_parametrization()` - Function Name

**Function Signature**:
```python
 @inject_host
def _apply_parametrization(f, host_class_or_module):
    """ execute parametrization of test function or fixture `f` """

```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _apply_parametrization
```

**Function**:
Internal helper applying collected case parametrization to a target function.

**Parameter Description**:
- `f`: Target function to parametrize.
- `host_class_or_module`: Module or class hosting case functions.

**Return Value**:
None (modifies f with parametrize marks).

#### 24. `_get_original_case_func()` - Function Name

**Function Signature**:
```python
def _get_original_case_func(case_fun  # type: Callable
                            ):
    """

    :param case_fun:
    :return: the original case function, and a boolean indicating if it is different from the input
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _get_original_case_func
```

**Function**:
Returns the original case function if it has been wrapped/decorated.

**Parameter Description**:
- `case_fun`: Potentially decorated case function.

**Return Value**:
Original unwrapped case function.

#### 25. `create_glob_name_filter()` - Function Name

**Function Signature**:
```python
def create_glob_name_filter(glob_str  # type: str
                            ):
    """
    Creates a glob-like matcher for the name of case functions
    The only special character that is supported is `*` and it can not be
    escaped. However it can be used multiple times in an expression.

    :param glob_str: for example `*_success` or `*_*`
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import create_glob_name_filter
```

**Function**:
Creates a predicate that matches case names against a glob pattern.

**Parameter Description**:
- `glob_str`: Glob pattern string (e.g., "test_*").

**Return Value**:
A filter function that matches case names against the glob pattern.

#### 26. `_glob_name_filter()` - Function Name

**Function Signature**:
```python
def _glob_name_filter(case_fun)
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _glob_name_filter
```

**Function**:
It is an internal function of the `create_glob_name_filter` function
Internal predicate used to filter case functions by name.

**Parameter Description**:
- `case_fun`: Case function to check against the glob pattern.

**Return Value**:
True if the case name matches the glob, False otherwise.

#### 27. `get_all_cases()` - Function Name

**Function Signature**:
```python
def get_all_cases(parametrization_target=None,  # type: Callable
                  cases=AUTO,                   # type: Union[CaseType, List[CaseType]]
                  prefix=CASE_PREFIX_FUN,       # type: str
                  glob=None,                    # type: str
                  has_tag=None,                 # type: Union[str, Iterable[str]]
                  filter=None                   # type: Callable[[Callable], bool]  # noqa
                  ):
    # type: (...) -> List[Callable]
    """
    Lists all desired cases for a given `parametrization_target` (a test function or a fixture). This function may be
    convenient for debugging purposes. See `@parametrize_with_cases` for details on the parameters.

    :param parametrization_target: either an explicit module object or a function or None. If it's a function, it will
        use the module it is defined in. If None is given, it will just get the module it was called from.
    :param cases: a case function, a class containing cases, a module or a module name string (relative module
        names accepted). Or a list of such items. You may use `THIS_MODULE` or `'.'` to include current module.
        `AUTO` (default) means that the module named `test_<name>_cases.py` will be loaded, where `test_<name>.py` is
        the module file of the decorated function. `AUTO2` allows you to use the alternative naming scheme
        `cases_<name>.py`. When a module is listed, all of its functions matching the `prefix`, `filter` and `has_tag`
        are selected, including those functions nested in classes following naming pattern `*Case*`. When classes are
        explicitly provided in the list, they can have any name and do not need to follow this `*Case*` pattern.
    :param prefix: the prefix for case functions. Default is 'case_' but you might wish to use different prefixes to
        denote different kind of cases, for example 'data_', 'algo_', 'user_', etc.
    :param glob: a matching pattern for case ids, for example `*_success` or `*_failure`. The only special character
        that can be used for now in this pattern is `*`, it can not be escaped, and it can be used several times in the
        same expression. The pattern should match the entire case id for the case to be selected. Note that this is
        applied on the case id, and therefore if it is customized through `@case(id=...)` it will be taken into
        account.
    :param has_tag: a single tag or a tuple, set, list of tags that should be matched by the ones set with the `@case`
        decorator on the case function(s) to be selected.
    :param filter: a callable receiving the case function and returning True or a truth value in case the function
        needs to be selected.
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_all_cases
```

**Function**:
Collects case functions from modules/classes according to filters and tags.

**Parameter Description**:
- `parametrization_target`: Module or class to search for cases.
- `cases`: Case functions to use (can be AUTO for auto-discovery).
- `prefix`: Expected prefix for case functions.
- `glob`: Glob pattern to filter case names.
- `has_tag`: Tag predicate to filter cases.
- `filter`: Additional filter function.

**Return Value**:
List of case functions.

#### 28. `get_parametrize_args()` - Function Name

**Function Signature**:
```python
def get_parametrize_args(host_class_or_module,    # type: Union[Type, ModuleType]
                         cases_funs,              # type: List[Callable]
                         prefix,                  # type: str
                         scope="function",        # type: str
                         import_fixtures=False,   # type: bool
                         debug=False              # type: bool
                         ):
    # type: (...) -> List[CaseParamValue]
    """
    Transforms a list of cases (obtained from `get_all_cases`) into a list of argvalues for `@parametrize`.
    Each case function `case_fun` is transformed into one or several `lazy_value`(s) or a `fixture_ref`:

     - If `case_fun` requires at least on fixture, a fixture will be created if not yet present, and a `fixture_ref`
       will be returned. The fixture will be created in `host_class_or_module`
     - If `case_fun` is a parametrized case, one `lazy_value` with a partialized version will be created for each
       parameter combination.
     - Otherwise, `case_fun` represents a single case: in that case a single `lazy_value` is returned.

    :param host_class_or_module: host of the parametrization target. A class or a module.
    :param cases_funs: a list of case functions, returned typically by `get_all_cases`
    :param prefix:
    :param scope:
    :param import_fixtures: experimental feature. Turn this to True in order to automatically import all fixtures
        defined in the cases module into the current module.
    :param debug: a boolean flag, turn it to True to print debug messages.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_parametrize_args
```

**Function**:
Builds arguments for pytest parametrize based on discovered cases.

**Parameter Description**:
- `host_class_or_module`: Module or class hosting cases.
- `cases_funs`: List of case functions.
- `prefix`: Case function prefix.
- `scope`: Pytest fixture scope.
- `import_fixtures`: Whether to import fixtures.
- `debug`: Enable debug output.

**Return Value**:
Tuple of (argnames, argvalues, ids) for pytest.mark.parametrize.

#### 29. `case_to_argvalues()` - Function Name

**Function Signature**:
```python
def case_to_argvalues(host_class_or_module,    # type: Union[Type, ModuleType]
                      case_fun,                # type: Callable
                      prefix,                  # type: str
                      scope,                   # type: str
                      import_fixtures=False,   # type: bool
                      debug=False              # type: bool
                      ):
    # type: (...) -> Tuple[CaseParamValue, ...]
    """Transform a single case into one or several `lazy_value`(s) or a `fixture_ref` to be used in `@parametrize`

    If `case_fun` requires at least on fixture, a fixture will be created if not yet present, and a `fixture_ref` will
    be returned.

    If `case_fun` is a parametrized case, (NEW since 3.0.0) a fixture will be created if not yet present,
    and a `fixture_ref` will be returned. (OLD < 3.0.0) one `lazy_value` with a partialized version will be created
    for each parameter combination.

    Otherwise, `case_fun` represents a single case: in that case a single `lazy_value` is returned.

    :param case_fun:
    :param import_fixtures: experimental feature. Turn this to True in order to automatically import all fixtures
        defined in the cases module into the current module.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import case_to_argvalues
```

**Function**:
Converts a case function to pytest argvalues (values, ids, marks).

**Parameter Description**:
- `host_class_or_module`: Module or class containing the case.
- `case_fun`: Case function to convert.
- `prefix`: Case function prefix.
- `scope`: Pytest fixture scope.
- `import_fixtures`: Whether to import fixtures.
- `debug`: Enable debug output.

**Return Value**:
Tuple of (argvalues, ids, marks) for a single case.

#### 30. `get_or_create_case_fixture()` - Function Name

**Function Signature**:
```python
def get_or_create_case_fixture(case_id,                # type: str
                               case_fun,               # type: Callable
                               target_host,            # type: Union[Type, ModuleType]
                               add_required_fixtures,  # type: Iterable[str]
                               scope,                  # type: str
                               import_fixtures=False,  # type: bool
                               debug=False             # type: bool
                               ):
    # type: (...) -> Tuple[str, Tuple[Mark]]
    """
    When case functions require fixtures, we want to rely on pytest to inject everything. Therefore
    we create a "case fixture" wrapping the case function. Since a case function may not be located in the same place
    than the symbol decorated with @parametrize_with_cases, we create that "case fixture" in the
    appropriate module/class (the host of the test/fixture function, `target_host`).

    If the case is parametrized, the parametrization marks are put on the created fixture.

    If the case has other marks, they are returned as the

    Note that we create a small cache in the module/class in order to reuse the created fixture corresponding
    to a case function if it was already required by a test/fixture in this host.

    :param case_id:
    :param case_fun:
    :param target_host:
    :param add_required_fixtures:
    :param import_fixtures: experimental feature. Turn this to True in order to automatically import all fixtures
        defined in the cases module into the current module.
    :param debug:
    :return: the newly created fixture name, and the remaining marks not applied
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_or_create_case_fixture
```

**Function**:
Creates a fixture for a case or returns an existing one, wiring dependencies.

**Parameter Description**:
- `case_id`: Identifier for the case fixture.
- `case_fun`: Case function to create fixture for.
- `target_host`: Target module or class to add fixture to.
- `add_required_fixtures`: Whether to add required fixtures.
- `scope`: Pytest fixture scope.
- `import_fixtures`: Whether to import fixtures.
- `debug`: Enable debug output.

**Return Value**:
Fixture function or existing fixture.

#### 31. `name_changer()` - Function Name

**Function Signature**:
```python
def name_changer(name, i)
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import name_changer
```

**Function**:
It is an internal function of the `get_or_create_case_fixture` function
Helper to generate unique names when synthesizing fixtures from cases.

**Parameter Description**:
- `name`: Base name.
- `i`: Index to append.

**Return Value**:
Modified name string.

#### 32. `_get_fixture_cases()` - Function Name

**Function Signature**:
```python
def _get_fixture_cases(module_or_class  # type: Union[ModuleType, Type]
                       ):
    """
    Returns our 'storage unit' in a module or class, used to remember the fixtures created from case functions.
    That way we can reuse fixtures already created for cases, in a given module/class.

    In addition, the host module of the class, or the module itself, is used to store a list of modules
    from where we imported fixtures already. This relates to the EXPERIMENTAL `import_fixtures=True` param.
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _get_fixture_cases
```

**Function**:
Returns all case functions defined as fixtures within a module or class.

**Parameter Description**:
- `module_or_class`: Module or class to search for fixture cases.

**Return Value**:
List of fixture case functions.

#### 33. `import_default_cases_module()` - Function Name

**Function Signature**:
```python
def import_default_cases_module(test_module_name):
    """
    Implements the `module=AUTO` behaviour of `@parameterize_cases`.

    `test_module_name` will have the format "test_<module>.py", the associated python module "test_<module>_cases.py"
    will be loaded to load the cases.

    If "test_<module>_cases.py" module is not found it looks for the alternate file `cases_<module>.py`.

    :param test_module_name: the test module
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import import_default_cases_module
```

**Function**:
Imports the default cases module alongside a test module when needed.

**Parameter Description**:
- `test_module_name`: Name of the test module.

**Return Value**:
The imported cases module or None.

#### 34. `hasinit()` - Function Name

**Function Signature**:
```python
def hasinit(obj): ...
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import hasinit
```

**Function**:
Returns True if the object defines an __init__ method.

**Parameter Description**:
- `obj`: Object to check.

**Return Value**:
True if obj has __init__, False otherwise.

#### 35. `hasnew()` - Function Name

**Function Signature**:
```python
def hasnew(obj): ...
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import hasnew
```

**Function**:
Returns True if the object defines a __new__ method.

**Parameter Description**:
- `obj`: Object to check.

**Return Value**:
True if obj has __new__, False otherwise.

#### 36. `extract_cases_from_class()` - Function Name

**Function Signature**:
```python
def extract_cases_from_class(cls,
                             check_name=True,
                             case_fun_prefix=CASE_PREFIX_FUN,
                             _case_param_factory=None
                             ):
    # type: (...) -> List[Callable]
    """
    Collects all case functions (methods matching ``case_fun_prefix``) in class ``cls``.

    Parameters
    ----------
    cls : Type
        A class where to look for case functions. All methods matching ``prefix`` will be returned.

    check_name : bool
        If this is ``True`` and class name does not contain the string ``Case``, the class will not be inspected and
        an empty list will be returned.

    case_fun_prefix : str
        A prefix that case functions (class methods) must match to be collected.

    _case_param_factory :
        Legacy. Not used.

    Returns
    -------
    cases_lst : List[Callable]
        A list of collected case functions (class methods).
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import extract_cases_from_class
```

**Function**:
Discovers case functions from a class according to naming and factory rules.

**Parameter Description**:
- `cls`: Class to extract case functions from.
- `check_name`: Whether to validate names.
- `case_fun_prefix`: Expected prefix for case functions.
- `_case_param_factory`: Factory for creating case parameters.

**Return Value**:
List of case functions extracted from the class.

#### 37. `extract_cases_from_module()` - Function Name

**Function Signature**:
```python
def extract_cases_from_module(module,                           # type: Union[str, ModuleRef]
                              package_name=None,                # type: str
                              case_fun_prefix=CASE_PREFIX_FUN,  # type: str
                              _case_param_factory=None
                              ):
    # type: (...) -> List[Callable]
    """
    Internal method used to create a list of case functions for all cases available from the given module.
    See `@cases_data`

    See also `_pytest.python.PyCollector.collect` and `_pytest.python.PyCollector._makeitem` and
    `_pytest.python.pytest_pycollect_makeitem`: we could probably do this in a better way in pytest_pycollect_makeitem

    Parameters
    ----------
    module : Union[str, ModuleRef]
        A module where to look for case functions. All functions in the module matching ``prefix`` will be
        returned. In addition, all classes in the module with ``Case`` in their name will be inspected. For each of
        them, all methods matching ``prefix`` will be returned too.

    package_name : Optional[str], default: None
        If ``module`` is provided as a string, this is a mandatory package full qualified name (e.g. ``a.b.c``) where
        to import the module from.

    case_fun_prefix : str
        A prefix that case functions (including class methods) must match to be collected.

    _case_param_factory :
        Legacy. Not used.

    Returns
    -------
    cases : List[Callable]
        A list of case functions
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import extract_cases_from_module
```

**Function**:
Discovers case functions from a module considering prefixes, tags, and factories.

**Parameter Description**:
- `module`: Module to extract case functions from.
- `package_name`: Package name for the module.
- `case_fun_prefix`: Expected prefix for case functions.
- `_case_param_factory`: Factory for creating case parameters.

**Return Value**:
List of case functions extracted from the module.

#### 38. `_extract_cases_from_module_or_class()` - Function Name

**Function Signature**:
```python
def _extract_cases_from_module_or_class(module=None,                      # type: ModuleRef
                                        cls=None,                         # type: Type
                                        case_fun_prefix=CASE_PREFIX_FUN,  # type: str
                                        _case_param_factory=None
                                        ):  # type: (...) -> List[Callable]
    """
    Extracts all case functions from `module` or `cls` (only one non-None must be provided).

    Parameters
    ----------
    module : Optional[ModuleRef], default: None
        A module where to look for case functions. All functions in the module matching ``prefix`` will be
        returned. In addition, all classes in the module with ``Case`` in their name will be inspected. For each of
        them, all methods matching ``prefix`` will be returned too.

    cls : Optional[Type], default: None
        A class where to look for case functions. All methods matching ``prefix`` will be returned.

    case_fun_prefix : str
        A prefix that case functions (including class methods) must match to be collected.

    _case_param_factory :
        Legacy. Not used.

    Returns
    -------
    cases : List[Callable]
        A list of case functions
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _extract_cases_from_module_or_class
```

**Function**:
Internal routine that extracts cases from either a module or a class.

**Parameter Description**:
- `module`: Module to extract from (optional).
- `cls`: Class to extract from (optional).
- `case_fun_prefix`: Expected prefix for case functions.
- `_case_param_factory`: Factory for creating case parameters.

**Return Value**:
List of case functions extracted from module or class.

#### 39. `get_current_params()` - Function Name

**Function Signature**:
```python
def get_current_params(request_or_item):
    """
    Returns a dictionary containing all parameters for the currently active `pytest` item.
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_current_params
```

**Function**:
Returns the current parameter dictionary during a parametrized test run.

**Parameter Description**:
- `request_or_item`: Pytest request or test item.

**Return Value**:
Dictionary of current parameter values.

#### 40. `_is_same_parametrized_target()` - Function Name

**Function Signature**:
```python
def _is_same_parametrized_target(parametrized, test_fun):
    """

    :param parametrized:
    :param test_fun:
    :return:
    """
    return parametrized.__name__ == test_fun.__name__
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _is_same_parametrized_target
```

**Function**:
Checks whether two parametrized targets represent the same underlying test.

**Parameter Description**:
- `parametrized`: Parametrized target object.
- `test_fun`: Test function to compare.

**Return Value**:
True if they represent the same test, False otherwise.

#### 41. `_find_fixture_name()` - Function Name

**Function Signature**:
```python
def _find_fixture_name(parametrized):
    """
    Finds the actual fixture symbol whose implementation is this function.
    :param parametrized:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _find_fixture_name
```

**Function**:
Retrieves the fixture name associated with a parametrized target.

**Parameter Description**:
- `parametrized`: Parametrized target object.

**Return Value**:
Fixture name string or None.

#### 42. `get_current_param()` - Function Name

**Function Signature**:
```python
def get_current_param(value, argname_or_fixturename, mp_fix_to_args):
    """
    This function's primary role is to unpack the various parameter values (instances of `ParamAlternative`) created by
    @parametrize when a fixture reference is used in the parametrization.

    Returns the argnames, actual value, and parametrized fixture name if it can be known,
    associated with parameter value `value`.

    :param value:
    :param argname_or_fixturename:
    :param mp_fix_to_args:
    :return: (argnames, actual_value, paramztrized_fixname)
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_current_param
```

**Function**:
Returns the current parameter value bound to a given argument or fixture.

**Parameter Description**:
- `value`: Default value to return if not found.
- `argname_or_fixturename`: Parameter or fixture name.
- `mp_fix_to_args`: Mapping from fixtures to arguments.

**Return Value**:
Current parameter value or the default.

#### 43. `_do()` - Function Name

**Function Signature**:
```python
def _do(name, value, dct, preserve = False)
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _do
```

**Function**:
It is an internal function of the `get_current_cases` function
Internal helper to update dictionaries preserving pre-existing entries when requested.

**Parameter Description**:
- `name`: Key to set in the dictionary.
- `value`: Value to set.
- `dct`: Dictionary to update.
- `preserve`: If True, don't overwrite existing keys.

**Return Value**:
None (modifies dct in place).

#### 44. `_get_place_as()` - Function Name

**Function Signature**:
```python
def _get_place_as(f): ...
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _get_place_as
```

**Function**:
Returns the placement (module/class) where a function logically belongs.

**Parameter Description**:
- `f`: Function to get placement for.

**Return Value**:
Module or class object where the function belongs.

#### 45. `get_current_case_id()` - Function Name

**Function Signature**:
```python
def get_current_case_id(request_or_item,
                        argnames  # type: Union[Iterable[str], str]
                        ):
    """ DEPRECATED - use `get_current_cases` instead
    A helper function to return the current case id for a given `pytest` item (available in some hooks) or `request`
    (available in hooks, and also directly as a fixture).

    You need to provide the argname(s) used in the corresponding `@parametrize_with_cases` so that this method finds
    the right id.

    :param request_or_item:
    :param argnames:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_current_case_id
```

**Function**:
Returns the currently active case id within a parametrized test function.

**Parameter Description**:
- `request_or_item`: Pytest request or test item.
- `argnames`: Parameter names for the test.

**Return Value**:
Current case identifier string.

#### 46. `get_code_first_line()` - Function Name

**Function Signature**:
```python
def get_code_first_line(f):
    """
    Returns the source code associated to function or class f. It is robust to wrappers such as @lru_cache
    :param f:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_others import get_code_first_line
```

**Function**:
Returns the first line of source code for a function.

**Parameter Description**:
- `f`: Function to get the first line for.

**Return Value**:
String containing the first line of the function's source code.

#### 47. `unfold_expected_err()` - Function Name

**Function Signature**:
```python
def unfold_expected_err(expected_e  # type: ExpectedError
                        ):
    # type: (...) -> Tuple[ExpectedErrorType, ExpectedErrorPattern, ExpectedErrorInstance, ExpectedErrorValidator]
    """
    'Unfolds' the expected error `expected_e` to return a tuple of
     - expected error type
     - expected error representation pattern (a regex Pattern)
     - expected error instance
     - error validation callable

    If `expected_e` is an exception type, returns `expected_e, None, None, None`

    If `expected_e` is a string, returns `BaseException, re.compile(expected_e), None, None`

    If `expected_e` is an exception instance, returns `type(expected_e), None, expected_e, None`

    If `expected_e` is an exception validation function, returns `BaseException, None, None, expected_e`

    :param expected_e: an `ExpectedError`, that is, either an exception type, a regex string, an exception
        instance, or an exception validation function
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_others import unfold_expected_err
```

**Function**:
Normalizes an expected error spec into a uniform structure used by assertions.

**Parameter Description**:
- `expected_e`: Expected error specification (can be exception class, tuple, or other format).

**Return Value**:
Normalized error specification structure.

#### 48. `assert_exception()` - Function Name

**Function Signature**:
```python
def assert_exception(expected  # type: ExpectedError
    ):
 return AssertException(expected)
```

**Import Statement**:
```python
from pytest_cases.common_others import assert_exception
```

**Function**:
Context manager/helper to assert that a callable raises the expected exception.

**Parameter Description**:
- `expected`: Expected exception specification.

**Return Value**:
Context manager for exception assertion.

#### 49. `get_host_module()` - Function Name

**Function Signature**:
```python
def get_host_module(a):
    """get the host module of a, or a if it is already a module"""
```

**Import Statement**:
```python
from pytest_cases.common_others import get_host_module
```

**Function**:
Returns the module hosting an object (function/class), following indirections.

**Parameter Description**:
- `a`: Object (function or class) to get the host module for.

**Return Value**:
Module object hosting the given object.

#### 50. `in_same_module()` - Function Name

**Function Signature**:
```python
def in_same_module(a, b):
    """Compare the host modules of a and b"""
    return get_host_module(a) == get_host_module(b)
```

**Import Statement**:
```python
from pytest_cases.common_others import in_same_module
```

**Function**:
Checks whether two objects live in the same module.

**Parameter Description**:
- `a`: First object.
- `b`: Second object.

**Return Value**:
True if both objects are in the same module, False otherwise.

#### 51. `get_function_host()` - Function Name

**Function Signature**:
```python

def get_function_host(func, fallback_to_module=True):
    """
    Returns the module or class where func is defined. Approximate method based on qname but "good enough"

    :param func:
    :param fallback_to_module: if True and an HostNotConstructedYet error is caught, the host module is returned
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_others import get_function_host
```

**Function**:
Returns the module or class that hosts a function, optionally falling back to module when unbounded.

**Parameter Description**:
- `func`: Function to get the host for.
- `fallback_to_module`: If True, return module when function is unbound.

**Return Value**:
Module or class that hosts the function.

#### 52. `needs_binding()` - Function Name

**Function Signature**:
```python
def needs_binding(f, return_bound=False):
    # type: (...) -> Union[bool, Tuple[bool, Callable]]
    """Utility to check if a function needs to be bound to be used """

```

**Import Statement**:
```python
from pytest_cases.common_others import needs_binding
```

**Function**:
Returns True if a function requires explicit binding (belongs to a class) and optionally returns a bound method.

**Parameter Description**:
- `f`: Function to check.
- `return_bound`: If True, return the bound method; if False, just return boolean.

**Return Value**:
True if function needs binding, or the bound method if return_bound=True.

#### 53. `is_static_method()` - Function Name

**Function Signature**:
```python
def is_static_method(cls, func_name, func=None):
    """ Adapted from https://stackoverflow.com/a/64436801/7262247

    indeed isinstance(staticmethod) does not work if the method is already bound

    :param cls:
    :param func_name:
    :param func: optional, if you have it already
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_others import is_static_method
```

**Function**:
Checks if a given name/function is a staticmethod in a class.

**Parameter Description**:
- `cls`: Class to check.
- `func_name`: Name of the function to check.
- `func`: Optional function object to check directly.

**Return Value**:
True if the function is a staticmethod, False otherwise.

#### 54. `is_class_method()` - Function Name

**Function Signature**:
```python
def is_class_method(cls, func_name, func=None):
    """ Adapted from https://stackoverflow.com/a/64436801/7262247

    indeed isinstance(classmethod) does not work if the method is already bound

    :param cls:
    :param func_name:
    :param func: optional, if you have it already
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_others import is_class_method
```

**Function**:
Checks if a given name/function is a classmethod in a class.

**Parameter Description**:
- `cls`: Class to check.
- `func_name`: Name of the function to check.
- `func`: Optional function object to check directly.

**Return Value**:
True if the function is a classmethod, False otherwise.

#### 55. `is_bound_builtin_method()` - Function Name

**Function Signature**:
```python
def is_bound_builtin_method(meth):
    """Helper returning True if meth is a bound built-in method"""
    return (inspect.isbuiltin(meth)
            and getattr(meth, '__self__', None) is not None
            and getattr(meth.__self__, '__class__', None))

```

**Import Statement**:
```python
from pytest_cases.common_others import is_bound_builtin_method
```

**Function**:
Checks if an object is a bound built-in method.

**Parameter Description**:
- `meth`: Method object to check.

**Return Value**:
True if meth is a bound built-in method, False otherwise.

#### 56. `funcopy()` - Function Name

**Function Signature**:
```python
def funcopy(f):
    """

    >>> def foo():
    ...     return 1
    >>> foo.att = 2
    >>> f = funcopy(foo)
    >>> f.att
    2
    >>> f()
    1

    """
```

**Import Statement**:
```python
from pytest_cases.common_others import funcopy
```

**Function**:
Creates a shallow copy of a function suitable for decorating or wrapping.

**Parameter Description**:
- `f`: Function to copy.

**Return Value**:
Shallow copy of the function.

#### 57. `robust_isinstance()` - Function Name

**Function Signature**:
```python
def robust_isinstance(o, cls): ...
```

**Import Statement**:
```python
from pytest_cases.common_others import robust_isinstance
```

**Function**:
Type check avoiding circular import traps and version differences.

**Parameter Description**:
- `o`: Object to check.
- `cls`: Class or type to check against.

**Return Value**:
True if o is an instance of cls, False otherwise.

#### 58. `isidentifier()` - Function Name

**Function Signature**:
```python
def isidentifier(s # type: str
): 
"""python 2+3 compliant <str>.isidentifier()"""
```

**Import Statement**:
```python
from pytest_cases.common_others import isidentifier
```

**Function**:
Checks if a string forms a valid Python identifier.

**Parameter Description**:
- `s`: String to check.

**Return Value**:
True if s is a valid identifier, False otherwise.

#### 59. `make_identifier()` - Function Name

**Function Signature**:
```python
def make_identifier(name  # type: str
                    ):
    """Transform the given name into a valid python identifier"""
```

**Import Statement**:
```python
from pytest_cases.common_others import make_identifier
```

**Function**:
Converts a name into a valid identifier, cleaning invalid characters.

**Parameter Description**:
- `name`: Name string to convert to a valid identifier.

**Return Value**:
Valid Python identifier string.

#### 60. `pytest_is_running()` - Function Name

**Function Signature**:
```python
def pytest_is_running():
    """Return True if the current process is a pytest run

    See https://stackoverflow.com/questions/25188119/test-if-code-is-executed-from-within-a-py-test-session
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import pytest_is_running
```

**Function**:
Returns True if pytest is the running test framework.

**Parameter Description**:
None

**Return Value**:
True if pytest is running, False otherwise.

#### 61. `remove_duplicates()` - Function Name

**Function Signature**:
```python
def remove_duplicates(lst): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest import remove_duplicates
```

**Function**:
Removes duplicates from a list while preserving order.

**Parameter Description**:
- `lst`: List to remove duplicates from.

**Return Value**:
List with duplicates removed, preserving order.

#### 62. `safe_isclass()` - Function Name

**Function Signature**:
```python
def safe_isclass(obj  # type: object
                 ):
    # type: (...) -> bool
    """Ignore any exception via isinstance on Python 3."""
```

**Import Statement**:
```python
from pytest_cases.common_pytest import safe_isclass
```

**Function**:
Type check that behaves correctly across Python versions and avoids import cycles.

**Parameter Description**:
- `obj`: Object to check.

**Return Value**:
True if obj is a class, False otherwise.

#### 63. `safe_isinstance()` - Function Name

**Function Signature**:
```python
def safe_isinstance(obj,  # type: object
                    cls):
    # type: (...) -> bool
    """Ignore any exception via isinstance"""
```

**Import Statement**:
```python
from pytest_cases.common_pytest import safe_isinstance
```

**Function**:
Type check handling both Python 2/3 and avoiding circular imports.

**Parameter Description**:
- `obj`: Object to check.
- `cls`: Class or type to check against.

**Return Value**:
True if obj is an instance of cls, False otherwise.

#### 64. `assert_is_fixture()` - Function Name

**Function Signature**:
```python
def assert_is_fixture(fixture_fun  # type: Any
                      ):
    """
    Raises a ValueError if the provided fixture function is not a fixture.

    :param fixture_fun:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import assert_is_fixture
```

**Function**:
Asserts that a function is actually a pytest fixture, raising if not.

**Parameter Description**:
- `fixture_fun`: Function to check if it's a fixture.

**Return Value**:
None (raises AssertionError if not a fixture).

#### 65. `is_function_node()` - Function Name

**Function Signature**:
```python
def is_function_node(node): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest import is_function_node
```

**Function**:
Returns True if a pytest node represents a function-level item.

**Parameter Description**:
- `node`: Pytest node to check.

**Return Value**:
True if node is a function node, False otherwise.

#### 66. `get_parametrization_markers()` - Function Name

**Function Signature**:
```python
def get_parametrization_markers(fnode): 
    """
    Returns the parametrization marks on a pytest Function node.
    :param fnode:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import get_parametrization_markers
```

**Function**:
Collects all parametrize markers attached to a function node.

**Parameter Description**:
- `fnode`: Function node to get markers from.

**Return Value**:
List of parametrize marker objects.

#### 67. `get_param_names()` - Function Name

**Function Signature**:
```python
def get_param_names(fnode):
    """
    Returns a list of parameter names for the given pytest Function node.
    parameterization marks containing several names are split

    :param fnode:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import get_param_names
```

**Function**:
Returns the parameter names from a pytest parametrize marker.

**Parameter Description**:
- `fnode`: Function node to get parameter names from.

**Return Value**:
List of parameter name strings.

#### 68. `combine_ids()` - Function Name

**Function Signature**:
```python
def combine_ids(paramid_tuples):
    """
    Receives a list of tuples containing ids for each parameterset.
    Returns the final ids, that are obtained by joining the various param ids by '-' for each test node

    :param paramid_tuples:
    :return:
    """
    #
    return ['-'.join(pid for pid in testid) for testid in paramid_tuples]

```

**Import Statement**:
```python
from pytest_cases.common_pytest import combine_ids
```

**Function**:
Combines multiple id tuples into a single compact or explicit string id.

**Parameter Description**:
- `paramid_tuples`: List of (param_name, id_value) tuples.

**Return Value**:
Combined string id.

#### 69. `make_test_ids()` - Function Name

**Function Signature**:
```python
def make_test_ids(global_ids, id_marks, argnames=None, argvalues=None, precomputed_ids=None):
    """
    Creates the proper id for each test based on (higher precedence first)

     - any specific id mark from a `pytest.param` (`id_marks`)
     - the global `ids` argument of pytest parametrize (`global_ids`)
     - the name and value of parameters (`argnames`, `argvalues`) or the precomputed ids(`precomputed_ids`)

    See also _pytest.python._idvalset method

    :param global_ids:
    :param id_marks:
    :param argnames:
    :param argvalues:
    :param precomputed_ids:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import make_test_ids
```

**Function**:
Generates pytest test id strings from global ids, marks, args, and optional precomputed ids.

**Parameter Description**:
- `global_ids`: Global id mapping.
- `id_marks`: ID marks from pytest markers.
- `argnames`: Parameter names.
- `argvalues`: Parameter values.
- `precomputed_ids`: Precomputed id list.

**Return Value**:
List of test id strings.

#### 70. `resolve_ids()` - Function Name

**Function Signature**:
```python
def resolve_ids(ids,                # type: Optional[Union[Callable, Iterable[str]]]
                argvalues,          # type: Sized(Any)
                full_resolve=False  # type: bool
                ):
    # type: (...) -> Union[List[str], Callable]
    """
    Resolves the `ids` argument of a parametrized fixture.

    If `full_resolve` is False (default), iterable ids will be resolved, but not callable ids. This is useful if the
    `argvalues` have not yet been cleaned of possible `pytest.param` wrappers.

    If `full_resolve` is True, callable ids will be called using the argvalues, so the result is guaranteed to be a
    list.
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import resolve_ids
```

**Function**:
Resolves ambiguous or partial ids against argument values, including lazy resolution.

**Parameter Description**:
- `ids`: ID values or callables.
- `argvalues`: Argument values.
- `full_resolve`: If True, fully resolve lazy values.

**Return Value**:
List of resolved id strings.

#### 71. `make_test_ids_from_param_values()` - Function Name

**Function Signature**:
```python
def make_test_ids_from_param_values(param_names, param_values)
```

**Import Statement**:
```python
from pytest_cases.common_pytest import make_test_ids_from_param_values
```

**Function**:
Builds test ids based solely on parameter names and their values.

**Parameter Description**:
- `param_names`: Parameter names.
- `param_values`: Parameter values for each test case.

**Return Value**:
List of test id strings.

#### 72. `extract_parameterset_info()` - Function Name

**Function Signature**:
```python
def make_test_ids_from_param_values(param_names,
                                    param_values,
                                    ):
    """
    Replicates pytest behaviour to generate the ids when there are several parameters in a single `parametrize.
    Note that param_values should not contain marks.

    :param param_names:
    :param param_values:
    :return: a list of param ids
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import extract_parameterset_info
```

**Function**:
Extracts structure info from parametrize argnames and argvalues.

**Parameter Description**:
- `argnames`: Parameter names.
- `argvalues`: Parameter values.
- `check_nb`: Whether to check the number of parameters.

**Return Value**:
Information about the parameter set structure.

#### 73. `extract_pset_info_single()` - Function Name

**Function Signature**:
```python
def extract_pset_info_single(nbnames, argvalue):
    """Return id, marks, value"""
```

**Import Statement**:
```python
from pytest_cases.common_pytest import extract_pset_info_single
```

**Function**:
Parses a single argvalue tuple/list/tree into a (values, ids) pair.

**Parameter Description**:
- `nbnames`: Number of parameter names.
- `argvalue`: Single argument value tuple/list/tree.

**Return Value**:
Tuple of (values, ids).

#### 74. `get_pytest_nodeid()` - Function Name

**Function Signature**:
```python
def get_pytest_nodeid(metafunc): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest import get_pytest_nodeid
```

**Function**:
Returns the pytest node id for a metafunc object.

**Parameter Description**:
- `metafunc`: Metafunc object.

**Return Value**:
Node id string.

#### 75. `in_callspec_explicit_args()` - Function Name

**Function Signature**:
```python
def in_callspec_explicit_args(
    callspec,  # type: CallSpec2
    name  # type: str
):  # type: (...) -> bool
    """Return True if name is explicitly used in callspec args"""
    return (name in callspec.params) or (not PYTEST8_OR_GREATER and name in callspec.funcargs)

```

**Import Statement**:
```python
from pytest_cases.common_pytest import in_callspec_explicit_args
```

**Function**:
Checks whether a given name appears in a CallSpec's explicit arguments.

**Parameter Description**:
- `callspec`: CallSpec object.
- `name`: Argument name to check.

**Return Value**:
True if name is in explicit args, False otherwise.

#### 76. `mini_idval()` - Function Name

**Function Signature**:
```python
def mini_idval(
        val,      # type: object
        argname,  # type: str
        idx,      # type: int
):
    """
    A simplified version of idval where idfn, item and config do not need to be passed.

    :param val:
    :param argname:
    :param idx:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import mini_idval
```

**Function**:
Generates a compact string id for a single value/name/index.

**Parameter Description**:
- `val`: Value to generate id for.
- `argname`: Argument name.
- `idx`: Index.

**Return Value**:
Compact string identifier.

#### 77. `mini_idvalset()` - Function Name

**Function Signature**:
```python
def mini_idvalset(argnames, argvalues, idx):
    """ mimic _pytest.python._idvalset but can handle lazyvalues used for tuples or args

    argvalues should not be a pytest.param (ParameterSet)
    This function returns a SINGLE id for a single test node
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import mini_idvalset
```

**Function**:
Generates compact ids for a set of param values at the given index.

**Parameter Description**:
- `argnames`: Parameter names.
- `argvalues`: Parameter values for all test cases.
- `idx`: Index to generate id for.

**Return Value**:
Compact string identifier.

#### 78. `add_fixture_params()` - Function Name

**Function Signature**:
```python
def add_fixture_params(func, new_names)
```

**Import Statement**:
```python
from pytest_cases.common_pytest import add_fixture_params
```

**Function**:
Adds additional fixture parameters to an existing function.

**Parameter Description**:
- `func`: Function to add parameters to.
- `new_names`: List of additional parameter names.

**Return Value**:
None (modifies func in place).

#### 79. `wrapped_func()` - Function Name

**Function Signature**:
```python
@wraps(func, new_sig=new_sig)
def wrapped_func(**kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest import wrapped_func
```

**Function**:
It is an internal function of the `add_fixture_params` function
Generic wrapper function that accepts kwargs for cases where fixture injection occurs.

**Parameter Description**:
- `**kwargs`: Variable keyword arguments to pass through.

**Return Value**:
Result of the wrapped function execution.

#### 80. `get_callspecs()` - Function Name

**Function Signature**:
```python
def get_callspecs(func):
    """
    Returns a list of pytest CallSpec objects corresponding to calls that should be made for this parametrized function.
    This mini-helper assumes no complex things (scope='function', indirect=False, no fixtures, no custom configuration)

    Note that this function is currently only used in tests.
    """
    meta = MiniMetafunc(func)
    # meta.update_callspecs()
    # noinspection PyProtectedMember
    return meta._calls

```

**Import Statement**:
```python
from pytest_cases.common_pytest import get_callspecs
```

**Function**:
Retrieves pytest CallSpec objects attached to a function node.

**Parameter Description**:
- `func`: Function to get CallSpecs from.

**Return Value**:
List of CallSpec objects.

#### 81. `cart_product_pytest()` - Function Name

**Function Signature**:
```python
def cart_product_pytest(argnames, argvalues):
    """
     - do NOT use `itertools.product` as it fails to handle MarkDecorators
     - we also unpack tuples associated with several argnames ("a,b") if needed
     - we also propagate marks

    :param argnames:
    :param argvalues:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import cart_product_pytest
```

**Function**:
Creates a cartesian product of multiple parametrization lists.

**Parameter Description**:
- `argnames`: Parameter names.
- `argvalues`: Parameter values.

**Return Value**:
Cartesian product of argnames and argvalues.

#### 82. `_cart_product_pytest()` - Function Name

**Function Signature**:
```python
def _cart_product_pytest(argnames_lists, argvalues): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest import _cart_product_pytest
```

**Function**:
Internal helper to compute a cartesian product of argnames and values.

**Parameter Description**:
- `argnames_lists`: Lists of parameter names.
- `argvalues`: Parameter values.

**Return Value**:
Cartesian product result.

#### 83. `inject_host()` - Function Name

**Function Signature**:
```python
def inject_host(apply_decorator):
    """
    A decorator for function with signature `apply_decorator(f, host)`, in order to inject 'host', the host of f.

    Since it is not entirely feasible to detect the host in python, my first implementation was a bit complex: it was
    returning an object with custom implementation of __call__ and __get__ methods, both reacting when pytest collection
    happens.

    That was very complex. Now we rely on an approximate but good enough alternative with `get_function_host`

    :param apply_decorator:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest import inject_host
```

**Function**:
Decorator that injects the function's host module/class as a first argument.

**Parameter Description**:
- `apply_decorator`: Decorator function to apply.

**Return Value**:
Decorator that injects the host.

#### 84. `apply()` - Function Name

**Function Signature**:
```python
def apply(test_or_fixture_func)
```

**Import Statement**:
```python
from pytest_cases.common_pytest import apply
```

**Function**:
It is an internal function of the `inject_host` function
Decorator that applies pytest marks and transformations to a test or fixture function.

**Parameter Description**:
- `test_or_fixture_func`: Test or fixture function to apply transformations to.

**Return Value**:
Decorated function.

#### 85. `get_pytest_request_and_item()` - Function Name

**Function Signature**:
```python
def get_pytest_request_and_item(request_or_item):
    """Return the `request` and `item` (node) from whatever is provided"""
```

**Import Statement**:
```python
from pytest_cases.common_pytest import get_pytest_request_and_item
```

**Function**:
Extracts both request and item from pytest objects, normalizing input.

**Parameter Description**:
- `request_or_item`: Pytest request or item object.

**Return Value**:
Tuple of (request, item).

#### 86. `_unwrap()` - Function Name

**Function Signature**:
```python
def _unwrap(obj):
    """A light copy of _pytest.compat.get_real_func. In our case
    we do not wish to unwrap the partial nor handle pytest fixture
    Note: maybe from inspect import unwrap could do the same?
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import _unwrap
```

**Function**:
Removes wrapper objects to access the underlying object (usually a function).

**Parameter Description**:
- `obj`: Object to unwrap.

**Return Value**:
Underlying unwrapped object.

#### 87. `partial_to_str()` - Function Name

**Function Signature**:
```python
def partial_to_str(partialfun):
    """Return a string representation of a partial function, to use in lazy_value ids"""
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import partial_to_str
```

**Function**:
Converts a functools.partial object into a string representation.

**Parameter Description**:
- `partialfun`: functools.partial object.

**Return Value**:
String representation of the partial function.

#### 88. `is_lazy_value()` - Function Name

**Function Signature**:
```python
def is_lazy_value(argval):
    """ Return True if `argval` is the *immediate* output of `lazy_value()` """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import is_lazy_value
```

**Function**:
Returns True if the argument value is a lazy value wrapper.

**Parameter Description**:
- `argval`: Argument value to check.

**Return Value**:
True if argval is a lazy value, False otherwise.

#### 89. `is_lazy()` - Function Name

**Function Signature**:
```python
def is_lazy(argval):
    """
    Return True if `argval` is the outcome of processing a `lazy_value` through `@parametrize`
    As opposed to `is_lazy_value`, this encompasses lazy tuples that are created when parametrizing several argnames
    with the same `lazy_value()`.
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import is_lazy
```

**Function**:
Checks if an argument value is lazy (alias for is_lazy_value).

**Parameter Description**:
- `argval`: Argument value to check.

**Return Value**:
True if argval is lazy, False otherwise.

#### 90. `get_lazy_args()` - Function Name

**Function Signature**:
```python
def get_lazy_args(argval, request_or_item):
    """
    Possibly calls the lazy values contained in argval if needed, before returning it.
    Since the lazy values cache their result to ensure that their underlying function is called only once
    per test node, the `request` argument here is mandatory.

    :param request_or_item: the context of this call: either a pytest request or item
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import get_lazy_args
```

**Function**:
Resolves lazy argument values into concrete values using the request context.

**Parameter Description**:
- `argval`: Lazy argument value.
- `request_or_item`: Pytest request or item for context.

**Return Value**:
Resolved concrete value.

#### 91. `get_test_node()` - Function Name

**Function Signature**:
```python
def get_test_node(request_or_item):
    """
    Return the test node, typically a _pytest.Function.
    Provided arg may be the node already, or the pytest request

    :param request_or_item:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_lazy_values import get_test_node
```

**Function**:
Returns the pytest item node from a request or item object.

**Parameter Description**:
- `request_or_item`: Pytest request or item object.

**Return Value**:
Pytest item node.

#### 92. `get_param_argnames_as_list()` - Function Name

**Function Signature**:
```python
def get_param_argnames_as_list(argnames):
    """
    pytest parametrize accepts both coma-separated names and list/tuples.
    This function makes sure that we always return a list
    :param argnames:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_param_argnames_as_list
```

**Function**:
Converts parameter names from string or list format into a list format.

**Parameter Description**:
- `argnames`: Parameter names (string or list).

**Return Value**:
List of parameter names.

#### 93. `_pytest_mark_parametrize()` - Function Name

**Function Signature**:
```python
def _pytest_mark_parametrize(argnames, argvalues, ids = None, indirect = False, scope = None, **kwargs):
    pass
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import _pytest_mark_parametrize
```

**Function**:
Creates a pytest.mark.parametrize decorator with the given arguments.

**Parameter Description**:
- `argnames`: Parameter names.
- `argvalues`: Parameter values.
- `ids`: ID generation strategy.
- `indirect`: Whether parameters are indirect.
- `scope`: Fixture scope.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
pytest.mark.parametrize decorator.

#### 94. `get_parametrize_signature()` - Function Name

**Function Signature**:
```python
def get_parametrize_signature():
    """

    :return: a reference signature representing
    """
    return signature(_pytest_mark_parametrize)
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_parametrize_signature
```

**Function**:
Returns the signature parameters for pytest.mark.parametrize.

**Parameter Description**:
None

**Return Value**:
Signature information for parametrize.

#### 95. `copy_pytest_marks()` - Function Name

**Function Signature**:
```python
def copy_pytest_marks(from_f, to_f, override = False):
    """Copy all pytest marks from a function or class to another"""

```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import copy_pytest_marks
```

**Function**:
Copies pytest marks from one function to another, optionally overriding.

**Parameter Description**:
- `from_f`: Source function to copy marks from.
- `to_f`: Target function to copy marks to.
- `override`: Whether to override existing marks.

**Return Value**:
None (modifies to_f in place).

#### 96. `filter_marks()` - Function Name

**Function Signature**:
```python
def filter_marks(marks,  # type: Iterable[Mark]
                 remove  # type: str
                 ):
    # type: (...) -> Tuple[Mark]
    """
    Returns a tuple of all marks in `marks` that do not have a 'parametrize' name.

    :param marks:
    :param remove:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import filter_marks
```

**Function**:
Removes specific marks from a marks list or collection.

**Parameter Description**:
- `marks`: List of marks to filter.
- `remove`: Mark names or types to remove.

**Return Value**:
Filtered list of marks.

#### 97. `get_pytest_marks_on_function()` - Function Name

**Function Signature**:
```python
def get_pytest_marks_on_function(f,
                                 as_decorators=False  # type: bool
                                 ):
    # type: (...) -> Union[List[Mark], List[MarkDecorator]]
    """
    Utility to return a list of *ALL* pytest marks (not only parametrization) applied on a function
    Note that this also works on classes

    :param f:
    :param as_decorators: transforms the marks into decorators before returning them
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_pytest_marks_on_function
```

**Function**:
Retrieves all pytest marks from a function, optionally returning decorator objects.

**Parameter Description**:
- `f`: Function to get marks from.
- `as_decorators`: If True, return as decorator objects.

**Return Value**:
List of mark objects or decorators.

#### 98. `get_pytest_marks_on_item()` - Function Name

**Function Signature**:
```python
def get_pytest_marks_on_item(item):
    """lists all marks on an item such as `request._pyfuncitem`"""
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_pytest_marks_on_item
```

**Function**:
Extracts pytest marks from a test item or node.

**Parameter Description**:
- `item`: Pytest test item or node.

**Return Value**:
List of mark objects.

#### 99. `get_pytest_usefixture_marks()` - Function Name

**Function Signature**:
```python
def get_pytest_usefixture_marks(f): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_pytest_usefixture_marks
```

**Function**:
Returns all usefixture marks on a function.

**Parameter Description**:
- `f`: Function to get usefixture marks from.

**Return Value**:
List of usefixture mark objects.

#### 100. `remove_pytest_mark()` - Function Name

**Function Signature**:
```python
def remove_pytest_mark(f, mark_name): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import remove_pytest_mark
```

**Function**:
Removes a specific pytest mark from a function's mark collection.

**Parameter Description**:
- `f`: Function to remove marks from.
- `mark_name`: Name of the mark to remove.

**Return Value**:
None (modifies f in place).

#### 101. `get_pytest_parametrize_marks()` - Function Name

**Function Signature**:
```python
def get_pytest_parametrize_marks(
    f,
    pop=False  # type: bool
):
    """
    Returns the @pytest.mark.parametrize marks associated with a function (and only those)

    :param f:
    :param pop: boolean flag, when True the marks will be removed from f.
    :return: a tuple containing all 'parametrize' marks
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import get_pytest_parametrize_marks
```

**Function**:
Retrieves pytest.mark.parametrize marks from a function, optionally popping them.

**Parameter Description**:
- `f`: Function to get marks from.
- `pop`: If True, remove marks after retrieving.

**Return Value**:
List of parametrize mark objects.

#### 102. `markinfos_to_markdecorators()` - Function Name

**Function Signature**:
```python
def markinfos_to_markdecorators(marks,                # type: Iterable[Mark]
                                function_marks=False  # type: bool
                                ):
    # type: (...) -> List[MarkDecorator]
    """
    Transforms the provided marks (MarkInfo or Mark in recent pytest) obtained from marked cases, into MarkDecorator so
    that they can be re-applied to generated pytest parameters in the global @pytest.mark.parametrize.

    Returns a list.

    :param marks:
    :param function_marks:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import markinfos_to_markdecorators
```

**Function**:
Converts mark info objects into mark decorator objects.

**Parameter Description**:
- `marks`: List of mark info objects.
- `function_marks`: Whether these are function marks.

**Return Value**:
List of mark decorator objects.

#### 103. `markdecorators_to_markinfos()` - Function Name

**Function Signature**:
```python
def markdecorators_to_markinfos(marks # type: Sequence[MarkDecorator]
): ...
```

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import markdecorators_to_markinfos
```

**Function**:
Extracts mark info from decorator objects.

**Parameter Description**:
- `marks`: List of mark decorator objects.

**Return Value**:
List of mark info objects.

#### 104. `has_tags()` - Function Name

**Function Signature**:
```python
def has_tags(*tag_names  # type: str
             ):
    """
    Selects cases that have all tags in `tag_names`. See `@case(tags=...)` to add tags to a case.

    :param tag_names:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.filters import has_tags
```

**Function**:
Creates a filter function that checks if a case has specific tags.

**Parameter Description**:
- `*tag_names`: Variable-length tag names to filter by.

**Return Value**:
Filter function that checks for tags.

#### 105. `_filter()` - Function Name

**Function Signature**:
```python
def _filter(case)
```

**Import Statement**:
```python
from pytest_cases.filters import _filter
```

**Function**:
It is an internal function of `has_tags`, `id_has_prefix`,`id_has_suffix` and `id_match_regex` functions.
Internal filtering logic for case functions.

**Parameter Description**:
- `case`: Case function to filter.

**Return Value**:
True if case passes the filter, False otherwise.

#### 106. `id_has_prefix()` - Function Name

**Function Signature**:
```python
def id_has_prefix(prefix  # type: str
                  ):
    """
    Selects cases that have a case id prefix `prefix`.

    Note that this is not the prefix of the whole case function name, but the case id,
    possibly overridden with `@case(id=)`
    """
```

**Import Statement**:
```python
from pytest_cases.filters import id_has_prefix
```

**Function**:
Creates a filter that matches case ids with the given prefix.

**Parameter Description**:
- `prefix`: Prefix string to match.

**Return Value**:
Filter function that checks for prefix.

#### 107. `id_has_suffix()` - Function Name

**Function Signature**:
```python
def id_has_suffix(suffix  # type: str
                  ):
    """
    Selects cases that have a case id suffix `suffix`.

    Note that this is not the suffix of the whole case function name, but the case id,
    possibly overridden with `@case(id=)`
    """
```

**Import Statement**:
```python
from pytest_cases.filters import id_has_suffix
```

**Function**:
Creates a filter that matches case ids with the given suffix.

**Parameter Description**:
- `suffix`: Suffix string to match.

**Return Value**:
Filter function that checks for suffix.

#### 108. `is_fixture_union_params()` - Function Name

**Function Signature**:
```python
def is_fixture_union_params(params):
    """
    Internal helper to quickly check if a bunch of parameters correspond to a union fixture.

    Note: unfortunately `pytest` transform all params to a list when a @pytest.fixture is created,
    so we can not pass a subclass of list to do the trick, we really have to work on the list elements.
    :param params:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import is_fixture_union_params
```

**Function**:
Checks if parameters indicate a fixture union scenario.

**Parameter Description**:
- `params`: Parameters to check.

**Return Value**:
True if params indicate a fixture union, False otherwise.

#### 109. `is_used_request()` - Function Name

**Function Signature**:
```python
def is_used_request(request):
    return getattr(request, 'param', None) is not NOT_USED
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import is_used_request
```

**Function**:
Determines if a pytest request object is actually used by the fixture.

**Parameter Description**:
- `request`: Pytest request object.

**Return Value**:
True if request is used, False otherwise.

#### 110. `ignore_unused()` - Function Name

**Function Signature**:
```python
def ignore_unused(fixture_func):
    """
    A decorator for fixture functions so that they are compliant with fixture unions.
    It

     - adds the `request` fixture dependency to their signature if needed
     - filters the calls based on presence of the `NOT_USED` token in the request params.

    IMPORTANT: even if 'params' is not in kwargs, the fixture can be used in a fixture union and therefore a param
    *will* be received on some calls (and the fixture will be called several times - only once for real) - we have to
    handle the NOT_USED.

    :param fixture_func:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import ignore_unused
```

**Function**:
Decorator to mark fixture arguments as optionally unused without warnings.

**Parameter Description**:
- `fixture_func`: Fixture function to wrap.

**Return Value**:
Wrapped fixture function that ignores unused warnings.

#### 111. `_fixture_union()` - Function Name

**Function Signature**:
```python
def _fixture_union(fixtures_dest,
                   name,                  # type: str
                   fix_alternatives,      # type: Sequence[UnionFixtureAlternative]
                   unique_fix_alt_names,  # type: List[str]
                   scope="function",      # type: str
                   idstyle="compact",     # type: Optional[Union[str, Callable]]
                   ids=None,              # type: Union[Callable, Iterable[str]]
                   autouse=False,         # type: bool
                   hook=None,             # type: Callable[[Callable], Callable]
                   caller=fixture_union,  # type: Callable
                   **kwargs):
    """
    Internal implementation for fixture_union.
    The "alternatives" have to be created beforehand, by the caller. This allows `fixture_union` and `parametrize`
    to use the same implementation while `parametrize` uses customized "alternatives" containing more information.

    :param fixtures_dest:
    :param name:
    :param fix_alternatives:
    :param unique_fix_alt_names:
    :param idstyle:
    :param scope:
    :param ids:
    :param unpack_into:
    :param autouse:
    :param hook: an optional hook to apply to each fixture function that is created during this call. The hook function
        will be called every time a fixture is about to be created. It will receive a single argument (the function
        implementing the fixture) and should return the function to use. For example you can use `saved_fixture` from
        `pytest-harvest` as a hook in order to save all such created fixtures in the fixture store.
    :param caller: a function to reference for error messages
    :param kwargs:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import _fixture_union
```

**Function**:
Internal implementation for creating union fixtures that select from multiple alternatives.

**Parameter Description**:
- `fixtures_dest`: Destination module or class.
- `name`: Fixture name.
- `fix_alternatives`: List of fixture alternatives.
- `unique_fix_alt_names`: Unique alternative names.
- `scope`: Fixture scope.
- `idstyle`: ID generation style.
- `ids`: ID list.
- `autouse`: Whether fixture is autouse.
- `hook`: Hook function.
- `caller`: Caller function.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
Created union fixture function.

#### 112. `_new_fixture()` - Function Name

**Function Signature**:
```python
@with_signature("%s(%s, request)" % (name, ', '.join(unique_fix_alt_names)))
def _new_fixture(request, **all_fixtures): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import _new_fixture
```

**Function**:
It is an internal function of the `_fixture_union` function
Creates a new fixture generator from a request and multiple fixture dependencies.

**Parameter Description**:
- `request`: Pytest request object.
- `**all_fixtures`: All fixture dependencies.

**Return Value**:
Fixture generator function.

#### 113. `unpack_fixture()` - Function Name

**Function Signature**:
```python
def unpack_fixture(argnames,      # type: str
                   fixture,       # type: Union[str, Callable]
                   in_cls=False,  # type: bool
                   hook=None      # type: Callable[[Callable], Callable]
                   ):
    """
    Creates several fixtures with names `argnames` from the source `fixture`. Created fixtures will correspond to
    elements unpacked from `fixture` in order. For example if `fixture` is a tuple of length 2, `argnames="a,b"` will
    create two fixtures containing the first and second element respectively.

    The created fixtures are automatically registered into the callers' module, but you may wish to assign them to
    variables for convenience. In that case make sure that you use the same names,
    e.g. `a, b = unpack_fixture('a,b', 'c')`.

    ```python
    import pytest
    from pytest_cases import unpack_fixture, fixture

    @fixture
    @pytest.mark.parametrize("o", ['hello', 'world'])
    def c(o):
        return o, o[0]

    a, b = unpack_fixture("a,b", c)

    def test_function(a, b):
        assert a[0] == b
    ```

    You can also use this function inside a class with `in_cls=True`. In that case you MUST assign the output of the
    function to variables, as the created fixtures won't be registered with the encompassing module.

    ```python
    import pytest
    from pytest_cases import unpack_fixture, fixture

    @fixture
    @pytest.mark.parametrize("o", ['hello', 'world'])
    def c(o):
        return o, o[0]

    class TestClass:
        a, b = unpack_fixture("a,b", c, in_cls=True)

        def test_function(self, a, b):
            assert a[0] == b
    ```

    :param argnames: same as `@pytest.mark.parametrize` `argnames`.
    :param fixture: a fixture name string or a fixture symbol. If a fixture symbol is provided, the created fixtures
        will have the same scope. If a name is provided, they will have scope='function'. Note that in practice the
        performance loss resulting from using `function` rather than a higher scope is negligible since the created
        fixtures' body is a one-liner.
    :param in_cls: a boolean (default False). You may wish to turn this to `True` to use this function inside a class.
        If you do so, you **MUST** assign the output to variables in the class.
    :param hook: an optional hook to apply to each fixture function that is created during this call. The hook function
        will be called every time a fixture is about to be created. It will receive a single argument (the function
        implementing the fixture) and should return the function to use. For example you can use `saved_fixture` from
        `pytest-harvest` as a hook in order to save all such created fixtures in the fixture store.
    :return: the created fixtures.
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import unpack_fixture
```

**Function**:
Creates a fixture that unpacks a tuple/list into multiple named parameters.

**Parameter Description**:
- `argnames`: Names of parameters to unpack.
- `fixture`: Fixture to unpack from.
- `in_cls`: Whether fixture is in a class.
- `hook`: Optional hook function.

**Return Value**:
Unpacking fixture function.

#### 114. `_unpack_fixture()` - Function Name

**Function Signature**:
```python
def _unpack_fixture(fixtures_dest,  # type: ModuleType
                    argnames,       # type: Union[str, Iterable[str]]
                    fixture,        # type: Union[str, Callable]
                    in_cls,         # type: bool
                    hook            # type: Callable[[Callable], Callable]
                    ):
    """

    :param fixtures_dest: if this is `None` the fixtures won't be registered anywhere (just returned)
    :param argnames:
    :param fixture:
    :param in_cls: a boolean indicating if the `self` argument should be prepended.
    :param hook: an optional hook to apply to each fixture function that is created during this call. The hook function
        will be called every time a fixture is about to be created. It will receive a single argument (the function
        implementing the fixture) and should return the function to use. For example you can use `saved_fixture` from
        `pytest-harvest` as a hook in order to save all such created fixtures in the fixture store.
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import _unpack_fixture
```

**Function**:
Internal helper to implement unpacking fixtures in module or class contexts.

**Parameter Description**:
- `fixtures_dest`: Destination module or class.
- `argnames`: Names of parameters to unpack.
- `fixture`: Fixture to unpack from.
- `in_cls`: Whether fixture is in a class.
- `hook`: Optional hook function.

**Return Value**:
None (creates unpacking fixtures in destination).

#### 115. `param_fixture()` - Function Name

**Function Signature**:
```python
def param_fixture(argname,           # type: str
                  argvalues,         # type: Iterable[Any]
                  autouse=False,     # type: bool
                  ids=None,          # type: Union[Callable, Iterable[str]]
                  scope="function",  # type: str
                  hook=None,         # type: Callable[[Callable], Callable]
                  debug=False,       # type: bool
                  **kwargs):
    """
    Identical to `param_fixtures` but for a single parameter name, so that you can assign its output to a single
    variable.

    ```python
    import pytest
    from pytest_cases import param_fixtures, param_fixture

    # create a single parameter fixture
    my_parameter = param_fixture("my_parameter", [1, 2, 3, 4])

    @pytest.fixture
    def fixture_uses_param(my_parameter):
        ...

    def test_uses_param(my_parameter, fixture_uses_param):
        ...
    ```

    :param argname: see fixture `name`
    :param argvalues: see fixture `params`
    :param autouse: see fixture `autouse`
    :param ids: see fixture `ids`
    :param scope: see fixture `scope`
    :param hook: an optional hook to apply to each fixture function that is created during this call. The hook function
        will be called every time a fixture is about to be created. It will receive a single argument (the function
        implementing the fixture) and should return the function to use. For example you can use `saved_fixture` from
        `pytest-harvest` as a hook in order to save all such created fixtures in the fixture store.
    :param debug: print debug messages on stdout to analyze fixture creation (use pytest -s to see them)
    :param kwargs: any other argument for 'fixture'
    :return: the create fixture
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import param_fixture
```

**Function**:
Creates a parametrized fixture that provides multiple values for a single parameter.

**Parameter Description**:
- `argname`: Parameter name.
- `argvalues`: List of values for the parameter.
- `autouse`: Whether fixture is autouse.
- `ids`: ID list for values.
- `scope`: Fixture scope.
- `hook`: Optional hook function.
- `debug`: Enable debug output.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
None (creates the parametrized fixture).

#### 116. `_create_param_fixture()` - Function Name

**Function Signature**:
```python
def _create_param_fixture(fixtures_dest,
                          argname,           # type: str
                          argvalues,         # type: Sequence[Any]
                          autouse=False,     # type: bool
                          ids=None,          # type: Union[Callable, Iterable[str]]
                          scope="function",  # type: str
                          hook=None,         # type: Callable[[Callable], Callable]
                          auto_simplify=False,
                          debug=False,
                          **kwargs):
    """ Internal method shared with param_fixture and param_fixtures """
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import _create_param_fixture
```

**Function**:
Internal helper that constructs a parameter fixture from values and metadata.

**Parameter Description**:
- `fixtures_dest`: Destination module or class.
- `argname`: Parameter name.
- `argvalues`: List of values for the parameter.
- `autouse`: Whether fixture is autouse.
- `ids`: ID list for values.
- `scope`: Fixture scope.
- `hook`: Optional hook function.
- `auto_simplify`: Whether to auto-simplify.
- `debug`: Enable debug output.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
None (creates the parameter fixture in destination).

#### 117. `param_fixtures()` - Function Name

**Function Signature**:
```python
def param_fixtures(argnames, argvalues, autouse = False, ids = None, scope = 'function', hook = None, debug = False, **kwargs)
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import param_fixtures
```

**Function**:
Creates multiple parametrized fixtures from combined argnames and argvalues.

**Parameter Description**:
- `argnames`: Parameter names (string or list).
- `argvalues`: List of value tuples for parameters.
- `autouse`: Whether fixtures are autouse.
- `ids`: ID list for values.
- `scope`: Fixture scope.
- `hook`: Optional hook function.
- `debug`: Enable debug output.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
None (creates the parametrized fixtures).

#### 118. `_create_params_fixture()` - Function Name

**Function Signature**:
```python
def _create_params_fixture(fixtures_dest,
                           argnames_lst,      # type: Sequence[str]
                           argvalues,         # type: Sequence[Any]
                           autouse=False,     # type: bool
                           ids=None,          # type: Union[Callable, Iterable[str]]
                           scope="function",  # type: str
                           hook=None,         # type: Callable[[Callable], Callable]
                           debug=False,       # type: bool
                           **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import _create_params_fixture
```

**Function**:
Internal helper to create multiple combined parametrized fixtures.

**Parameter Description**:
- `fixtures_dest`: Destination module or class.
- `argnames_lst`: List of parameter names.
- `argvalues`: List of value tuples for parameters.
- `autouse`: Whether fixtures are autouse.
- `ids`: ID list for values.
- `scope`: Fixture scope.
- `hook`: Optional hook function.
- `debug`: Enable debug output.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
None (creates the parametrized fixtures in destination).

#### 119. `_root_fixture()` - Function Name

**Function Signature**:
```python
@fixture(name=root_fixture_name, autouse=autouse, scope=scope, hook=hook, **kwargs)
@pytest.mark.parametrize(argnames, argvalues, ids=ids)
@with_signature("%s(%s)" % (root_fixture_name, argnames))
def _root_fixture(**_kwargs):

```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _root_fixture
```

**Function**:
It is an internal function of the `_create_params_fixture` function
Placeholder root fixture used as a dependency anchor in fixture graphs.

**Parameter Description**:
- `**_kwargs`: Variable keyword arguments (usually empty).

**Return Value**:
None (placeholder fixture).

#### 120. `pytest_fixture_plus()` - Function Name

**Function Signature**:
```python
@pytest.hookimpl(optionalhook=True)
def pytest_fixture_plus(*args, **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import pytest_fixture_plus
```

**Function**:
Enhanced pytest fixture decorator with additional features like unpacking and parameter injection.

**Parameter Description**:
- `*args`: Variable positional arguments.
- `**kwargs`: Variable keyword arguments for fixture configuration.

**Return Value**:
Fixture decorator or decorated function.

#### 121. `_fixture_plus()` - Function Name

**Function Signature**:
```python
def _fixture_plus(f): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _fixture_plus
```

**Function**:
It is an internal function of the `pytest_fixture_plus` function
Internal decorator that prepares a function to become a fixture_plus.

**Parameter Description**:
- `f`: Function to prepare as fixture_plus.

**Return Value**:
Prepared fixture_plus function.

#### 122. `_decorate_fixture_plus()` - Function Name

**Function Signature**:
```python
def _decorate_fixture_plus(fixture_func,
                           scope="function",   # type: str
                           autouse=False,      # type: bool
                           name=None,          # type: str
                           unpack_into=None,   # type: Iterable[str]
                           hook=None,          # type: Callable[[Callable], Callable]
                           _caller_module_offset_when_unpack=3,  # type: int
                           **kwargs):
    """ decorator to mark a fixture factory function.

    Identical to `@pytest.fixture` decorator, except that

     - it supports multi-parametrization with `@pytest.mark.parametrize` as requested in
       https://github.com/pytest-dev/pytest/issues/3960. As a consequence it does not support the `params` and `ids`
       arguments anymore.

     - it supports a new argument `unpack_into` where you can provide names for fixtures where to unpack this fixture
       into.

    :param scope: the scope for which this fixture is shared, one of "function" (default), "class", "module" or
        "session".
    :param autouse: if True, the fixture func is activated for all tests that can see it.  If False (the default) then
        an explicit reference is needed to activate the fixture.
    :param name: the name of the fixture. This defaults to the name of the decorated function. Note: If a fixture is
        used in the same module in which it is defined, the function name of the fixture will be shadowed by the
        function arg that requests the fixture; one way to resolve this is to name the decorated function
        ``fixture_<fixturename>`` and then use ``@pytest.fixture(name='<fixturename>')``.
    :param unpack_into: an optional iterable of names, or string containing coma-separated names, for additional
        fixtures to create to represent parts of this fixture. See `unpack_fixture` for details.
    :param hook: an optional hook to apply to each fixture function that is created during this call. The hook function
        will be called every time a fixture is about to be created. It will receive a single argument (the function
        implementing the fixture) and should return the function to use. For example you can use `saved_fixture` from
        `pytest-harvest` as a hook in order to save all such created fixtures in the fixture store.
    :param kwargs: other keyword arguments for `@pytest.fixture`
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_core2 import _decorate_fixture_plus
```

**Function**:
Applies fixture_plus transformations and metadata to a function.

**Parameter Description**:
- `fixture_func`: Fixture function to decorate.
- `scope`: Fixture scope.
- `autouse`: Whether fixture is autouse.
- `name`: Fixture name.
- `unpack_into`: Parameters to unpack into.
- `hook`: Optional hook function.
- `_caller_module_offset_when_unpack`: Stack offset for module detection.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
Decorated fixture function.

#### 123. `_map_arguments()` - Function Name

**Function Signature**:
```python
def _map_arguments(*_args, **_kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _map_arguments
```

**Function**:
Maps pytest fixture arguments to the wrapped function's signature dynamically.

**Parameter Description**:
- `*_args`: Variable positional arguments.
- `**_kwargs`: Variable keyword arguments.

**Return Value**:
Mapped arguments.

#### 124. `_fixture_product()` - Function Name

**Function Signature**:
```python
def _fixture_product(fixtures_dest,
                     name,                # type: str
                     fixtures_or_values,
                     fixture_positions,
                     scope="function",    # type: str
                     unpack_into=None,    # type: Iterable[str]
                     autouse=False,       # type: bool
                     hook=None,           # type: Callable[[Callable], Callable]
                     caller=None,         # type: Callable
                     **kwargs):
    """
    Internal implementation for fixture products created by pytest parametrize plus.

    :param fixtures_dest:
    :param name:
    :param fixtures_or_values:
    :param fixture_positions:
    :param idstyle:
    :param scope:
    :param ids:
    :param unpack_into:
    :param autouse:
    :param kwargs:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _fixture_product
```

**Function**:
Creates a fixture that yields the cartesian product of multiple fixture alternatives.

**Parameter Description**:
- `fixtures_dest`: Destination module or class.
- `name`: Fixture name.
- `fixtures_or_values`: Fixtures or values to combine.
- `fixture_positions`: Positions of fixtures.
- `scope`: Fixture scope.
- `unpack_into`: Parameters to unpack into.
- `autouse`: Whether fixture is autouse.
- `hook`: Optional hook function.
- `caller`: Caller function.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
Product fixture function.

#### 125. `_tuple_generator()` - Function Name

**Function Signature**:
```python
def _tuple_generator(request, all_fixtures)
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _tuple_generator
```

**Function**:
It is an internal function of the `_fixture_product` function
Generator that yields tuples of fixture values for product fixtures.

**Parameter Description**:
- `request`: Pytest request object.
- `all_fixtures`: All fixture dependencies.

**Return Value**:
Generator of value tuples.

#### 126. `pytest_parametrize_plus()` - Function Name

**Function Signature**:
```python
@pytest.hookimpl(optionalhook=True)
def pytest_parametrize_plus(*args, **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import pytest_parametrize_plus
```

**Function**:
Enhanced parametrize decorator supporting fixture references and unpacking.

**Parameter Description**:
- `*args`: Variable positional arguments.
- `**kwargs`: Variable keyword arguments for parametrize configuration.

**Return Value**:
Parametrize decorator.

#### 127. `_get_argnames_argvalues()` - Function Name

**Function Signature**:
```python
def _get_argnames_argvalues(
    argnames=None,   # type: Union[str, Tuple[str], List[str]]
    argvalues=None,  # type: Iterable[Any]
    **args
):
    """

    :param argnames:
    :param argvalues:
    :param args:
    :return: argnames, argvalues - both guaranteed to be lists
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _get_argnames_argvalues
```

**Function**:
Extracts and validates argnames and argvalues from arguments.

**Parameter Description**:
- `argnames`: Parameter names (optional).
- `argvalues`: Parameter values (optional).
- `**args`: Additional keyword arguments.

**Return Value**:
Tuple of (argnames, argvalues).

#### 128. `_gen_ids()` - Function Name

**Function Signature**:
```python
def _gen_ids(argnames, argvalues, idgen):
    """
    Generates an explicit test ids list from a non-none `idgen`.

    `idgen` should be either a callable of a string template.

    :param argnames:
    :param argvalues:
    :param idgen:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _gen_ids
```

**Function**:
Generates test ids for parametrized tests using a custom id generation function.

**Parameter Description**:
- `argnames`: Parameter names.
- `argvalues`: Parameter values.
- `idgen`: ID generation function.

**Return Value**:
List of generated test ids.

#### 129. `_process_argvalues()` - Function Name

**Function Signature**:
```python

def _process_argvalues(argnames, marked_argvalues, nb_params, has_custom_ids, auto_refs):
    """Internal method to use in _pytest_parametrize_plus

    Processes the provided marked_argvalues (possibly marked with pytest.param) and returns
    p_ids, p_marks, argvalues (not marked with pytest.param), fixture_indices

    Note: `marked_argvalues` is modified in the process if a `lazy_value` is found with a custom id or marks.

    :param argnames:
    :param marked_argvalues:
    :param nb_params:
    :param has_custom_ids: a boolean indicating if custom ids are provided separately in `ids` or `idgen` (see
        @parametrize)
    :param auto_refs: if True, a `fixture_ref` will be created around fixture symbols used as argvalues automatically
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import _process_argvalues
```

**Function**:
Processes argument values including lazy evaluation and auto-references to fixtures.

**Parameter Description**:
- `argnames`: Parameter names.
- `marked_argvalues`: Marked argument values.
- `nb_params`: Number of parameters.
- `has_custom_ids`: Whether custom ids are provided.
- `auto_refs`: Whether to auto-reference fixtures.

**Return Value**:
Processed argument values.

#### 130. `check_name_available()` - Function Name

**Function Signature**:
```python
def check_name_available(module,
                         name,                  # type: str
                         if_name_exists=RAISE,  # type: int
                         name_changer=None,     # type: Callable
                         caller=None,           # type: Callable[[Any], Any]
                         extra_forbidden_names=()  # type: Iterable[str]
                         ):
    """
    Routine to check that a name is not already in dir(module) + extra_forbidden_names.
    The `if_name_exists` argument allows users to specify what happens if a name exists already.

    `if_name_exists=CHANGE` allows users to ask for a new non-conflicting name to be found and returned.

    :param module: a module or a class. dir(module) + extra_forbidden_names is used as a reference of forbidden names
    :param name: proposed name, to check against existent names in module
    :param if_name_exists: policy to apply if name already exists in dir(module) + extra_forbidden_names
    :param name_changer: an optional custom name changer function for new names to be generated
    :param caller: for warning / error messages. Something identifying the caller
    :param extra_forbidden_names: a reference list of additional forbidden names that can be provided, in addition to
        dir(module)
    :return: a name that might be different if policy was CHANGE
    """
```

**Import Statement**:
```python
from pytest_cases.fixture__creation import check_name_available
```

**Function**:
Verifies that a name is available in a module and renames if necessary.

**Parameter Description**:
- `module`: Module to check.
- `name`: Name to verify.
- `if_name_exists`: Action when name exists.
- `name_changer`: Function to rename.
- `caller`: Caller information.
- `extra_forbidden_names`: Additional forbidden names.

**Return Value**:
Available name string.

#### 131. `get_caller_module()` - Function Name

**Function Signature**:
```python
def get_caller_module(frame_offset=1):
    # type: (...) -> ModuleType
    """ Return the module where the last frame belongs.

    :param frame_offset: an alternate offset to look further up in the call stack
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture__creation import get_caller_module
```

**Function**:
Returns the module of the calling frame at the specified stack offset.

**Parameter Description**:
- `frame_offset`: Stack offset (default 1).

**Return Value**:
Module object of the caller.

#### 132. `_get_callerframe()` - Function Name

**Function Signature**:
```python
def _get_callerframe(offset = 0):
    """ Return a frame in the call stack

    :param offset: an alternate offset to look further up in the call stack
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.fixture__creation import _get_callerframe
```

**Function**:
Internal helper to get the calling frame at a given stack offset.

**Parameter Description**:
- `offset`: Stack offset (default 0).

**Return Value**:
Frame object of the caller.

#### 133. `_ignore_unused_generator_pep380()` - Function Name

**Function Signature**:
```python
def _ignore_unused_generator_pep380(fixture_func, new_sig, func_needs_request): ...
```

**Import Statement**:
```python
from pytest_cases.pep380 import _ignore_unused_generator_pep380
```

**Function**:
Wraps generator fixtures (PEP 380) to suppress unused parameter warnings.

**Parameter Description**:
- `fixture_func`: Generator fixture function.
- `new_sig`: New function signature.
- `func_needs_request`: Whether function needs request.

**Return Value**:
Wrapped fixture function.

#### 134. `wrapped_fixture_func()` - Function Name

**Function Signature**:
```python
@wraps(fixture_func, new_sig=new_sig)
def wrapped_fixture_func(*args, **kwargs)
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import wrapped_fixture_func
```

**Function**:
It is an internal function of the `_ignore_unused_generator_pep380` and
Wrapper function for fixtures that handles argument injection and parameter mapping.

**Parameter Description**:
- `*args`: Variable positional arguments.
- `**kwargs`: Variable keyword arguments.

**Return Value**:
Result of the wrapped fixture execution.

#### 135. `_decorate_fixture_plus_generator_pep380()` - Function Name

**Function Signature**:
```python
def _decorate_fixture_plus_generator_pep380(fixture_func, new_sig, map_arguments):  
```

**Import Statement**:
```python
from pytest_cases.pep380 import _decorate_fixture_plus_generator_pep380
```

**Function**:
Applies fixture_plus decorator to generator fixtures following PEP 380 behavior.

**Parameter Description**:
- `fixture_func`: Generator fixture function.
- `new_sig`: New function signature.
- `map_arguments`: Argument mapping function.

**Return Value**:
Decorated generator fixture function.

#### 136. `_parametrize_plus_decorate_generator_pep380()` - Function Name

**Function Signature**:
```python
def _parametrize_plus_decorate_generator_pep380(test_func, new_sig, fixture_union_name, replace_paramfixture_with_values): ...
```

**Import Statement**:
```python
from pytest_cases.pep380 import _parametrize_plus_decorate_generator_pep380
```

**Function**:
Applies parametrize_plus to tests using generator fixtures with PEP 380 style.

**Parameter Description**:
- `test_func`: Test function to decorate.
- `new_sig`: New function signature.
- `fixture_union_name`: Fixture union name.
- `replace_paramfixture_with_values`: Whether to replace param fixtures.

**Return Value**:
Decorated test function.

#### 137. `wrapped_test_func()` - Function Name

**Function Signature**:
```python
def wrapped_test_func(*args, **kwargs)
```

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import wrapped_test_func
```

**Function**:
It is an internal function of the `_parametrize_plus_decorate_generator_pep380` function
Wrapper function for parametrized test functions using fixtures.

**Parameter Description**:
- `*args`: Variable positional arguments.
- `**kwargs`: Variable keyword arguments.

**Return Value**:
Result of the wrapped test function execution.

#### 138. `_ignore_unused_coroutine_pep492()` - Function Name

**Function Signature**:
```python
def _ignore_unused_coroutine_pep492(fixture_func, new_sig, func_needs_request): 
    @wraps(fixture_func, new_sig=new_sig)
    async def wrapped_fixture_func(*args, **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.pep492 import _ignore_unused_coroutine_pep492
```

**Function**:
Handles async coroutine fixtures (PEP 492) to suppress unused warnings.

**Parameter Description**:
- `fixture_func`: Async coroutine fixture function.
- `new_sig`: New function signature.
- `func_needs_request`: Whether function needs request.

**Return Value**:
Wrapped async coroutine fixture function.

#### 139. `_decorate_fixture_plus_coroutine_pep492()` - Function Name

**Function Signature**:
```python
def _decorate_fixture_plus_coroutine_pep492(fixture_func, new_sig, map_arguments):
    @wraps(fixture_func, new_sig=new_sig)
    async def wrapped_fixture_func(*_args, **_kwargs):
```

**Import Statement**:
```python
from pytest_cases.pep492 import _decorate_fixture_plus_coroutine_pep492
```

**Function**:
Applies fixture_plus to async coroutine fixtures (PEP 492).

**Parameter Description**:
- `fixture_func`: Async coroutine fixture function.
- `new_sig`: New function signature.
- `map_arguments`: Argument mapping function.

**Return Value**:
Decorated async coroutine fixture function.

#### 140. `_parametrize_plus_decorate_coroutine_pep492()` - Function Name

**Function Signature**:
```python
def _parametrize_plus_decorate_coroutine_pep492(test_func, new_sig, fixture_union_name, replace_paramfixture_with_values):
    @wraps(test_func, new_sig=new_sig)
    async def wrapped_test_func(*args, **kwargs):  ...# noqa
```

**Import Statement**:
```python
from pytest_cases.pep492 import _parametrize_plus_decorate_coroutine_pep492
```

**Function**:
Applies parametrize_plus to tests using async coroutine fixtures.

**Parameter Description**:
- `test_func`: Test function to decorate.
- `new_sig`: New function signature.
- `fixture_union_name`: Fixture union name.
- `replace_paramfixture_with_values`: Whether to replace param fixtures.

**Return Value**:
Decorated async test function.

#### 141. `_ignore_unused_asyncgen_pep525()` - Function Name

**Function Signature**:
```python
def _ignore_unused_asyncgen_pep525(fixture_func, new_sig, func_needs_request):
    @wraps(fixture_func, new_sig=new_sig)
    async def wrapped_fixture_func(*args, **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.pep525 import _ignore_unused_asyncgen_pep525
```

**Function**:
Handles async generator fixtures (PEP 525) to suppress unused parameter warnings.

**Parameter Description**:
- `fixture_func`: Async generator fixture function.
- `new_sig`: New function signature.
- `func_needs_request`: Whether function needs request.

**Return Value**:
Wrapped async generator fixture function.

#### 142. `_decorate_fixture_plus_asyncgen_pep525()` - Function Name

**Function Signature**:
```python
def _decorate_fixture_plus_asyncgen_pep525(fixture_func, new_sig, map_arguments):
    @wraps(fixture_func, new_sig=new_sig)
    async def wrapped_fixture_func(*_args, **_kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.pep525 import _decorate_fixture_plus_asyncgen_pep525
```

**Function**:
Applies fixture_plus to async generator fixtures (PEP 525).

**Parameter Description**:
- `fixture_func`: Async generator fixture function.
- `new_sig`: New function signature.
- `map_arguments`: Argument mapping function.

**Return Value**:
Decorated async generator fixture function.

#### 143. `_parametrize_plus_decorate_asyncgen_pep525()` - Function Name

**Function Signature**:
```python
def _parametrize_plus_decorate_asyncgen_pep525(test_func, new_sig, fixture_union_name, replace_paramfixture_with_values):
     @wraps(test_func, new_sig=new_sig)
    async def wrapped_test_func(*args, **kwargs): ...
```

**Import Statement**:
```python
from pytest_cases.pep525 import _parametrize_plus_decorate_asyncgen_pep525
```

**Function**:
Applies parametrize_plus to tests using async generator fixtures.

**Parameter Description**:
- `test_func`: Test function to decorate.
- `new_sig`: New function signature.
- `fixture_union_name`: Fixture union name.
- `replace_paramfixture_with_values`: Whether to replace param fixtures.

**Return Value**:
Decorated async test function.

#### 144. `pytest_runtest_setup()` - Function Name

**Function Signature**:
```python
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_setup(item):
    """ Resolve all `lazy_value` in the dictionary of function args """

```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_runtest_setup
```

**Function**:
Pytest hook that runs before each test item execution for fixture union setup.

**Parameter Description**:
- `item`: Pytest test item object.

**Return Value**:
None (hook function).

#### 145. `pytest_collection()` - Function Name

**Function Signature**:
```python
def pytest_collection(session):
    session._fixturemanager.getfixtureclosure = partial(getfixtureclosure, session._fixturemanager)  # noqa

```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_collection
```

**Function**:
Pytest hook executed during test collection phase.

**Parameter Description**:
- `session`: Pytest session object.

**Return Value**:
None (hook function).

#### 146. `_getfixtureclosure()` - Function Name

**Function Signature**:
```python
def _getfixtureclosure(fm, fixturenames, parentnode, ignore_args = ()):
    """
    Replaces pytest's getfixtureclosure method to handle unions.
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import _getfixtureclosure
```

**Function**:
Internal helper to compute fixture closure dependencies for a test item.

**Parameter Description**:
- `fm`: Fixture manager object.
- `fixturenames`: List of fixture names to resolve.
- `parentnode`: Parent node in the test hierarchy.
- `ignore_args`: Tuple of argument names to ignore.

**Return Value**:
Fixture closure dictionary mapping fixture names to their dependencies.

#### 147. `create_super_closure()` - Function Name

**Function Signature**:
```python
def create_super_closure(fm,
                         parentnode,
                         fixturenames,
                         ignore_args
                         ):
    # type: (...) -> Tuple[List, Union[List, SuperClosure], Mapping]
    """

    :param fm:
    :param parentnode:
    :param fixturenames:
    :param ignore_args:
    :return:
    """

```

**Import Statement**:
```python
from pytest_cases.plugin import create_super_closure
```

**Function**:
Constructs a fixture closure considering super-class fixtures in class hierarchies.

**Parameter Description**:
- `fm`: Fixture manager object.
- `parentnode`: Parent node in the test hierarchy.
- `fixturenames`: List of fixture names to resolve.
- `ignore_args`: Tuple of argument names to ignore.

**Return Value**:
Fixture closure dictionary including super-class fixtures.

#### 148. `_merge()` - Function Name

**Function Signature**:
```python
def _merge(new_items, into_list):
 """ Appends items from `new_items` into `into_list`, only if they are not already there. """
     
```

**Import Statement**:
```python
from pytest_cases.fixture__creation import _merge
```

**Function**:
It is an internal function of the `create_super_closure` function
Merges new fixture items into an existing list without duplicates.

**Parameter Description**:
- `new_items`: New items to merge.
- `into_list`: Existing list to merge into.

**Return Value**:
Updated list with merged items.

#### 149. `pytest_generate_tests()` - Function Name

**Function Signature**:
```python
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_generate_tests(metafunc):
    """
    We use this hook to replace the 'parametrize' function of `metafunc` with our own below, before it is called
    by pytest. Note we could do it in a static way in pytest_sessionstart or plugin init hook but
    that way we can still access the original method using metafunc.__class__.parametrize
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_generate_tests
```

**Function**:
Core pytest hook that generates test parametrization from fixtures.

**Parameter Description**:
- `metafunc`: Pytest metafunc object containing test function metadata.

**Return Value**:
None (modifies metafunc in place).

#### 150. `get_calls_for_tree()` - Function Name

**Function Signature**:
```python
def get_calls_for_tree(metafunc,
                       fix_closure_tree,  # type: FixtureClosureNode
                       pending_dct        # type: MutableMapping[str, Union[UnionParamz, NormalParamz]]
                       ):
    """
    Creates the list of calls for `metafunc` based on
    :param metafunc:
    :param fix_closure_tree:
    :param pending:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import get_calls_for_tree
```

**Function**:
Builds fixture call sequences by traversing the fixture dependency tree.

**Parameter Description**:
- `metafunc`: Pytest metafunc object.
- `fix_closure_tree`: Fixture closure dependency tree.
- `pending_dct`: Dictionary of pending fixture calls.

**Return Value**:
List of fixture call sequences.

#### 151. `_cleanup_calls_list()` - Function Name

**Function Signature**:
```python
def _cleanup_calls_list(metafunc,
                        fix_closure_tree,   # type: FixtureClosureNode
                        calls,              # type: List[CallSpec2]
                        nodes,              # type: List[FixtureClosureNode]
                        pending_dct         # type: MutableMapping[str, Union[UnionParamz, NormalParamz]]
                        ):
    """
    Cleans the calls list so that all calls contain a value for all parameters. This is basically
    about adding "NOT_USED" parametrization everywhere relevant.

    :param calls:
    :param nodes:
    :param pending:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import _cleanup_calls_list
```

**Function**:
Removes redundant fixture calls and optimizes the call sequence.

**Parameter Description**:
- `metafunc`: Pytest metafunc object.
- `fix_closure_tree`: Fixture closure dependency tree.
- `calls`: List of fixture calls to clean up.
- `nodes`: Set of processed nodes.
- `pending_dct`: Dictionary of pending fixture calls.

**Return Value**:
Cleaned up list of fixture calls.

#### 152. `_parametrize_calls()` - Function Name

**Function Signature**:
```python
def _parametrize_calls(metafunc, init_calls, argnames, argvalues, discard_id=False, indirect=False, ids=None,
                       scope=None, **kwargs):
    """Parametrizes the initial `calls` with the provided information and returns the resulting new calls"""

```

**Import Statement**:
```python
from pytest_cases.plugin import _parametrize_calls
```

**Function**:
Applies parametrization to fixture calls with id generation options.

**Parameter Description**:
- `metafunc`: Pytest metafunc object.
- `init_calls`: Initial fixture calls.
- `argnames`: Argument names for parametrization.
- `argvalues`: Argument values for parametrization.
- `discard_id`: Whether to discard generated IDs.
- `indirect`: Whether to use indirect parametrization.
- `ids`: Custom ID generation function.
- `scope`: Fixture scope.
- `**kwargs`: Additional keyword arguments.

**Return Value**:
Parametrized fixture calls.

#### 153. `_process_node()` - Function Name

**Function Signature**:
```python
def _process_node(metafunc,
                  current_node,  # type: FixtureClosureNode
                  pending,       # type: MutableMapping[str, Union[UnionParamz, NormalParamz]]
                  calls          # type: List[CallSpec2]
                  ):
    """
    Routine to apply all the parametrization tasks in `pending` that are relevant to `current_node`,
    to `calls` (a list of pytest CallSpec2).

    It first applies all parametrization that correspond to current node (normal parameters),
    then applies the "split" parametrization if needed and recurses into each tree branch.

    It returns a tuple containing a list of calls and a list of same length containing which leaf node each one
    corresponds to.

    :param metafunc:
    :param current_node: the closure tree node we're focusing on
    :param pending: a list of parametrization orders to apply
    :param calls:
    :return: a tuple (calls, nodes) of two lists of the same length. So that for each CallSpec calls[i], you can see
        the corresponding leaf node in nodes[i]
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import _process_node
```

**Function**:
Processes a fixture node in the dependency tree, updating pending and calls.

**Parameter Description**:
- `metafunc`: Pytest metafunc object.
- `current_node`: Current fixture node to process.
- `pending`: Dictionary of pending fixture calls.
- `calls`: List of fixture calls.

**Return Value**:
Updated pending and calls dictionaries.

#### 154. `flatten_list()` - Function Name

**Function Signature**:
```python
def flatten_list(lst):
    return [v for nested_list in lst for v in nested_list]

```

**Import Statement**:
```python
from pytest_cases.plugin import flatten_list
```

**Function**:
Flattens a nested list of fixture calls into a single level sequence.

**Parameter Description**:
- `lst`: Nested list to flatten.

**Return Value**:
Flattened list.

#### 155. `sort_according_to_ref_list()` - Function Name

**Function Signature**:
```python
def sort_according_to_ref_list(fixturenames, param_names):
    """
    Sorts items in the first list, according to their position in the second.
    Items that are not in the second list stay in the same position, the others are just swapped.
    A new list is returned.

    :param fixturenames:
    :param param_names:
    :return:
    """
```

**Import Statement**:
```python
from pytest_cases.plugin import sort_according_to_ref_list
```

**Function**:
Orders fixture names to match the order specified by a reference parameter list.

**Parameter Description**:
- `fixturenames`: List of fixture names to sort.
- `param_names`: Reference parameter list for ordering.

**Return Value**:
Sorted list of fixture names.

#### 156. `pytest_addoption()` - Function Name

**Function Signature**:
```python
def pytest_addoption(parser): ...
```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_addoption
```

**Function**:
Pytest hook to add command-line options for the pytest-cases plugin.

**Parameter Description**:
- `parser`: Pytest argument parser object.

**Return Value**:
None (adds options to parser).

#### 157. `pytest_load_initial_conftests()` - Function Name

**Function Signature**:
```python
def pytest_load_initial_conftests(early_config): ...
```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_load_initial_conftests
```

**Function**:
Pytest hook that loads initial conftest modules early in the session.

**Parameter Description**:
- `early_config`: Early pytest configuration object.

**Return Value**:
None (loads conftest modules).

#### 158. `pytest_configure()` - Function Name

**Function Signature**:
```python
def pytest_configure(config): ...
```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_configure
```

**Function**:
Pytest hook that configures the plugin during pytest initialization.

**Parameter Description**:
- `config`: Pytest configuration object.

**Return Value**:
None (configures plugin).

#### 159. `pytest_collection_modifyitems()` - Function Name

**Function Signature**:
```python
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_collection_modifyitems(session, config, items): ...
```

**Import Statement**:
```python
from pytest_cases.plugin import pytest_collection_modifyitems
```

**Function**:
Pytest hook that modifies collected test items after collection.

**Parameter Description**:
- `session`: Pytest session object.
- `config`: Pytest configuration object.
- `items`: List of collected test items.

**Return Value**:
None (modifies items in place).


#### 160. Module Import

```python
from pytest_cases.case_parametrizer_new import parametrize_with_cases
```

#### 161. `parametrize_with_cases()` Decorator - Parameterizing Test Cases

**Function**: Parametrize test functions using test case functions to separate test code from test data.

**Function Signature**:
```python
def parametrize_with_cases(argnames,                # type: Union[str, List[str], Tuple[str, ...]]
                           cases=AUTO,              # type: Union[CaseType, List[CaseType]]
                           prefix=CASE_PREFIX_FUN,  # type: str
                           glob=None,               # type: str
                           has_tag=None,            # type: Any
                           filter=None,             # type: Callable[..., bool]  # noqa
                           ids=None,                # type: Union[Callable, Iterable[str]]
                           idstyle=None,            # type: Union[str, Callable]
                           # idgen=_IDGEN,            # type: Union[str, Callable]
                           debug=False,             # type: bool
                           scope="function",        # type: str
                           import_fixtures=False    # type: bool
                           ):
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import parametrize_with_cases
```

**Parameter Description**:
- `argnames` (str): Names of the test function parameters, a comma-separated string
- `cases` (Union[CaseType, List[CaseType]]): Source of test cases, default is AUTO (auto-discovery)
- `prefix` (str): Prefix of test case functions, default is 'case_'
- `glob` (str): File matching pattern for filtering test case files
- `has_tag` (Union[str, Iterable[str]]): Tag filtering condition
- `filter` (Callable): Custom filtering function
- `ids` (Union[Callable, Iterable[str]]): Test case ID generator
- `idstyle` (Union[str, Callable]): ID style configuration
- `debug=False` (bool): choice of debug
- `scope` (str): Parametrization scope, default is "function"
- `import_fixtures` (bool): Whether to import fixtures, default is False

**Return Value**: Decorator function

#### 162. `case()` Decorator - Marking Test Cases

**Function**: Add markers and metadata to test case functions.

**Import Statement**:
```python
from pytest_cases.case_funcs import case
```

**Function Signature**:
```python
@function_decorator
def case(id=None,             # type: str  # noqa
         tags=None,           # type: Union[Any, Iterable[Any]]
         marks=(),            # type: Union[MarkDecorator, SeveralMarkDecorators]
         case_func=DECORATED  # noqa
         ):
    marks = markdecorators_as_tuple(marks)
    case_info = _CaseInfo(id, marks, tags)
    case_info.attach_to(case_func)
    return case_func
```

**Parameter Description**:
- `id` (str): Unique identifier of the test case
- `tags` (Union[str, Iterable[str]]): List of tags for filtering and classification
- `marks` (Union[MarkDecorator, Iterable[MarkDecorator]]): Pytest markers
- `case_func` Case function

**Return Value**: Decorator function

#### 163. `get_current_cases()` Function - Getting Information about the Current Test Case

**Function**: Get detailed information about the current test case, including case ID, function object, and parameters.

**Function Signature**:
```python
def get_current_cases(request_or_item):
    """
    Returns a dictionary containing all case parameters for the currently active `pytest` item.
    You can either pass the `pytest` item (available in some hooks) or the `request` (available in hooks, and also
    directly as a fixture).

    For each test function argument parametrized using a `@parametrize_with_case(<argname>, ...)` this dictionary
    contains an entry `{<argname>: (case_id, case_function, case_params)}`. If several argnames are parametrized this
    way, a dedicated entry will be present for each argname. The tuple is a `namedtuple` containing

     - `id` a string containing the actual case id constructed by `@parametrize_with_cases`.
     - `function` the original case function.
     - `params` a dictionary, containing the parameters of the case, if itself is parametrized. Note that if the
    case is parametrized with `@parametrize_with_cases`, the associated parameter value in the dictionary will also be
    `(actual_id, case_function, case_params)`.

    If a fixture parametrized with cases is active, the dictionary will contain an entry `{<fixturename>: <dct>}` where
    `<dct>` is a dictionary `{<argname>: (case_id, case_function, case_params)}`.

    To get more information on a case function, you can use `get_case_marks(f)`, `get_case_tags(f)`.
    You can also use `matches_tag_query` to check if a case function matches some expectations either concerning its id
    or its tags. See https://smarie.github.io/python-pytest-cases/#filters-and-tags

    Note that you can get the same contents directly by using the `current_cases` fixture.
    """
```

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import get_current_cases
```

**Parameter Description**:
- `request_or_item: Pytest request object

**Return Value**: Dictionary containing information about the current test case


#### 164. `flake8()` - Function Name

**Function Signature**:
```python
@nox.session(python=PY311)
def flake8(session):
    """Launch flake8 qualimetry."""
```

**Import Statement**:
```python
from noxfile import flake8
```

**Function**:
Launch flake8 qualimetry for the project, generating HTML reports and a badge.

**Parameter Description**:
- `session`: Nox session object used to run installations and flake8 commands.


### Detailed Implementation Constants

#### 1. `ENVS` Constant - Test Environment Configuration

**Description**:
Dictionary defining test environments for different Python versions and pytest versions. Each environment specifies coverage settings and package specifications for comprehensive testing across multiple Python and pytest versions.

**Import Statement**:
```python
from noxfile import ENVS
```

**Constant**:
```python
ENVS = {
    # python 3.14
    (PY314, "pytest-latest"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": ""}},
    (PY314, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY314, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # python 3.13
    (PY313, "pytest-latest"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": ""}},
    (PY313, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY313, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # python 3.12
    (PY312, "pytest-latest"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": ""}},
    (PY312, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY312, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # python 3.11
    (PY311, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY311, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # python 3.10
    (PY310, "pytest-latest"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": ""}},
    (PY310, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY310, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # python 3.9
    (PY39, "pytest-latest"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": ""}},
    (PY39, "pytest7.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<8"}},
    (PY39, "pytest6.x"): {"coverage": False, "pkg_specs": {"pip": ">19", "pytest": "<7"}},
    # IMPORTANT: this should be last so that the folder docs/reports is not deleted afterwards
    (PY311, "pytest-latest"): {"coverage": True, "pkg_specs": {"pip": ">19", "pytest": ""}},
}
```

---

#### 2. `ENV_PARAMS` Constant - Environment Parameters Tuple

**Description**:
Tuple containing environment parameters derived from ENVS dictionary. Extracts Python version, coverage flag, and package specifications for each test environment.

**Import Statement**:
```python
from noxfile import ENV_PARAMS
```

**Constant**:
```python
ENV_PARAMS = tuple((k[0], v["coverage"], v["pkg_specs"]) for k, v in ENVS.items())
```

---

#### 3. `ENV_IDS` Constant - Environment IDs Tuple

**Description**:
Tuple containing environment IDs generated from ENVS dictionary. Creates unique identifiers for each test environment by combining Python version and pytest version.

**Import Statement**:
```python
from noxfile import ENV_IDS
```

**Constant**:
```python
ENV_IDS = tuple(f"{k[0].replace('.', '-')}-env-{k[1]}" for k in ENVS)
```

---

#### 4. `DOWNLOAD_URL` Constant - Package Download URL

**Description**:
URL for downloading the package distribution files.

**Import Statement**:
```python
from setup import DOWNLOAD_URL
```

**Constant**:
Reference to package download URL configuration.

---

#### 5. `DONT_INSTALL` Constant - Installation Skip Indicator

**Description**:
Configuration constant indicating whether installation should be skipped for specific dependencies.

**Import Statement**:
```python
from ci_tools.nox_utils import DONT_INSTALL
```

**Constant**:
Boolean or list value indicating packages that should not be installed.

---

#### 6. `CASE_FIELD` Constant - Case Field Identifier

**Description**:
Constant used to identify the case field in case function definitions.

**Import Statement**:
```python
from pytest_cases.case_funcs import CASE_FIELD
```

**Constant**:
String identifier for case field.

---

#### 7. `GEN_BY_US` Constant - Generation Marker

**Description**:
Marker indicating that a case or fixture was generated by the pytest-cases library.

**Import Statement**:
```python
from pytest_cases.case_funcs import GEN_BY_US
```

**Constant**:
String marker for generated test components.

---

#### 8. `THIS_MODULE` Constant - Current Module Reference

**Description**:
Reference to the current module being processed, used for module-level operations.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import THIS_MODULE
```

**Constant**:
Module reference constant.

---

#### 9. `_HOST_CLS_ATTR` Constant - Host Class Attribute

**Description**:
Internal constant marking the host class attribute in parametrizer classes.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import _HOST_CLS_ATTR
```

**Constant**:
String identifier for host class attribute.

---

#### 10. `PY3` Constant - Python 3 Detection

**Description**:
Boolean constant indicating whether running on Python 3.

**Import Statement**:
```python
from pytest_cases.common_mini_six import PY3
```

**Constant**:
Boolean value (True for Python 3, False for Python 2).

---

#### 11. `PY34` Constant - Python 3.4 Detection

**Description**:
Boolean constant indicating whether running on Python 3.4 or greater.

**Import Statement**:
```python
from pytest_cases.common_mini_six import PY34
```

**Constant**:
Boolean value for Python 3.4+ detection.

---

#### 12. `PYTEST_VERSION` Constant - Pytest Version

**Description**:
Constant storing the current pytest version.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST_VERSION
```

**Constant**:
Pytest version string.

---

#### 13. `PYTEST3_OR_GREATER` Constant - Pytest 3+ Check

**Description**:
Boolean constant indicating pytest version 3 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST3_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3+ compatibility.

---

#### 14. `PYTEST32_OR_GREATER` Constant - Pytest 3.2+ Check

**Description**:
Boolean constant indicating pytest version 3.2 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST32_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.2+ compatibility.

---

#### 15. `PYTEST33_OR_GREATER` Constant - Pytest 3.3+ Check

**Description**:
Boolean constant indicating pytest version 3.3 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST33_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.3+ compatibility.

---

#### 16. `PYTEST34_OR_GREATER` Constant - Pytest 3.4+ Check

**Description**:
Boolean constant indicating pytest version 3.4 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST34_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.4+ compatibility.

---

#### 17. `PYTEST35_OR_GREATER` Constant - Pytest 3.5+ Check

**Description**:
Boolean constant indicating pytest version 3.5 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST35_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.5+ compatibility.

---

#### 18. `PYTEST361_36X` Constant - Pytest 3.6.1-3.6.x Check

**Description**:
Boolean constant indicating pytest version 3.6.1 through 3.6.x.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST361_36X
```

**Constant**:
Boolean marker for pytest 3.6.1-3.6.x compatibility.

---

#### 19. `PYTEST37_OR_GREATER` Constant - Pytest 3.7+ Check

**Description**:
Boolean constant indicating pytest version 3.7 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST37_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.7+ compatibility.

---

#### 20. `PYTEST38_OR_GREATER` Constant - Pytest 3.8+ Check

**Description**:
Boolean constant indicating pytest version 3.8 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST38_OR_GREATER
```

**Constant**:
Boolean marker for pytest 3.8+ compatibility.

---

#### 21. `PYTEST46_OR_GREATER` Constant - Pytest 4.6+ Check

**Description**:
Boolean constant indicating pytest version 4.6 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST46_OR_GREATER
```

**Constant**:
Boolean marker for pytest 4.6+ compatibility.

---

#### 22. `PYTEST53_OR_GREATER` Constant - Pytest 5.3+ Check

**Description**:
Boolean constant indicating pytest version 5.3 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST53_OR_GREATER
```

**Constant**:
Boolean marker for pytest 5.3+ compatibility.

---

#### 23. `PYTEST54_OR_GREATER` Constant - Pytest 5.4+ Check

**Description**:
Boolean constant indicating pytest version 5.4 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST54_OR_GREATER
```

**Constant**:
Boolean marker for pytest 5.4+ compatibility.

---

#### 24. `PYTEST421_OR_GREATER` Constant - Pytest 4.21+ Check

**Description**:
Boolean constant indicating pytest version 4.21 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST421_OR_GREATER
```

**Constant**:
Boolean marker for pytest 4.21+ compatibility.

---

#### 25. `PYTEST6_OR_GREATER` Constant - Pytest 6+ Check

**Description**:
Boolean constant indicating pytest version 6 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST6_OR_GREATER
```

**Constant**:
Boolean marker for pytest 6+ compatibility.

---

#### 26. `PYTEST7_OR_GREATER` Constant - Pytest 7+ Check

**Description**:
Boolean constant indicating pytest version 7 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST7_OR_GREATER
```

**Constant**:
Boolean marker for pytest 7+ compatibility.

---

#### 27. `PYTEST71_OR_GREATER` Constant - Pytest 7.1+ Check

**Description**:
Boolean constant indicating pytest version 7.1 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST71_OR_GREATER
```

**Constant**:
Boolean marker for pytest 7.1+ compatibility.

---

#### 28. `PYTEST8_OR_GREATER` Constant - Pytest 8+ Check

**Description**:
Boolean constant indicating pytest version 8 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST8_OR_GREATER
```

**Constant**:
Boolean marker for pytest 8+ compatibility.

---

#### 29. `PYTEST81_OR_GREATER` Constant - Pytest 8.1+ Check

**Description**:
Boolean constant indicating pytest version 8.1 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST81_OR_GREATER
```

**Constant**:
Boolean marker for pytest 8.1+ compatibility.

---

#### 30. `PYTEST84_OR_GREATER` Constant - Pytest 8.4+ Check

**Description**:
Boolean constant indicating pytest version 8.4 or greater.

**Import Statement**:
```python
from pytest_cases.common_pytest_marks import PYTEST84_OR_GREATER
```

**Constant**:
Boolean marker for pytest 8.4+ compatibility.

---

#### 31. `NOT_USED` Constant - Fixture Not Used

**Description**:
Constant indicating that a fixture is not currently used in the fixture union.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import NOT_USED
```

**Constant**:
Marker value for unused fixtures.

---

#### 32. `USED` Constant - Fixture Used

**Description**:
Constant indicating that a fixture is currently used in the fixture union.

**Import Statement**:
```python
from pytest_cases.fixture_core1_unions import USED
```

**Constant**:
Marker value for used fixtures.

---

#### 33. `EMPTY_ID` Constant - Empty ID Marker

**Description**:
Constant representing an empty ID string for parametrized test cases.

**Import Statement**:
```python
from pytest_cases.fixture_parametrize_plus import EMPTY_ID
```

**Constant**:
Empty string or null ID marker.

---

#### 34. `WARN` Constant - Warning Level

**Description**:
Constant representing warning level in fixture creation process.

**Import Statement**:
```python
from pytest_cases.fixture__creation import WARN
```

**Constant**:
Warning level constant.

---

#### 35. `CHANGE` Constant - Change Level

**Description**:
Constant representing change level in fixture creation process.

**Import Statement**:
```python
from pytest_cases.fixture__creation import CHANGE
```

**Constant**:
Change level constant.

---

#### 36. `_DEBUG` Constant - Debug Mode

**Description**:
Boolean constant enabling debug mode for the pytest-cases plugin.

**Import Statement**:
```python
from pytest_cases.plugin import _DEBUG
```

**Constant**:
Boolean debug mode flag.

---

#### 37. `_OPTION_NAME` Constant - Option Name

**Description**:
Constant defining the option name for the pytest-cases plugin configuration.

**Import Statement**:
```python
from pytest_cases.plugin import _OPTION_NAME
```

**Constant**:
String option name identifier.

---

#### 38. `_SKIP` Constant - Skip Mode

**Description**:
Constant representing skip mode in plugin configuration.

**Import Statement**:
```python
from pytest_cases.plugin import _SKIP
```

**Constant**:
Skip mode constant.

---

#### 39. `_NORMAL` Constant - Normal Mode

**Description**:
Constant representing normal mode in plugin configuration.

**Import Statement**:
```python
from pytest_cases.plugin import _NORMAL
```

**Constant**:
Normal mode constant.

---

#### 40. `_OPTIONS` Constant - Options Dictionary

**Description**:
Dictionary containing configuration options for the pytest-cases plugin.

**Import Statement**:
```python
from pytest_cases.plugin import _OPTIONS
```

**Constant**:
Dictionary of configuration options.

---

#### 41. `PYTEST_CONFIG` Constant - Pytest Configuration

**Description**:
Constant storing pytest configuration information.

**Import Statement**:
```python
from pytest_cases.plugin import PYTEST_CONFIG
```

**Constant**:
Pytest configuration object reference.

---

#### 42. `AUTO2` Constant - Auto Mode 2

**Description**:
Constant defining auto mode 2 for parameterization.

**Import Statement**:
```python
from pytest_cases.__init__ import AUTO2
```

**Constant**:
Auto mode 2 identifier.

---

#### 43. `THIS_MODULE` Constant - Module Reference (Tests)

**Description**:
Reference to the current module in test context.

**Import Statement**:
```python
from pytest_cases.case_parametrizer_new import THIS_MODULE
```

**Constant**:
Module reference for testing.

---

#### 55. `__all__` - Constant

**Description**:
Export list defining the public API of the `pytest_cases` package.

**Import Statement**:
```python
from python-pytest-cases-main.src.pytest_cases.__init__ import __all__
```

**Constant**:
Definition present in `pytest_cases/__init__.py`.

#### 56. `SetupCfg` - Type Alias

**Description**:
Named tuple alias representing parsed setup configuration sections.

**Import Statement**:
```python
from python-pytest-cases-main.ci_tools.nox_utils import SetupCfg
```

**Type Alias**:
```python
SetupCfg = namedtuple('SetupCfg', ('setup_requires', 'install_requires', 'tests_requires', 'extras_require'))
```

---

#### 57. `_make_fixture_union` - Type Alias

**Description**:
Internal alias pointing to the fixture union builder.

**Import Statement**:
```python
from python-pytest-cases-main.src.pytest_cases.fixture_parametrize_plus import _make_fixture_union
```

**Type Alias**:
```python
_make_fixture_union = _fixture_union
```
---

#### 58. `_make_unpack_fixture` - Type Alias

**Description**:
Internal alias pointing to the fixture unpacking helper.

**Import Statement**:
```python
from python-pytest-cases-main.src.pytest_cases.fixture_core1_unions import _make_unpack_fixture
```

**Type Alias**:
```python
_make_unpack_fixture = _unpack_fixture
```

---

#### 59. `_make_fixture_product` - Type Alias

**Description**:
Internal alias pointing to the fixture cartesian product helper.

**Import Statement**:
```python
from python-pytest-cases-main.src.pytest_cases.fixture_parametrize_plus import _make_fixture_product
```

**Type Alias**:
```python
_make_fixture_product = _fixture_product
```
---
