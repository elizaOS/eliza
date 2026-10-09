## Introduction and Goals of the Typing-Extensions Project

Typing-Extensions is an **extension library for the Python type system**. It can provide the type hinting features of newer Python versions to older ones and support the early adoption of experimental type system features. This tool performs excellently in evaluations within the Python type checking ecosystem, achieving "the best backward compatibility and the broadest type system support". Its core functions include: backporting new type features (automatically providing the latest type hinting features for Python 3.9+ versions), **support for experimental type systems** (enabling the early use of new features in PEP proposals before their official release), and a complete implementation of advanced type constructs such as Protocol, Literal, TypedDict, and TypeGuard. In short, Typing-Extensions aims to provide a robust Python type system extension library for using the type hinting features of newer Python versions in older ones (for example, using new features like TypeGuard, Self, and Literal by importing the typing_extensions module and getting the same type checking support as the native typing module through static type checkers like mypy and pyright).


## Natural Language Instruction (Prompt)

Please create a Python project named Typing-Extensions to implement a Python type system extension library. The project should include the following functions:

1. Core type system module: Provide the type hinting features of newer Python versions to older ones, including backporting new type features (such as TypeGuard, Self, Literal, TypedDict, Protocol, etc.) and supporting experimental type systems. All type constructs should be extensions of the Python standard library's typing module and fully compatible with static type checkers like mypy and pyright.

2. Type construct implementation: Implement a complete set of type system constructs, including basic types (Any, ClassVar, Final, Literal, etc.), advanced type systems (Protocol, TypedDict, TypeGuard, etc.), utility functions (get_args, get_origin, get_type_hints, etc.), and experimental features (supporting new type system concepts in PEP proposals).

3. Backward compatibility support: Backport the latest type hinting features to Python 3.9+ versions to ensure seamless integration with existing code. It should support semantic versioning to ensure API stability and have zero runtime overhead (all functions are at the type level).

4. Interface design: Design independent type construct and utility function interfaces for each functional module to support full integration with static type checkers. Each module should define clear type annotations and docstrings and provide a rich set of type system utility functions.

5. Examples and usage guide: Provide sample code and usage instructions to demonstrate how to use new features by importing the typing_extensions module (e.g., from typing_extensions import TypeGuard, Self, Literal, etc.) and how to get the same type checking support as the native typing module through static type checkers. The above functions need to be combined to build a complete Python type system extension toolkit. The final project should include modules such as type constructs, utility functions, and backward compatibility support, along with typical usage examples, to form a reproducible type system extension process.

6. Core file requirements: The project must include a well-configured pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as python>=3.9, flit_core>=3.11,<4, ruff==0.12.3, pre-commit==5.0.0, sphinx-lint==1.0.0, etc.). The pyproject.toml file can verify whether all functional modules work properly. Additionally, src/typing_extensions.py should be provided as a unified API entry point, exporting type constructs and utility functions such as _FORWARD_REF_HAS_CLASS, Annotated, Any, AnyStr, AsyncContextManager, AsyncIterator, Awaitable, Buffer, Callable, ClassVar, Concatenate, Dict, Doc, Final, Format, Generic, IntVar, Iterable, Iterator, List, Literal, LiteralString, NamedTuple, Never, NewType, NoDefault, etc., and provide version information, allowing users to access all major functions through a simple "from typing_extensions import *" statement. In typing_extensions.py, a complete type system implementation should be provided, including all backported type constructs and experimental functions.


## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
attrs                     25.3.0
cachetools                6.1.0
certifi                   2025.8.3
cfgv                      3.4.0
chardet                   5.2.0
charset-normalizer        3.4.3
check-jsonschema          0.33.3
click                     8.2.1
colorama                  0.4.6
distlib                   0.4.0
exceptiongroup            1.3.0
fastjsonschema            2.21.2
filelock                  3.19.1
flit_core                 3.12.0
identify                  2.6.13
idna                      3.10
iniconfig                 2.1.0
jsonschema                4.25.1
jsonschema-specifications 2025.4.1
nodeenv                   1.9.1
packaging                 25.0
pip                       23.0.1
platformdirs              4.3.8
pluggy                    1.6.0
polib                     1.2.0
pre_commit                4.3.0
pre_commit_hooks          6.0.0
Pygments                  2.19.2
pyproject-api             1.9.1
pytest                    8.4.1
PyYAML                    6.0.2
referencing               0.36.2
regex                     2025.7.34
regress                   2025.5.1
requests                  2.32.5
rpds-py                   0.27.0
ruamel.yaml               0.18.15
ruamel.yaml.clib          0.2.12
ruff                      0.12.10
setuptools                65.5.1
sphinx-lint               1.0.0
tomli                     2.2.1
tox                       4.28.4
urllib3                   2.5.0
validate-pyproject        0.24.1
virtualenv                20.34.0
wheel                     0.40.0
zizmor                    1.12.1
```


## Typing-Extensions Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md
├── doc
│   ├── .gitignore
│   ├── Makefile
│   ├── _extensions
│   │   ├── __init__.py
│   │   ├── gh_link.py
│   ├── conf.py
│   ├── index.rst
│   ├── make.bat
├── pyproject.toml
├── scripts
│   ├── check_package.py
├── src
│   ├── _typed_dict_test_helper.py
│   ├── typing_extensions.py
└── tox.ini

```


## API Usage Guide

### Core API

#### 1. Module Import

```python
import typing_extensions
from _typed_dict_test_helper import Foo, FooGeneric, VeryAnnotated
from typing_extensions import (
    _FORWARD_REF_HAS_CLASS,
    Annotated,
    Any,
    AnyStr,
    AsyncContextManager,
    AsyncIterator,
    Awaitable,
    Buffer,
    Callable,
    ClassVar,
    Concatenate,
    Dict,
    Doc,
    Final,
    Format,
    Generic,
    IntVar,
    Iterable,
    Iterator,
    List,
    Literal,
    LiteralString,
    NamedTuple,
    Never,
    NewType,
    NoDefault,
    NoExtraItems,
    NoReturn,
    NotRequired,
    Optional,
    ParamSpec,
    ParamSpecArgs,
    ParamSpecKwargs,
    Protocol,
    ReadOnly,
    Required,
    Self,
    Sentinel,
    Set,
    Tuple,
    Type,
    TypeAlias,
    TypeAliasType,
    TypedDict,
    TypeForm,
    TypeGuard,
    TypeIs,
    TypeVar,
    TypeVarTuple,
    Union,
    Unpack,
    assert_never,
    assert_type,
    clear_overloads,
    dataclass_transform,
    deprecated,
    disjoint_base,
    evaluate_forward_ref,
    final,
    get_annotations,
    get_args,
    get_origin,
    get_original_bases,
    get_overloads,
    get_protocol_members,
    get_type_hints,
    is_protocol,
    is_typeddict,
    no_type_check,
    overload,
    override,
    reveal_type,
    runtime,
    runtime_checkable,
    type_repr,
)
```

#### 2. `Foo`
**Functional Description**: Used to test the basic class of `TypedDict`.

**Definition**:
```python
class Foo(TypedDict):
    a: _DoNotImport
```

#### 3. `FooGeneric`
**Functional Description**: A test class for generic `TypedDict`.

**Definition**:
```python
class FooGeneric(TypedDict, Generic[T]):
    a: Optional[T]
```

#### 4. `VeryAnnotated`
**Functional Description**: Used to test `TypedDict` with multiple layers of annotations.

**Definition**:
```python
class VeryAnnotated(TypedDict, total=False):
    a: Annotated[Annotated[Annotated[Required[int], "a"], "b"], "c"]
```
#### 5. Basic Types

##### typing_extensions.NoReturn
**Functional Description**:
- Indicates that a function never returns normally; it always throws an exception or enters an infinite loop
- Used for type annotations to denote that a function does not return via a return statement

**Example**:
```python
def stop() -> NoReturn:
    raise Exception("This function never returns")
```

##### typing_extensions._ASSERT_NEVER_REPR_MAX_LENGTH
**Functional Description**:
- An internal constant used to control the maximum display length of type names in the `assert_never()` function
- Type names exceeding this length will be truncated

#### 6. Container Types

##### typing_extensions.Deque
**Functional Description**:
- A generic version of a double-ended queue
- Inherits from `collections.deque` and adds type annotations

**Type Parameters**:
- `T`: The type of elements in the queue

**Example**:
```python
from collections import deque
from typing_extensions import Deque

d: Deque[int] = deque([1, 2, 3])
```

##### typing_extensions.Counter
**Functional Description**:
- A generic version of a counter
- Inherits from `collections.Counter` and adds type annotations

**Type Parameters**:
- `T`: The type of keys to be counted, must be hashable

**Example**:
```python
from collections import Counter
from typing_extensions import Counter

word_counts: Counter[str] = Counter(["hello", "world", "hello"])
```

##### typing_extensions.DefaultDict
**Functional Description**:
- A generic version of a default dictionary
- Inherits from `collections.defaultdict` and adds type annotations

**Type Parameters**:
- `K`: The type of keys
- `V`: The type of values

**Example**:
```python
from collections import defaultdict
from typing import List
from typing_extensions import DefaultDict

d: DefaultDict[str, List[int]] = defaultdict(list)
d["key"].append(1)
```

##### typing_extensions.ChainMap
**Functional Description**:
- A generic version of a chain map
- Inherits from `collections.ChainMap` and adds type annotations

**Type Parameters**:
- `K`: The type of keys
- `V`: The type of values

**Example**:
```python
from collections import ChainMap
from typing_extensions import ChainMap

m1 = {"a": 1, "b": 2}
m2 = {"b": 3, "c": 4}
cm: ChainMap[str, int] = ChainMap(m1, m2)
```

#### 7. Asynchronous and Generator Types

##### typing_extensions.Awaitable
**Functional Description**:
- A generic for awaitable objects
- Used to annotate coroutine functions or objects that implement the `__await__` method

**Type Parameters**:
- `T_co`: The type of the coroutine's return value (covariant)

**Example**:
```python
from typing_extensions import Awaitable

async def fetch() -> str: ...

def run(coro: Awaitable[str]) -> None: ...
```

##### typing_extensions.Coroutine
**Functional Description**:
- A generic for coroutine types
- Inherits from `typing.Awaitable` and adds type annotations

**Type Parameters**:
- `T_co`: The type of the coroutine's final return value (covariant)
- `T_contra`: The type of values received by the coroutine (contravariant)
- `T_co2`: The type of values yielded by the coroutine (covariant)

**Example**:
```python
from typing_extensions import Coroutine

async def process() -> int: ...

coro: Coroutine[None, None, int] = process()
```

##### typing_extensions.AsyncIterable
**Functional Description**:
- A generic for asynchronous iterable objects
- Represents objects that implement the `__aiter__` method

**Type Parameters**:
- `T_co`: The type of iterable elements (covariant)

**Example**:
```python
from typing_extensions import AsyncIterable

class AsyncRange:
    def __aiter__(self) -> AsyncIterable[int]:
        return self

    async def __anext__(self) -> int: ...
```

##### typing_extensions.AsyncGenerator
**Functional Description**:
- A generic for asynchronous generators
- Inherits from `typing.AsyncIterator` and adds type annotations

**Type Parameters**:
- `T_co`: The type of values yielded by the generator (covariant)
- `T_contra`: The type of values received by the generator (contravariant)

**Example**:
```python
from typing_extensions import AsyncGenerator

async def async_counter() -> AsyncGenerator[int, None]:
    for i in range(10):
        yield i
```

#### 8. Context Manager Types

##### typing_extensions.ContextManager
**Functional Description**:
- A generic for synchronous context managers
- Represents objects that implement the `__enter__` and `__exit__` methods

**Type Parameters**:
- `T_co`: The type of value returned when entering the context manager (covariant)

**Example**:
```python
from contextlib import contextmanager
from typing_extensions import ContextManager

@contextmanager
def my_context() -> ContextManager[str]:
    print("Entering")
    try:
        yield "context value"
    finally:
        print("Exiting")
```

##### typing_extensions.AsyncContextManager
**Functional Description**:
- A generic for asynchronous context managers
- Represents objects that implement the `__aenter__` and `__aexit__` methods

**Type Parameters**:
- `T_co`: The type of value returned when entering the asynchronous context manager (covariant)

**Example**:
```python
from contextlib import asynccontextmanager
from typing_extensions import AsyncContextManager

@asynccontextmanager
async def async_my_context() -> AsyncContextManager[str]:
    print("Async entering")
    try:
        yield "async context value"
    finally:
        print("Async exiting")
```

#### 9. Protocols and Metaclasses

##### typing_extensions._ProtocolMeta
**Functional Description**:
- The metaclass for `Protocol`
- Used to implement runtime protocol checking
- Typically not used directly but indirectly through the `@runtime_checkable` decorator

**Methods**:
- `__instancecheck__`: Checks if an instance satisfies the protocol
- `__subclasscheck__`: Checks if a class satisfies the protocol

**Example**:
```python
from typing_extensions import Protocol, runtime_checkable

@runtime_checkable
class Closeable(Protocol):
    def close(self) -> None: ...

# Using ProtocolMeta for runtime checking
assert isinstance(open('file.txt'), Closeable)  # Returns True
```

#### 10. Generator Types

##### typing_extensions.Generator
**Functional Description**:
- Return type annotation for generator functions
- Inherits from `typing.Iterator` and adds type annotations

**Type Parameters**:
- `YieldType`: The type of values yielded by the generator
- `SendType`: The type of values received by the generator
- `ReturnType`: The final return value type of the generator

**Example**:
```python
from typing_extensions import Generator

def count_up_to(n: int) -> Generator[int, None, str]:
    for i in range(n):
        yield i
    return "done"
```

##### typing_extensions.Iterable
**Functional Description**:
- A generic for iterable objects
- Represents objects that implement the `__iter__` method

**Type Parameters**:
- `T_co`: The type of iterable elements (covariant)

**Example**:
```python
from typing_extensions import Iterable

def print_all(items: Iterable[str]) -> None:
    for item in items:
        print(item)
```

#### 11. Special Types

##### typing_extensions.Never
**Functional Description**:
- Represents a type that can never be instantiated
- Used to indicate that a function never returns normally, or that a variable cannot have any value

**Example**:
```python
from typing_extensions import Never

def stop() -> Never:
    raise Exception("This function never returns")

# This variable can never have a value
x: Never = ...  # Type checker will report an error
```
#### 12. `TypeVar`
**Function Signature**: `TypeVar(name, *constraints, bound=None, covariant=False, contravariant=False, default=NoDefault, infer_variance=False)`
- **Description**: Creates a type variable that can be used to define generic types, functions, and methods.
- **Parameters**:
  - `name`: The name of the type variable
  - `*constraints`: Type constraints (if any)
  - `bound`: The upper bound of the type variable
  - `covariant`: If True, the type variable is covariant
  - `contravariant`: If True, the type variable is contravariant
  - `default`: The default type if not specified
  - `infer_variance`: If True, infer variance
- **Returns**: Type variable object

#### 13. `ParamSpec`
**Function Signature**: `ParamSpec(name, *, bound=None, covariant=False, contravariant=False, infer_variance=False, default=NoDefault)`
- **Description**: Used for parameter specifications in higher-order functions.
- **Attributes**:
  - `args`: Represents positional arguments
  - `kwargs`: Represents keyword arguments

#### 14. `TypeVarTuple`
**Function Signature**: `TypeVarTuple(name, *, default=NoDefault)`
- **Description**: Represents a variably-sized tuple of type variables.

#### 15. Special Types

##### 15.1. `Any`
**Description**: A special type representing an unconstrained type. Compatible with every type.

##### 15.2. `NoReturn`
**Description**: A special type indicating that a function never returns.

##### 15.3. `Self`
**Description**: A special type used in method return types to represent the current class.

##### 15.4. `Literal`
**Function Signature**: `Literal[value]`
- **Description**: Indicates that a value has a specific literal value.

##### 15.5. `LiteralString`
**Description**: A string literal type that can be used to prevent injection attacks.

#### 16. Protocols and Abstract Base Classes

##### 16.1. `Protocol`
**Class Decorator**: `@runtime_checkable`
- **Description**: Base class for protocol classes supporting structural subtyping.

##### 16.2. `runtime_checkable`
**Function Signature**: `runtime_checkable(cls)`
- **Description**: A decorator that marks a protocol class as a runtime protocol.

#### 17. Type Checking Tools

##### 17.1. `TypeGuard`
**Type Alias**: `TypeGuard[Type]`
- **Description**: Used to annotate type guard functions.

##### 17.2. `TypeIs`
**Type Alias**: `TypeIs[Type]`
- **Description**: Used to annotate type guard functions that narrow types.

##### 17.3. `assert_type`
**Function Signature**: `assert_type(val, typ, /)`
- **Description**: Asserts at runtime that a value belongs to a specific type.

##### 17.4. `reveal_type`
**Function Signature**: `reveal_type(obj, /)`
- **Description**: Used to debug type information in type checkers.

#### 18. Type Hints and Annotations

##### 18.1. `Annotated`
**Function Signature**: `Annotated[type, ...]`
- **Description**: Adds runtime metadata to type hints.

##### 18.2. `get_type_hints`
**Function Signature**: `get_type_hints(obj, globalns=None, localns=None, include_extras=False)`
- **Description**: Returns the type hints of an object.

##### 18.3. `get_origin`
**Function Signature**: `get_origin(tp)`
- **Description**: Gets the unsubscripted version of a type.

##### 18.4. `get_args`
**Function Signature**: `get_args(tp)`
- **Description**: Gets the type parameters of a generic type.

#### 19. Decorators

##### 19.1. `@final`
**Function Signature**: `final(func_or_class)`
- **Description**: A decorator indicating that a method cannot be overridden or a class cannot be inherited.

##### 19.2. `@overload`
**Function Signature**: `overload(func)`
- **Description**: A decorator that defines multiple function signatures for type checkers.

##### 19.3. `@dataclass_transform`
**Function Signature**: `dataclass_transform(*, eq_default=True, order_default=False, kw_only_default=False, field_specifiers=(), **kwargs)`
- **Description**: A decorator that marks a class as providing dataclass-like behavior.

##### 19.4. `@deprecated`
**Function Signature**: `deprecated(*, since: str = '', message: str = '')`
- **Description**: Marks a function, class, or module as deprecated.

#### 20. Deprecation and Version Management

##### 20.1. `NoDefault`
**Description**: A sentinel value indicating that no default value was provided.

##### 20.2. `NoExtraItems`
**Description**: A sentinel value indicating that extra items are not allowed in a TypedDict.

#### 21. Type Aliases

##### 21.1. `TypeAlias`
**Description**: A special form for defining type aliases.

##### 21.2. `TypeAliasType`
**Description**: The type of type aliases.

#### 22. Typed Dictionaries

##### 22.1. `TypedDict`
**Function Signature**: `TypedDict(typename, fields, total=True, *, closed=None, extra_items=NoExtraItems, **kwargs)`
- **Description**: Creates a typed dictionary class.

##### 22.2. `Required` and `NotRequired`
**Description**: Special forms for marking fields as required or not required in a TypedDict.

#### 23. Async Types

##### 23.1. `Awaitable`
**Type Alias**: `Awaitable[ReturnType]`
- **Description**: Represents an awaitable object.

##### 23.2. `AsyncIterator`
**Type Alias**: `AsyncIterator[YieldType]`
- **Description**: Represents an asynchronous iterator.

##### 23.3. `AsyncContextManager`
**Type Alias**: `AsyncContextManager[ReturnType]`
- **Description**: Represents an asynchronous context manager.

#### 24. Utility Functions

##### 24.1. `assert_never`
**Function Signature**: `assert_never(arg, /)`
- **Description**: A helper function for exhaustive checking.

##### 24.2. `clear_overloads`
**Function Signature**: `clear_overloads()`
- **Description**: Clears all registered overloads.

##### 24.3. `get_overloads`
**Function Signature**: `get_overloads(func)`
- **Description**: Returns all defined overloads of a function.

#### 25. Type Checking

##### 25.1. `is_protocol`
**Function Signature**: `is_protocol(tp)`
- **Description**: Checks if a type is a protocol.

##### 25.2. `is_typeddict`
**Function Signature**: `is_typeddict(tp)`
- **Description**: Checks if a type is a TypedDict.

##### 25.3. `type_repr`
**Function Signature**: `type_repr(obj)`
- **Description**: Returns the string representation of a type.

#### 26. Compatibility Types

##### 26.1. `Buffer`
**Description**: The type of objects supporting the buffer protocol.

##### 26.2. `Concatenate`
**Function Signature**: `Concatenate[P1, P2, ..., Pn, R]`
- **Description**: Used with `ParamSpec` and `Callable` to represent higher-order functions.

##### 26.3. `Unpack`
**Function Signature**: `Unpack[Ts]`
- **Description**: Used to unpack type variable tuples.

#### 27. **`ClassVar`**: A special type constructor used to mark class variables.
  ```python
  from typing_extensions import ClassVar
  class C:
      x: ClassVar[int] = 0  # Class variable
      y: int = 1            # Instance variable
  ```

#### 28. **`Final`**: A special type construct indicating that a name cannot be reassigned or overridden.
  ```python
  from typing_extensions import Final

  RATE: Final = 3000

  class Base:
      DEFAULT_ID: Final[int] = 0
  ```

#### 29. AnyStr
**Description**: Represents a string-type variable that can be either `str` or `bytes`.
**Example**:
```python
def concat(a: AnyStr, b: AnyStr) -> AnyStr:
    return a + b
```

#### 30. ClassVar
**Description**: A special type constructor used to mark class variables.
**Example**:
```python
class Example:
    class_var: ClassVar[int] = 42  # Class variable
    instance_var: int = 0          # Instance variable
```

#### 31. Callable
**Description**: `Callable[[ParameterType1, ParameterType2], ReturnType]` represents a callable object.
**Example**:
```python
def apply_func(func: Callable[[int, int], int], x: int, y: int) -> int:
    return func(x, y)
```

#### 32. Dict, List, Set, Tuple
**Description**: Generic versions of built-in collection types.
**Example**:
```python
def process_data(data: Dict[str, List[int]]) -> Set[str]:
    return {k for k, v in data.items() if sum(v) > 10}
```

#### 33. Advanced Types

##### 33.1 Generic
**Description**: Abstract base class for generic types.
**Example**:
```python
T = TypeVar('T')
class Box(Generic[T]):
    def __init__(self, item: T) -> None:
        self.item = item
```

##### 33.2 NamedTuple
**Description**: Typed version of named tuples.
**Example**:
```python
class Point(NamedTuple):
    x: float
    y: float
    z: float = 0.0  # Default value
```

##### 33.3 NewType
**Description**: Creates simple unique types with almost zero runtime overhead.
**Example**:
```python
UserId = NewType('UserId', int)
user = UserId(42)
```

##### 33.4 Optional
**Description**: `Optional[X]` is equivalent to `X | None` or `Union[X, None]`.
**Example**:
```python
def greet(name: Optional[str] = None) -> str:
    return f"Hello, {name if name else 'stranger'}"
```

##### 33.5 ParamSpecArgs and ParamSpecKwargs
**Description**: Used to preserve parameter types in higher-order functions.
**Example**:
```python
P = ParamSpec('P')

def log_call(func: Callable[P, T]) -> Callable[P, T]:
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
        print(f"Calling {func.__name__}")
        return func(*args, **kwargs)
    return wrapper
```

##### 33.6 ReadOnly
**Description**: Marks a type as read-only.
**Example**:
```python
def process_data(data: ReadOnly[Dict[str, Any]]) -> None:
    # Cannot modify data here
    pass
```

#### 34. Special Values and Constants

##### 34.1 _FORWARD_REF_HAS_CLASS
**Description**: A boolean value indicating whether ForwardRef has the `__forward_is_class__` attribute.

##### 34.2 Never
**Description**: A special type indicating that a function never returns.
**Example**:
```python
def stop() -> Never:
    raise RuntimeError("Cannot continue")
```

#### 35. Utility Functions

##### 35.1 disjoint_base
**Description**: A decorator used to mark a class as a disjoint base class.
**Example**:
```python
@disjoint_base
class BaseA: pass

@disjoint_base
class BaseB: pass

# The type checker will report an error:
class Child(BaseA, BaseB): pass
```

##### 35.2 evaluate_forward_ref
**Description**: Evaluates a forward reference.
**Example**:
```python
def process_type(t: Any) -> None:
    if isinstance(t, str):
        t = evaluate_forward_ref(t, globals(), locals())
    # Process the type...
```

##### 35.3 get_annotations
**Description**: Retrieves annotations with optional string evaluation.
**Example**:
```python
class Example:
    x: 'int'
    y: 'str'

annotations = get_annotations(Example, eval_str=True)
```

##### 35.4 get_original_bases
**Description**: Retrieves the original base classes before any modifications.
**Example**:
```python
class Base: pass
class Derived(Base): pass
print(get_original_bases(Derived))  # (<class '__main__.Base'>,)
```

##### 35.5 get_protocol_members
**Description**: Retrieves all members of a protocol.
**Example**:
```python
class Proto(Protocol):
    def method(self) -> int: ...
    attr: int

print(get_protocol_members(Proto))  # {'method', 'attr'}
```

##### 35.6 no_type_check
**Description**: A decorator indicating that a function should not be type-checked.
**Example**:
```python
@no_type_check
def legacy_function(x):
    # This function is not type-checked
    return x + " string"
```

##### 35.7 override
**Description**: A decorator indicating that a method is intended to override a method in a superclass.
**Example**:
```python
class Base:
    def method(self) -> int:
        return 1

class Derived(Base):
    @override
    def method(self) -> int:
        return 2
```

##### 35.8 runtime
**Description**: Alias for `runtime_checkable`.
**Example**:
```python
@runtime
class Proto(Protocol):
    def method(self) -> int: ...
```

#### 36. Type Variables

##### 36.1 IntVar
**Description**: Integer type variable.
**Example**:
```python
T = IntVar('T')
def add(x: T, y: T) -> T:
    return x + y
```

#### 36. Format Strings

##### 36.1 Format
**Description**: Type for format strings.
**Example**:
```python
def log(message: Format, *args: Any) -> None:
    print(message % args)
```
#### 37. AsyncContextManager
**Function Description**: Protocol class for asynchronous context managers, supporting the `async with` syntax.

**Type Signature**:
```python
class typing_extensions.AsyncContextManager[T_co]
```

**Methods**:
- `async def __aenter__(self) -> T_co`: Called when entering the asynchronous context
- `async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool | None`: Called when exiting the asynchronous context

**Example**:
```python
class AsyncResource:
    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *args):
        await self.close()
```

#### 38. Doc
**Function Description**: A marker type for adding documentation strings to type annotations.

**Type Signature**:
```python
class typing_extensions.Doc
```

**Usage**:
- Used with `Annotated` to add documentation to type annotations
- Documentation strings become part of the type annotation and can be used by type checkers and documentation generation tools

**Example**:
```python
from typing_extensions import Annotated, Doc

def greet(
    name: Annotated[str, Doc("The name of the person to greet")]
) -> None:
    print(f"Hello, {name}!")
```

#### 39. Iterable and Iterator
**Function Description**: Protocols for iterable objects and iterators.

**Type Signature**:
```python
class typing_extensions.Iterable[T_co]
class typing_extensions.Iterator[Iterator_T_co]
```

**Methods**:
- `def __iter__(self) -> Iterator[T_co]`: Returns an iterator
- `def __next__(self) -> T_co`: Returns the next element

**Example**:
```python
from typing_extensions import Iterable, Iterator

def process_items(items: Iterable[int]) -> None:
    for item in items:
        print(item)

class CountUpTo(Iterator[int]):
    def __init__(self, max: int):
        self.current = 0
        self.max = max

    def __iter__(self) -> Iterator[int]:
        return self

    def __next__(self) -> int:
        if self.current >= self.max:
            raise StopIteration
        self.current += 1
        return self.current - 1
```

#### 40. Sentinel
**Function Description**: Creates unique marker objects, typically used to represent special values or states.

**Type Signature**:
```python
class typing_extensions.Sentinel
```

**Methods**:
- `def __init__(self, name: str, repr: str | None = None)`: Creates a new marker object

**Example**:
```python
from typing_extensions import Sentinel

MISSING = Sentinel("MISSING")

class Config:
    def __init__(self, value=MISSING):
        if value is MISSING:
            self.value = "default"
        else:
            self.value = value
```

#### 41. Type and TypeVar
**Function Description**: Represents types themselves and type variables.

**Type Signature**:
```python
class typing_extensions.Type[CT_co]
class typing_extensions.TypeVar(name, *constraints, bound=None, covariant=False, contravariant=False)
```

**Example**:
```python
from typing_extensions import Type, TypeVar

T = TypeVar('T')

def create_instance(cls: Type[T]) -> T:
    return cls()

class Animal: pass
class Dog(Animal): pass

# Type checking will ensure the return type matches the input type
dog: Dog = create_instance(Dog)
```

#### 42. TypeForm
**Function Description**: Type annotation representing type objects themselves.

**Type Signature**:
```python
class typing_extensions.TypeForm[T]
```

**Use Cases**:
- When needing to annotate that a parameter or return value is a type object itself
- Particularly useful when used with `isinstance()` or `issubclass()`

**Example**:
```python
from typing_extensions import TypeForm

def get_type_name(t: TypeForm) -> str:
    return t.__name__

print(get_type_name(int))  # "int"
print(get_type_name(str))  # "str"

# Type checkers will verify that the argument is a type object
get_type_name(123)  # Type checker error: expected a type
```

## Detailed Implementation Nodes of Functions

## Detailed Implementation Nodes of Functions

### Node 1: Sentinel Class

**Function Description**: Create a unique sentinel object.

**Core Algorithm**:
- Initialization with name and optional repr string
- Custom repr implementation returning the provided representation
- Special handling for Python version compatibility (__call__ method for <3.11)
- Union operator support for Python 3.10+
- Pickle prevention through __getstate__ method

**Input/Output Example**:

```python
class Sentinel:
    """Create a unique sentinel object.

    *name* should be the name of the variable to which the return value shall be assigned.

    *repr*, if supplied, will be used for the repr of the sentinel object.
    If not provided, "<name>" will be used.
    """
```

### Node 2: Final Decorator

**Function Description**: Decorator to indicate to type checkers that the decorated method cannot be overridden, and decorated class cannot be subclassed.

**Core Algorithm**:
- Sets `__final__ = True` attribute on decorated object
- Graceful handling of non-writable attributes via try/except block
- No runtime checking, only type checker guidance

**Input/Output Example**:

```python
def final(f):
    """This decorator can be used to indicate to type checkers that
    the decorated method cannot be overridden, and decorated class
    cannot be subclassed. For example:

        class Base:
            @final
            def done(self) -> None:
                ...
        class Sub(Base):
            def done(self) -> None:  # Error reported by type checker
                ...
        @final
        class Leaf:
            ...
        class Other(Leaf):  # Error reported by type checker
            ...

    There is no runtime checking of these properties. The decorator
    sets the ``__final__`` attribute to ``True`` on the decorated object
    to allow runtime introspection.
    """
```

### Node 3: Overload Decorator System

**Function Description**: Decorator for overloaded functions/methods with registry system for runtime overload retrieval.

**Core Algorithm**:
- Registry system using nested defaultdicts organized by module and qualname
- Line number-based storage for overload definitions
- `get_overloads()` function to retrieve all overloads for a function
- `clear_overloads()` function to clear the overload registry

**Input/Output Example**:

```python
def overload(func):
    """Decorator for overloaded functions/methods.

    In a stub file, place two or more stub definitions for the same
    function in a row, each decorated with @overload.  For example:

    @overload
    def utf8(value: None) -> None: ...
    @overload
    def utf8(value: bytes) -> bytes: ...
    @overload
    def utf8(value: str) -> bytes: ...

    In a non-stub file (i.e. a regular .py file), do the same but
    follow it with an implementation.  The implementation should *not*
    be decorated with @overload.
    """
```

### Node 4: Runtime Checkable Protocol Decorator

**Function Description**: Mark a protocol class as a runtime protocol that can be used with isinstance() and issubclass().

**Core Algorithm**:
- Validation that class is a protocol before applying decorator
- Sets `_is_runtime_protocol = True` attribute
- Computes non-callable protocol members for issubclass() validation
- Type checking for protocol class requirement

**Input/Output Example**:

```python
def runtime_checkable(cls):
    """Mark a protocol class as a runtime protocol.

    Such protocol can be used with isinstance() and issubclass().
    Raise TypeError if applied to a non-protocol class.
    This allows a simple-minded structural check very similar to
    one trick ponies in collections.abc such as Iterable.

    For example::

        @runtime_checkable
        class Closable(Protocol):
            def close(self): ...

        assert isinstance(open('/some/file'), Closable)

    Warning: this will check only the presence of the required methods,
    not their type signatures!
    """
```

### Node 5: Assert Type Function

**Function Description**: Assert (to the type checker) that the value is of the given type.

**Core Algorithm**:
- Type checker validation without runtime type checking
- Returns the value unchanged at runtime
- Simple pass-through implementation for runtime compatibility

**Input/Output Example**:

```python
def assert_type(val, typ, /):
    """Assert (to the type checker) that the value is of the given type.

    When the type checker encounters a call to assert_type(), it
    emits an error if the value is not of the specified type::

        def greet(name: str) -> None:
            assert_type(name, str)  # ok
            assert_type(name, int)  # type checker error

    At runtime this returns the first argument unchanged and otherwise
    does nothing.
    """
```

### Node 6: Reveal Type Function

**Function Description**: Reveal the inferred type of a variable to static type checkers.

**Core Algorithm**:
- Static type checker directive for type revelation
- Runtime type printing to stderr for debugging
- Value return unchanged for runtime compatibility

**Input/Output Example**:

```python
def reveal_type(obj: T, /) -> T:
    """Reveal the inferred type of a variable.

    When a static type checker encounters a call to ``reveal_type()``,
    it will emit the inferred type of the argument::

        x: int = 1
        reveal_type(x)

    Running a static type checker (e.g., ``mypy``) on this example
    will produce output similar to 'Revealed type is "builtins.int"'.

    At runtime, the function prints the runtime type of the
    argument and returns it unchanged.
    """
```

### Node 7: Assert Never Function

**Function Description**: Assert to the type checker that a line of code is unreachable.

**Core Algorithm**:
- Runtime assertion error with value representation
- Type checker directive for unreachable code detection
- Value length limiting for error message readability

**Input/Output Example**:

```python
def assert_never(arg: Never, /) -> Never:
    """Assert to the type checker that a line of code is unreachable.

    Example::

        def int_or_str(arg: int | str) -> None:
            match arg:
                case int():
                    print("It's an int")
                case str():
                    print("It's a str")
                case _:
                    assert_never(arg)

    If a type checker finds that a call to assert_never() is
    reachable, it will emit an error.

    At runtime, this throws an exception when called.
    """
```

### Node 8: Override Decorator

**Function Description**: Indicate that a method is intended to override a method in a base class.

**Core Algorithm**:
- Sets `__override__ = True` attribute on decorated method
- Graceful handling of non-writable attributes
- Type checker validation without runtime checking

**Input/Output Example**:

```python
def override(arg: _F, /) -> _F:
    """Indicate that a method is intended to override a method in a base class.

    Usage:

        class Base:
            def method(self) -> None:
                pass

        class Child(Base):
            @override
            def method(self) -> None:
                super().method()

    When this decorator is applied to a method, the type checker will
    validate that it overrides a method with the same name on a base class.
    This helps prevent bugs that may occur when a base class is changed
    without an equivalent change to a child class.

    There is no runtime checking of these properties.
    """
```

### Node 9: Get Type Hints Function

**Function Description**: Return type hints for an object with support for forward references and annotation stripping.

**Core Algorithm**:
- Recursive annotation processing with `_strip_extras` helper
- Forward reference resolution using global and local namespaces
- Optional inclusion of annotation extras via `include_extras` parameter
- Compatibility handling for different Python versions

**Input/Output Example**:

```python
def get_type_hints(obj, globalns=None, localns=None, include_extras=False):
    """Return type hints for an object.

    This is often the same as obj.__annotations__, but it handles
    forward references encoded as string literals, adds Optional[t] if a
    default value equal to None is set and recursively replaces all
    'Annotated[T, ...]', 'Required[T]' or 'NotRequired[T]' with 'T'
    (unless 'include_extras=True').

    The argument may be a module, class, method, or function. The annotations
    are returned as a dictionary. For classes, annotations include also
    inherited members.

    TypeError is raised if the argument is not of a type that can contain
    annotations, and an empty dictionary is returned if no annotations are
    present.
    """
```

### Node 10: Type Guard Special Form

**Function Description**: Special typing form used to annotate the return type of a user-defined type guard function.

**Core Algorithm**:
- Single type argument validation
- Type narrowing indication for static type checkers
- Boolean return type requirement for runtime
- Generic alias creation for type system integration

**Input/Output Example**:

```python
@_ExtensionsSpecialForm
def TypeGuard(self, parameters):
    """Special typing form used to annotate the return type of a user-defined
    type guard function.  ``TypeGuard`` only accepts a single type argument.
    At runtime, functions marked this way should return a boolean.

    ``TypeGuard`` aims to benefit *type narrowing* -- a technique used by static
    type checkers to determine a more precise type of an expression within a
    program's code flow.
    """
```
