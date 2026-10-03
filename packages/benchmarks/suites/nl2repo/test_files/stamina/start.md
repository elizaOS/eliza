## Introduction and Goals of the Stamina Project

Stamina is a Python library **designed for production-grade retry mechanisms**, offering intelligent retry solutions for transient failures in distributed systems. Built on the mature Tenacity library, it aims to provide "the simplest and most user-friendly API, while doing the right thing by default and minimizing the possibility of misuse." Its core features include: intelligent exception retry (supporting precise control using specific exception types and predicate functions), **exponential backoff and jitter mechanism** (starting from 100ms, exponentially increasing with a base of 2, up to a maximum of 5 seconds, with a random jitter of 0 - 1 second added), and comprehensive support for both synchronous and asynchronous code (including the Trio asynchronous library). In short, Stamina is dedicated to providing a robust retry system for handling inevitable transient failures in distributed systems (for example, automatically retrying failed HTTP requests using the `@stamina.retry` decorator, and retrying arbitrary code blocks using the `retry_context()` function), while avoiding cascading failures and the thundering herd effect.

## Natural Language Instruction (Prompt)

Please create a Python project named Stamina to implement a production-grade retry mechanism library. The project should include the following features:

1. Core retry decorator: Implement the `@stamina.retry()` decorator, which can perform intelligent retries based on specified exception types or predicate functions. The decorator should support configuring parameters such as the number of retries, timeout, and backoff strategy, and maintain the type hints of the decorated function.

2. Exponential backoff and jitter mechanism: Implement an intelligent backoff algorithm starting with an initial delay of 100ms, exponentially increasing with a base of 2, up to a maximum delay of 5 seconds, and adding a random jitter of 0 - 1 second for each retry to avoid the thundering herd effect. The backoff formula should be: `min(5.0, 0.1 * 2.0^(attempt - 1) + random(0, 1.0))`.

3. Asynchronous retry support: Implement automatic support for asynchronous functions by the `@stamina.retry()` decorator, including compatibility with the asyncio and Trio asynchronous libraries. Asynchronous retries should use an appropriate asynchronous sleep mechanism.

4. Context manager retry: Implement the `stamina.retry_context()` function, which returns an iterable context manager, allowing arbitrary code blocks to be retried. Each context manager should provide information on the current retry count and the next waiting time.

5. Function caller: Implement the `RetryingCaller` and `AsyncRetryingCaller` classes, providing a retry mechanism for direct function calls, and supporting the `on()` method for pre-binding exception types.

6. Observability and monitoring: Integrate Prometheus metric collection (the `stamina_retries_total` counter), structlog structured logging, and fallback support for the standard logging module. Provide an `instrumentation` module for custom monitoring hooks.

7. Test mode support: Implement test configuration functionality, allowing global disabling of retries, limiting the number of retries, removing backoff delays, etc., to facilitate unit testing and integration testing.

8. Interface design: Design clear API interfaces for each functional module, including decorators, context managers, caller classes, etc. Each module should define clear input and output formats and error handling mechanisms.

9. Examples and documentation: Provide complete example code and test cases to demonstrate how to use various retry mechanisms to handle common scenarios such as HTTP requests, database operations, and API calls.

10. Core File Requirements: The project must include a well-configured pyproject.toml file, configuring the project as an installable package (supporting `pip install`), and declaring a complete list of dependencies (including core libraries such as tenacity>=8.2.3, typing-extensions>=4.12.2; python_version < '3.10', trio>=0.25.0, anyio>=4.3.0, structlog>=24.1.0, prometheus-client>=0.20.0). It is necessary to provide `stamina/__init__.py` as a unified API entry point, exporting core functions and classes such as retry, retry, AsyncRetryingCaller, retry_context, is_active, is_testing, set_active, set_testing, CONFIG, _Config, _Testing, _make_stop, RetryHookFactory, get_on_retry_hooks, set_on_retry_hooks, RetryDetails, guess_name, get_default_hooks, init_structlog, and providing version information, enabling users to access all major functions through simple statements (from stamina import **, from stamina._config import **, from stamina._core import **, from stamina.instrumentation import **, from stamina.instrumentation.** import **).

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.7


### Core Dependency Library Versions

```Plain

anyio             4.10.0
dirty-equals      0.9.0
idna              3.10
iniconfig         2.1.0
packaging         25.0
pip               23.2.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
setuptools        65.5.1
sniffio           1.3.1
structlog         25.4.0
tenacity          9.1.2
typing_extensions 4.14.1
wheel             0.42.0
trio              0.25.0
```

## Stamina Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .git_archival.txt
├── .gitignore
├── .pre-commit-config.yaml
├── .python-version-default
├── .readthedocs.yaml
├── CHANGELOG.md
├── LICENSE
├── README.md
├── noxfile.py
├── pyproject.toml
├── src
│   ├── stamina
│   │   ├── __init__.py
│   │   ├── _config.py
│   │   ├── _core.py
│   │   ├── instrumentation
│   │   │   ├── __init__.py
│   │   │   ├── _data.py
│   │   │   ├── _hooks.py
│   │   │   ├── _logging.py
│   │   │   ├── _prometheus.py
│   │   │   ├── _structlog.py
│   │   ├── py.typed
│   │   └── typing.py
└── zizmor.yml

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
import stamina
from stamina import is_active, is_testing, set_active, set_testing
from stamina._config import CONFIG, _Config, _Testing
from stamina.instrumentation import (
    RetryHookFactory,get_on_retry_hooks,set_on_retry_hooks,
)
from stamina.instrumentation._data import RetryDetails, guess_name
from stamina.instrumentation._hooks import get_default_hooks
from stamina.instrumentation._structlog import init_structlog
from stamina._core import _make_stop

```
#### Detailed API Explanation

##### 1. retry

**Function**: Provides an intelligent retry mechanism for synchronous or asynchronous functions, supporting parameters such as exception types/predicates, maximum number of attempts, timeout, exponential backoff, and jitter.

**Function Signature**:
```python
@stamina.retry(
    on: Exception | tuple[Exception, ...] | Callable[[Exception], bool],
    attempts: int | None = 10,
    timeout: float | timedelta | None = 45.0,
    wait_initial: float | timedelta = 0.1,
    wait_max: float | timedelta = 5.0,
    wait_jitter: float | timedelta = 1.0,
    wait_exp_base: float = 2.0,
)
def func(...): ...
```
**Parameter Explanation**:
- `on`: Exception type, tuple, or predicate function, determining which exceptions will trigger a retry (required).
- `attempts`: Maximum number of retries, `None` means infinite.
- `timeout`: Maximum total retry duration (in seconds or `timedelta`), `None` means no limit.
- `wait_initial`: Waiting time for the first retry.
- `wait_max`: Maximum waiting time for a single retry.
- `wait_jitter`: Upper limit of jitter to prevent the thundering herd effect.
- `wait_exp_base`: Base for exponential backoff.

**Return Value**: The decorated function, automatically implementing retries.

**Usage Example**:
```python
@stamina.retry(on=ValueError, attempts=3)
def foo(): ...
```

---

##### 2. retry_context

**Function**: Implements retries for arbitrary code blocks in the form of a context manager, suitable for scenarios where only part of the code needs to be retried.

**Function Signature**:
```python
for attempt in stamina.retry_context(on=Exception, attempts=3):
    with attempt:
        risky_operation()
```
**Parameter Explanation**: Same as `retry`.

**Return Value**: An iterable `Attempt` object.

---


##### 3. Attempt

**Function**: Represents the context of each attempt in `retry_context`, providing information such as the attempt number and the next waiting time.

**Common Attributes**:
- `num`: Current attempt number (starting from 1)
- `next_wait`: Waiting time for the next retry (in seconds, may have jitter)

---
##### 4. Internal Class `_LazyNoAsyncRetry`

**Description**: Internal null object pattern used to represent an async iterator that does not retry.

**Methods**:
- `__aiter__`: Returns an async retry iterator configured to not retry

**Implementation**:
```python
class _LazyNoAsyncRetry:
    """
    Allows us to use a non-retrying null object pattern, avoiding the use of None.
    """
    __slots__ = ()

    def __aiter__(self) -> _t.AsyncRetrying:
        return _t.AsyncRetrying(
            reraise=True, stop=_STOP_NO_RETRY, sleep=_smart_sleep
        ).__aiter__()
```
---

##### 5. Retry Hooks

###### `RetryHook` Protocol
**Function Description**: Defines the interface protocol for retry hooks, used to execute custom logic when a retry occurs.

```python
class RetryHook(Protocol):
    def __call__(self, details: RetryDetails) -> None | AbstractContextManager[None]: ...
```

###### `RetryDetails` Class
**Function Description**: Contains detailed information about the retry attempt, passed to the retry hook.

**Attributes**:
- `name` (str): The name of the callable being retried
- `args` (tuple[object, ...]): The positional arguments passed to the callable
- `kwargs` (dict[str, object]): The keyword arguments passed to the callable
- `retry_num` (int): The sequence number of the retry attempt (starting from 1)
- `wait_for` (float): The waiting time before the next retry (in seconds)
- `waited_so_far` (float): The total time waited so far for the current callable (in seconds)
- `caused_by` (Exception): The exception that caused the retry

###### `RetryHookFactory` Class
**Function Description**: Wraps a callable that returns a `RetryHook`, used for lazy initialization.

```python
@dataclass(frozen=True)
class RetryHookFactory:
    hook_factory: Callable[[], RetryHook]
```

##### 6. Hook Management

###### `get_on_retry_hooks()`
**Function Description**: Gets the currently configured retry hooks.

**Returns**:
- `tuple[RetryHook, ...]`: A tuple of the currently configured retry hooks

**Example**:
```python
hooks = get_on_retry_hooks()
```

###### `set_on_retry_hooks(hooks)`
**Function Description**: Sets the retry hooks.

**Parameters**:
- `hooks` (Iterable[RetryHook | RetryHookFactory] | None): The retry hooks to set. Pass `None` to reset to default values, pass an empty iterable to disable hooks.

**Example**:
```python
# Set custom hooks
set_on_retry_hooks([my_custom_hook])

# Reset to default hooks
set_on_retry_hooks(None)

# Disable all hooks
set_on_retry_hooks([])
```

###### `get_default_hooks()`
**Function Description**: Gets the default retry hooks, automatically selecting the appropriate logging implementation based on availability.

**Returns**:
- `tuple[RetryHookFactory, ...]`: A tuple of default hook factories

**Behavior**:
1. If `prometheus_client` is installed, add `PrometheusOnRetryHook`
2. If `structlog` is installed, add `StructlogOnRetryHook`
3. Otherwise, add `LoggingOnRetryHook`

##### 7. Structlog Integration

###### `init_structlog()`
**Function Description**: Initializes structlog integration.

**Returns**:
- `RetryHook`: The configured structlog retry hook

**Log Format**:
```python
{
    'event': 'stamina.retry_scheduled',
    'callable': 'module.function_name',
    'args': ('arg1', 'arg2'),
    'kwargs': {'key': 'value'},
    'retry_num': 1,
    'caused_by': 'Exception("error message")',
    'wait_for': 1.23,
    'waited_so_far': 4.56
}
```

##### 8. Helper Functions

###### `guess_name(obj)`
**Function Description**: Guesses the name of an object, used for logging.

**Parameters**:
- `obj` (object): The object to get the name for

**Returns**:
- `str`: A string in the format `module.qualname`, returns `<unknown module>.<unnamed object>` if it cannot be determined

##### 9. Usage Examples

###### 9.1. Basic Usage
```python
from stamina import retry
from stamina.instrumentation import get_on_retry_hooks, set_on_retry_hooks

# Get current hooks
current_hooks = get_on_retry_hooks()

# Set custom hooks
def my_retry_hook(details):
    print(f"Retrying {details.name}, attempt {details.retry_num}")

set_on_retry_hooks([my_retry_hook])
```

###### 9.2 Using structlog Integration
```python
from stamina.instrumentation import init_structlog, set_on_retry_hooks

# Initialize structlog and set hooks
structlog_hook = init_structlog()
set_on_retry_hooks([structlog_hook])

# Or use the factory directly
from stamina.instrumentation import StructlogOnRetryHook
set_on_retry_hooks([StructlogOnRetryHook])
```

###### 9.3 Creating Custom Hooks
```python
from stamina.instrumentation import RetryHook, set_on_retry_hooks
from contextlib import contextmanager

class MyRetryHook:
    def __call__(self, details):
        print(f"Will retry {details.name} in {details.wait_for:.2f}s")
        
        @contextmanager
        def _context():
            print("Entering retry context")
            try:
                yield
            finally:
                print("Exiting retry context")
                
        return _context()

# Use custom hook
set_on_retry_hooks([MyRetryHook()])
```

##### 10. Version Information

```python
import stamina

# Get the current version number
stamina.__version__
```

##### 11 Global Configuration    

**Function Description**: Controls the global behavior of Stamina.

**Configuration Items**:
- `stamina.CONFIG`: Global configuration object

**Methods**:
- `stamina.is_active()`: Check if retry functionality is activated
- `stamina.set_active(active: bool)`: Activate or deactivate retry functionality
- `stamina.is_testing()`: Check if it is in testing mode
- `stamina.set_testing(testing: bool, *, attempts: int = 1, cap: bool = False)`: Set testing mode

**Examples**:
```python
import stamina

# Deactivate retry functionality
stamina.set_active(False)

# Check retry functionality status
if stamina.is_active():
    print("Retries are enabled")

# Enable testing mode
with stamina.set_testing(True, attempts=3):
    # Within this block, retry logic will use the testing configuration
    pass
```

##### 12 Retry Caller

**Function Description**: Provides a more flexible way to call callable objects and handle retries.

**Classes**:
- `stamina.RetryingCaller`: Base class for synchronous callers
- `stamina.AsyncRetryingCaller`: Base class for asynchronous callers
- `stamina.BoundRetryingCaller`: Synchronous caller bound to specific exception types
- `stamina.BoundAsyncRetryingCaller`: Asynchronous caller bound to specific exception types

**Examples**:
```python
import httpx
import stamina

# Create a caller instance
caller = stamina.RetryingCaller(attempts=3)

# Synchronous call
result = caller(httpx.HTTPError, lambda: httpx.get("https://api.example.com/data").raise_for_status())

# Or bind to a specific exception
http_caller = caller.on(httpx.HTTPError)
result = http_caller(lambda: httpx.get("https://api.example.com/data").raise_for_status())

# Asynchronous caller example
async_caller = stamina.AsyncRetryingCaller(attempts=3)

# Create an asynchronous caller bound to BaseException
arc = stamina.AsyncRetryingCaller().on(BaseException)

# Use the bound asynchronous caller
async def fetch_data_async():
    async with httpx.AsyncClient() as client:
        response = await client.get("https://api.example.com/data")
        response.raise_for_status()
        return response.json()

# Use the bound caller for asynchronous calls
result = await arc(fetch_data_async)
```

##### 13. Core Configuration Classes

###### 13.1 `_Config` Class  
**Function Description**: Global retry configuration class, used to manage global settings for retries.  

**Attributes**:  
- `is_active` (bool): Gets or sets whether the retry functionality is active  
- `testing` (Optional[_Testing]): Gets or sets the testing mode configuration  

**Methods**:  
- `__init__(self, lock: Lock)`: Initializes the configuration with a thread lock  

###### 13.2 `CONFIG` Global Variable  
**Function Description**: Global configuration instance, providing access to and modification of the retry system settings.  

**Type**: `_Config`  

**Attributes**:  
- `is_active` (bool): Gets or sets whether the retry functionality is globally enabled  
- `testing` (Optional[_Testing]): Gets or sets the testing mode configuration  

**Example**:  
```python  
import stamina  

# Deactivate retries  
stamina.CONFIG.is_active = False  

# Check if retries are active  
if stamina.CONFIG.is_active:  
    print("Retry functionality is enabled")  
```  

###### 13.3 `_Testing` Class  
**Function Description**: Testing mode configuration class, used to control retry behavior in testing environments.  

**Attributes**:  
- `attempts` (int): Number of attempts in testing mode  
- `cap` (bool): Whether to cap the maximum number of attempts  

**Methods**:  
- `__init__(self, attempts: int, cap: bool)`: Initializes the testing configuration  
- `get_attempts(self, non_testing_attempts: int | None) -> int`: Gets the actual number of attempts to use  

##### 14. Core Function Functions  

###### 14.1 `_make_stop` Function  
**Function Description**: Combines the number of attempts and timeout duration into a stop condition.  

**Function Signature**:  
```python  
def _make_stop(*, attempts: int | None, timeout: float | None) -> _t.stop_anyof  
```  

**Parameters**:  
- `attempts` (int | None): Maximum number of attempts, None indicates unlimited  
- `timeout` (float | None): Timeout duration (seconds), None indicates no timeout  

**Return Value**:  
- Returns a tenacity stop condition object, which can be used to control the stop condition for retries

---

## Detailed Function Implementation Nodes

### Node 1: Synchronous Retry Decorator

**Function Description**: Implement an intelligent retry mechanism for synchronous functions, supporting control by exception types and predicate functions, and providing an exponential backoff and jitter algorithm.

**Core Features**:
- Exception type retry: Support for a single exception type or a tuple of exceptions
- Predicate function retry: Support for custom retry condition judgment
- Parameter passing: Maintain the integrity of function parameters and return values
- Type hint preservation: The decorator does not破坏 the original type hints

**Input and Output Examples**:

```python
import stamina
import httpx

# Basic exception retry
@stamina.retry(on=httpx.HTTPError, attempts=3)
def fetch_data(url: str) -> httpx.Response:
    resp = httpx.get(url)
    resp.raise_for_status()
    return resp

# Predicate function retry
def should_retry(exc: Exception) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return isinstance(exc, httpx.HTTPError)

@stamina.retry(on=should_retry, attempts=5)
def api_call(endpoint: str) -> dict:
    resp = httpx.get(endpoint)
    resp.raise_for_status()
    return resp.json()

# Time parameter configuration
@stamina.retry(
    on=ValueError,
    attempts=10,
    timeout=45.0,
    wait_initial=0.1,
    wait_max=5.0,
    wait_jitter=1.0,
    wait_exp_base=2.0
)
def process_data(data: list) -> dict:
    # Processing logic
    return {"result": "success"}

# Test case verification
def test_retry_success():
    @stamina.retry(on=ValueError, attempts=2)
    def f():
        return 42
    
    assert f() == 42

def test_retry_with_exception():
    i = 0
    @stamina.retry(on=ValueError, attempts=2)
    def f():
        nonlocal i
        if i < 1:
            i += 1
            raise ValueError
        return 42
    
    assert f() == 42
    assert i == 1
```

### Node 2: Asynchronous Retry Decorator

**Function Description**: Implement an intelligent retry mechanism for asynchronous functions, supporting the asyncio and Trio asynchronous libraries, and providing the same API interface as the synchronous version.

**Core Features**:
- Automatic detection of asynchronous functions: Automatically recognize async functions and apply asynchronous retries
- Support for multiple asynchronous libraries: Compatible with asyncio and Trio
- Asynchronous sleep mechanism: Use an appropriate asynchronous waiting function
- Method retry support: Support asynchronous retries for class methods

**Input and Output Examples**:

```python
import stamina
import httpx

# Basic asynchronous retry
@stamina.retry(on=httpx.HTTPError, attempts=3)
async def fetch_data_async(url: str) -> httpx.Response:
    async with httpx.AsyncClient() as client:
        resp = await client.get(url)
    resp.raise_for_status()
    return resp

# Asynchronous retry for class methods
class DataProcessor:
    @stamina.retry(on=ValueError, attempts=2)
    async def process_async(self, data: list) -> dict:
        # Asynchronous processing logic
        return {"processed": data}

# Use timedelta for time parameters
import datetime as dt

@stamina.retry(
    on=httpx.HTTPError,
    timeout=dt.timedelta(seconds=30),
    wait_initial=dt.timedelta(milliseconds=100),
    wait_max=dt.timedelta(seconds=5)
)
async def api_call_async(endpoint: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint)
    resp.raise_for_status()
    return resp.json()

# Test case verification
async def test_async_retry_success():
    @stamina.retry(on=ValueError, attempts=2)
    async def f():
        return 42
    
    assert await f() == 42

async def test_async_retry_with_exception():
    i = 0
    @stamina.retry(on=ValueError, attempts=2)
    async def f():
        nonlocal i
        if i < 1:
            i += 1
            raise ValueError
        return 42
    
    assert await f() == 42
    assert i == 1
```

### Node 3: Context Manager Retry

**Function Description**: Provide an iterable context manager, allowing arbitrary code blocks to be retried, supporting both synchronous and asynchronous modes.

**Core Features**:
- Code block retry: Support for retrying arbitrary code blocks rather than the entire function
- `Attempt` object: Provide information on the current retry count and the next waiting time
- Synchronous and asynchronous support: Support for `for` loops and `async for` loops
- Context management: Automatically handle retry status and exceptions

**Input and Output Examples**:

```python
import stamina
import httpx

# Synchronous context manager retry
def sync_context_retry():
    for attempt in stamina.retry_context(on=httpx.HTTPError, attempts=3):
        with attempt:
            resp = httpx.get("https://api.example.com")
            resp.raise_for_status()
            return resp.json()

# Asynchronous context manager retry
async def async_context_retry():
    async for attempt in stamina.retry_context(on=httpx.HTTPError, attempts=3):
        with attempt:
            async with httpx.AsyncClient() as client:
                resp = await client.get("https://api.example.com")
            resp.raise_for_status()
            return resp.json()

# Access properties of the Attempt object
def attempt_properties():
    for attempt in stamina.retry_context(on=ValueError, wait_max=0.1):
        with attempt:
            print(f"Current retry count: {attempt.num}")
            print(f"Next waiting time: {attempt.next_wait}")
            print(f"Attempt object: {repr(attempt)}")
            
            if attempt.num < 2:
                raise ValueError

# Test case verification
def test_context_retry():
    i = 0
    for attempt in stamina.retry_context(on=ValueError, wait_max=0):
        with attempt:
            i += 1
            assert i == attempt.num
            assert 0.0 == attempt.next_wait
            if i < 2:
                raise ValueError
    assert i == 2

async def test_async_context_retry():
    num_called = 0
    async for attempt in stamina.retry_context(on=ValueError, wait_max=0):
        with attempt:
            num_called += 1
            assert num_called == attempt.num
            if num_called < 2:
                raise ValueError
    assert num_called == 2
```

### Node 4: Function Caller

**Function Description**: Provide a retry mechanism for direct function calls, supporting both synchronous and asynchronous functions, and providing the function of pre-binding exception types.

**Core Features**:
- `RetryingCaller`: Synchronous function caller
- `AsyncRetryingCaller`: Asynchronous function caller
- Pre-binding of exception types: Pre-bind exception types through the `on()` method
- Parameter passing: Completely pass function parameters and keyword parameters

**Input and Output Examples**:

```python
import stamina
import httpx

# Synchronous function caller
def sync_function_caller():
    rc = stamina.RetryingCaller(attempts=5, timeout=30.0)
    
    def fetch_data(url: str, **kwargs) -> dict:
        resp = httpx.get(url, **kwargs)
        resp.raise_for_status()
        return resp.json()
    
    # Direct call
    result = rc(httpx.HTTPError, fetch_data, "https://api.example.com", headers={"Authorization": "Bearer token"})
    
    # Pre-bind exception types
    bound_rc = rc.on(httpx.HTTPError)
    result = bound_rc(fetch_data, "https://api.example.com", headers={"Authorization": "Bearer token"})
    
    return result

# Asynchronous function caller
async def async_function_caller():
    async_rc = stamina.AsyncRetryingCaller(attempts=5, timeout=30.0)
    
    async def fetch_data_async(url: str, **kwargs) -> dict:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, **kwargs)
        resp.raise_for_status()
        return resp.json()
    
    # Direct call
    result = await async_rc(httpx.HTTPError, fetch_data_async, "https://api.example.com", headers={"Authorization": "Bearer token"})
    
    # Pre-bind exception types
    bound_async_rc = async_rc.on(httpx.HTTPError)
    result = await bound_async_rc(fetch_data_async, "https://api.example.com", headers={"Authorization": "Bearer token"})
    
    return result

# Test case verification
def test_retrying_caller():
    rc = stamina.RetryingCaller().on(BaseException)
    
    def f():
        return 42
    
    assert rc(f) == 42

def test_retrying_caller_with_args():
    i = 0
    def f(*args, **kw):
        nonlocal i
        if i < 1:
            i += 1
            raise ValueError
        return args, kw
    
    bound_rc = stamina.RetryingCaller(wait_max=0).on(ValueError)
    args, kw = bound_rc(f, 42, foo="bar")
    
    assert i == 1
    assert (42,) == args
    assert {"foo": "bar"} == kw

async def test_async_retrying_caller():
    arc = stamina.AsyncRetryingCaller().on(BaseException)
    
    async def f():
        return 42
    
    assert await arc(f) == 42
```

### Node 5: Configuration Management System

**Function Description**: Provide global configuration management functions, including activating/deactivating retries, setting test mode, and supporting context managers.

**Core Features**:
- Global activation control: `set_active()` and `is_active()` functions
- Test mode: `set_testing()` and `is_testing()` functions
- Context manager: Support configuration management using the `with` statement
- Nested support: Support nested configuration context managers

**Input and Output Examples**:

```python
import stamina

# Activate/deactivate retries
def activation_control():
    # Check the current status
    assert stamina.is_active() == True
    
    # Deactivate retries
    stamina.set_active(False)
    assert stamina.is_active() == False
    
    # Reactivate
    stamina.set_active(True)
    assert stamina.is_active() == True

# Set test mode
def testing_mode():
    # Set test mode
    stamina.set_testing(True, attempts=3)
    assert stamina.is_testing() == True
    
    # Reset test mode
    stamina.set_testing(False)
    assert stamina.is_testing() == False

# Context manager
def context_manager():
    assert not stamina.is_testing()
    
    with stamina.set_testing(True, attempts=3):
        assert stamina.is_testing()
        assert stamina.CONFIG.testing.get_attempts(None) == 3
        assert not stamina.CONFIG.testing.cap
    
    assert not stamina.is_testing()

# Nested context managers
def nested_context_manager():
    assert not stamina.is_testing()
    
    with stamina.set_testing(True, attempts=3):
        assert stamina.is_testing()
        assert stamina.CONFIG.testing.attempts == 3
        
        with stamina.set_testing(True, attempts=5, cap=True):
            assert stamina.is_testing()
            assert stamina.CONFIG.testing.attempts == 5
            assert stamina.CONFIG.testing.cap
        
        assert stamina.is_testing()
        assert stamina.CONFIG.testing.attempts == 3
        assert not stamina.CONFIG.testing.cap
    
    assert not stamina.is_testing()

# Test case verification
def test_activate_deactivate():
    assert stamina.is_active()
    
    stamina.set_active(False)
    assert not stamina.is_active()
    
    stamina.set_active(True)
    assert stamina.is_active()

def test_context_manager_exception():
    assert not stamina.is_testing()
    
    try:
        with stamina.set_testing(True, attempts=3):
            assert stamina.is_testing()
            raise ValueError("test")
    except ValueError:
        pass
    
    assert not stamina.is_testing()
```

### Node 6: Observability System

**Function Description**: Provide complete monitoring and observability functions, including structured logging, Prometheus metrics, custom hooks, etc.

**Core Features**:
- `RetryDetails` data class: Contains information on retry details
- Custom hooks: Support custom retry monitoring functions
- Structured logging: Integrate structlog and standard logging
- Prometheus metrics: Provide a retry counter
- Context manager hooks: Support hook functions for context managers

**Input and Output Examples**:

```python
from stamina.instrumentation import (
    RetryDetails, 
    RetryHook, 
    RetryHookFactory,
    get_on_retry_hooks,
    set_on_retry_hooks,
    get_prometheus_counter
)

# Custom monitoring hook
def custom_retry_hook(details: RetryDetails) -> None:
    print(f"Retry {details.name} for the {details.retry_num}th time")
    print(f"Wait for {details.wait_for} seconds")
    print(f"Already waited for {details.waited_so_far} seconds")
    print(f"Exception: {details.caused_by}")

# Set custom hooks
set_on_retry_hooks([custom_retry_hook])

# Context manager hook
from contextlib import contextmanager

@contextmanager
def context_manager_hook(details: RetryDetails):
    print(f"Start retrying {details.name}")
    yield
    print(f"End retrying {details.name}")

set_on_retry_hooks([context_manager_hook])

# Lazy initialization of hooks
def init_expensive_hook():
    import expensive_module
    
    def expensive_hook(details: RetryDetails) -> None:
        expensive_module.log_retry(details)
    
    return expensive_hook

set_on_retry_hooks([RetryHookFactory(init_expensive_hook)])

# Prometheus metrics
def prometheus_integration():
    counter = get_prometheus_counter()
    if counter:
        print(f"Prometheus counter: {counter}")
    
    # Use the built-in Prometheus hook
    from stamina.instrumentation import PrometheusOnRetryHook
    set_on_retry_hooks([PrometheusOnRetryHook])

# Structured logging
def structlog_integration():
    from stamina.instrumentation import StructlogOnRetryHook
    set_on_retry_hooks([StructlogOnRetryHook])

# Standard logging
def logging_integration():
    from stamina.instrumentation import LoggingOnRetryHook
    set_on_retry_hooks([LoggingOnRetryHook])

# Test case verification
def test_guess_name():
    def function():
        pass
    
    class Foo:
        def method(self):
            pass
    
    foo = Foo()
    
    assert "test_function" in guess_name(function)
    assert "Foo.method" in guess_name(foo.method)

def test_retry_details():
    details = RetryDetails(
        name="test_function",
        args=(1, 2),
        kwargs={"key": "value"},
        retry_num=1,
        wait_for=0.5,
        waited_so_far=1.0,
        caused_by=ValueError("test")
    )
    
    assert details.name == "test_function"
    assert details.retry_num == 1
    assert details.wait_for == 0.5
    assert isinstance(details.caused_by, ValueError)

def test_hook_management():
    def hook(details):
        pass
    
    # Set hooks
    set_on_retry_hooks([hook])
    assert hook in get_on_retry_hooks()
    
    # Clear hooks
    set_on_retry_hooks([])
    assert len(get_on_retry_hooks()) == 0
    
    # Restore default hooks
    set_on_retry_hooks(None)
    assert len(get_on_retry_hooks()) > 0
```

### Node 7: Exponential Backoff Algorithm

**Function Description**: Implement an intelligent exponential backoff algorithm, including a jitter mechanism to avoid the thundering herd effect, and provide configurable backoff parameters.

**Core Features**:
- Exponential growth: Start from the initial delay and increase exponentially
- Jitter mechanism: Add random jitter to avoid synchronous retries
- Maximum delay limit: Prevent the backoff time from being too long
- Configurable parameters: Support custom backoff parameters

**Input and Output Examples**:

```python
import stamina
from stamina._core import _compute_backoff

# Implementation of the backoff formula
def backoff_formula():
    """
    Backoff formula: min(wait_max, wait_initial * wait_exp_base^(attempt - 1) + random(0, wait_jitter))
    """
    # Default parameters
    wait_initial = 0.1  # Initial waiting time
    wait_max = 5.0      # Maximum waiting time
    wait_exp_base = 2.0 # Exponential base
    wait_jitter = 1.0   # Jitter time
    
    # Calculate the backoff time for different retry counts
    for attempt in range(1, 6):
        backoff = _compute_backoff(
            num=attempt,
            max_backoff=wait_max,
            initial=wait_initial,
            exp_base=wait_exp_base,
            max_jitter=wait_jitter
        )
        print(f"Backoff time for the {attempt}th retry: {backoff:.3f} seconds")

# Test backoff calculation
def test_backoff_computation():
    rci = stamina.retry_context(on=ValueError, wait_max=0.42)
    
    for i in range(1, 10):
        backoff = rci._backoff_for_attempt_number(i)
        assert backoff <= 0.42
        
        jittered = rci._jittered_backoff_for_rcs(
            SimpleNamespace(attempt_number=i)
        )
        assert jittered <= 0.42

# Practical application example
def practical_backoff_example():
    @stamina.retry(
        on=httpx.HTTPError,
        attempts=5,
        wait_initial=0.1,
        wait_max=5.0,
        wait_jitter=1.0,
        wait_exp_base=2.0
    )
    def api_call():
        # Simulate an API call
        resp = httpx.get("https://api.example.com")
        resp.raise_for_status()
        return resp.json()
    
    try:
        result = api_call()
        return result
    except httpx.HTTPError as e:
        print(f"API call failed: {e}")

# Test case verification
def test_backoff_clamps():
    """Test that the backoff time does not exceed the maximum limit"""
    rci = stamina.retry_context(on=ValueError, wait_max=0.42)
    
    for i in range(1, 10):
        backoff = rci._backoff_for_attempt_number(i)
        assert backoff <= 0.42
        
        jittered = rci._jittered_backoff_for_rcs(
            SimpleNamespace(attempt_number=i)
        )
        assert jittered <= 0.42

def test_next_wait_property():
    """Test the update of the next_wait property"""
    for attempt in stamina.retry_context(on=ValueError, wait_max=0.0001):
        with attempt:
            assert attempt.next_wait == pytest.approx(0.0001)
            if attempt.num == 1:
                raise ValueError
```

### Node 8: Stop Condition Management

**Function Description**: Manage the stop conditions for retries, including the maximum number of retries, total timeout, and their combined logic.

**Core Features**:
- Maximum number of retries: Limit the number of retries
- Total timeout: Limit the total retry time
- Combined conditions: Support using multiple stop conditions simultaneously
- Infinite retries: Support unlimited retries (use with caution)

**Input and Output Examples**:

```python
import stamina
from stamina._core import _make_stop
import tenacity

# Stop condition configuration
def stop_condition_examples():
    # Only limit the number of retries
    @stamina.retry(on=ValueError, attempts=3)
    def limited_attempts():
        pass
    
    # Only limit the timeout
    @stamina.retry(on=ValueError, timeout=30.0)
    def limited_timeout():
        pass
    
    # Combined conditions
    @stamina.retry(on=ValueError, attempts=5, timeout=60.0)
    def combined_conditions():
        pass
    
    # Infinite retries (use with caution)
    @stamina.retry(on=ValueError, attempts=None, timeout=None)
    def infinite_retry():
        pass

# Test stop conditions
def test_stop_conditions():
    # Test the condition with no limits
    assert tenacity.stop_never is _make_stop(attempts=None, timeout=None)
    
    # Test the condition with limits
    stop_condition = _make_stop(attempts=3, timeout=30.0)
    assert stop_condition is not None

# Practical application examples
def practical_stop_examples():
    # Quick failure scenario
    @stamina.retry(on=httpx.HTTPError, attempts=2, timeout=5.0)
    def quick_fail_api():
        resp = httpx.get("https://api.example.com")
        resp.raise_for_status()
        return resp.json()
    
    # Persistent retry scenario
    @stamina.retry(on=httpx.HTTPError, attempts=10, timeout=300.0)
    def persistent_api():
        resp = httpx.get("https://api.example.com")
        resp.raise_for_status()
        return resp.json()
    
    # Time-priority scenario
    @stamina.retry(on=httpx.HTTPError, timeout=60.0)
    def time_limited_api():
        resp = httpx.get("https://api.example.com")
        resp.raise_for_status()
        return resp.json()

# Test case verification
def test_never_stop():
    """Test the stop condition with no limits"""
    assert tenacity.stop_never is _make_stop(attempts=None, timeout=None)

def test_attempts_only():
    """Test the limit of only the number of retries"""
    stop = _make_stop(attempts=3, timeout=None)
    assert stop is not None

def test_timeout_only():
    """Test the limit of only the timeout"""
    stop = _make_stop(attempts=None, timeout=30.0)
    assert stop is not None

def test_combined_stop():
    """Test the combined stop condition"""
    stop = _make_stop(attempts=5, timeout=60.0)
    assert stop is not None
```

### Node 9: Version Management

**Function Description**: Provide version information management for the project, ensure that the version number is consistent with the package metadata, and support dynamic version retrieval.

**Core Features**:
- Dynamic version retrieval: Retrieve version information from the package metadata
- Version consistency: Ensure that `__version__` is consistent with the package metadata
- Warning-free retrieval: Avoid warning messages when retrieving the version

**Input and Output Examples**:

```python
import stamina
from importlib import metadata

# Version information retrieval
def version_management():
    # Get the current version
    current_version = stamina.__version__
    print(f"Current version: {current_version}")
    
    # Get the version from the metadata
    metadata_version = metadata.version("stamina")
    print(f"Metadata version: {metadata_version}")
    
    # Verify version consistency
    assert current_version == metadata_version
    
    return current_version

# Version test
def test_version_consistency():
    """Test version consistency"""
    assert metadata.version("stamina") == stamina.__version__
    
    # Ensure there are no warnings
    import warnings
    with warnings.catch_warnings(record=True) as w:
        version = stamina.__version__
        assert len(w) == 0

# Practical application examples
def version_usage_examples():
    # Record the version in the log
    import logging
    logging.info(f"Stamina version: {stamina.__version__}")
    
    # Include the version in the API response
    def api_info():
        return {
            "service": "stamina",
            "version": stamina.__version__,
            "features": ["retry", "async", "instrumentation"]
        }
    
    # Version check
    def check_version():
        version = stamina.__version__
        major, minor, patch = map(int, version.split('.'))
        
        if major < 1:
            print("Warning: Using a pre-release version")
        elif minor < 5:
            print("It is recommended to upgrade to the latest version")
        else:
            print("Version check passed")
    
    return api_info(), check_version()

# Test case verification
def test_version_format():
    """Test the version format"""
    version = stamina.__version__
    
    # The version should be a string
    assert isinstance(version, str)
    
    # The version should contain numbers separated by dots
    parts = version.split('.')
    assert len(parts) >= 2
    
    # The major version number should be a number
    assert parts[0].isdigit()

def test_version_no_warnings():
    """Test that there are no warnings when retrieving the version"""
    import warnings
    
    with warnings.catch_warnings(record=True) as w:
        version = stamina.__version__
        assert len(w) == 0
```