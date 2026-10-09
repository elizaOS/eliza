# Introduction and Goals of the unittest-parametrize Project

unittest-parametrize is a library for parameterizing Python unit tests. It can achieve a functionality similar to pytest.mark.parametrize in unittest TestCase, providing an elegant solution for test parameterization. While maintaining compatibility with the unittest framework, this tool realizes "the simplest API and the most powerful functions". Its core functions include: parameterizing test methods (automatically generating multiple independent test methods, supporting custom test IDs and naming), supporting both synchronous and asynchronous tests (supporting parameterization of both ordinary test methods and async test methods), and flexible parameter configuration (supporting various configuration methods such as string parameter names, tuple parameter names, param objects, and custom IDs). In short, unittest-parametrize aims to provide a robust unittest test parameterization system to simplify the writing of repetitive test code and improve test coverage (for example, expanding a single test method into multiple independent tests through the @parametrize decorator, and implementing parameterization support through the ParametrizedTestCase base class).

## Natural Language Instructions (Prompt)

Please create a Python project named unittest-parametrize to implement a unittest test parameterization library. The project should include the following functions:

1. Parameterized Decorator: It should be able to parameterize unittest test methods through the @parametrize decorator, supporting multiple ways of defining parameter names (string form like "x,expected" and tuple form like ("x", "expected")). The decorator should automatically generate multiple independent test methods, with each method corresponding to a set of parameter values.

2. Basic Test Class: Implement the ParametrizedTestCase base class, which inherits from unittest.TestCase. Use Python's __init_subclass__ mechanism to automatically handle parameterized test methods when the class is defined. This base class should be fully compatible with the existing unittest test framework and support multiple test runners such as Django tests and pytest.

3. Advanced Parameter Configuration: Provide a param object for advanced parameter configuration, supporting functions such as custom test IDs and parameter value wrapping. Implement support for the ids parameter, allowing users to specify a custom test name suffix for each set of parameters, improving test readability and debugging convenience.

4. Synchronous and Asynchronous Support: Fully support parameterization of both synchronous and asynchronous test methods, correctly handle test methods defined by async def, and ensure that parameterized asynchronous tests can run normally.

5. Error Handling and Validation: Implement a comprehensive parameter validation mechanism, including checking the number of parameters, validating parameter types, detecting duplicate IDs, and checking decorator stacking. Provide clear error messages to help developers quickly locate problems.

6. Interface Design: The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as pytest==8.4.0 pytest-randomly==3.16.0 typing-extensions==4.14.0 tomli==2.2.1 pygments==2.19.1 pluggy==1.6.0 packaging==25.0.0 iniconfig==2.1.0 importlib-metadata==8.7.0 exceptiongroup==1.3.0 colorama==0.4.6 coverage>=7.8.2). The setup.py file should be able to verify whether all functional modules work properly. At the same time, it is necessary to provide unittest_parametrize/__init__.py as a unified API entry, exporting core components such as the parametrize decorator, the ParametrizedTestCase base class, and the param parameter object, and providing version information, allowing users to access all major functions through a simple "from unittest_parametrize import parametrize, ParametrizedTestCase, param" statement.

7. Examples and Test Scripts: Provide example code and test cases to demonstrate how to use the @parametrize decorator and the ParametrizedTestCase base class for test parameterization (for example, @parametrize("x,expected", [(1,1), (2,4), (3,9)]) should be able to generate three independent test methods: test_square_0, test_square_1, and test_square_2).

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.18

### Core Dependency Library Versions

```
coverage          7.10.4
exceptiongroup    1.3.0
iniconfig         2.1.0
packaging         25.0
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
pytest-randomly   3.16.0
setuptools        65.5.1
tomli             2.2.1
typing_extensions 4.14.1
wheel             0.45.1
```

## Project Architecture of unittest-parametrize

```
workspace/
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
├── .typos.toml
├── CHANGELOG.rst
├── LICENSE
├── MANIFEST.in
├── README.rst
├── pyproject.toml
├── src
│   ├── unittest_parametrize
│   │   ├── __init__.py
│   │   └── py.typed
├── tox.ini
└── uv.lock

```

## API Usage Guide

### Core API

#### 1. Module Import
from unittest_parametrize import (
    parametrize, ParametrizedTestCase, param
)
#### 2. **ParametrizedTestCase** Class
A basic test class that inherits from `unittest.TestCase` and provides support for parameterized tests.

```python
class ParametrizedTestCase(TestCase):
    @classmethod
    def __init_subclass__(cls, **kwargs: Any) -> None:
        """
        Args:
            kwargs: Keyword arguments

        Returns:
            None

        Raises:
            TypeError: If the @parametrize decorator is not the top-most decorator on the test method
            ValueError: If the duplicate test name is found in the class
            ValueError: If the id is not a valid Python identifier suffix
        """
        super().__init_subclass__(**kwargs)

        for name, func in list(cls.__dict__.items()):
            if not isinstance(func, FunctionType):
                continue
            if not hasattr(func, "_parametrized"):
                continue

            if hasattr(func, "__wrapped__") and hasattr(
                func.__wrapped__, "_parametrized"
            ):
                raise TypeError(
                    "@parametrize must be the top-most decorator on "
                    + func.__qualname__
                )

            _parametrized = func._parametrized  # type: ignore [attr-defined]
            delattr(cls, name)
            for param in _parametrized.params:
                params = dict(zip(_parametrized.argnames, param.args))
                if inspect.iscoroutinefunction(func):
                    @wraps(func)
                    async def test(
                        self: TestCase,
                        *args: Any,
                        _func: FunctionType = func,
                        _params: dict[str, Any] = params,
                        **kwargs: Any,
                    ) -> Any:
                        """
                        Args:
                            self: The test case instance
                            args: The arguments passed to the test method
                            _func: The original test method
                            _params: The parameters passed to the test method
                            kwargs: The keyword arguments passed to the test method

                        Returns:
                        Any: The result of the test method

                    Raises:
                        Exception: If the test method raises an exception
                    """
                else:
                    @wraps(func)
                    def test(
                        self: TestCase,
                        *args: Any,
                        _func: FunctionType = func,
                        _params: dict[str, Any] = params,
                        **kwargs: Any,
                    ) -> Any:
                    """
                    Args:
                        self: The test case instance
                        args: The arguments passed to the test method
                        _func: The original test method
                        _params: The parameters passed to the test method
                        kwargs: The keyword arguments passed to the test method

                    Returns:
                        Any: The result of the test method

                    Raises:
                        Exception: If the test method raises an exception
                    """
```

**Usage:**
```python
from unittest_parametrize import ParametrizedTestCase

class MyTests(ParametrizedTestCase):
    def test_normal(self):
        # Ordinary test method
        pass
    
    @parametrize("x", [(1,), (2,)])
    def test_parametrized(self, x):
        # Parameterized test method
        pass
```

#### 3. **@parametrize** Function
The core function used to mark test methods for parameterization.

```python
def parametrize(
    argnames: str | Sequence[str],
    argvalues: Sequence[tuple[Any, ...] | param | Any],
    ids: Sequence[str | None] | Callable[[Any], str | None] | None = None,
) -> Callable[[Callable[P, T]], Callable[P, T]]:
```

**Parameter Description:**

| Parameter | Type | Description | Example |
|------|------|------|------|
| `argnames` | `str \| Sequence[str]` | Parameter names, which can be a comma-separated string or a sequence of strings | `"x,y"` or `["x", "y"]` |
| `argvalues` | `Sequence[tuple] \| Sequence[param]` | A list of parameter values, with each element being a parameter combination | `[(1,2), (3,4)]` |
| `ids` | `Sequence[str] \| None` | An optional list of test IDs used to customize test names | `["test1", "test2"]` |

**Usage Example:**

```python
# Basic usage - String parameter names
@parametrize("x,expected", [(1,1), (2,4), (3,9)])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)

# Sequence parameter names
@parametrize(["x", "expected"], [(1,1), (2,4)])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)

# Parameter names with spaces (automatically cleaned)
@parametrize("x, expected", [(1,1), (2,4)])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)

# Custom test IDs
@parametrize("x,expected", [(1,1), (2,4)], ids=["one", "two"])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)
```

#### 4. **param** Class
A parameter object used for advanced parameter configuration.

```python
class param:
    __slots__ = ("args", "id")

    def __init__(self, *args: Any, id: str | None = None) -> None:
        self.args = args

        if id is not None and not f"_{id}".isidentifier():
            raise ValueError(f"id must be a valid Python identifier suffix: {id!r}")

        self.id = id
```

**Usage Example:**

```python
# Use the param object to specify a custom ID
@parametrize("x,expected", [
    param(1, 1, id="one"),
    param(2, 4, id="two"),
    param(3, 9, id="three"),
])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)

# Mix the use of the param object and ordinary tuples
@parametrize("x,expected", [
    param(1, 1, id="one"),
    (2, 4),  # Automatically generate an ID of "1"
    param(3, 9, id="three"),
])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)

# A param object without an ID (fall back to index naming)
@parametrize("x,expected", [
    param(1, 1),      # ID is "0"
    param(2, 4, id="custom"),
])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)
```

#### 5. **make_id** Function
A function used to generate a test ID.

```python
def make_id(
    i: int,
    argvalue: tuple[Any, ...] | param,
    ids: Sequence[str | None] | Callable[[Any], str | None] | None,
) -> str:
```

**Parameter Description:**

| Parameter | Type | Description | Example |
|------|------|------|------|
| `i` | `int` | The index of the parameter | `0` |
| `argvalue` | `tuple[Any, ...] \| param` | The parameter value | `(1, 2)` |
| `ids` | `Sequence[str] \| None` | An optional list of test IDs used to customize test names | `["test1", "test2"]` |

**Usage Example:**

```python
# Use the make_id function to generate a test ID
@parametrize("x,expected", [
    param(1, 1, id="one"),
    param(2, 4, id="two"),
    param(3, 9, id="three"),
])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)
```

#### 6. **parametrized** Class
A class used to configure parameterized tests.

```python
class parametrized:
    __slots__ = ("argnames", "params")

    def __init__(self, argnames: Sequence[str], params: Sequence[param]) -> None:
        self.argnames = argnames
        self.params = params
```

**Usage Example:**

```python
# Use the parametrized class to configure parameterized tests
@parametrized(["x", "expected"], [param(1, 1), param(2, 4), param(3, 9)])
def test_square(self, x, expected):
    self.assertEqual(x**2, expected)
```
## Usage Examples

### Basic Usage

```python
from unittest_parametrize import parametrize, ParametrizedTestCase

class MathTests(ParametrizedTestCase):
    @parametrize(
        "x,expected",
        [
            (1, 1),
            (2, 4),
            (3, 9),
        ],
    )
    def test_square(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)
```

### Advanced Usage

```python
from unittest_parametrize import parametrize, ParametrizedTestCase, param

class AdvancedTests(ParametrizedTestCase):
    @parametrize(
        "input,output",
        [
            param("hello", 5, id="string"),
            param([1,2,3], 3, id="list"),
            param({}, 0, id="empty"),
        ],
    )
    def test_length(self, input, output):
        self.assertEqual(len(input), output)
```


## Detailed Implementation Nodes of Functions

### Node 1: Basic Parametrization Decorator

**Function Description**: The core `@parametrize` decorator converts a single test method into multiple independent parameterized tests.

**Core Mechanism**:

- Method Replacement: Delete the original test method and generate multiple independent methods.
- Parameter Injection: Pass test data through keyword parameters.
- Automatic Naming: Generate unique test method names.

**Input and Output Example**:

```python
from unittest_parametrize import ParametrizedTestCase, parametrize

# Basic string parameter names
class MathTests(ParametrizedTestCase):
    @parametrize(
        "x,expected",  # str: Comma-separated parameter names
        [
            (1, 1),        # tuple[int, int]: Parameter value pairs
            (2, 4),        # tuple[int, int]: Parameter value pairs
            (3, 9),        # tuple[int, int]: Parameter value pairs
        ],
    )
    def test_square(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)

# Execution result:
# - The original method test_square is deleted.
# - test_square_0, test_square_1, and test_square_2 are generated.
# - Each method receives the corresponding parameter values.
print(hasattr(MathTests, "test_square"))      # False
print(hasattr(MathTests, "test_square_0"))    # True
print(hasattr(MathTests, "test_square_1"))    # True
print(hasattr(MathTests, "test_square_2"))    # True
```

### Node 2: Argument Name Formatting

**Function Description**: Support multiple formats for defining parameter names and automatically handle spaces and formatting.

**Supported Formats**:
- String Format: `"x,y,z"` or `"x, y, z"`
- Tuple Format: `("x", "y", "z")`
- Sequence Format: `["x", "y", "z"]`

**Input and Output Example**:

```python
# String parameter names with spaces
class SpaceTests(ParametrizedTestCase):
    @parametrize(
        "x, expected",  # str: With spaces, automatically cleaned
        [(1, 1), (2, 4)],
    )
    def test_with_spaces(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)

# Tuple-form parameter names
class TupleTests(ParametrizedTestCase):
    @parametrize(
        ("input", "output"),  # tuple[str, str]: Tuple format
        [("hello", 5), ("world", 5)],
    )
    def test_length(self, input: str, output: int) -> None:
        self.assertEqual(len(input), output)

# Error handling: Empty parameter names
try:
    parametrize((), [])  # tuple: Empty tuple
except ValueError as e:
    print(e)  # "argnames must contain at least one element"

# Error handling: Mismatched parameters
try:
    @parametrize("x", [(1, 2)])  # One parameter name, two values
    def bad_test(self, x): pass
except ValueError as e:
    print(e)  # "tuple at index 0 has wrong number of arguments (2 != 1)"
```

### Node 3: Custom Test ID Support

**Function Description**: Allow specifying a custom identifier for each parameterized test to improve test readability.

**ID Strategies**:
- Default ID: Numeric index `0, 1, 2...`
- Custom ID: Specify through the `ids` parameter (list/sequence or callable) or the `param` object.
- Callable IDs: The `ids` parameter can be a callable that generates IDs dynamically based on parameter values.
- ID Validation: Ensure compliance with Python identifier rules.

**Input and Output Example**:

```python
# Customize IDs through the ids parameter
class CustomIdTests(ParametrizedTestCase):
    @parametrize(
        "value,expected",
        [(1, 1), (2, 4), (3, 9)],
        ids=["one", "two", "three"]  # list[str]: List of custom IDs
    )
    def test_with_ids(self, value: int, expected: int) -> None:
        self.assertEqual(value**2, expected)

# Result: test_with_ids_one, test_with_ids_two, and test_with_ids_three are generated.

# ID validation: Invalid identifier
try:
    parametrize("x", [(1,)], ids=["invalid-id"])  # Contains a hyphen
except ValueError as e:
    print(e)  # ID format error

# ID length validation
try:
    parametrize("x", [(1,), (2,)], ids=["only_one"])  # Two values, one ID
except ValueError as e:
    print(e)  # "ids must have the same length as argvalues"

# Duplicate ID detection
try:
    parametrize("x", [(1,), (2,)], ids=["same", "same"])
except ValueError as e:
    print(e)  # "Duplicate param id 'same'"

# Callable IDs: Generate IDs dynamically
def make_id(value):
    return f"num{value}"

class CallableIdTests(ParametrizedTestCase):
    @parametrize(
        "x,expected",
        [(1, 1), (2, 4), (3, 9)],
        ids=make_id  # callable: Function to generate IDs
    )
    def test_with_callable_ids(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)

# Result: test_with_callable_ids_num1_num1, test_with_callable_ids_num2_num4, test_with_callable_ids_num3_num9 are generated.
# The callable is called for each parameter value in the tuple/param object.
# For a tuple (x, y), the callable is called twice: once with x, once with y.
# The results are joined with underscores to form the final ID.
# If the callable returns None for a value, the string representation of that value is used instead.
```

### Node 4: Advanced param Object Configuration

**Function Description**: Provide a `param` object for advanced parameter configuration, supporting inline ID definition and parameter wrapping.

**Features of param**:
- Parameter Wrapping: `param(*args, id=None)`
- ID Embedding: Specify the ID directly in the parameter.
- Mixed Use: Mix with ordinary tuples.
- Reuse Support: The same param object can be used multiple times.

**Input and Output Example**:

```python
from unittest_parametrize import param

# Use the param object to define parameters
class ParamTests(ParametrizedTestCase):
    @parametrize(
        "input,expected",
        [
            param("hello", 5, id="string"),      # param: String test
            param([1, 2, 3], 3, id="list"),      # param: List test  
            param({}, 0, id="empty"),            # param: Empty container test
        ],
    )
    def test_length(self, input, expected: int) -> None:
        self.assertEqual(len(input), expected)

# Result: test_length_string, test_length_list, and test_length_empty are generated.

# Mix the use of param and tuple
class MixedTests(ParametrizedTestCase):
    @parametrize(
        "x,y",
        [
            param(1, 2, id="custom"),  # param: Custom ID
            (3, 4),                    # tuple: Automatic ID "1"
            param(5, 6),               # param: No ID, automatically generated "2"
        ],
    )
    def test_mixed(self, x: int, y: int) -> None:
        self.assertEqual(x + 1, y)

# Reuse the param object
cases = [param(2, 4, id="square")]
class ReuseTests(ParametrizedTestCase):
    @parametrize("x,expected", cases)  # Reuse the same cases
    def test_positive(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)
    
    @parametrize("x,expected", cases, ids=["negative"])  # Reuse and override the ID
    def test_negative(self, x: int, expected: int) -> None:
        self.assertEqual((-x)**2, expected)

# param parameter validation
try:
    param(id="!")  # str: Invalid identifier
except ValueError as e:
    print(e)  # "id must be a valid Python identifier suffix: '!'"

try:
    parametrize("x,y", [param(1)])  # Mismatched number of parameters
except ValueError as e:
    print(e)  # "param at index 0 has wrong number of arguments (1 != 2)"
```

### Node 5: Async Test Support

**Function Description**: Fully support parameterization of test methods defined by `async def` and automatically handle coroutine wrapping.

**Async Features**:
- Coroutine Detection: `inspect.iscoroutinefunction()`
- Async Wrapping: Maintain async features.
- Event Loop: Integrate with `IsolatedAsyncioTestCase`.

**Input and Output Example**:

```python
import asyncio
from unittest import IsolatedAsyncioTestCase

# Async parameterized tests
class AsyncTests(ParametrizedTestCase, IsolatedAsyncioTestCase):
    @parametrize(
        "delay,multiplier", 
        [
            (0.001, 2),    # tuple[float, int]: Short delay
            (0.002, 3),    # tuple[float, int]: Medium delay
            (0.003, 4),    # tuple[float, int]: Long delay
        ]
    )
    async def test_async_operation(self, delay: float, multiplier: int) -> None:
        start = asyncio.get_event_loop().time()
        await asyncio.sleep(delay)
        end = asyncio.get_event_loop().time()
        self.assertGreaterEqual(end - start, delay * multiplier * 0.8)

# Enhanced async error handling
class AsyncErrorTests(ParametrizedTestCase, IsolatedAsyncioTestCase):
    @parametrize("x,expected", [(1, 2)])  # Deliberately wrong expected value
    async def test_async_failure(self, x: int, expected: int) -> None:
        await asyncio.sleep(0.001)
        self.assertEqual(x**2, expected)  # 1**2 != 2, will fail

# Enhanced async error information in Python 3.11+
# The failure message will include:
# AssertionError: 1 != 2
# Test parameters: x=1, expected=2

# Simple async tests
class SimpleAsyncTests(ParametrizedTestCase, IsolatedAsyncioTestCase):
    @parametrize("value", [(0,), (1,), (2,)])  # list[tuple[int]]: Single parameter
    async def test_async_values(self, value: int) -> None:
        await asyncio.sleep(0.001)
        self.assertGreaterEqual(value, 0)
```

### Node 6: Error Enhancement & Debugging

**Function Description**: Automatically add parameter information to failed parameterized tests in Python 3.11+ to improve the debugging experience.

**Enhanced Features**:
- Automatic Annotation: `exc.add_note()` adds parameter information.
- Version Detection: `sys.version_info >= (3, 11)`
- Synchronous and Asynchronous: Support both ordinary and async tests.

**Input and Output Example**:

```python
import sys

# Test for enhanced error information
class ErrorEnhancementTests(ParametrizedTestCase):
    @parametrize(
        "x,expected",
        [
            (1, 2),    # tuple[int, int]: Deliberately wrong
            (3, 8),    # tuple[int, int]: Deliberately wrong
        ]
    )
    def test_with_failures(self, x: int, expected: int) -> None:
        self.assertEqual(x**2, expected)  # Will fail

# Example of error output in Python 3.11+:
"""
FAIL: test_with_failures_0 (ErrorEnhancementTests)
AssertionError: 1 != 2
Test parameters: x=1, expected=2

FAIL: test_with_failures_1 (ErrorEnhancementTests)  
AssertionError: 9 != 8
Test parameters: x=3, expected=8
"""

# Traditional error output (Python < 3.11):
"""
FAIL: test_with_failures_0 (ErrorEnhancementTests)
AssertionError: 1 != 2

FAIL: test_with_failures_1 (ErrorEnhancementTests)
AssertionError: 9 != 8
"""

# Check version support
if sys.version_info >= (3, 11):
    print("Support for enhanced error information")
else:
    print("Enhanced error information is not supported, but the function works normally")
```

### Node 7: Decorator Constraints & Validation

**Function Description**: Implement strict rules for using decorators to ensure correct usage patterns.

**Restriction Rules**:
- Top-Level Decorator: `@parametrize` must be the outermost decorator.
- No Stacking: Multiple `@parametrize` are not allowed.
- Name Conflict: Detect duplicate test method names.

**Input and Output Example**:

```python
from unittest import mock
from types import SimpleNamespace

# Error: @parametrize is not the top-level decorator
obj = SimpleNamespace(x=1)
try:
    class BadOrderTests(ParametrizedTestCase):
        @mock.patch.object(obj, "x", new=2)  # Error: Other decorator on top
        @parametrize("y", [(1,)])
        def test_bad_order(self, y: int) -> None:
            pass
except TypeError as e:
    print("Decorator order error:", str(e))

# Correct: @parametrize is on the top
class GoodOrderTests(ParametrizedTestCase):
    @parametrize("y", [(1,)])
    @mock.patch.object(obj, "x", new=2)  # Correct: @parametrize is the outermost
    def test_good_order(self, mock_x, y: int) -> None:
        self.assertEqual(y, 1)

# Error: Decorator stacking
try:
    class StackedTests(ParametrizedTestCase):
        @parametrize("x", [(1,)])
        @parametrize("y", [(2,)])  # Error: Cannot stack
        def test_stacked(self, x: int, y: int) -> None:
            pass
except TypeError as e:
    print("Decorator stacking error:", str(e))

# Correct: Use cross product
from itertools import product
class CrossProductTests(ParametrizedTestCase):
    @parametrize(
        "x,y", 
        list(product([1, 2], [3, 4]))  # [(1,3), (1,4), (2,3), (2,4)]
    )
    def test_cross_product(self, x: int, y: int) -> None:
        self.assertIsInstance(x * y, int)

# Error: Test name conflict
try:
    class ConflictTests(ParametrizedTestCase):
        @parametrize("x", [(1,)])
        def test_something(self, x: int) -> None:
            pass
        
        def test_something_0(self) -> None:  # Conflict: Same name as the generated method
            pass
except ValueError as e:
    print("Name conflict error:", str(e))
```

### Node 8: Parameter Validation & Type Checking

**Function Description**: A comprehensive parameter validation mechanism to ensure the correctness and consistency of input data.

**Validation Mechanisms**:
- Number of Parameters: The number of `argnames` and `argvalues` should match.
- Parameter Type: Accept tuples, `param` objects, or single values (when `len(argnames) == 1`).
- Function Signature: Validate that parameter names match the function signature.

**Input and Output Example**:

```python
# Type validation: Wrong parameter value type
try:
    parametrize("x", [{"x": 1}])  # dict: Unsupported type
except TypeError as e:
    print(e)  # "argvalue at index 0 is not a tuple or param instance: {'x': 1}"

# Single parameter values: When there's only one parameter name, single values are allowed
class SingleValueTests(ParametrizedTestCase):
    @parametrize("x", [1, 2, 3])  # list[int]: Single values, not tuples
    def test_single_values(self, x: int) -> None:
        self.assertGreaterEqual(x, 0)

# Multiple parameters: Must use tuples or param objects
try:
    parametrize("x,y", ["string"])  # str: Unsupported when multiple parameters
except TypeError as e:
    print(e)  # "argvalue at index 0 is not a tuple, param instance, or single value: 'string'"

# Validation of the number of parameters
try:
    parametrize("x,y", [(1,)])  # Two parameter names, one value
except ValueError as e:
    print(e)  # "tuple at index 0 has wrong number of arguments (1 != 2)"

try:
    parametrize("x", [(1, 2, 3)])  # One parameter name, three values
except ValueError as e:
    print(e)  # "tuple at index 0 has wrong number of arguments (3 != 1)"

# Function signature validation
try:
    @parametrize("x", [(1,)])
    def test_signature_mismatch(self, y: int) -> None:  # Mismatched parameter names
        pass
except TypeError as e:
    print(e)  # "got an unexpected keyword argument 'x'"

# Correct type usage
class ValidTypesTests(ParametrizedTestCase):
    @parametrize(
        "number,text,flag",
        [
            (42, "hello", True),           # tuple[int, str, bool]
            param(-1, "world", False),     # param object
            (0, "", True),                 # tuple[int, str, bool]
        ]
    )
    def test_mixed_types(self, number: int, text: str, flag: bool) -> None:
        self.assertIsInstance(number, int)
        self.assertIsInstance(text, str) 
        self.assertIsInstance(flag, bool)
```

### Node 9: Compatibility & Integration

**Function Description**: Perfect integration with the existing unittest ecosystem, maintaining backward compatibility.

**Compatibility Features**:
- unittest Inheritance: Based on `unittest.TestCase`
- Test Runners: Support unittest, pytest, and Django tests.
- Ordinary Tests: Non-parameterized tests work normally.

**Input and Output Example**:

```python
# Mix with traditional unittest tests
class MixedTestSuite(ParametrizedTestCase):
    # Traditional test method
    def test_traditional(self) -> None:
        """Ordinary unittest test, no parameterization"""
        self.assertEqual(1 + 1, 2)
        self.assertTrue(True)
    
    # Parameterized test method
    @parametrize("x,y", [(1, 2), (3, 4)])
    def test_parametrized(self, x: int, y: int) -> None:
        """Parameterized test"""
        self.assertLess(x, y)
    
    # Another traditional test
    def test_another_traditional(self) -> None:
        """Another ordinary test"""
        self.assertIsNone(None)

# Zero-parameterized test (boundary case)
class EmptyParametrizedTests(ParametrizedTestCase):
    @parametrize("x", [])  # list: Empty parameter list
    def test_never_runs(self, x: int) -> None:
        """This test will never execute"""
        self.fail("This should never run")

# Verification:
# - The test_never_runs method is deleted.
# - No parameterized methods are generated.
print(hasattr(EmptyParametrizedTests, "test_never_runs"))    # False
print(hasattr(EmptyParametrizedTests, "test_never_runs_0"))  # False

# Utility function to run test suites
def run_test_suite(test_class):
    """Helper function to run a test suite"""
    import unittest
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(test_class)  
    runner = unittest.TextTestRunner(verbosity=2)
    return runner.run(suite)

# Usage example
result = run_test_suite(MixedTestSuite)
print(f"Ran {result.testsRun} tests")
print(f"Failures: {len(result.failures)}, Errors: {len(result.errors)}")
```

### Node 10: Advanced Usage Patterns

**Function Description**: Demonstrate advanced usage techniques and best practices of unittest-parametrize.

**Advanced Patterns**:
- Data-Driven Testing: Load test data from external sources.
- Conditional Parameterization: Generate parameters based on conditions.
- Parameter Generator: Dynamically generate test parameters.

**Input and Output Example**:

```python
import json
from pathlib import Path

# Data-driven testing
class DataDrivenTests(ParametrizedTestCase):
    # Load test data from a JSON file
    test_data = [
        {"input": "hello", "expected": 5, "case": "simple"},
        {"input": "world", "expected": 5, "case": "another"},
        {"input": "", "expected": 0, "case": "empty"},
    ]
    
    @parametrize(
        "test_case",
        [param(data, id=data["case"]) for data in test_data]  # Dynamically generate param
    )
    def test_from_data(self, test_case: dict) -> None:
        input_val = test_case["input"]
        expected = test_case["expected"]
        self.assertEqual(len(input_val), expected)

# Conditional parameterization
import sys
class ConditionalTests(ParametrizedTestCase):
    # Conditional parameterization based on Python version
    version_params = []
    if sys.version_info >= (3, 10):
        version_params.extend([
            param("match", "pattern_matching", id="modern"),
            param("union", "X | Y", id="union_operator"),
        ])
    version_params.append(param("classic", "traditional", id="classic"))
    
    @parametrize("feature,syntax", version_params)
    def test_python_features(self, feature: str, syntax: str) -> None:
        self.assertIsInstance(feature, str)
        self.assertIsInstance(syntax, str)

# Parameter generator pattern
class GeneratorTests(ParametrizedTestCase):
    # Math sequence generator
    @staticmethod
    def fibonacci_pairs(n: int):
        """Generate test pairs for the Fibonacci sequence"""
        a, b = 0, 1
        for i in range(n):
            yield param(i, a, id=f"fib_{i}")
            a, b = b, a + b
    
    @parametrize("index,expected", list(fibonacci_pairs(5)))
    def test_fibonacci(self, index: int, expected: int) -> None:
        def fib(n):
            return n if n < 2 else fib(n-1) + fib(n-2)
        self.assertEqual(fib(index), expected)

# Testing complex data structures
class ComplexDataTests(ParametrizedTestCase):
    @parametrize(
        "data_structure,operation,expected",
        [
            param([1, 2, 3], len, 3, id="list_length"),
            param({"a": 1, "b": 2}, len, 2, id="dict_length"),
            param({1, 2, 3, 2}, len, 3, id="set_length"),
            param("hello", str.upper, "HELLO", id="string_upper"),
        ]
    )
    def test_operations(self, data_structure, operation, expected):
        """Test operations on different data structures"""
        result = operation(data_structure)
        self.assertEqual(result, expected)

# Parameterization for performance testing
import time
class PerformanceTests(ParametrizedTestCase):
    @parametrize(
        "size,max_time",
        [
            param(100, 0.001, id="small"),     # 100 elements, within 1ms
            param(1000, 0.01, id="medium"),    # 1000 elements, within 10ms  
            param(10000, 0.1, id="large"),     # 10000 elements, within 100ms
        ]
    )
    def test_list_creation_performance(self, size: int, max_time: float) -> None:
        """Test the performance of list creation"""
        start = time.time()
        data = list(range(size))
        end = time.time()
        
        self.assertEqual(len(data), size)
        self.assertLess(end - start, max_time, 
                       f"Creating {size} elements took {end-start:.4f}s, exceeding the {max_time}s limit")
```