## Introduction to the Cachier Project

Cachier is a persistent caching library designed specifically for Python functions. It adds intelligent caching capabilities to functions through a simple decorator syntax, significantly enhancing application performance. The core value of this library lies in providing cross-session and cross-machine caching functionality, ensuring that cached data remains valid even after the Python process is restarted. Cachier is implemented in pure Python, requiring no external dependencies. It supports Python 3.9+ and is cross-platform compatible, running stably on Linux, macOS, and Windows systems.

In terms of functional features, Cachier provides a persistent caching mechanism, supporting local cache storage based on pickle files. It also integrates high-performance Redis caching and MongoDB distributed caching support to meet caching needs in different scenarios. The library has a built-in intelligent expiration mechanism that allows developers to set the "shelf life" of cached data. The system automatically handles expired data to ensure the timeliness of cached content. Additionally, Cachier is thread-safe, supporting secure use in a multi-threaded environment. You can enable full caching functionality for a function with just a simple decorator, greatly simplifying the complexity of cache implementation.

## Natural Language Instruction (Prompt)

Please create a Python project named Cachier to implement a persistent, non-expiring function caching library. The project should include the following features:

1. **Decorator Caching System**: Implement the `@cachier` decorator to support function-level persistent caching, including parameter hash generation, cache key management, result storage, and retrieval. The decorator should support various configuration parameters, such as `stale_after` (expiration time), `backend` (cache backend), `hash_func` (custom hash function), etc.

2. **Multi-Backend Architecture**: Implement support for five cache backends, including in-memory cache (memory), pickle file cache (pickle), Redis cache (redis), MongoDB cache (mongo), and SQL database cache (sql). Each backend should implement a unified interface but provide different storage characteristics, supporting cross-machine caching and distributed deployment.

3. **Intelligent Expiration Management**: Implement the `stale_after` expiration mechanism to support setting the "shelf life" of cached data; implement the `next_time` asynchronous update mode to recalculate on the next call; implement the function of automatically cleaning up expired entries, supporting regular cleaning by a background thread.

4. **Concurrency Safety Mechanism**: Implement thread-safe cache operations, including status marking during calculation, waiting mechanism, timeout control, and lock management. Support concurrent access in a multi-threaded environment to prevent duplicate calculations and race conditions.

5. **Configuration Management System**: Support global configuration and function-level configuration, providing default parameter settings, global enable/disable cache function, and the ability to override parameters at runtime. Implement dynamic configuration updates and parameter validation.

6. **Error Handling and Recovery**: Implement a comprehensive exception handling mechanism, including recovery from corrupted cache files, handling of database connection failures, and calculation timeout control. Provide graceful error recovery and degradation strategies.

7. **Performance Optimization Features**: Support cache entry size limits, performance monitoring, and performance comparison of different cache strategies. Provide performance evaluation scripts and optimization suggestions.

8. **Command-Line Tool**: Provide a `cachier` command-line tool to support system-level configuration such as setting the maximum number of worker threads and cache management operations.

9. **Core File Requirements**: The project must include a complete `pyproject.toml` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `pytest==8.4.1`, `mypy_extensions ==1.1.0` etc). `pyproject.toml` can verify whether all functional modules work properly. At the same time, it should provide `src\cachier\__init__.py` as a unified API entry, allowing users to access all main functions through a simple `from cachier  import *` statement.Import `_BaseCore`, `RecalculationNeeded` from the `cachier.cores.base` module; import `get_default_params`, `set_default_params`, `CacheEntry`, `_global_params` from the `cachier.config` module; import `get_global_params`, `cachier` from the `cachier` module; import `DEFAULT_MAX_WORKERS`, `MAX_WORKERS_ENVAR_NAME`, `_get_executor`, `_max_workers`, `_set_max_workers` from the `cachier.core` module; import `cli`, `set_max_workers` from the `cachier.__main__` module; import `_MemoryCore` from the `cachier.cores.memory` module; import `MissingMongetter`, `_MongoCore` from the `cachier.cores.mongo` module; import `_PickleCore` from the `cachier.cores.pickle` module; import `MissingRedisClient`, `_RedisCore` from the `cachier.cores.redis` module; import `_SQLCore` from the `cachier.cores.sql` module, and import the `cachier.cores.sql` module as `sql_mod`,import `parse_bytes` from the `cachier.util` module; also import the `cachier` module itself. The version information is provided through the `_version.py` file within the `cachier` module, and the project's `pyproject.toml` configures the version retrieval via `[tool.setuptools.dynamic]` with `version = { attr = "cachier._version.__version__" }`.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.13

### Core Dependency Library Versions

```python
birch             0.0.35
black             25.1.0
cfgv              3.4.0
click             8.2.1
distlib           0.4.0
dnspython         2.7.0
filelock          3.19.1
greenlet          3.2.4
identify          2.6.13
iniconfig         2.1.0
mypy_extensions   1.1.0
nodeenv           1.9.1
numpy             2.3.2
packaging         25.0
pandas            2.3.1
pathspec          0.12.1
pip               25.2
platformdirs      4.3.8
pluggy            1.6.0
portalocker       3.2.0
pre_commit        4.3.0
psycopg2-binary   2.9.10
Pygments          2.19.2
pymongo           3.13.0
pymongo_inmemory  0.5.0
Pympler           1.1
python-dateutil   2.9.0.post0
pytz              2025.2
PyYAML            6.0.2
redis             6.4.0
ruff              0.12.9
setuptools        65.5.1
six               1.17.0
SQLAlchemy        2.0.43
strct             0.0.35
typing_extensions 4.14.1
tzdata            2025.2
virtualenv        20.34.0
watchdog          6.0.0
wheel             0.45.1
bson              0.5.10
```

## Project Framework Suggestion

```
workspace/
├── .codecov.yml
├── .fdignore
├── .gitattributes
├── .gitignore
├── .pre-commit-config.yaml
├── AGENTS.md
├── CLAUDE.md
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.rst
├── examples
│   ├── redis_example.py
├── pyproject.toml
├── src
│   ├── cachier
│   │   ├── __init__.py
│   │   ├── __main__.py
│   │   ├── _types.py
│   │   ├── _version.py
│   │   ├── config.py
│   │   ├── core.py
│   │   ├── cores
│   │   │   ├── __init__.py
│   │   │   ├── base.py
│   │   │   ├── memory.py
│   │   │   ├── mongo.py
│   │   │   ├── pickle.py
│   │   │   ├── redis.py
│   │   │   ├── sql.py
│   │   ├── py.typed
│   │   ├── util.py
│   │   └── version.info
└── uv.lock

```


## API Usage Guide

### 1. Import the core module
```python
from cachier.cores.base import _BaseCore,RecalculationNeeded
import cachier
from cachier.config import get_default_params, set_default_params
from cachier import  get_global_params
from cachier.core import (
    DEFAULT_MAX_WORKERS,
    MAX_WORKERS_ENVAR_NAME,
    _get_executor,
    _max_workers,
    _set_max_workers,
)
from cachier.__main__ import cli, set_max_workers
from cachier import cachier
from cachier.cores.memory import _MemoryCore
from cachier.cores.mongo import MissingMongetter
from cachier.cores.mongo import _MongoCore
from cachier.config import CacheEntry, _global_params
from cachier.cores.pickle import _PickleCore
from cachier.cores.redis import MissingRedisClient, _RedisCore
from cachier.cores.sql import _SQLCore
import cachier.cores.sql as sql_mod
from cachier.util import parse_bytes

from cachier.config import _default_cache_dir
from cachier._version import _get_git_sha
from cachier.cores.base import _get_func_str
from cachier.core import ZERO_TIMEDELTA
from cachier._version import (
    _PATH_HERE,
    _PATH_VERSION,
    _RELEASING_PROCESS
)
from cachier.cores.mongo import MONGO_SLEEP_DURATION_IN_SEC
from cachier.cores.redis import REDIS_SLEEP_DURATION_IN_SEC

from cachier.examples.redis_example import (
    setup_redis_client,
    expensive_calculation,
    demo_basic_caching,
    cached_calculation,
    demo_stale_after,
    time_sensitive_calculation,
    demo_callable_client,
    get_redis_client,
    cached_with_callable,
    demo_cache_management,
    managed_calculation
)
```

### 2. Core Decorator `cachier`

**Function Description**:  
`cachier` is a persistent, non-expiring Python function result caching decorator. It can automatically cache the return results of functions and directly return the cached results in subsequent calls, improving function execution efficiency. Supports multiple backend storage methods, including memory, files, MongoDB, Redis, and SQL databases.

#### Function Signature
```python
def cachier(
    hash_func: Optional[HashFunc] = None,
    hash_params: Optional[HashFunc] = None,
    backend: Optional[Backend] = None,
    mongetter: Optional[Mongetter] = None,
    sql_engine: Optional[Union[str, Any, Callable[[], Any]]] = None,
    redis_client: Optional["RedisClient"] = None,
    stale_after: Optional[timedelta] = None,
    next_time: Optional[bool] = None,
    cache_dir: Optional[Union[str, os.PathLike]] = None,
    pickle_reload: Optional[bool] = None,
    separate_files: Optional[bool] = None,
    wait_for_calc_timeout: Optional[int] = None,
    allow_none: Optional[bool] = None,
    cleanup_stale: Optional[bool] = None,
    cleanup_interval: Optional[timedelta] = None,
    entry_size_limit: Optional[Union[int, str]] = None,
)
```

#### Parameter Description

#### Cache Key Related
- `hash_func` (callable, optional): A callable object used to generate hash keys from the parameters of the decorated function. Particularly useful when the function's parameters contain non-hashable Python objects.
- `hash_params` (callable, optional, deprecated): Please use `hash_func` instead.

#### Backend Configuration
- `backend` (str, optional): Specifies the backend to use. Valid options include:
  - `'pickle'`: Default value, uses local file system storage for caching
  - `'mongo'`: Uses MongoDB storage
  - `'memory'`: Uses in-memory storage
  - `'sql'`: Uses SQL database storage
  - `'redis'`: Uses Redis storage

#### Backend-Specific Parameters
- `mongetter` (callable, optional): A callable object that takes no parameters and returns a `pymongo.Collection` object with write permissions. If not set, local pickle caching is used.
- `sql_engine` (str, Engine, or callable, optional): SQLAlchemy connection string, Engine object, or callable that returns an Engine. Used for SQL backend.
- `redis_client` (redis.Redis or callable, optional): Redis client instance or callable that returns a Redis client. Used for Redis backend.

#### Cache Behavior Control
- `stale_after` (datetime.timedelta, optional): How long after which a cached result is considered stale. After becoming stale, subsequent calls will trigger recalculation, but whether the new result or the old result is returned depends on the `next_time` parameter.
- `next_time` (bool, optional): If True, when a stale result is found, the stale result is returned immediately instead of waiting for the new result to finish calculating. Defaults to False.
- `cache_dir` (str or os.PathLike, optional): The directory path for cache files. If not provided, defaults to `~/.cachier/`.
- `pickle_reload` (bool, optional): If True, the in-memory cache is reloaded every time the cache is read, allowing multiple threads to share the cache. Single-threaded programs can set this to False to improve read speed. Defaults to True.
- `separate_files` (bool, optional, Pickle core only): If True, the cache for each function is split into multiple files, one file per parameter set. Useful when a single function's cache file becomes too large.
- `wait_for_calc_timeout` (int, optional, MongoDB only): The maximum time (in seconds) to wait for an ongoing calculation to complete. When a process starts a calculation and sets being_calculated to True, any process attempting to read the same entry will wait for up to the number of seconds specified by this parameter. 0 means wait forever. If timed out, calculation will be triggered.
- `allow_none` (bool, optional): Whether to allow storing None values in the cache. If False, functions returning None will not be cached and will be recalculated on every call.
- `cleanup_stale` (bool, optional): If True, stale cache entries are periodically deleted in a background thread. Defaults to False.
- `cleanup_interval` (datetime.timedelta, optional): The minimum time interval between automatic cleanups. Defaults to one day.
- `entry_size_limit` (int or str, optional): The maximum serialized size of a cached value. Values exceeding the limit will be returned but not cached. Supports human-readable strings like "10MB".

#### Return Value
Returns a decorator function that caches the result of the decorated function.

#### Example Usage

##### Basic Usage
```python
from datetime import timedelta
from cachier import cachier

@cachier(stale_after=timedelta(days=1))
def get_expensive_data(param1, param2):
    # Time-consuming calculation or data fetching operation
    return result
```


#### Additional Parameters of the Decorated Function
Functions decorated by `cachier` support the following additional parameters:

##### `max_age` Parameter
- Type: `datetime.timedelta`
- Description: Specifies the maximum allowed age of the cached result. If the cached result is older than `max_age`, recalculation will be triggered.
- Example:
  ```python
  # Return cached results no older than 1 hour, otherwise recalculate
  result = get_expensive_data(param1, param2, max_age=timedelta(hours=1))
  ```

##### `ignore_cache` Parameter
- Type: Boolean
- Description: If True, ignores the cache, directly calls the original function, and returns the result.
- Example:
  ```python
  # Ignore cache, force recalculation
  result = get_expensive_data(param1, param2, ignore_cache=True)
  ```

##### `overwrite_cache` Parameter
- Type: Boolean
- Description: If True, ignores the existing cache, calls the original function, and updates the cache with the new result.
- Example:
  ```python
  # Force update cache
  result = get_expensive_data(param1, param2, overwrite_cache=True)
  ```

##### `verbose_cache` Parameter
- Type: Boolean
- Description: If True, prints detailed information about cache operations for debugging.
- Example:
  ```python
  # Print cache operation details
  result = get_expensive_data(param1, param2, verbose_cache=True)
  ```

#### 2. Internal Functions of the Decorator `cachier`

##### 2.1 Cache Core Functions

###### `_function_thread(core, key, func, args, kwds)`
- **Function**: Executes the function in a background thread and caches the result
- **Parameters**:
  - `core`: Cache core object, responsible for actual cache operations
  - `key`: Cache key, used to identify the cache item
  - `func`: Function to execute
  - `args`: Positional arguments of the function
  - `kwds`: Keyword arguments of the function

- **Behavior**:
  1. Executes the target function in a separate thread
  2. Stores the function result in the cache
  3. If an exception occurs during execution, prints the exception information but does not throw it
- **Usage Scenario**: Used to update expired caches in the background when `next_time=True`
- **Parameters**:
  - `core`: Cache core object
  - `key`: Cache key
  - `func`: Function to execute
  - `args`: Positional arguments
  - `kwds`: Keyword arguments
- **Return Value**: None

###### `_calc_entry(core, key, func, args, kwds, printer=lambda *_: None)`
- **Function**: Calculates the function result and updates the cache
- **Parameters**:
  - `core`: Cache core object
  - `key`: Cache key
  - `func`: Function to execute
  - `args`: Positional arguments
  - `kwds`: Keyword arguments
  - `printer`: Print function, defaults to an empty function
- **Return Value**: Function execution result

##### 2.2 Helper Functions

###### `_max_workers()`
- **Function**: Gets the maximum number of worker threads
- **Return Value**: Integer representing the maximum number of worker threads

###### `_set_max_workers(max_workers)`
- **Function**: Sets the maximum number of worker threads
- **Parameters**:
  - `max_workers`: Maximum number of worker threads

###### `_get_executor(reset=False)`
- **Function**: Gets the thread pool executor
- **Parameters**:
  - `reset`: Whether to reset the executor
- **Return Value**: Thread pool executor instance

###### `_convert_args_kwargs(func, _is_method, args, kwds)`
- **Function**: Converts positional and keyword arguments into a unified keyword argument dictionary
- **Parameters**:
  - `func`: Target function
  - `_is_method`: Whether it is a class method
  - `args`: Positional arguments
  - `kwds`: Keyword arguments
- **Return Value**: Sorted parameter dictionary

###### `_pop_kwds_with_deprecation(kwds, name, default_value)`
- **Function**: Handles deprecated keyword arguments
- **Parameters**:
  - `kwds`: Keyword argument dictionary
  - `name`: Parameter name
  - `default_value`: Default value
- **Return Value**: Parameter value

##### 2.3 Internal Functions and Methods of the Decorator

###### `_cachier_decorator(func)`
- **Function**: The main decorator function used to wrap the target function and add caching functionality
- **Parameters**:
  - `func`: Target function to be decorated
- **Return Value**: Wrapped function with caching functionality

###### `def _call(*args, max_age: Optional[timedelta] = None, **kwds):`
- **Function**: Internal function that handles function calls and implements caching logic
- **Parameters**:
  - `*args`: Positional arguments passed to the decorated function
  - `max_age`: Optional timedelta object specifying the maximum allowed age of the cached result. This overrides the decorator-level `stale_after` setting.
  - `**kwds`: Keyword arguments passed to the decorated function
- **Special Parameters** (passed via `**kwds`):
  - `ignore_cache` / `cachier__skip_cache`: If True, ignores the cache and directly calls the original function
  - `overwrite_cache` / `cachier__overwrite_cache`: If True, ignores the existing cache and forces recalculation
  - `verbose_cache` / `cachier__verbose`: If True, prints detailed cache operation information
- **Return Value**: Cached result or newly calculated result
- **Behavior**:
  1. Handles cache-related special parameters
  2. Checks whether the cache should be ignored or forced to recalculate
  3. Determines whether the cache is expired based on `max_age` and `stale_after`
  4. If the cache is valid and not expired, returns the cached result
  5. If the cache is expired but `next_time=True`, updates the cache in the background and returns the old value
  6. Otherwise, recalculates and updates the cache

###### `func_wrapper(*args, **kwargs)`
- **Function**: Wrapper function returned by the decorator, handles parameter passing
- **Parameters**:
  - `*args`: Positional arguments
  - `**kwargs`: Keyword arguments
- **Return Value**: Result of calling the `_call` function

###### Methods provided via `func_wrapper`:

 `clear_cache()`
- **Function**: Clears all caches of the current function
- **Method Source**: Added via `func_wrapper.clear_cache = _clear_cache`
- **Example**:
  ```python
  @cachier()
  def my_func():
      return expensive_operation()
  
  # Clear the cache of my_func
  my_func._clear_cache()
  ```

`clear_being_calculated()`
- **Function**: Marks all cache items as not being calculated
- **Method Source**: Added via `func_wrapper.clear_being_calculated = _clear_being_calculated`
- **Usage Scenario**: Used for exception recovery or when cache state needs to be reset

`cache_dpath()`
- **Function**: Gets the cache directory path (if it exists)
- **Method Source**: Added via `func_wrapper.cache_dpath = _cache_dpath`
- **Return Value**: Cache directory path or None
- **Example**:
  ```python
  cache_dir = my_func._cache_dpath()
  print(f"Cache directory: {cache_dir}")
  ```

 `precache_value(*args, value_to_cache, **kwds)`
- **Function**: Adds a precomputed value to the cache
- **Parameters**:
  - `*args`: Positional arguments
  - `value_to_cache`: Value to cache
  - `**kwds`: Keyword arguments
- **Return Value**: Result of the cache operation
- **Method Source**: Added via `func_wrapper.precache_value = _precache_value`
- **Example**:
  ```python
  @cachier()
  def expensive_operation(x, y):
      return x * y
  
  # Precache a value
  expensive_operation.precache_value(2, 3, value_to_cache=6)
  ```
- **Parameters**:
  - `*args`: Positional arguments
  - `value_to_cache`: Value to cache
  - `**kwds`: Keyword arguments
- **Usage Scenario**: Used when a cache value needs to be manually set instead of being computed by the function
- **Example**:
  ```python
  # Manually set a cache value
  my_func._precache_value(param1, param2, value_to_cache=precomputed_result)
  ```


##### 2.4 Internal Class Methods of the Decorator `cachier`

###### `core.set_entry(key, value)`
- **Function**: Sets a cache entry
- **Parameters**:
  - `key`: Cache key
  - `value`: Value to cache

###### `core.get_entry(key, args, kwds)`
- **Function**: Gets a cache entry
- **Parameters**:
  - `key`: Cache key
  - `args`: Positional arguments
  - `kwds`: Keyword arguments
- **Return Value**: Cached value or None

###### `core.mark_entry_being_calculated(key)`
- **Function**: Marks a cache entry as being calculated
- **Parameters**:
  - `key`: Cache key

###### `core.mark_entry_not_calculated(key)`
- **Function**: Marks a cache entry as calculation completed
- **Parameters**:
  - `key`: Cache key

###### `core.wait_on_entry_calc(key)`
- **Function**: Waits for the calculation of the cache entry with the specified key to complete
- **Parameters**:
  - `key`: Cache key
- **Return Value**: Cached value
- **Exceptions**: May throw `RecalculationNeeded` if calculation fails or times out

##### 2.5 Usage Example: Accessing Internal Methods

```python
@cachier()
def get_expensive_data(param1, param2):
    # Time-consuming calculation or data fetching operation
    return result

# Clear cache
get_expensive_data.clear_cache()

# Get cache directory
cache_dir = get_expensive_data.cache_dpath()
print(f"Cache directory: {cache_dir}")

# Precache a value
get_expensive_data.precache_value('key1', 'key2', value_to_cache='cached_value')

# Reset calculation state
get_expensive_data.clear_being_calculated()
```
### 3. Base Exception Class

#### `RecalculationNeeded`
**Function Description**: Exception thrown when recalculation is needed.

**Inheritance**: `Exception`

**Attributes**: No additional attributes

**Methods**: No additional methods

**Example**:
```python
raise RecalculationNeeded()
```

### 4. Base Core Class `_BaseCore`

**Function Description**: `_BaseCore` is the abstract base class of the Cachier caching system, defining the basic interface for cache cores. All specific cache implementations (such as memory, MongoDB, Redis, etc.) must inherit from this class and implement its abstract methods.

**Class Decorator**:
```python
__metaclass__ = abc.ABCMeta
```
- **Function**: Marks the class as an abstract base class, requiring subclasses to implement all abstract methods
- **Location**: At the beginning of the class definition
- **Usage Scenario**: Defines interface specifications to ensure all cache core implementations provide necessary functionality

#### 4.1 Initialization Method

#### `__init__(self, hash_func: Optional[HashFunc], wait_for_calc_timeout: Optional[int], entry_size_limit: Optional[int] = None)`
**Function**: Initializes the cache core.

**Parameters**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `wait_for_calc_timeout` (Optional[int]): Maximum time (in seconds) to wait for calculation to complete
- `entry_size_limit` (Optional[int]): Cache entry size limit (in bytes)

**Attributes**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `wait_for_calc_timeout` (Optional[int]): Maximum time (in seconds) to wait for calculation to complete
- `lock` (threading.RLock): Reentrant lock object for thread synchronization
- `entry_size_limit` (Optional[int]): Cache entry size limit (in bytes)
- `func` (Callable): Function to be cached
- `func_is_method` (bool): Flag indicating whether the function is a class method

#### 4.2 Public Methods

#### `set_func(self, func)`
**Function**: Sets the function to be cached.

**Parameters**:
- `func` (callable): Function to be cached

**Description**:
- Must be set before calling any other methods
- Automatically detects whether the function is a class method
- Supports functions wrapped with `functools.partial`

#### `get_key(self, args, kwds)`
**Function**: Generates a unique cache key based on parameters.

**Parameters**:
- `args`: Tuple of positional arguments
- `kwds`: Dictionary of keyword arguments

**Returns**:
- `str`: Generated cache key

#### `get_entry(self, args, kwds)`
**Function**: Gets a cache entry based on parameters.

**Parameters**:
- `args`: Tuple of positional arguments
- `kwds`: Dictionary of keyword arguments

**Returns**:
- `Tuple[str, Optional[CacheEntry]]`: Tuple of (cache key, cache entry)

#### `precache_value(self, args, kwds, value_to_cache)`
**Function**: Stores a precomputed value in the cache.

**Parameters**:
- `args`: Tuple of positional arguments
- `kwds`: Dictionary of keyword arguments
- `value_to_cache`: Value to cache

**Returns**:
- The cached value

#### `check_calc_timeout(self, time_spent)`
**Function**: Checks if calculation has timed out, throws `RecalculationNeeded` exception if timed out.

**Parameters**:
- `time_spent` (float): Time already spent (in seconds)

**Exceptions**:
- `RecalculationNeeded`: Thrown when calculation times out

#### 4.3 Abstract Methods

The following methods are marked with the `@abc.abstractmethod` decorator, subclasses must implement these methods:

##### `@abc.abstractmethod
get_entry_by_key(self, key)`
**Function**: Gets a cache entry by key.

**Parameters**:
- `key` (str): Cache key

**Returns**:
- `Tuple[str, Optional[CacheEntry]]`: Tuple of (cache key, cache entry)

##### `@abc.abstractmethod
set_entry(self, key, func_res)`
**Function**: Stores the result in the cache.

**Parameters**:
- `key` (str): Cache key
- `func_res`: Value to cache

**Returns**:
- `bool`: Whether storage was successful

##### `@abc.abstractmethod
mark_entry_being_calculated(self, key)`
**Function**: Marks the cache entry with the specified key as being calculated.

**Parameters**:
- `key` (str): Cache key

##### `@abc.abstractmethod
mark_entry_not_calculated(self, key)`
**Function**: Marks the cache entry with the specified key as calculation completed.

**Parameters**:
- `key` (str): Cache key

##### `@abc.abstractmethod
wait_on_entry_calc(self, key)`
**Function**: Waits for the calculation of the cache entry with the specified key to complete.

**Parameters**:
- `key` (str): Cache key

##### `@abc.abstractmethod
clear_cache(self)`
**Function**: Clears the cache.

##### `@abc.abstractmethod
clear_being_calculated(self)`
**Function**: Marks all cache entries as not being calculated.

##### `@abc.abstractmethod
delete_stale_entries(self, stale_after)`
**Function**: Deletes expired cache entries.

**Parameters**:
- `stale_after` (datetime.timedelta): Expiration time delta

#### 4.4 Internal Methods

##### `_estimate_size(self, value)`
**Function**: Estimates the size of an object.

**Parameters**:
- `value`: Object to estimate size of

**Returns**:
- `int`: Object size (in bytes)

#### `_should_store(self, value)`
**Function**: Checks whether the value should be stored (based on size limit).

**Parameters**:
- `value`: Value to check

**Returns**:
- `bool`: Returns True if should be stored


### 5. config Module

#### `@dataclass`
**Function**: Automatically generates special methods (such as `__init__`, `__repr__`, etc.) for the class

#### `@dataclass
class CacheEntry`
**Function Description**: Data class representing a cache entry, storing cached values and their metadata.

**Class Attributes**:
- `value` (Any): Cached value
- `time` (datetime): Cache creation time
- `stale` (bool): Flag indicating whether the cache is stale
- `_processing` (bool): Flag indicating whether it is being processed (internal use)
- `_condition` (Optional[threading.Condition]): Thread condition variable (internal use)
- `_completed` (bool): Flag indicating whether processing is completed (internal use)

**Example**:
```python
from datetime import datetime
from cachier.config import CacheEntry

entry = CacheEntry(
    value="cached_data",
    time=datetime.now(),
    stale=False,
    _processing=False
)
```

#### 5.1. Decorators

##### `@dataclass`
**Function**: Automatically generates special methods (such as `__init__`, `__repr__`, etc.) for the class

**Location**:
- `@dataclass class Params`
- `@dataclass class CacheEntry`

**Usage Example**:
```python
from dataclasses import dataclass

@dataclass
class Example:
    name: str
    value: int = 0
```

#### 5.2. Backward Compatibility Functions

##### `get_default_params()`
**Function**: Gets the current global parameter configuration (deprecated, recommended to use `get_global_params`).

**Returns**:
- `Params`: Object containing all global configuration parameters

**Deprecation Notice**:
- This function is deprecated and will be removed in a future version
- Please use `get_global_params()` instead

##### `set_default_params(**params)`
**Function**: Sets global cache parameters (deprecated, recommended to use `set_global_params`).

**Parameters**:
- `**params`: Keyword arguments, supported parameters are the same as the `Params` class attributes

**Deprecation Notice**:
- This function is deprecated and will be removed in a future version
- Please use `set_global_params(**params)` instead

#### 5.3. Cache Control Functions

##### `enable_caching()`
**Function**: Globally enables caching.

**Example**:
```python
from cachier.config import enable_caching

enable_caching()  # Globally enable caching
```

##### `disable_caching()`
**Function**: Globally disables caching.

**Example**:
```python
from cachier.config import disable_caching

disable_caching()  # Globally disable caching
```

#### 5.4. Helper Functions

##### `_update_with_defaults(param, name: str, func_kwargs: Optional[dict] = None)`
**Function**: Internal function used to get parameter values, prioritizing function parameters, and using global defaults if not provided.

**Parameters**:
- `param`: Directly provided parameter value
- `name` (str): Parameter name
- `func_kwargs` (Optional[dict]): Function parameter dictionary

**Returns**:
- Parameter value

**Internal Use**:
```python
# Example internal use
hash_func = _update_with_defaults(hash_func, "hash_func", kwds)
```

#### 5.5. Parameter Class

##### `@dataclass
class Params`
**Function Description**: The `Params` class is a data class used to define and store all configuration parameters for the Cachier caching system. It uses Python's `@dataclass` decorator to automatically generate common methods such as `__init__`, `__repr__`, and `__eq__`.

**Class Signature**:
```python
@dataclass
class Params:
    caching_enabled: bool = True
    hash_func: HashFunc = _default_hash_func
    backend: Backend = "pickle"
    mongetter: Optional[Mongetter] = None
    stale_after: timedelta = timedelta.max
    next_time: bool = False
    cache_dir: Union[str, os.PathLike] = field(default_factory=LazyCacheDir)
    pickle_reload: bool = True
    separate_files: bool = False
    wait_for_calc_timeout: int = 0
    allow_none: bool = False
    cleanup_stale: bool = False
    cleanup_interval: timedelta = timedelta(days=1)
    entry_size_limit: Optional[int] = None
```

**Class Decorator**:
- `@dataclass`: Automatically generates special methods (such as `__init__`, `__repr__`, etc.) for the class

**Parameter Description**:

**Basic Cache Control**
- `caching_enabled` (bool, defaults to `True`): 
  - Whether caching is enabled. When set to `False`, all cache operations will be skipped.

- `hash_func` (Callable, defaults to `_default_hash_func`):
  - Hash function used to generate cache keys. The default implementation uses `pickle` to serialize parameters and calculate SHA-256 hash.

- `backend` (str, defaults to `"pickle"`):
  - Specifies the cache backend type. Supported options include "pickle", "mongo", etc.

- `mongetter` (Optional[Callable], defaults to `None`):
  - When using MongoDB backend, the callback function that returns the database connection.

**Cache Expiration and Update**
- `stale_after` (timedelta, defaults to `timedelta.max`):
  - How long after which a cache entry becomes stale. By default, caches never expire.

- `next_time` (bool, defaults to `False`):
  - If `True`, asynchronously updates expired caches on the next access.

**File Cache Configuration**
- `cache_dir` (Union[str, os.PathLike], defaults to `LazyCacheDir()`):
  - Storage directory for file caches. Defaults to XDG cache directory (if available), otherwise uses `~/.cachier/`.

- `pickle_reload` (bool, defaults to `True`):
  - Whether to reload pickle cache files on every access.

- `separate_files` (bool, defaults to `False`):
  - Whether to store each cache entry as a separate file.

**Concurrency Control**
- `wait_for_calc_timeout` (int, defaults to `0`):
  - Timeout (in seconds) to wait for other threads to complete calculations. 0 means do not wait, -1 means wait indefinitely.

**Advanced Options**
- `allow_none` (bool, defaults to `False`):
  - Whether to allow caching `None` values.

- `cleanup_stale` (bool, defaults to `False`):
  - Whether to automatically clean up stale cache entries.

- `cleanup_interval` (timedelta, defaults to `timedelta(days=1)`):
  - Time interval for cleaning up stale cache entries.

- `entry_size_limit` (Optional[int], defaults to `None`):
  - Size limit (in bytes) for a single cache entry. Entries exceeding this limit will be rejected.

**Global Parameter Instance**

```python
_global_params = Params()
```

**Function Description**:
`_global_params` is a global instance of the `Params` class used to store default parameters for all decorators. When creating new cache decorators, if parameters are not explicitly provided, these global defaults will be used.

#### 5.6 Related Functions

`get_global_params()`
**Function**: Gets the current global parameter configuration.

**Returns**:
- `Params`: Object containing all global configuration parameters

**Example**:
```python
from cachier.config import get_global_params

params = get_global_params()
print(f"Current cache directory: {params.cache_dir}")
```

 `set_global_params(**params)`
**Function**: Sets global cache parameters.

**Parameters**:
- `**params`: Keyword arguments, supported parameters are the same as the `Params` class attributes

**Description**:
- Only the 'stale_after', 'next_time', and 'wait_for_calc_timeout' parameters take effect after the decorator is applied
- Other parameters only take effect for decorators applied afterwards

**Example**:
```python
from datetime import timedelta
from cachier.config import set_global_params

# Set global cache expiration time to 1 day
set_global_params(
    stale_after=timedelta(days=1),
    next_time=True,
    cache_dir="/tmp/my_cache"
)
```
#### 5.7. _default_cache_dir Function - Default Cache Directory

**Functionality**:
Returns the default cache directory based on the XDG specification (X Desktop Group specification).

**Function Signature**:
```python
def _default_cache_dir() -> str:
```

**Parameters**:
No parameters.

**Return Value**:
- `str`: Returns the full path string of the cache directory.
  - If the `XDG_CACHE_HOME` environment variable is set, returns `$XDG_CACHE_HOME/cachier/`
  - If `XDG_CACHE_HOME` is not set, returns `~/.cachier/`

**Implementation Details**:
- First checks if the `XDG_CACHE_HOME` environment variable is set
- If set, returns `$XDG_CACHE_HOME/cachier/`
- If not set, returns the `.cachier/` directory under the user's home directory
- The `~` in the path is automatically expanded to the current user's home directory

**Usage Example**:
```python
from cachier.config import _default_cache_dir

# Get the default cache directory
cache_dir = _default_cache_dir()
print(f"Cache directory: {cache_dir}")
```

#### 5.8 Usage Examples

##### Creating Custom Parameter Configuration
```python
from datetime import timedelta
from cachier.config import Params

# Create custom parameter configuration
custom_params = Params(
    cache_dir="/tmp/my_cache",
    stale_after=timedelta(hours=1),
    allow_none=True,
    cleanup_stale=True,
    cleanup_interval=timedelta(hours=6)
)
```

##### Using Custom Parameters in Decorators
```python
import time
from datetime import timedelta
from cachier import cachier

# Create decorator with custom parameters
@cachier(
    stale_after=timedelta(minutes=30),
    next_time=True,
    cache_dir="/tmp/my_app_cache"
)
def expensive_operation(x):
    time.sleep(2)  # Simulate time-consuming operation
    return x * x
```

##### Dynamically Modifying Global Parameters
```python
from datetime import timedelta
from cachier.config import set_global_params, get_global_params

# Get current global parameters
current_params = get_global_params()
print(f"Current cache dir: {current_params.cache_dir}")

# Update global parameters
set_global_params(
    stale_after=timedelta(hours=2),
    cleanup_stale=True
)

# Verify parameters are updated
updated_params = get_global_params()
print(f"Updated stale_after: {updated_params.stale_after}")
```

#### 5.9 Default Hash Function

##### `_default_hash_func(args, kwds)`
**Function**: Default hash function used to generate cache keys.

**Parameters**:
- `args`: Positional arguments
- `kwds`: Keyword argument dictionary

**Returns**:
- `str`: SHA-256 hash value of the parameters

**Implementation Details**:
1. Sorts keyword arguments by key name to ensure consistency
2. Uses pickle to serialize parameters
3. Calculates SHA-256 hash value

**Internal Use**:
```python
# Generate cache key
cache_key = _default_hash_func(args, kwds)
```

### 6. Constants

#### `MAX_WORKERS_ENVAR_NAME`
**Type**: `str`
**Default Value**: `"CACHIER_MAX_WORKERS"`
**Function**: Environment variable name used to set the maximum number of worker threads.

#### `DEFAULT_MAX_WORKERS`
**Type**: `int`
**Default Value**: `8`
**Function**: Default maximum number of worker threads.

#### `ZERO_TIMEDELTA` Constant

**Functionality**:
Represents a zero time interval `timedelta` constant.

**Type**: `datetime.timedelta`

**Value**: `timedelta(seconds=0)`

**Explanation**:
- Used to represent no time interval or immediate expiration
- Commonly used in caching systems to indicate immediate cache expiration or no delay

**Usage Example**:
```python
from cachier.core import ZERO_TIMEDELTA
from datetime import timedelta

# Check if it's a zero time interval
if some_interval == ZERO_TIMEDELTA:
    print("No time delay")
```

#### `MONGO_SLEEP_DURATION_IN_SEC` Constant

**Functionality**:
Defines the sleep duration (in seconds) when waiting during MongoDB cache operations.

**Type**: `int`

**Value**: `1`

**Explanation**:
- When using MongoDB as the backend, if a key is being calculated by another process, the current process waits for this time interval before retrying
- Unit: seconds

**Usage Example**:
```python
from cachier.cores.mongo import MONGO_SLEEP_DURATION_IN_SEC

print(f"MongoDB retry interval: {MONGO_SLEEP_DURATION_IN_SEC} seconds")
```

#### `REDIS_SLEEP_DURATION_IN_SEC` Constant

**Functionality**:
Defines the sleep duration (in seconds) when waiting during Redis cache operations.

**Type**: `int`

**Value**: `1`

**Explanation**:
- When using Redis as the backend, if a key is being calculated by another process, the current process waits for this time interval before retrying
- Unit: seconds

**Usage Example**:
```python
from cachier.cores.redis import REDIS_SLEEP_DURATION_IN_SEC

print(f"Redis retry interval: {REDIS_SLEEP_DURATION_IN_SEC} seconds")
```

### 7. Thread Pool Management Functions

#### `_max_workers()`
**Function**: Gets the currently configured maximum number of worker threads.

**Returns**:
- `int`: The maximum number of worker threads, obtained from the environment variable `CACHIER_MAX_WORKERS`, defaults to `DEFAULT_MAX_WORKERS`.

**Implementation**:
```python
def _max_workers():
    return int(os.environ.get(MAX_WORKERS_ENVAR_NAME, DEFAULT_MAX_WORKERS))
```

#### `_set_max_workers(max_workers)`
**Function**: Sets the maximum number of worker threads.

**Parameters**:
- `max_workers` (int): The maximum number of worker threads to set.

**Implementation**:
```python
def _set_max_workers(max_workers):
    os.environ[MAX_WORKERS_ENVAR_NAME] = str(max_workers)
    _get_executor(True)
```

#### `_get_executor(reset=False)`
**Function**: Gets or creates a thread pool executor.

**Parameters**:
- `reset` (bool, optional): Whether to reset the executor. Defaults to `False`.

**Returns**:
- `ThreadPoolExecutor`: The thread pool executor instance.

**Implementation**:
```python
def _get_executor(reset=False):
    if reset or not hasattr(_get_executor, "executor"):
        _get_executor.executor = ThreadPoolExecutor(_max_workers())
    return _get_executor.executor
```
### 8. _version Module

#### 8.1. Module-Level Variables

##### 8.1.1 _PATH_HERE
**Type**: `str`  
**Description**: Stores the absolute path of the directory where the current module file is located.  
**Implementation Details**:  
- Uses `os.path.dirname(__file__)` to get the directory of the current module file

##### 8.1.2 _PATH_VERSION
**Type**: `str`  
**Description**: Stores the complete path of the version information file.  
**Implementation Details**:  
- Constructs the path via `os.path.join(_PATH_HERE, "version.info")`
- Points to the `version.info` file in the same directory as `_version.py`

##### 8.1.3 _RELEASING_PROCESS
**Type**: `bool`  
**Description**: Marks whether currently in the release process.  
**Implementation Details**:  
- Gets the value from the environment variable `RELEASING_PROCESS`, defaults to `"0"`
- When the environment variable value is `"1"`, it is `True`; otherwise, `False`

##### 8.1.4 __all__
**Type**: `list[str]`  
**Description**: Defines the public interface of the module, specifying which symbols should be imported when using `from module import *`.  
**Value**: `["__version__"]`  
**Explanation**:  
- Only `__version__` will be exported to the module's public interface
- Other variables and functions (such as `_get_git_sha`, `_PATH_HERE`, etc.) are considered internal implementation details of the module and will not be imported via `import *`

#### 8.2. _get_git_sha Function

**Functionality**: Gets the short commit hash of the current Git repository.

**Function Signature**:
```python
def _get_git_sha() -> str:
```

**Parameters**:
No parameters.

**Return Value**:
- `str`: The short commit hash of the current Git repository (7 characters)
  - If successfully obtained, returns a string like `a1b2c3d`
  - If acquisition fails (e.g., not in a Git repository), throws a `subprocess.CalledProcessError` exception

**Implementation Details**:
- Uses `subprocess.check_output()` to execute the `git rev-parse --short HEAD` command
- Captures the command's standard error and discards it (redirected to `subprocess.DEVNULL`)
- Decodes the command output from bytes to utf-8 string and removes leading/trailing whitespace characters

**Usage Example**:
```python
from cachier._version import _get_git_sha

try:
    git_sha = _get_git_sha()
    print(f"Current Git commit hash: {git_sha}")
except Exception as e:
    print(f"Failed to get Git commit hash: {e}")
```

### 9. `__main__` Module

#### 9.1. Main Components

##### 9.1.1 `cli` Command Group
**Function Description**: The command-line interface entry point for Cachier, used to organize and manage all subcommands.

**Import Method**:
```python
from cachier.__main__ import cli
```

**Features**:
- Command-line interface implemented using the `click` library
- Serves as a command group that can add multiple subcommands
- Provides basic help information and docstrings

**Implementation Code**:
```python
@click.group()
def cli():
    """A command-line interface for cachier."""  # noqa: D401
```

##### 9.1.2 `set_max_workers` Command
**Function Description**: Sets the maximum number of worker threads used by Cachier.

**Import Method**:
```python
from cachier.__main__ import cli
```

**Command Format**:
```bash
cachier set-max-workers <max_workers>
```

**Parameters**:
- `max_workers` (int, required): The maximum number of worker threads to set.

**Implementation Code**:
```python
@cli.command("Limits the number of worker threads used by cachier.")
@click.argument("max_workers", nargs=1, type=int)
def set_max_workers(max_workers):
    """Limits the number of worker threads used by cachier."""
    _set_max_workers(max_workers)
```
### 10. In-Memory Cache Core Class _MemoryCore

**Function Description**: `_MemoryCore` is the in-memory cache core implementation class in the Cachier library, providing thread-safe in-memory caching functionality.

**Import Method**:
```python
from cachier.cores.memory import _MemoryCore
```

#### 10.1 Initialization Method

```python
def __init__(
    self,
    hash_func: Optional[HashFunc],
    wait_for_calc_timeout: Optional[int],
    entry_size_limit: Optional[int] = None,
):
```

**Parameters**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `wait_for_calc_timeout` (Optional[int]): Maximum timeout for waiting on calculation completion
- `entry_size_limit` (Optional[int], optional): Cache entry size limit, defaults to None

#### 10.2 Main Methods

##### 10.2.0 Generate Hash Key (Internal Method)
```python
def _hash_func_key(self, key: str) -> str:
```
**Function**: Generates a hash key for caching
**Parameters**:
- `key` (str): Original key name
**Returns**:
- str: String in the format `"function_name:key_name"`

##### 10.2.1 Get Cache Entry
```python
def get_entry_by_key(self, key: str, reload: bool = False) -> Tuple[str, Optional[CacheEntry]]:
```
**Function**: Gets a cache entry by key
**Parameters**:
- `key` (str): Cache key
- `reload` (bool, optional): Whether to reload, defaults to False
**Returns**:
- Tuple[str, Optional[CacheEntry]]: Returns a (key, cache entry) tuple

##### 10.2.2 Set Cache Entry
```python
def set_entry(self, key: str, func_res: Any) -> bool:
```
**Function**: Sets a cache entry
**Parameters**:
- `key` (str): Cache key
- `func_res` (Any): Value to cache
**Returns**:
- bool: Returns True if successfully set, otherwise False

##### 10.2.3 Mark Entry as Being Calculated
```python
def mark_entry_being_calculated(self, key: str) -> None:
```
**Function**: Marks that the value corresponding to a key is being calculated
**Parameters**:
- `key` (str): Cache key

##### 10.2.4 Mark Entry as Not Calculated
```python
def mark_entry_not_calculated(self, key: str) -> None:
```
**Function**: Marks that the value corresponding to a key is not yet calculated
**Parameters**:
- `key` (str): Cache key

##### 10.2.5 Wait for Entry Calculation Completion
```python
def wait_on_entry_calc(self, key: str) -> Any:
```
**Function**: Waits for the value corresponding to the specified key to complete calculation
**Parameters**:
- `key` (str): Cache key
**Returns**:
- Any: Cached value

##### 10.2.6 Clear Cache
```python
def clear_cache(self) -> None:
```
**Function**: Clears all cache

##### 10.2.7 Clear Entries Being Calculated
```python
def clear_being_calculated(self) -> None:
```
**Function**: Resets all entries marked as being calculated to not calculated state

##### 10.2.8 Delete Stale Entries
```python
def delete_stale_entries(self, stale_after: timedelta) -> None:
```
**Function**: Deletes expired entries from the in-memory cache
**Parameters**:
- `stale_after` (timedelta): Expiration time interval

#### 10.3 Usage Examples

```python
from datetime import timedelta
from cachier.cores.memory import _MemoryCore

# Initialize in-memory cache
memory_cache = _MemoryCore(
    hash_func=hash,  # Use Python built-in hash function
    wait_for_calc_timeout=30,  # 30-second timeout
    entry_size_limit=1000  # Maximum 1000 bytes per entry
)

# Set cache
memory_cache.set_entry("key1", "value1")

# Get cache
key, entry = memory_cache.get_entry_by_key("key1")
print(entry.value)  # Output: value1

# Mark as being calculated
memory_cache.mark_entry_being_calculated("key2")

# Clear cache
memory_cache.clear_cache()

# Delete expired entries
memory_cache.delete_stale_entries(timedelta(minutes=30))
```
### 11. Exception Classes

#### MissingMongetter
**Functionality Description**: Exception thrown when the `mongetter` keyword argument is missing.
**Inherits From**: `ValueError`
**Definition**:
```python
class MissingMongetter(ValueError):
    """Thrown when the mongetter keyword argument is missing."""
    pass
```

### 12. _MongoCore
**Functionality Description**: Core implementation class for caching based on MongoDB, inherits from `_BaseCore`.

#### 12.1 Initialization Method
```python
def __init__(
    self,
    hash_func: Optional[HashFunc],
    mongetter: Optional[Mongetter],
    wait_for_calc_timeout: Optional[int],
    entry_size_limit: Optional[int] = None,
)
```
**Parameters**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `mongetter` (Optional[Mongetter]): Callable that returns a MongoDB collection
- `wait_for_calc_timeout` (Optional[int]): Timeout in seconds for waiting on calculation results
- `entry_size_limit` (Optional[int], optional): Cache entry size limit

**Exceptions**:
- If `pymongo` is not installed, an `ImportWarning` warning is issued
- If the `mongetter` parameter is not provided, a `MissingMongetter` exception is thrown

#### 12.2 Properties

##### _func_str
```python
@property
def _func_str(self) -> str
```
**Functionality**: Gets the string representation of the current function, used as part of the index key in MongoDB.
**Returns**:
- `str`: String representation of the function
**Example**:
```python
# Assuming func is a function object
core = _MongoCore(...)
func_str = core._func_str  # Get the string representation of the function
```
**Note**: This is a read-only property implemented using the `@property` decorator.

#### 12.3 Main Methods

##### get_entry_by_key
```python
def get_entry_by_key(self, key: str) -> Tuple[str, Optional[CacheEntry]]
```
**Functionality**: Gets a cache entry by key
**Parameters**:
- `key` (str): Cache key
**Returns**:
- `Tuple[str, Optional[CacheEntry]]`: Tuple containing the key and cache entry

##### set_entry
```python
def set_entry(self, key: str, func_res: Any) -> bool
```
**Functionality**: Sets a cache entry
**Parameters**:
- `key` (str): Cache key
- `func_res` (Any): Value to cache
**Returns**:
- `bool`: Returns `True` if successfully set, otherwise `False`

##### mark_entry_being_calculated
```python
def mark_entry_being_calculated(self, key: str) -> None
```
**Functionality**: Marks an entry as being calculated
**Parameters**:
- `key` (str): Cache key

##### mark_entry_not_calculated
```python
def mark_entry_not_calculated(self, key: str) -> None
```
**Functionality**: Marks an entry as not being calculated
**Parameters**:
- `key` (str): Cache key

##### wait_on_entry_calc
```python
def wait_on_entry_calc(self, key: str) -> Any
```
**Functionality**: Waits for the calculation of an entry to complete
**Parameters**:
- `key` (str): Cache key
**Returns**:
- `Any`: Result after calculation completes
**Exceptions**:
- If the entry does not exist or times out, throws a `RecalculationNeeded` exception

##### clear_cache
```python
def clear_cache(self) -> None
```
**Functionality**: Clears all cache for the current function

##### clear_being_calculated
```python
def clear_being_calculated(self) -> None
```
**Functionality**: Clears all "being calculated" states

##### delete_stale_entries
```python
def delete_stale_entries(self, stale_after: timedelta) -> None
```
**Functionality**: Deletes expired cache entries
**Parameters**:
- `stale_after` (timedelta): Expiration interval

### 13. Core Class _PickleCore

**Functionality Description**: `_PickleCore` is the pickle serialization-based cache core implementation class in the Cachier library, providing local file caching functionality, supporting multi-process safe access and automatic cache invalidation.

#### Import
```python
from cachier.cores.pickle import _PickleCore
```

#### Class Definition
```python
class _PickleCore(_BaseCore):
    """The pickle core class for cachier."""
    
    class CacheChangeHandler(PatternMatchingEventHandler):
        """Handles cache file modification events."""
        
        def __init__(self, filename: str, core: '_PickleCore', key: str):
            """Initializes the cache change handler.
            
            Args:
                filename: The filename to monitor
                core: The parent _PickleCore instance
                key: The cache key
            """
            
        def inject_observer(self, observer) -> None:
            """Injects an observer instance.
            
            Args:
                observer: The observer instance
            """
            
        def _check_calculation(self) -> None:
            """Checks if the calculation is complete and stops the observer if so."""
            
        def on_created(self, event) -> None:
            """Handles file creation events."""
            
        def on_modified(self, event) -> None:
            """Handles file modification events."""
    
    def __init__(
        self,
        hash_func: Optional[HashFunc],
        pickle_reload: Optional[bool],
        cache_dir: Optional[Union[str, os.PathLike]],
        separate_files: Optional[bool],
        wait_for_calc_timeout: Optional[int],
        entry_size_limit: Optional[int] = None,
    ):
        """Initializes the pickle cache core.
        
        """
        super().__init__(hash_func, wait_for_calc_timeout, entry_size_limit)
        self._cache_dict: Dict[str, CacheEntry] = {}
        self.reload = _update_with_defaults(pickle_reload, "pickle_reload")
        self.cache_dir = os.path.expanduser(
            _update_with_defaults(cache_dir, "cache_dir")
        )
        self.separate_files = _update_with_defaults(
            separate_files, "separate_files"
        )
        self._cache_used_fpath = ""
```

#### Parameter Description

##### hash_func
- **Type**: `Optional[HashFunc]`
- **Description**: Hash function used to generate cache keys. If `None`, the default hash function will be used.
- **Example**: `hash_func=hash`

##### pickle_reload
- **Type**: `Optional[bool]`
- **Description**: Whether to reload the cache file on each access. When set to `True`, each access will reload the cache from disk to ensure the latest data is obtained, but may impact performance.
- **Default**: `None` (uses global default settings)

###### cache_dir
- **Type**: `Optional[Union[str, os.PathLike]]`
- **Description**: Directory where cache files are stored. If the directory does not exist, it will be created automatically.
- **Default**: `None` (uses global default directory)
- **Example**: `cache_dir="./cache"`

###### separate_files
- **Type**: `Optional[bool]`
- **Description**: Whether to use separate files for each cache entry. When set to `True`, each key generates a separate file, suitable for large files or scenarios requiring independent expiration.
- **Default**: `None` (uses global default settings)

###### wait_for_calc_timeout
- **Type**: `Optional[int]`
- **Description**: Maximum time in seconds to wait for calculation completion. When other processes are calculating the same key, this parameter controls the maximum wait time.
- **Example**: `wait_for_calc_timeout=60`

###### entry_size_limit
- **Type**: `Optional[int]`
- **Description**: Size limit for a single cache entry in bytes. Cache entries exceeding this size will be rejected.
- **Default**: `None` (no size limit)
- **Example**: `entry_size_limit=1024*1024` (limit to 1MB)

#### Core Methods

##### 1. Cache Operations

###### get_entry_by_key
```python
def get_entry_by_key(
    self, 
    key: str, 
    reload: bool = False
) -> Tuple[str, Optional[CacheEntry]]
```
**Functionality**: Gets a cache entry by key  
**Parameters**:
- `key` (str): Cache key
- `reload` (bool): Whether to force reload the cache  
**Returns**: Tuple containing the key and cache entry, or (key, None) if it does not exist

###### set_entry
```python
def set_entry(self, key: str, func_res: Any) -> bool
```
**Functionality**: Sets a cache entry  
**Parameters**:
- `key`: Cache key
- `func_res`: Value to cache  
**Returns**: Whether the cache was successfully set

###### clear_cache
```python
def clear_cache(self) -> None
```
**Functionality**: Clears all cache

###### delete_stale_entries
```python
def delete_stale_entries(self, stale_after: timedelta) -> None
```
**Functionality**: Deletes expired cache entries  
**Parameters**:
- `stale_after`: Time delta after which cache entries are considered expired and will be deleted

##### 2. Calculation State Management

###### mark_entry_being_calculated_separate_files
```python
def mark_entry_being_calculated_separate_files(self, key: str) -> None
```
**Functionality**: Marks a key's corresponding value as being calculated in separate file mode
**Parameters**:
- `key`: The cache key to mark

###### _mark_entry_not_calculated_separate_files
```python
def _mark_entry_not_calculated_separate_files(self, key: str) -> None
```
**Functionality**: Marks a key's corresponding value as calculation completed in separate file mode
**Parameters**:
- `key`: The cache key to update

###### mark_entry_being_calculated
```python
def mark_entry_being_calculated(self, key: str) -> None
```
**Functionality**: Marks a key's corresponding value as being calculated

###### mark_entry_not_calculated
```python
def mark_entry_not_calculated(self, key: str) -> None
```
**Functionality**: Marks a key's corresponding value as calculation completed

###### clear_being_calculated
```python
def clear_being_calculated(self) -> None
```
**Functionality**: Clears all "being calculated" marks

##### 3. Waiting Mechanism

###### wait_on_entry_calc
```python
def wait_on_entry_calc(self, key: str) -> Any
```
**Functionality**: Waits for the calculation of the specified key to complete  
**Parameters**:
- `key`: The cache key to wait for
**Returns**: The value after calculation completes

###### _create_observer
```python
def _create_observer(self) -> Observer
```
**Functionality**: Creates and returns a new observer instance
**Returns**: `watchdog.observers.Observer` instance

###### _cleanup_observer
```python
def _cleanup_observer(self, observer: Observer) -> None
```
**Functionality**: Cleans up observer resources
**Parameters**:
- `observer`: The observer instance to clean up

###### _wait_with_inotify
```python
def _wait_with_inotify(self, key: str, filename: str) -> Any
```
**Functionality**: Waits for calculation completion using the inotify mechanism
**Parameters**:
- `key`: Cache key
- `filename`: The filename to monitor
**Returns**: The value after calculation completes

###### _wait_with_polling
```python
def _wait_with_polling(self, key: str) -> Any
```
**Functionality**: Waits for calculation completion using a polling mechanism (alternative when inotify is not available)
**Parameters**:
- `key`: Cache key
**Returns**: The value after calculation completes

##### 4. Internal Methods

###### _save_cache
```python
def _save_cache(
    self,
    cache: Union[Dict[str, CacheEntry], CacheEntry],
    separate_file_key: Optional[str] = None,
    hash_str: Optional[str] = None,
) -> None
```
**Functionality**: Saves cache to file  
**Parameters**:
- `cache`: Dictionary or cache entry to cache
- `separate_file_key`: Key name for separate files
- `hash_str`: Hash string

###### get_cache_dict
```python
def get_cache_dict(self, reload: bool = False) -> Dict[str, CacheEntry]
```
**Functionality**: Gets the complete cache dictionary  
**Parameters**:
- `reload`: Whether to force reload the cache  
**Returns**: Dictionary containing all cache entries

###### _clear_all_cache_files
```python
def _clear_all_cache_files(self) -> None
```
**Functionality**: Clears all cache files
**Description**: When using separate file mode, deletes all related cache files

###### _clear_being_calculated_all_cache_files
```python
def _clear_being_calculated_all_cache_files(self) -> None
```
**Functionality**: Clears all cache files marked as "being calculated"
**Description**: Iterates through all cache files and sets the `_processing` mark to `False`

###### _load_cache_dict
```python
def _load_cache_dict(self) -> Dict[str, CacheEntry]
```
**Functionality**: Loads the cache dictionary from file  
**Returns**: Dictionary containing all cache entries

###### _load_cache_by_key
```python
def _load_cache_by_key(self, key=None, hash_str=None) -> Optional[CacheEntry]
```
**Functionality**: Loads a single cache entry by key or hash value  
**Returns**: Cache entry, or None if it does not exist

##### 5. Internal Methods

###### _convert_legacy_cache_entry (Static Method)
```python
@staticmethod
def _convert_legacy_cache_entry(
    entry: Union[dict, CacheEntry],
) -> CacheEntry
```
**Functionality**: Converts legacy cache entry format to new `CacheEntry` objects  
**Parameters**:
- `entry`: Legacy dictionary format or new `CacheEntry` object  
**Returns**: Converted `CacheEntry` object

##### Properties

###### cache_fname (property)
```python
@property
def cache_fname(self) -> str
```
**Functionality**: Gets the cache filename  
**Returns**: Filename string in the format `.module.function_name`, with special characters `<` and `>` replaced by `_`

###### cache_fpath (property)
```python
@property
def cache_fpath(self) -> str
```
**Functionality**: Gets the complete cache file path  
**Returns**: Complete absolute path of the cache file; if the directory does not exist, it will be created automatically

##### Usage Examples

###### Basic Usage
```python
from cachier.cores.pickle import _PickleCore
from cachier.config import CacheEntry
from datetime import datetime, timedelta

# Initialize cache core
cache = _PickleCore(
    hash_func=hash,
    pickle_reload=True,
    cache_dir="./cache",
    separate_files=False,
    wait_for_calc_timeout=60
)

# Set cache
cache.set_entry("key1", "value1")

# Get cache
key, entry = cache.get_entry_by_key("key1")
if entry:
    print(f"Cached value: {entry.value}")

# Delete expired cache
cache.delete_stale_entries(timedelta(days=1))

# Clear all cache
cache.clear_cache()
```


### 14. Exception Class MissingRedisClient

**Functionality Description**: Exception thrown when a Redis client is not provided.

**Inheritance Relationship**:
```python
class MissingRedisClient(ValueError)
```

**Description**:
- This exception is thrown when using the Redis core but the `redis_client` parameter is not provided.
- Inherits from Python's built-in `ValueError` exception.

### 15. Core Class _RedisCore

**Functionality Description**: Redis-based cache core implementation class, providing distributed caching functionality, supporting cache sharing in multi-process/multi-host environments.

**Inheritance Relationship**:
```python
class _RedisCore(_BaseCore)
```

#### 15.1 Initialization Method

##### `__init__`
```python
def __init__(
    self,
    hash_func: Optional[HashFunc],
    redis_client: Optional[Union["redis.Redis", Callable[[], "redis.Redis"]]],
    wait_for_calc_timeout: Optional[int] = None,
    key_prefix: str = "cachier",
    entry_size_limit: Optional[int] = None,
)
```

**Parameter Description**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `redis_client` (Optional[Union[redis.Redis, Callable[[], redis.Redis]]]): Redis client instance or callable that returns a Redis client
- `wait_for_calc_timeout` (Optional[int]): Maximum time in seconds to wait for calculation completion
- `key_prefix` (str): Redis key name prefix, defaults to "cachier"
- `entry_size_limit` (Optional[int]): Cache entry size limit in bytes

**Description**:
- If the Redis module is not installed, a warning is issued but initialization is not prevented
- The `redis_client` parameter is required; if `None`, a `MissingRedisClient` exception is thrown

#### 15.2 Main Methods

##### `set_func`
```python
def set_func(self, func) -> None
```

**Functionality**: Sets the function to be cached by the current core

**Parameters**:
- `func` (Callable): Function object to be cached

**Description**:
- Generates a unique identifier for the function internally
- Must be called to set the function before calling other methods
- Inherited from the base class `_BaseCore`

##### `get_entry_by_key`
```python
def get_entry_by_key(self, key: str) -> Tuple[str, Optional[CacheEntry]]
```

**Functionality**: Gets a cache entry from Redis by key

**Parameters**:
- `key` (str): Cache key

**Returns**:
- Tuple[str, Optional[CacheEntry]]: Tuple containing the key and cache entry, or (key, None) if it does not exist

**Exceptions**:
- If Redis operations fail, a warning is issued but no exception is thrown

##### `set_entry`
```python
def set_entry(self, key: str, func_res: Any) -> bool
```

**Functionality**: Saves function results to Redis cache

**Parameters**:
- `key` (str): Cache key
- `func_res` (Any): Function result to cache

**Returns**:
- bool: Whether the cache was successfully set

**Description**:
- If the size of `func_res` exceeds the `entry_size_limit`, it will not be saved
- Automatically sets timestamp and status flags

##### `mark_entry_being_calculated`
```python
def mark_entry_being_calculated(self, key: str) -> None
```

**Functionality**: Marks the cache entry for the specified key as "being calculated" state

**Parameters**:
- `key` (str): Cache key

**Description**:
- Sets `processing=True` and `completed=False` flags
- Updates the cache entry's timestamp

##### `mark_entry_not_calculated`
```python
def mark_entry_not_calculated(self, key: str) -> None
```

**Functionality**: Marks the cache entry for the specified key as "not being calculated" state

**Parameters**:
- `key` (str): Cache key

**Description**:
- Sets `processing=False` flag

##### `wait_on_entry_calc`
```python
def wait_on_entry_calc(self, key: str) -> Any
```

**Functionality**: Waits for the calculation of the specified key's cache entry to complete

**Parameters**:
- `key` (str): Cache key to wait for

**Returns**:
- Any: Cached value

**Exceptions**:
- RecalculationNeeded: If the cache entry does not exist
- RuntimeError: If waiting times out

**Description**:
- Uses polling to check cache status
- Each check interval is 1 second

##### `clear_cache`
```python
def clear_cache(self) -> None
```

**Functionality**: Clears all cache for the current function

**Description**:
- Deletes all Redis keys matching `{key_prefix}:{func_str}:*`

##### `clear_being_calculated`
```python
def clear_being_calculated(self) -> None
```

**Functionality**: Marks all cache entries as "not being calculated" state

**Description**:
- Batch updates the `processing` flag to `false` for all matching keys
- Uses Redis pipeline for efficiency

##### `delete_stale_entries`
```python
def delete_stale_entries(self, stale_after: timedelta) -> None
```

**Functionality**: Deletes expired cache entries

**Parameters**:
- `stale_after` (timedelta): Expiration time delta

**Description**:
- Deletes all cache entries with timestamps earlier than (current time - stale_after)

#### 15.3 Helper Methods

##### `_resolve_redis_client`
```python
def _resolve_redis_client(self)
```

**Functionality**: Resolves and returns the Redis client instance

**Returns**:
- redis.Redis: Redis client instance

**Description**:
- If `redis_client` is a callable object, calls it to get the instance
- Otherwise, directly returns `redis_client`

##### `_get_redis_key`
```python
def _get_redis_key(self, key: str) -> str
```

**Functionality**: Generates Redis key names

**Parameters**:
- `key` (str): Original key name

**Returns**:
- str: Key name in the format `{key_prefix}:{func_str}:{key}`

#### 15.4 Usage Examples

##### Basic Usage
```python
import redis
from cachier.cores.redis import _RedisCore

# Create Redis client
redis_client = redis.Redis(host='localhost', port=6379, db=0)

# Initialize Redis core
redis_core = _RedisCore(
    hash_func=hash,
    redis_client=redis_client,
    key_prefix="myapp"
)

# Set cache
redis_core.set_entry("key1", {"data": "value"})

# Get cache
key, entry = redis_core.get_entry_by_key("key1")
if entry:
    print(entry.value)  # Output: {'data': 'value'}
```

##### Mark Calculation Status
```python
# Mark as being calculated
redis_core.mark_entry_being_calculated("expensive_key")

try:
    # Execute time-consuming calculation
    result = expensive_operation()
    
    # Save result
    redis_core.set_entry("expensive_key", result)
    
    return result
except Exception as e:
    # Mark as not being calculated when an error occurs
    redis_core.mark_entry_not_calculated("expensive_key")
    raise
```

##### Clean Up Cache
```python
# Clear all cache
redis_core.clear_cache()

# Clear expired cache (30 days ago)
redis_core.delete_stale_entries(timedelta(days=30))
```
### 16. SQL Module Constants

#### `SQLALCHEMY_AVAILABLE`
**Type**: `bool`

**Description**:
- Boolean value indicating whether SQLAlchemy is available
- `True` if importing SQLAlchemy-related modules succeeds, otherwise `False`
- Automatically detected during module import

### 17. SQL Module Core Class _SQLCore

**Functionality Description**: Cache core implementation class based on SQLAlchemy, supporting various SQL database backends (such as SQLite, PostgreSQL, etc.), providing thread-safe cache operations.

**Inheritance Relationship**:
```python
class _SQLCore(_BaseCore)
```

#### 17.1 Initialization Method

##### `__init__`
```python
def __init__(
    self,
    hash_func: Optional[HashFunc],
    sql_engine: Optional[Union[str, "Engine", Callable[[], "Engine"]]],
    wait_for_calc_timeout: Optional[int] = None,
    entry_size_limit: Optional[int] = None,
)
```

**Parameter Description**:
- `hash_func` (Optional[HashFunc]): Hash function used to generate cache keys
- `sql_engine` (Optional[Union[str, Engine, Callable[[], Engine]]]): 
  - Can be an SQLAlchemy Engine object
  - Or a database connection string (e.g., `sqlite:///cache.db`)
  - Or a callable that returns an Engine
- `wait_for_calc_timeout` (Optional[int]): Maximum time in seconds to wait for calculation completion
- `entry_size_limit` (Optional[int]): Cache entry size limit in bytes

**Exceptions**:
- `ImportError`: Thrown when SQLAlchemy is not installed
- `ValueError`: Thrown when the `sql_engine` parameter is invalid

#### 17.2 Main Methods

##### `set_func`
```python
def set_func(self, func) -> None
```

**Functionality**: Sets the function to be cached by the current core

**Parameters**:
- `func` (Callable): Function object to be cached

**Description**:
- Generates a unique identifier for the function internally
- Must be called to set the function before calling other methods

##### `get_entry_by_key`
```python
def get_entry_by_key(self, key: str) -> Tuple[str, Optional[CacheEntry]]
```

**Functionality**: Gets a cache entry from the database by key

**Parameters**:
- `key` (str): Cache key

**Returns**:
- Tuple[str, Optional[CacheEntry]]: Tuple containing the key and cache entry, or (key, None) if it does not exist

##### `set_entry`
```python
def set_entry(self, key: str, func_res: Any) -> bool
```

**Functionality**: Saves function results to the database cache

**Parameters**:
- `key` (str): Cache key
- `func_res` (Any): Function result to cache

**Returns**:
- bool: Whether the cache was successfully set

**Description**:
- If the size of `func_res` exceeds the `entry_size_limit`, it will not be saved
- Uses `pickle` to serialize values
- Automatically handles insert or update logic

##### `mark_entry_being_calculated`
```python
def mark_entry_being_calculated(self, key: str) -> None
```

**Functionality**: Marks the cache entry for the specified key as "being calculated" state

**Parameters**:
- `key` (str): Cache key

**Description**:
- If the key does not exist, creates a new record
- Sets `processing=True` and `completed=False`

##### `mark_entry_not_calculated`
```python
def mark_entry_not_calculated(self, key: str) -> None
```

**Functionality**: Marks the cache entry for the specified key as "not being calculated" state

**Parameters**:
- `key` (str): Cache key

##### `wait_on_entry_calc`
```python
def wait_on_entry_calc(self, key: str) -> Any
```

**Functionality**: Waits for the calculation of the specified key's cache entry to complete

**Parameters**:
- `key` (str): Cache key to wait for

**Returns**:
- Any: Cached value

**Exceptions**:
- `RecalculationNeeded`: If the cache entry does not exist
- `RuntimeError`: If waiting times out

**Description**:
- Uses polling to check cache status
- Each check interval is 1 second

##### `clear_cache`
```python
def clear_cache(self) -> None
```

**Functionality**: Clears all cache for the current function

**Description**:
- Deletes all cache records related to the current function

##### `clear_being_calculated`
```python
def clear_being_calculated(self) -> None
```

**Functionality**: Marks all cache entries as "not being calculated" state

**Description**:
- Sets `processing=False` for all cache entries where `processing=True`

##### `delete_stale_entries`
```python
def delete_stale_entries(self, stale_after: timedelta) -> None
```

**Functionality**: Deletes expired cache entries

**Parameters**:
- `stale_after` (timedelta): Expiration time delta

**Description**:
- Deletes all cache entries with timestamps earlier than (current time - stale_after)

#### 17.3 Internal Methods

##### `_resolve_engine`
```python
def _resolve_engine(self, sql_engine)
```

**Functionality**: Resolves and returns the SQLAlchemy engine

**Parameters**:
- `sql_engine`: Can be an Engine object, connection string, or a callable that returns an Engine

**Returns**:
- Engine: SQLAlchemy engine instance

**Exceptions**:
- `ValueError`: Thrown when the parameter type is invalid

#### 17.4 Database Model

##### `CacheTable`

**Functionality Description**: SQLAlchemy model representing the cache table structure

**Table Name**: `cachier_cache`

**Fields**:
- `id` (String, Primary Key): Unique identifier in the format `{function_id}:{key}`
- `function_id` (String, Index): Function identifier
- `key` (String, Index): Cache key
- `value` (LargeBinary): Serialized cache value
- `timestamp` (DateTime): Timestamp
- `stale` (Boolean): Whether it is stale
- `processing` (Boolean): Whether it is being calculated
- `completed` (Boolean): Whether calculation is completed

**Indexes**:
- Primary Key Index: `id`
- Unique Index: `(function_id, key)`

#### 17.5 Usage Examples

##### Basic Usage
```python
from sqlalchemy import create_engine
from cachier.cores.sql import _SQLCore
from datetime import timedelta

# Create SQLite engine (in-memory database)
engine = create_engine('sqlite:///:memory:')

# Initialize SQL core
sql_core = _SQLCore(
    hash_func=hash,
    sql_engine=engine
)

# Set function
sql_core.set_func(lambda x: x * 2)

# Set cache
sql_core.set_entry("key1", 42)

# Get cache
key, entry = sql_core.get_entry_by_key("key1")
if entry:
    print(entry.value)  # Output: 42

# Clean expired cache (1 day ago)
sql_core.delete_stale_entries(timedelta(days=1))
```

##### Using Connection String
```python
# Using SQLite file
sql_core = _SQLCore(
    hash_func=hash,
    sql_engine='sqlite:///cache.db'
)
```

### 18. `parse_bytes` Function

**Functionality Description**:
Converts human-readable size strings to byte counts. Supports different units (B, KB, MB, GB, TB) and automatically handles case sensitivity.

**Import Method**:
```python
from cachier.util import parse_bytes
```

**Function Signature**:
```python
def parse_bytes(size: Union[int, str, None]) -> Optional[int]
```

**Parameters**:
- `size` (Union[int, str, None]): The size value to convert, can be of the following types:
  - `int`: Directly returns the integer value
  - `str`: String in the format `"number[unit]"`, such as "1.5MB"
  - `None`: Returns `None`

**Supported Formats**:
- Number part: Integer or floating-point number
- Units (case-insensitive):
  - `B` or empty: Bytes
  - `KB`: Kilobytes (1024 bytes)
  - `MB`: Megabytes (1024² bytes)
  - `GB`: Gigabytes (1024³ bytes)
  - `TB`: Terabytes (1024⁴ bytes)

**Return Value**:
- `Optional[int]`: Converted byte count, returns `None` if input is `None`

**Exceptions**:
- `ValueError`: Thrown when the input format is invalid

**Usage Examples**:
```python
# Basic usage
print(parse_bytes("1.5MB"))     # Output: 1572864
print(parse_bytes("1.5mb"))     # Output: 1572864 (case-insensitive)
print(parse_bytes("1024"))      # Output: 1024 (defaults to bytes)
print(parse_bytes("1.5 GB"))    # Output: 1610612736 (supports spaces)

# Supports directly passing integers
print(parse_bytes(1024))        # Output: 1024

# Returns None cases
print(parse_bytes(None))        # Output: None

# Invalid format examples
try:
    parse_bytes("invalid")
except ValueError as e:
    print(e)  # Output: Invalid size value: invalid

try:
    parse_bytes("123XB")
except ValueError as e:
    print(e)  # Output: Invalid size value: 123XB
```
### 19. `_get_func_str` Function - Get Function Identifier

**Functionality**:
Generates a unique identifier string for a function in the format `.{module_name}.{function_name}`.

**Function Signature**:
```python
def _get_func_str(func: Callable) -> str:
```

**Parameters**:
- `func` (Callable): The function object for which to generate the identifier

**Return Value**:
- `str`: A string in the format `.{module_name}.{function_name}`

**Implementation Details**:
- Uses `func.__module__` to get the module name the function belongs to
- Uses `func.__name__` to get the function name
- Returns a string in the format `.{module}.{name}`

**Usage Example**:
```python
from cachier.cores.base import _get_func_str

def example_function():
    pass

func_str = _get_func_str(example_function)
# Example: ".__main__.example_function"
```

### 20 Cachier Redis Caching Examples

#### 20.1 `setup_redis_client` Function

**Functionality**:
Sets up and returns a Redis client instance for cache operations.

**Function Signature**:
```python
def setup_redis_client() -> Optional[redis.Redis]
```

**Parameters**:
No parameters.

**Return Value**:
- `Optional[redis.Redis]`: Returns a Redis client instance on success, returns `None` if connection fails.

**Exceptions**:
- When the Redis server is unavailable, prints an error message but does not throw an exception.

**Usage Example**:
```python
redis_client = setup_redis_client()
if redis_client:
    print("Redis connection successful")
```

#### 20.2 `expensive_calculation` Function

**Functionality**:
Simulates a time-consuming calculation task to demonstrate caching effects.

**Function Signature**:
```python
def expensive_calculation(n: int) -> int
```

**Parameters**:
- `n` (int): Input value.

**Return Value**:
- `int`: Calculation result, value is `n * n + 42`.

**Explanation**:
- The function internally pauses for 2 seconds to simulate time-consuming calculation.
- Each call prints the calculation process.

#### 20.3 `demo_basic_caching` Function

**Functionality**:
Demonstrates basic Redis caching functionality, including cache setting and retrieval.

**Function Signature**:
```python
def demo_basic_caching() -> None
```

**Parameters**:
No parameters.

**Return Value**:
No return value.

**Explanation**:
- Demonstrates using the `@cachier` decorator to cache function results.
- The first call performs actual calculation, subsequent calls retrieve results directly from cache.

#### 20.4 `cached_calculation` Function

**Functionality**:
A function decorated with `@cachier`, demonstrating basic caching functionality.

**Function Signature**:
```python
@cachier(backend="redis", redis_client=setup_redis_client())
def cached_calculation(n: int) -> int
```

**Parameters**:
- `n` (int): Input value.

**Return Value**:
- `int`: Calculation result.

**Explanation**:
- Uses Redis as the cache backend.
- Multiple calls with the same parameters return results directly from cache.

#### 20.5 `demo_stale_after` Function

**Functionality**:
Demonstrates the use of the `stale_after` parameter to set cache expiration time.

**Function Signature**:
```python
def demo_stale_after() -> None
```

**Parameters**:
No parameters.

**Return Value**:
No return value.

**Explanation**:
- Sets cache to expire after 3 seconds.
- Demonstrates automatic cache invalidation and recalculation.

#### 20.6 `time_sensitive_calculation` Function

**Functionality**:
Demonstrates a caching function with time sensitivity.

**Function Signature**:
```python
@cachier(
    backend="redis",
    redis_client=setup_redis_client(),
    stale_after=timedelta(seconds=3)
)
def time_sensitive_calculation(n: int) -> int
```

**Parameters**:
- `n` (int): Input value.

**Return Value**:
- `int`: Calculation result.

**Explanation**:
- Sets cache to expire after 3 seconds.
- First call after expiration triggers recalculation.

#### 20.7 `demo_callable_client` Function

**Functionality**:
Demonstrates using a callable object as the Redis client.

**Function Signature**:
```python
def demo_callable_client() -> None
```

**Parameters**:
No parameters.

**Return Value**:
No return value.

#### 20.8 `get_redis_client` Function

**Functionality**:
Returns a configured Redis client instance.

**Function Signature**:
```python
def get_redis_client() -> redis.Redis
```

**Parameters**:
No parameters.

**Return Value**:
- `redis.Redis`: Redis client instance.

#### 20.9 `cached_with_callable` Function

**Functionality**:
A caching function using a callable Redis client.

**Function Signature**:
```python
@cachier(backend="redis", redis_client=get_redis_client)
def cached_with_callable(n: int) -> int
```

**Parameters**:
- `n` (int): Input value.

**Return Value**:
- `int`: Calculation result.

#### 20.10 `demo_cache_management` Function

**Functionality**:
Demonstrates cache management functionality, including clearing cache.

**Function Signature**:
```python
def demo_cache_management() -> None
```

**Parameters**:
No parameters.

**Return Value**:
No return value.

#### 20.11 `managed_calculation` Function

**Functionality**:
A function demonstrating cache management.

**Function Signature**:
```python
@cachier(backend="redis", redis_client=setup_redis_client())
def managed_calculation(n: int) -> int
```

**Parameters**:
- `n` (int): Input value.

**Return Value**:
- `int`: Calculation result.

**Explanation**:
- Demonstrates the `clear_cache()` method for clearing cache.


## Detailed Function Implementation Nodes

### Node 1. Basic Caching

**Function Description**: Provide basic function result caching functionality, automatically cache the results of function calls, and directly return the cached results when the same parameters are called again.

**Input and Output Types**:
- Input: Any hashable Python object (function parameters)
- Output: The return value of the function, with the same type as defined in the function

**Test Interface and Example**:
```python
import time
from time import time
from cachier import cachier

def test_memory_core():
    """Basic memory core functionality."""
    @cachier(backend='memory')
    def _takes_2_seconds(arg_1, arg_2):
        time.sleep(2)
        return f"{arg_1}_{arg_2}"
    
    # Clear the cache
    _takes_2_seconds.clear_cache()
    
    # The first call will execute the function and cache the result
    _takes_2_seconds("a", "b")
    
    # The second call with the same parameters will directly get the result from the cache
    start = time()
    result = _takes_2_seconds("a", "b", cachier__verbose=True)  # Get from the cache
    duration = time() - start
    
    # Verify that getting from the cache is faster than executing the function
    assert duration < 1
    
    # Clean up the cache
    _takes_2_seconds.clear_cache()
    start = time.time()
    result = slow_function(1, 2)  # Return from the cache
    end = time.time()
    assert end - start < 0.1  # Much less than 2 seconds
    assert result == 3

# Clean up the cache
slow_function.clear_cache()
```

### Node 2. Expired Cache (Stale After)

**Function Description**: Allow the cache results to expire after a certain period. You can configure whether to recalculate immediately or return the expired result first after the result expires.

**Input and Output Types**:
- Input:
  - `stale_after`: datetime.timedelta, the cache expiration time
  - `next_time`: bool, whether to return the expired result first and then update it in the background after the result expires
- Output: The return value of the function, with the same type as defined in the function

**Test Interface and Example**:
```python
from datetime import timedelta
import time
from random import random

# Example of expired cache - test_stale_after, test_stale_after_next_time
def test_stale_after():
    @cachier(backend='memory', stale_after=timedelta(seconds=2))
    def get_random():
        return random()
    
    # The first call will execute the function and cache the result
    result1 = get_random()
    
    # Calling within 2 seconds will directly return the cached result
    result2 = get_random()
    assert result1 == result2
    
    # Wait for more than 2 seconds, and the result will expire
    time.sleep(2.1)
    
    # Default behavior: Wait for the new result to be calculated
    start = time.time()
    result3 = get_random()  # Will wait for the calculation to complete
    end = time.time()
    assert result3 != result1
    assert end - start >= 0  # Will wait for the calculation to complete
    
    # Use next_time=True to return the expired result first
    @cachier(backend='memory', stale_after=timedelta(seconds=2), next_time=True)
    def get_random_next():
        time.sleep(1)  # Simulate a time-consuming operation
        return random()
    
    result4 = get_random_next()
    time.sleep(2.1)
    
    # Will immediately return the expired result and update the cache in the background
    start = time.time()
    result5 = get_random_next()  # Immediately return the expired result
    end = time.time()
    assert result5 == result4  # Return the expired result
    assert end - start < 0.1  # Immediately return
    
    # Call again later to get the new result
    time.sleep(1.1)
    result6 = get_random_next()
    assert result6 != result4  # New result
```

### Node 3. Cache Control

**Function Description**: Provide cache control functions such as cache clearing, overwriting, and ignoring.

**Input and Output Types**:
- Input: Function parameters or cache keys
- Output: None or the operation result

**Test Interface and Example**:
```python
import random
from time import sleep
from cachier import cachier

# Test the cache overwriting function
def test_overwrite_cache():
    @cachier(backend='memory')
    def _random_num():
        return random.random()
    
    # The first call will cache the result
    num1 = _random_num()
    # Calling again with the same parameters will return the cached result
    num2 = _random_num()
    assert num2 == num1  # The results are the same
    
    # Use overwrite_cache=True to force update the cache
    num3 = _random_num(cachier__overwrite_cache=True)
    assert num3 != num1  # New result
    
    # Subsequent calls will return the new cached result
    num4 = _random_num()
    assert num4 == num3
    
    # Clean up the test cache
    _random_num.clear_cache()

# Test the cache ignoring function
def test_ignore_cache():
    @cachier(backend='memory')
    def _random_num():
        return random.random()
    
    # The first call will cache the result
    num1 = _random_num()
    # Calling again with the same parameters will return the cached result
    num2 = _random_num()
    assert num2 == num1  # The results are the same
    
    # Use skip_cache=True to ignore the cache and directly call the function
    num3 = _random_num(cachier__skip_cache=True)
    assert num3 != num1  # New result
    
    # Calling again will return the original cached result
    num4 = _random_num()
    assert num4 == num1  # Not the result of num3
    
    # Clean up the test cache
    _random_num.clear_cache()
```

### Node 4. Concurrency Control

**Function Description**: Handle concurrency control when multiple threads or processes access the cache simultaneously.

**Input and Output Types**:
- Input: Function parameters
- Output: The return value of the function

**Test Interface and Example**:
```python
import threading
import queue
import time

# Concurrency access test - test_memory_being_calculated
def test_memory_being_calculated():
    """Test the memory core's handling of concurrent calculation scenarios."""
    # Clean up the cache
    _takes_time.clear_cache()
    
    # Create a result queue and threads
    res_queue = queue.Queue()
    thread1 = threading.Thread(
        target=_calls_takes_time, kwargs={"res_queue": res_queue}, daemon=True
    )
    thread2 = threading.Thread(
        target=_calls_takes_time, kwargs={"res_queue": res_queue}, daemon=True
    )
    
    # Start the first thread
    thread1.start()
    # Wait a little to ensure that the first thread has started execution
    time.sleep(0.5)
    # Start the second thread
    thread2.start()
    
    # Wait for the threads to complete
    thread1.join(timeout=3)
    thread2.join(timeout=3)
    
    # Verify the results
    assert res_queue.qsize() == 2  # Ensure that both threads have completed
    res1 = res_queue.get()
    res2 = res_queue.get()
    assert res1 == res2  # Ensure that both threads get the same result
    @cachier(backend='memory')
    def slow_operation():
        time.sleep(1)
        return time.time()
    
    results = queue.Queue()
    
    def worker():
        results.put(slow_operation())
    
    # Start multiple threads to access simultaneously
    threads = []
    for _ in range(5):
        t = threading.Thread(target=worker)
        t.start()
        threads.append(t)
    
    for t in threads:
        t.join()
    
    # All threads should get the same result
    first = results.get()
    while not results.empty():
        assert results.get() == first  # All results should be the same
```

### Node 5. Cache Size Limit

**Function Description**: Limit the size of cache items. Items exceeding the limit will not be cached.

**Input and Output Types**:
- Input:
  - `entry_size_limit`: int or str, the cache item size limit, which can be the number of bytes or a human-readable string (e.g., '10MB')
- Output: The return value of the function, but if the size of the return value exceeds the limit, it will not be cached

**Test Interface and Example**:
```python
def test_entry_size_limit():
    # Limit the cache item size to 100 bytes
    @cachier(backend='memory', entry_size_limit=100)
    def get_data(size):
        return 'x' * size
    
    # Small data will be cached
    small = get_data(50)  # Will be cached
    assert get_data(50) == small  # Get from the cache
    
    # Large data will not be cached
    large = get_data(200)  # Will not be cached
    assert get_data(200) != large  # Will recalculate
    
    # Use a human-readable size limit
    @cachier(backend='memory', entry_size_limit='1KB')
    def get_large_data():
        return 'x' * 5000  # 5KB
    
    result = get_large_data()  # Will be cached
    assert get_large_data() == result  # Get from the cache
```

### Node 6. Custom Hash Function

**Function Description**: Allow customizing the hash function from parameters to cache keys, especially suitable for handling complex data types such as Pandas DataFrame.

**Input and Output Types**:
- Input:
  - `hash_func`: A callable object that takes args and kwargs and returns a cache key
  - Any serializable function parameters
- Output: The return value of the function

**Test Interface and Example**:
```python
import pandas as pd
import hashlib
from cachier import cachier
import random

def test_callable_hash_param():
    """Test the custom hash function for handling DataFrame parameters."""
    def _hash_func(args, kwargs):
        def _hash(obj):
            if isinstance(obj, pd.core.frame.DataFrame):
                # Hash the DataFrame
                return hashlib.sha256(
                    pd.util.hash_pandas_object(obj).values.tobytes()
                ).hexdigest()
            return obj

        # Process positional parameters
        k_args = tuple(map(_hash, args))
        # Process keyword parameters
        k_kwargs = tuple(
            sorted({k: _hash(v) for k, v in kwargs.items()}.items())
        )
        return k_args + k_kwargs

    @cachier(backend="memory", hash_func=_hash_func)
    def _params_with_dataframe(*args, **kwargs):
        """Simulate a function that uses a DataFrame as a parameter."""
        return random.random()

    # Clean up the cache
    _params_with_dataframe.clear_cache()

    # Create two DataFrames with the same content but different objects
    df_a = pd.DataFrame.from_dict({"a": [0], "b": [2], "c": [3]})
    df_b = pd.DataFrame.from_dict({"a": [0], "b": [2], "c": [3]})
    
    # Test positional parameters
    value_a = _params_with_dataframe(df_a, 1)
    value_b = _params_with_dataframe(df_b, 1)
    assert value_a == value_b  # The same content should produce the same cache key

    # Test keyword parameters
    value_c = _params_with_dataframe(1, df=df_a)
    value_d = _params_with_dataframe(1, df=df_b)
    assert value_c == value_d  # The same content should produce the same cache key
```

**Test Description**:
1. The test creates a custom hash function specifically for handling DataFrame type parameters.
2. Use `pd.util.hash_pandas_object` to ensure that DataFrames with the same content generate the same hash value.
3. The test covers both positional and keyword parameter passing methods.
4. It verifies that DataFrames with the same content, even if they are different objects, will be correctly recognized as the same cache key.

### Node 7. Multi-Backend Support

**Function Description**: Support multiple cache backends, including memory, MongoDB, Redis, SQLite, and the file system (through pickle serialization).

**Input and Output Types**:
- Input:
  - `backend`: A string specifying the backend type ('memory', 'mongo', 'redis', 'sql', 'pickle')
  - Backend-specific configuration parameters (such as `mongetter`, `redis_client`, `sql_engine`, etc.)
- Output: The return value of the function

**Test Interface and Example**:
```python
import time
import datetime
import tempfile
from cachier import cachier
from pymongo import MongoClient
import redis

# Test the default parameters of the backend
def test_backend_default_param():
    """Test the global default backend setting."""
    # Set the global backend to memory
    cachier.set_global_params(backend="memory")
    
    # Use the global backend setting (memory)
    @cachier.cachier()
    def global_test_1():
        return time.time()
    
    # Explicitly specify the backend (file system)
    @cachier.cachier(backend="pickle", cache_dir='./cache')
    def global_test_2():
        return time.time()
    
    # Verify that the memory backend does not create cache files
    assert global_test_1.cache_dpath() is None
    # Verify that the file system backend creates cache files
    assert global_test_2.cache_dpath() is not None
```

### Node 8. Cache Cleanup

**Function Description**: Provide the function of automatically cleaning up expired caches. You can set the expiration time of cache items and the cleanup interval.

**Input and Output Types**:
- Input:
  - `stale_after`: timedelta, the expiration time of cache items
  - `cleanup_stale`: bool, whether to automatically clean up expired caches
  - `cleanup_interval`: timedelta, the time interval for automatic cleanup
- Output: None (automatic cleanup) or the number of cleaned cache items (manual cleanup)

**Test Interface and Example**:
```python
import os
import pickle
import time
from datetime import timedelta
import tempfile
from cachier import cachier

def test_cleanup_stale_entries(tmp_path):
    """Test the automatic cleanup of expired cache items."""
    
    # Use a temporary directory as the cache directory
    @cachier(
        cache_dir=tmp_path,  # Use a temporary directory
        stale_after=timedelta(seconds=1),  # Expire after 1 second
        cleanup_stale=True,  # Enable automatic cleanup
        cleanup_interval=timedelta(seconds=0),  # Clean up immediately
    )
    def add(x):
        """A simple addition function."""
        return x + 1

    # Clean up the cache
    add.clear_cache()
    
    # Add two cache items
    add(1)  # Cache key 1
    add(2)  # Cache key 2
    
    # Get the cache file name
    fname = f".{add.__module__}.{add.__qualname__}".replace("<", "_").replace(
        ">", "_"
    )
    cache_path = os.path.join(add.cache_dpath(), fname)
    
    # Verify that there are two items in the cache
    with open(cache_path, "rb") as fh:
        data = pickle.load(fh)
    assert len(data) == 2, "There should be two items in the cache"
    
    # Wait for the cache items to expire
    time.sleep(1.1)
    
    # Call the function again to trigger automatic cleanup
    add(1)  # Will recalculate and clean up the expired cache
    
    # Wait briefly to ensure that the cleanup is completed
    time.sleep(0.2)
    
    # Verify that there is only one item in the cache (the expired item has been cleaned up)
    with open(cache_path, "rb") as fh:
        data = pickle.load(fh)
    assert len(data) == 1, "The expired cache item should have been cleaned up"
```

### Node 9. Concurrency Control Test

**Function Description**: Cachier provides a basic concurrency control mechanism to ensure the safety and consistency of cache operations in a multi-threaded environment.

**Input and Output Types**:
- Input: Function parameters for concurrent calls by multiple threads
- Output:
  - On success: The return result of the function (ensuring thread safety)
  - On failure: Exception information (such as timeout, lock acquisition failure, etc.)

**Test Code Example**:
```python
# Test the concurrency control of the memory backend 
@pytest.mark.memory
def test_memory_being_calculated():
    """Test the concurrency control of the memory backend during calculation."""
    _takes_time.clear_cache()
    res_queue = queue.Queue()
    
    # Start two threads to call the same function simultaneously
    thread1 = threading.Thread(
        target=_calls_takes_time, kwargs={"res_queue": res_queue}, daemon=True
    )
    thread2 = threading.Thread(
        target=_calls_takes_time, kwargs={"res_queue": res_queue}, daemon=True
    )
    
    thread1.start()
    sleep(0.5)  # Ensure that the first thread starts first
    thread2.start()
    
    thread1.join(timeout=3)
    thread2.join(timeout=3)
    
    # Verify that both threads have completed execution
    assert res_queue.qsize() == 2
    res1 = res_queue.get()
    res2 = res_queue.get()
    
    # Verify that both threads get the same result
    assert res1 == res2

# Test the interaction between the "being calculated" state and next_time 
@pytest.mark.memory
def test_being_calc_next_time():
    """Test the interaction between the "being calculated" state and the next_time parameter."""
    _being_calc_next_time.clear_cache()
    res_queue = queue.Queue()
    
    # Start two threads to call the same function simultaneously
    thread1 = threading.Thread(
        target=_calls_being_calc_next_time, 
        kwargs={"res_queue": res_queue}, 
        daemon=True
    )
    thread2 = threading.Thread(
        target=_calls_being_calc_next_time,
        kwargs={"res_queue": res_queue},
        daemon=True,
    )
    
    thread1.start()
    sleep(0.5)  # Ensure that the first thread starts first
    thread2.start()
    
    thread1.join(timeout=3)
    thread2.join(timeout=3)
    
    # Verify that both threads have completed execution
    assert res_queue.qsize() == 2
    res1 = res_queue.get()
    res2 = res_queue.get()
    
    # Verify that both threads get the same result
    assert res1 == res2

# Test clearing the "being calculated" state 
@pytest.mark.memory
def test_clear_being_calculated():
    """Test the function of clearing the "being calculated" state."""
    _bad_cache.clear_cache()
    
    # Set a cache entry that will fail
    with pytest.raises(ValueError):
        _bad_cache(1, 2)
    
    # Verify that the cache entry is in the "being calculated" state
    cache = _bad_cache._caching_enabled[0]
    key = cache.get_key((1, 2), {})
    assert key in cache.being_calculated
    
    # Clear the "being calculated" state
    cache.clear_being_calculated()
    
    # Verify that the "being calculated" state has been cleared
    assert key not in cache.being_calculated
```

### Node 10. Memory Cache Management

**Function Description**: Cachier provides basic cache management functions, including cache item expiration and cleanup mechanisms.

**Main Functions**:
1. **Cache Expiration**: Set the expiration time of cache items through the `stale_after` parameter.
2. **Cache Cleanup**: Support manual and automatic cleanup of expired caches.
3. **Concurrency Control**: Handle the situation where multiple threads access the same cache item simultaneously.

**Test Interface and Example**:

1. **Test Cache Expiration** (`test_stale_after`):
   ```python
   import time
   from datetime import timedelta
   
   @cachier(backend='memory', stale_after=timedelta(seconds=2))
   def get_data():
       return time.time()
   
   # First call - Set the cache
   first = get_data()
   # Call again immediately - Should return the cached value
   assert get_data() == first
   # Call after waiting for expiration - Should return a new value
   time.sleep(2.1)
   assert get_data() != first
   ```

### Node 11. Batch Operation Interface

**Function Description**: Support batch retrieval and setting of cache items to reduce network round-trips.

**Input and Output Types**:
- Input: A list of keys or a dictionary of key-value pairs
- Output: A dictionary of results

**Test Interface and Example**:
```python
def test_batch_operations():
    @cachier(backend='redis', redis_client=get_redis_client)
    def get_item(item_id):
        return f"item_{item_id}"

    # Batch setting
    items_to_cache = {f"item_{i}": f"data_{i}" for i in range(5)}
    for key, value in items_to_cache.items():
        get_item.set(key, value)

    # Batch retrieval
    keys = list(items_to_cache.keys())
    results = {k: get_item(k) for k in keys}
    
    assert results == items_to_cache
```

### Node 12. Serialization and Cache Storage

**Function Description**: Cachier uses pickle as the default serialization mechanism and supports custom cache storage locations.

**Main Functions**:
1. **Pickle Serialization**: Use Python's pickle module for object serialization by default.
2. **Custom Cache Directory**: Specify the storage location of cache files.
3. **File Storage Management**: Support both single-file and separate-file storage modes.

**Test Interface and Examples**:

1. **Test Custom Cache Directory** (`test_pickle_core_custom_cache_dir`):
   ```python
   import os
   from pathlib import Path
   
   # Set a custom cache directory
   CUSTOM_DIR = "~/.custom_cache"
   
   @cachier(cache_dir=CUSTOM_DIR, backend='pickle')
   def get_data():
       return "some data"
   
   # Test whether the cache directory is created correctly
   get_data()
   cache_path = Path(os.path.expanduser(CUSTOM_DIR))
   assert cache_path.exists()
   ```

2. **Test Cache Cleanup** (`test_delete_stale_entries_separate_files`):
   ```python
   import time
   from datetime import datetime, timedelta
   
   # Create an expired cache item
   @cachier(stale_after=timedelta(seconds=1), backend='pickle')
   def get_timestamp():
       return time.time()
   
   # Generate the cache
   get_timestamp()
   
   # Wait for the cache to expire
   time.sleep(2)
   
   # Clean up the expired cache
   get_timestamp.delete_stale_entries()
   ```

### Node 13. Cache Key Generation and Scope

**Function Description**: Cachier automatically generates cache keys using function parameters and supports custom key generation logic through the `hash_func` parameter.

**Main Functions**:
1. **Automatic Key Generation**: Generate unique cache keys using the function name and parameters by default.
2. **Custom Hash Function**: Support custom key generation logic through the `hash_func` parameter.
3. **Function Scope**: The cache of each function is independent and distinguished by the function name.

**Test Interface and Examples**:

1. **Test Custom Hash Function** (`test_callable_hash_param`):
   ```python
   def custom_hash_func(*args, **kwargs):
       # Use only the first parameter as the cache key
       return str(args[0])
   
   @cachier(backend='memory', hash_func=custom_hash_func)
   def get_user_data(user_id, user_type):
       return f"data_for_user_{user_id}_type_{user_type}"
   
   # Using the same user_id but different user_type will get the same result
   # Because the custom hash function only uses user_id
   result1 = get_user_data(1, "premium")
   result2 = get_user_data(1, "free")
   assert result1 == result2
   ```

2. **Test Function Scope** (`test_memory_core`):
   ```python
   @cachier(backend='memory')
   def function_a(x):
       return x * 2
   
   @cachier(backend='memory')
   def function_b(x):
       return x + 10
   
   # The same parameters, different functions, and the caches are independent
   assert function_a(5) == 10
   assert function_b(5) == 15
   ```

### Node 14. Error Handling and Recovery

**Function Description**: Cachier provides a basic error handling mechanism to gracefully handle exceptions when cache operations fail.

**Main Functions**:
1. **Exception Capture**: Capture and record exceptions in cache operations.
2. **Function Fallback**: Still execute the original function when cache operations fail.
3. **Error Isolation**: Cache errors do not affect the execution of the main program.

**Test Interface and Examples**:

1. **Test Error Handling** (`test_error_throwing_func`):
   ```python
   @cachier(backend='memory')
   def process_data(data):
       if data == 'error':
           raise ValueError("Invalid data")
       return f"processed_{data}"
   
   # Test the exception situation
   try:
       process_data('error')
   except ValueError as e:
       assert str(e) == "Invalid data"
   
   # Verify that the cache is still available after the exception
   assert process_data('valid') == "processed_valid"
   ```

2. **Test Cache Cleanup Error Handling** (`test_delete_stale_entries_file_not_found`):
   ```python
   import os
   import tempfile
   from datetime import datetime, timedelta
   
   # Create a temporary cache directory
   with tempfile.TemporaryDirectory() as temp_dir:
       @cachier(cache_dir=temp_dir, stale_after=timedelta(seconds=1))
       def get_timestamp():
           return datetime.now()
       
       # Generate the cache
       get_timestamp()
       
       # Manually delete the cache file
       for f in os.listdir(temp_dir):
           os.remove(os.path.join(temp_dir, f))
       
       # Clean up the expired cache (should gracefully handle the situation where the file does not exist)
       get_timestamp.delete_stale_entries()
   ```

### Node 15. Error Handling and Recovery

**Function Description**: Cachier provides a basic error handling mechanism to gracefully handle exceptions when cache operations fail.

**Main Functions**:
1. **Exception Capture**: Capture and record exceptions in cache operations.
2. **Function Fallback**: Still execute the original function when cache operations fail.
3. **Error Isolation**: Cache errors do not affect the execution of the main program.

**Test Interface and Examples**:

1. **Test Error Handling** (`test_error_throwing_func`):
   ```python
   @cachier(backend='memory')
   def process_data(data):
       if data == 'error':
           raise ValueError("Invalid data")
       return f"processed_{data}"
   
   # Test the exception situation
   try:
       process_data('error')
   except ValueError as e:
       assert str(e) == "Invalid data"
   
   # Verify that the cache is still available after the exception
   assert process_data('valid') == "processed_valid"
   ```

2. **Test Cache Cleanup Error Handling** (`test_delete_stale_entries_file_not_found`):
   ```python
   import os
   import tempfile
   from datetime import datetime, timedelta
   
   # Create a temporary cache directory
   with tempfile.TemporaryDirectory() as temp_dir:
       @cachier(cache_dir=temp_dir, stale_after=timedelta(seconds=1))
       def get_timestamp():
           return datetime.now()
       
       # Generate the cache
       get_timestamp()
       
       # Manually delete the cache file
       for f in os.listdir(temp_dir):
           os.remove(os.path.join(temp_dir, f))
       
       # Clean up the expired cache (should gracefully handle the situation where the file does not exist)
       get_timestamp.delete_stale_entries()
   ```

### Node 16. Cache Management

**Function Description**: Cachier provides various cache management functions, including cache invalidation, cleanup, and manual control.

**Main Functions**:
1. **Manual Cache Invalidation**: Clear the cache through the `clear_cache()` method.
2. **Cache Item Expiration**: Set the cache expiration time using the `stale_after` parameter.
3. **Cache Cleanup**: Delete expired cache items.

**Test Interface and Example**:

 **Test Cache Expiration** (`test_stale_after`):
   ```python
   from datetime import timedelta
   import time
   
   @cachier(backend='memory', stale_after=timedelta(seconds=1))
   def get_timestamp():
       return time.time()
   
   # First call, generate the cache
   first_call = get_timestamp()
   
   # Call again immediately, should return the cached result
   assert get_timestamp() == first_call
   
   # Wait for the cache to expire
   time.sleep(1.1)
   
   # Call again, should recalculate the result
   assert get_timestamp() != first_call
   ```

### Node 17. Cache Debugging and Inspection

**Function Description**: Cachier provides several methods to help debug and inspect the cache state.

**Main Functions**:
1. **Cache State Inspection**: Check whether the cache is enabled and configured.
2. **Cache Key Viewing**: Understand how cache keys are generated.
3. **Cache Content Inspection**: Directly access the cache storage.

**Test Interface and Examples**:

1. **Test Cache State Inspection** :
   ```python
   @cachier(backend='memory')
   def get_data():
       return "test_data"
   
   # Check whether the cache decorator is correctly applied
   assert hasattr(get_data, 'clear_cache')
   assert hasattr(get_data, '_cache')
   
   # The first call should calculate and cache the result
   result1 = get_data()
   
   # The second call should directly return the cached result
   result2 = get_data()
   assert result1 == result2
   ```

2. **Test Cache Key Generation** :
   ```python
   # Use a custom hash function
   def custom_hash_func(*args, **kwargs):
       return f"custom_key_{args[0]}"
   
   @cachier(backend='memory', hash_func=custom_hash_func)
   def get_item(item_id):
       return f"item_{item_id}"
   
   # Check whether the cache key is generated as expected
   assert get_item(123) == "item_123"
   ```