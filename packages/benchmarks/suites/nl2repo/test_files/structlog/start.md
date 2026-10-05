## Introduction and Goals of the structlog Project

structlog is a Python library **for structured logging** that provides a simple, powerful, and fast logging solution. This tool performs exceptionally well in production environments and has been widely used in systems of various scales since 2013, achieving "the highest performance and optimal flexibility." Its core functions include: structured logging (supporting arbitrary key-value pairs and context binding), **support for multiple output formats** (including JSON, logfmt, and colored console output), and seamless integration with the standard library `logging`. In short, structlog is dedicated to providing a modern logging system that allows developers to easily create structured, searchable, and analyzable log outputs (for example, creating a logger via `get_logger()`, binding context via the `bind()` method, and recording structured logs via methods such as `info()`).

## Natural Language Instruction (Prompt)

Please create a Python project named `structlog` to implement a structured logging library. The project should include the following functions:

1. Configuration Management System: It should be able to manage global logging configurations and support core functions such as `configure()`, `configure_once()`, `get_logger()`, and `wrap_logger()`. The configuration system should support flexible configuration of components such as processor chains, wrapper classes, context classes, and logger factories, and provide functions for querying and resetting the configuration status. The `_Configuration` class needs to be implemented in `src/structlog/_config.py` to manage the global configuration status.

2. Structured Logging: Implement the `BoundLogger` class to support structured logging, including methods such as `bind()`, `unbind()`, `try_unbind()`, and `new()` for context management. It should support arbitrary key-value pairs as log fields, automatic timestamps and log levels, exception stack traces, and context information. The `BoundLoggerBase` base class needs to be implemented in `src/structlog/_base.py`.

3. Processor System: Implement a rich processor chain, including processors such as `KeyValueRenderer`, `LogfmtRenderer`, `JSONRenderer`, `TimeStamper`, `StackInfoRenderer`, `CallsiteParameterAdder`, `UnicodeEncoder`, and `UnicodeDecoder`. Each processor should support custom configuration and serialization. All processor classes need to be implemented in `src/structlog/processors.py`.

4. Development Tool Support: Implement the `ConsoleRenderer` to provide colored console output, supporting exception formatting tools such as `RichTracebackFormatter`, `better_traceback`, and `plain_traceback`. It should support advanced features such as color configuration, column formatting, and level styles. The `ConsoleRenderer` and exception formatters need to be implemented in `src/structlog/dev.py`.

5. Standard Library Integration: Implement seamless integration with the Python standard library `logging`, including classes such as `BoundLogger`, `AsyncBoundLogger`, `LoggerFactory`, and `ProcessorFormatter`. It should support both synchronous and asynchronous logging and provide full compatibility with the `logging` interface. All standard library integration classes need to be implemented in `src/structlog/stdlib.py`.

6. Context Management: Implement support for thread-local storage and asynchronous context variables, including functions such as `ThreadLocalDict`, `merge_contextvars`, and `clear_contextvars`. It should support context binding, passing, and cleaning operations. Functions such as `bind_contextvars()` and `clear_contextvars()` need to be implemented in `src/structlog/contextvars.py`, and functions such as `bind_threadlocal()` and `clear_threadlocal()` need to be implemented in `src/structlog/threadlocal.py`.

7. Output System: Implement support for multiple output formats, including `PrintLogger`, `WriteLogger`, `BytesLogger`, and their corresponding factory classes. It should support different output methods such as file output, byte output, and print output. All output logger classes need to be implemented in `src/structlog/_output.py`.

8. Testing Framework: Implement testing tools such as `ReturnLogger`, `ReturnLoggerFactory`, and `CaptureLogs` to support log capturing, verification, and simulation. It should provide complete testing auxiliary functions. All testing tool classes need to be implemented in `src/structlog/testing.py`.

9. Exception Handling: Implement the `DropEvent` exception class and an exception handling mechanism to support exception capturing and graceful degradation in the processor chain. It should provide a comprehensive error handling strategy. The `DropEvent` exception class needs to be implemented in `src/structlog/exceptions.py`.

10. Type System: Implement complete type annotations and type checking support, including type definitions such as `EventDict`, `WrappedLogger`, and `Processor`. It should support static type checking and IDE intelligent prompts. All type definitions need to be implemented in `src/structlog/types.py` and `src/structlog/typing.py`.

11. Framework Integration: Implement support for integration with the Twisted asynchronous framework, including classes such as `TwistedLogger` and `TwistedLoggerFactory`. It should provide asynchronous logging and event loop integration. All Twisted integration classes need to be implemented in `src/structlog/twisted.py`.

12. Utility Functions: Implement utility functions such as `get_processname()`, `_format_exception()`, and `_format_stack()` to support functions such as process name retrieval, exception formatting, and stack formatting. The `get_processname()` function needs to be implemented in `src/structlog/_utils.py`, and the `_format_exception()` and `_format_stack()` functions need to be implemented in `src/structlog/_frames.py`.

13. Exception Tracing System: Implement complete exception tracing and formatting functions, including functions such as `ExceptionDictTransformer`, `safe_str()`, and `to_repr()`. It should support JSON formatting and safe string representation of exception stacks. All exception tracing-related functions need to be implemented in `src/structlog/tracebacks.py`.

14. Configuration Verification: Implement configuration verification and default value management, including functions such as `is_configured()`, `get_config()`, and `reset_defaults()`. It should provide functions for querying and resetting the configuration status. These configuration verification functions need to be implemented in `src/structlog/_config.py`.

15. Performance Optimization: Implement log caching and performance optimization mechanisms, including functions such as `cache_logger_on_first_use` and `make_filtering_bound_logger`. It should support high-performance logging and memory optimization. The `make_filtering_bound_logger()` function needs to be implemented in `src/structlog/_native.py`.

16. Scalability Design: Implement a scalable architecture design, supporting custom components such as processors, renderers, and factory classes. It should provide complete extension interfaces and documentation.

17. Interface Design: Design independent function interfaces for each functional module (such as configuration, logging, processors, and output) to support terminal call testing. Each module should define clear input and output formats.

18. Example and Evaluation Scripts: Provide example code and test cases to demonstrate how to use the `get_logger()` and `configure()` functions for log configuration and recording (for example, `get_logger().info("message", key="value")` should output structured logs). The above functions need to be combined to build a complete structured logging toolkit. The final project should include modules for configuration, recording, processing, output, and testing, along with typical test cases, to form a reproducible logging process.

19. Core File Requirements: The project must include a complete `pyproject.toml` file, which needs to configure the project's installable packages (supporting `pip install` and editable mode installation), declare a complete list of dependencies - including dependencies related to type support, and clearly support Python 3.6 and above. The `pyproject.toml` file needs to ensure through build configuration that all functional modules (such as logger creation, configuration management, log rendering, and context processing) can work properly and support triggering full-function verification through test commands. At the same time, `src/structlog/__init__.py` needs to be provided as a unified API entry. This file needs to import key components from each core module: import configuration and logger management tools such as `configure`, `get_logger`, `wrap_logger`, `configure_once`, and `BoundLoggerLazyProxy` from `_config`; import basic logger classes such as `BoundLoggerBase` and `BoundLogger` from `_base` and `_generic`; import log level constants such as `NAME_TO_LEVEL`, `LEVEL_TO_NAME`, `CRITICAL`, and `WARN` from `_log_levels`; import log processors such as `KeyValueRenderer`, `JSONRenderer`, `TimeStamper`, and `ExceptionRenderer` from `processors`; import thread-local context tools such as `bind_threadlocal` and `clear_threadlocal` from `threadlocal`; import context variable management functions such as `bind_contextvars` and `merge_contextvars` from `contextvars`; import standard library adaptation tools such as `ProcessorFormatter` and `add_log_level` from `stdlib`; import testing auxiliary tools such as `CapturingLogger`, `ReturnLogger`, and `LogCapture` from `testing`; import type hints such as `BindableLogger` and `EventDict` from `typing`; import development tools such as `ConsoleRenderer` from `dev`; import the `DropEvent` exception class from `exceptions`; in addition, import logger implementations such as `PrintLogger` and `BytesLogger` and utility functions such as `get_processname`, and provide version information such as `__version__`. Ensure that users can access all major functions through a simple `from structlog import get_logger, configure, BoundLogger, JSONRenderer` statement. In `src/structlog/_config.py`, in addition to `configure()`, `get_logger()`, and `wrap_logger()`, `configure_once()` also needs to be implemented to ensure that the configuration takes effect only once, define `BoundLoggerLazyProxy` for lazy initialization of the logger, and manage the global configuration object `_CONFIG` and default configuration items such as `_BUILTIN_DEFAULT_PROCESSORS` and `_BUILTIN_DEFAULT_LOGGER_FACTORY` to support the core logic of global logging configuration and logger creation and provide a unified configuration entry for other modules.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.0

### Versions of Core Dependent Libraries

```Plain
# Core logging library
typing-extensions>=4.0.0              # Type annotation extension support


# Type checking
mypy>=1.4                             # Static type checking
rich                                  # Rich text terminal support
twisted                               # Asynchronous framework support

# Documentation generation
cogapp                                # Code generation tool
furo                                  # Sphinx theme
myst-parser                           # Markdown parser
sphinx                                # Documentation generator
sphinx-notfound-page                  # 404 page generation
sphinxcontrib-mermaid                 # Diagram support
sphinxext-opengraph                   # Open Graph support

# Development tools
ruff                                  # Code formatting and checking
coverage                              # Code coverage
interrogate                           # Documentation coverage
```

## structlog Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .git_archival.txt           
├── .gitattributes              
├── .gitignore
├── .pre-commit-config.yaml
├── .python-version-default
├── .readthedocs.yaml
├── CHANGELOG.md
├── COPYRIGHT
├── LICENSE-APACHE
├── LICENSE-MIT
├── NOTICE
├── README.md
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── BoundLogger.svg
│   │   ├── Justfile
│   │   ├── console_renderer.png
│   │   ├── custom.css
│   │   ├── docset-icon.png
│   │   ├── docset-icon@2x.png
│   │   ├── social card.afdesign
│   │   ├── sponsors
│   │   │   ├── FilePreviews.svg
│   │   │   ├── Klaviyo.svg
│   │   │   ├── Polar.svg
│   │   │   ├── Privacy-Solutions.svg
│   │   │   ├── Sentry.svg
│   │   │   ├── Tidelift.svg
│   │   │   ├── Variomedia.svg
│   │   │   └── emsys-renewables.svg
│   │   ├── structlog_logo.afdesign
│   │   ├── structlog_logo.png
│   │   ├── structlog_logo.svg
│   │   ├── structlog_logo_horizontal.afdesign
│   │   ├── structlog_logo_horizontal.svg
│   │   └── structlog_logo_small.png
│   ├── api.rst
│   ├── bound-loggers.md
│   ├── conf.py
│   ├── configuration.md
│   ├── console-output.md
│   ├── contextvars.md
│   ├── exceptions.md
│   ├── frameworks.md
│   ├── getting-started.md
│   ├── glossary.md
│   ├── index.md
│   ├── license.md
│   ├── logging-best-practices.md
│   ├── make.bat
│   ├── performance.md
│   ├── processors.md
│   ├── recipes.md
│   ├── standard-library.md
│   ├── testing.md
│   ├── thread-local.md
│   ├── twisted.md
│   ├── typing.md
│   └──why.md
├── pyproject.toml
├── show_off.py
├── src
│   ├── structlog
│   │   ├── __init__.py
│   │   ├── _base.py
│   │   ├── _config.py
│   │   ├── _frames.py
│   │   ├── _generic.py
│   │   ├── _greenlets.py
│   │   ├── _log_levels.py
│   │   ├── _native.py
│   │   ├── _output.py
│   │   ├── _utils.py
│   │   ├── contextvars.py
│   │   ├── dev.py
│   │   ├── exceptions.py
│   │   ├── processors.py
│   │   ├── py.typed
│   │   ├── stdlib.py
│   │   ├── testing.py
│   │   ├── threadlocal.py
│   │   ├── tracebacks.py
│   │   ├── twisted.py
│   │   ├── types.py
│   │   └── typing.py
├── tox.ini
└── zizmor.yml
```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from structlog._output import (
    PrintLogger, BytesLogger, WriteLogger,
    BytesLoggerFactory, PrintLoggerFactory, WriteLoggerFactory
)
from structlog.testing import ReturnLogger
from structlog._config import (
    configure, configure_once, get_logger,
    get_context, wrap_logger, get_config
)
from structlog._native import make_filtering_bound_logger
from structlog._log_levels import (
    NAME_TO_LEVEL, LEVEL_TO_NAME, CRITICAL, WARN,
)
from structlog._utils import get_processname
from structlog._config import (
    _CONFIG, _BUILTIN_DEFAULT_CONTEXT_CLASS, _BUILTIN_DEFAULT_LOGGER_FACTORY,
    _BUILTIN_DEFAULT_PROCESSORS, _BUILTIN_DEFAULT_WRAPPER_CLASS, BoundLoggerLazyProxy,
)
from structlog._base import BoundLoggerBase
from structlog._output import WRITE_LOCKS, stderr, stdout
from structlog._native import _nop
from structlog._frames import (
    _find_first_app_frame_and_name, _format_exception, _format_stack,
)
from structlog._generic import BoundLogger
from structlog.processors import (
    KeyValueRenderer, JSONRenderer, LogfmtRenderer,
    MaybeTimeStamper, TimeStamper, ExceptionRenderer, CallsiteParameter,
    CallsiteParameterAdder, EventRenamer, ExceptionPrettyPrinter,
    StackInfoRenderer, UnicodeDecoder,  UnicodeEncoder,
    format_exc_info, _json_fallback_handler, _figure_out_exc_info,
)
from structlog.threadlocal import (
    _CONTEXT, as_immutable, bind_threadlocal, bound_threadlocal,
    clear_threadlocal, get_merged_threadlocal, get_threadlocal,
    merge_threadlocal, merge_threadlocal_context, tmp_bind,
    unbind_threadlocal, wrap_dict,
)
from structlog.contextvars import (
    _CONTEXT_VARS, bind_contextvars, bound_contextvars, clear_contextvars,
    get_contextvars, get_merged_contextvars, merge_contextvars,
    reset_contextvars, unbind_contextvars,
)
from structlog.stdlib import (
    AsyncBoundLogger, BoundLogger, ExtraAdder, LoggerFactory, PositionalArgumentsFormatter,
    ProcessorFormatter, _FixedFindCallerLogger, add_log_level, add_log_level_number,
    add_logger_name, filter_by_level, recreate_defaults, render_to_log_args_and_kwargs,
    render_to_log_kwargs,
)
from structlog.testing import (
    ReturnLogger, CapturedCall,  CapturingLogger, CapturingLoggerFactory,
    LogCapture, ReturnLoggerFactory,
)
from structlog.exceptions import DropEvent
from structlog.typing import (
    BindableLogger, EventDict, FilteringBoundLogger, ExcInfo,
)
from structlog.dev import ConsoleRenderer
```

#### 2. `get_logger()` Function - Get a Logger

`get_logger` has two main definitions in `structlog`, located in the `structlog._config` and `structlog.stdlib` modules respectively. The core functionality is provided by `structlog._config.get_logger`, while `structlog.stdlib.get_logger` builds upon it by offering more precise type hints and returning a `BoundLogger` integrated with the Python standard library.

##### 2.1. structlog.stdlib.get_logger

**Function**: 
This function is a wrapper around the core `structlog.get_logger`, providing more specific type hints (returning `structlog.stdlib.BoundLogger`). It is used to obtain a logger generated according to the current *structlog* configuration and integrated with the standard library `logging`. Before calling this function, you must ensure that *structlog* has been correctly configured to work with the standard library.

**Function Signature**:
```python
def get_logger(*args: Any, **initial_values: Any) -> BoundLogger:
```

**Parameter Description**:
- `*args` (Any): Optional positional arguments that are passed unmodified to the configured logger factory (`logger_factory`). The specific meaning of these arguments depends on the factory's implementation. For example, when using `structlog.stdlib.LoggerFactory`, the first positional argument can be used to specify the logger name.
- `**initial_values` (Any): Initial key-value pairs used to pre-populate the log context. These values are bound to the newly created logger and will appear in all log entries produced by this logger.

**Return Value**:
- `BoundLogger`: An instance or a proxy of `structlog.stdlib.BoundLogger`. This is a logger that has already bound the initial context, and its methods (such as `info`, `debug`, etc.) are compatible with the standard library `logging.Logger`.

##### 2.2. structlog._config.get_logger 

**Function**: 
This is a convenience function that returns a logger proxy according to the global configuration. When this proxy is used for the first time, it creates a correctly configured bound logger. This is the general entry point for obtaining a *structlog* logger.

**Function Signature**:
```python
def get_logger(*args: Any, **initial_values: Any) -> Any:
```

**Parameter Description**:
- `*args` (Any): Has the same meaning as `*args` in the `stdlib` version, passed to the logger factory.
- `**initial_values` (Any): Has the same meaning as `**initial_values` in the `stdlib` version, used to initialize the context.

**Return Value**:
- `Any`: A proxy object (`BoundLoggerLazyProxy`). This proxy will only create and return a configured bound logger when necessary (for example, when a logging method is called for the first time). By default, the type of the returned bound logger is `structlog.BoundLogger`, but this can be changed by configuring the `wrapper_class`.

#### 3. `configure()` Function - Configure `structlog`

**Function**: Globally configure the processor chain, wrapper, context class, logger factory, etc., of `structlog`.

**Function Signature**:
```python
def configure(
    processors: Iterable[Processor] | None = None,
    wrapper_class: type[BindableLogger] | None = None,
    context_class: type[Context] | None = None,
    logger_factory: Callable[..., WrappedLogger] | None = None,
    cache_logger_on_first_use: bool | None = None,
) -> None:
```

**Parameter Description**:
- `processors`: The processor chain.
- `wrapper_class`: The wrapper class.
- `context_class`: The context class.
- `logger_factory`: The logger factory.
- `cache_logger_on_first_use`: Whether to cache the logger.

#### 4. `BoundLogger` Class - Structured Logger

**Note**: There are three different BoundLogger class definitions in structlog, located in different files:

**4.1 Generic `BoundLogger` Class** 
**Class Signature**:
```python
from structlog._generic import BoundLogger

class BoundLogger(BoundLoggerBase):
```

**Function**: Generic structured logger that supports dynamic method creation and method caching.

**Main Methods**:
- `__getattr__(method_name)`: Dynamically create logging methods
- `__getstate__()`: Serialization support
- `__setstate__(state)`: Deserialization support

---

**4.2 Standard Library BoundLogger Class** 
**Class Signature**:
```python
from structlog.stdlib import BoundLogger

class BoundLogger(BoundLoggerBase):
    # Context management methods
    def bind(self, **new_values: Any) -> Self:
        """Return a new logger with new_values added to the existing ones."""

    def unbind(self, *keys: str) -> Self:
        """Return a new logger with keys removed from the context. Raises KeyError if key not found."""
       
    def try_unbind(self, *keys: str) -> Self:
        """Like unbind, but best effort: missing keys are ignored."""
       
    def new(self, **new_values: Any) -> Self:
        """Clear context and binds initial_values using bind."""
       
    
    # Synchronous logging methods
    def debug(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.debug with the result."""
       
    def info(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.info with the result."""
       
    def warning(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.warning with the result."""
       
    def warn(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Alias for warning method."""
       
    def error(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.error with the result."""
       
    def critical(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.critical with the result."""
       
    def fatal(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.critical with the result."""
       
    def exception(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call logging.Logger.exception with the result, after setting exc_info to True if not already set."""
       
    def log(self, level: int, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """Process event and call the appropriate logging method depending on level."""
       
    
    # Asynchronous logging methods (version 23.1.0+)
    async def adebug(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using debug(), but asynchronously in a separate thread."""
       
    async def ainfo(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using info(), but asynchronously in a separate thread."""
       
    async def awarning(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using warning(), but asynchronously in a separate thread."""
       
    async def aerror(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using error(), but asynchronously in a separate thread."""
       
    async def acritical(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using critical(), but asynchronously in a separate thread."""
       
    async def afatal(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using critical(), but asynchronously in a separate thread."""
       
    async def aexception(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using exception(), but asynchronously in a separate thread."""
       
    async def alog(self, level: Any, event: str, *args: Any, **kw: Any) -> None:
        """Log using log(), but asynchronously in a separate thread."""
       
    
    # Pass-through properties to mimic stdlib logger interface
    @property
    def name(self) -> str:
        """Returns logging.Logger.name"""
       
    @property
    def level(self) -> int:
        """Returns logging.Logger.level"""
       
    @property
    def parent(self) -> Any:
        """Returns logging.Logger.parent"""
       
    @property
    def propagate(self) -> bool:
        """Returns logging.Logger.propagate"""
       
    @property
    def handlers(self) -> Any:
        """Returns logging.Logger.handlers"""
       
    @property
    def disabled(self) -> int:
        """Returns logging.Logger.disabled"""
       
    
    # Pass-through methods to mimic stdlib logger interface
    def setLevel(self, level: int) -> None:
        """Calls logging.Logger.setLevel with unmodified arguments."""
       
    def findCaller(self, stack_info: bool = False) -> tuple[str, int, str, str | None]:
        """Calls logging.Logger.findCaller with unmodified arguments."""
       
    def makeRecord(self, name: str, level: int, fn: str, lno: int, msg: str, args: tuple[Any,...], exc_info: ExcInfo, func: str | None = None, extra: Any = None) -> logging.LogRecord:
        """Calls logging.Logger.makeRecord with unmodified arguments."""
        
    def handle(self, record: logging.LogRecord) -> None:
        """Calls logging.Logger.handle with unmodified arguments."""
        
    def addHandler(self, hdlr: logging.Handler) -> None:
        """Calls logging.Logger.addHandler with unmodified arguments."""
        
    def removeHandler(self, hdlr: logging.Handler) -> None:
        """Calls logging.Logger.removeHandler with unmodified arguments."""
        
    def hasHandlers(self) -> bool:
        """Calls logging.Logger.hasHandlers with unmodified arguments."""
        
    def callHandlers(self, record: logging.LogRecord) -> None:
        """Calls logging.Logger.callHandlers with unmodified arguments."""
        
    def getEffectiveLevel(self) -> int:
        """Calls logging.Logger.getEffectiveLevel with unmodified arguments."""
        
    def isEnabledFor(self, level: int) -> bool:
        """Calls logging.Logger.isEnabledFor with unmodified arguments."""
        
    def getChild(self, suffix: str) -> logging.Logger:
        """Calls logging.Logger.getChild with unmodified arguments."""
        
```

**Function**: BoundLogger compatible with Python standard library logging module, providing complete logging methods and pass-through access to underlying logger properties and methods.

**Main Methods**:
- **Context Management**: `bind(**new_values)`, `unbind(*keys)`, `try_unbind(*keys)`, `new(**new_values)`
- **Synchronous Logging**: `debug/info/warning/warn/error/critical/fatal/exception/log`
- **Asynchronous Logging**: `adebug/ainfo/awarning/aerror/acritical/afatal/aexception/alog` (version 23.1.0+)
- **Pass-through Properties**: `name`, `level`, `parent`, `propagate`, `handlers`, `disabled`
- **Pass-through Methods**: `setLevel`, `findCaller`, `makeRecord`, `handle`, `addHandler`, `removeHandler`, `hasHandlers`, `callHandlers`, `getEffectiveLevel`, `isEnabledFor`, `getChild`

---

**4.3 Twisted BoundLogger Class** (src/structlog/twisted.py)
**Class Signature**:
```python
from structlog.twisted import BoundLogger

class BoundLogger(BoundLoggerBase):
    def msg(self, event: str, *args: Any, **kw: Any) -> Any:
        # Process event and call ``log.msg()`` with the result.
    def err(self, event: str, *args: Any, **kw: Any) -> Any:
        # Process event and call ``log.err()`` with the result.
```

**Function**: BoundLogger compatible with Twisted async framework, providing Twisted-style logging methods.

**Main Methods**:
- `msg(event, *args, **kw)`: Log message
- `err(event, *args, **kw)`: Log error message

#### 5. Processor System (`processors` Submodule)

**5.1 KeyValueRenderer Class** - Key-value pair renderer

**Class Signature**:
```python
from structlog.processors import KeyValueRenderer

class KeyValueRenderer:
    def __init__(
        self,
        sort_keys: bool = False,
        key_order: Sequence[str] | None = None,
        drop_missing: bool = False,
        repr_native_str: bool = True,
    ) -> None:
        # Initialize renderer with provided configuration
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> str:
        # Render event_dict to key=value formatted string
        # Returns: Formatted string representation of the event dictionary
```

**Function**: Render event dictionary as key-value pair format string.

**Parameter Description**:
- `sort_keys`: Whether to sort keys
- `key_order`: Display order of keys
- `drop_missing`: Whether to drop missing keys
- `repr_native_str`: Whether to use repr for native strings

**Return Value**: Key-value pair format string

---

**5.2 LogfmtRenderer Class** - logfmt format renderer

**Class Signature**:
```python
from structlog.processors import LogfmtRenderer

class LogfmtRenderer:
    def __init__(
        self,
        sort_keys: bool = False,
        key_order: Sequence[str] | None = None,
        drop_missing: bool = False,
        bool_as_flag: bool = False,
    ) -> None:
        # Initialize logfmt renderer with configuration options
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> str:
        # Convert event_dict to logfmt formatted string (key=value pairs)
        # Returns: String in logfmt format
```

**Function**: Render event dictionary as logfmt format string.

**Parameter Description**:
- `sort_keys`: Whether to sort keys
- `key_order`: Display order of keys
- `drop_missing`: Whether to drop missing keys
- `bool_as_flag`: Whether to treat boolean values as flags

**Return Value**: logfmt format string



---


**5.3 JSONRenderer Class** - JSON renderer

**Class Signature**:
```python
from structlog.processors import JSONRenderer

class JSONRenderer:
    def __init__(self, serializer: Callable[..., str] | None = None) -> None:
        # Initialize JSON renderer with optional custom serializer
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> str:
        # Convert event_dict to JSON formatted string
        # Returns: String in JSON format
```

**Function**: Render event dictionary as JSON format string.

**Parameter Description**:
- `serializer`: Custom JSON serializer

**Return Value**: JSON format string
---

##### 5.4. TimeStamper Class - Timestamp Processor

**Function**:
`TimeStamper` is a *structlog* processor used to add a timestamp to the event dictionary (`event_dict`). It can generate timestamps in different formats according to configuration, such as ISO 8601 format, UNIX timestamp, or custom string format. This class is picklable.

**Class Definition**:
```python
class TimeStamper:
    __slots__ = ("_stamper", "fmt", "key", "utc")

    def __init__(
        self,
        fmt: str | None = None,
        utc: bool = True,
        key: str = "timestamp",
    ) -> None:

    def __call__(
        self, logger: WrappedLogger, name: str, event_dict: EventDict
    ) -> EventDict:

    def __getstate__(self) -> dict[str, Any]:

    def __setstate__(self, state: dict[str, Any]) -> None:

```

---

`__init__()`

**Function**: Initialize a `TimeStamper` instance.

**Function Signature**:
```python
def __init__(
    self,
    fmt: str | None = None,
    utc: bool = True,
    key: str = "timestamp",
) -> None:
```

**Parameter Description**:
- `fmt` (str | None): String used to format the timestamp. It can be:
  - A `strftime` format string (e.g., `"%Y-%m-%d %H:%M:%S"`).
  - `"iso"`: Generates an ISO 8601 formatted timestamp string.
  - `None` (default): Generates a UNIX timestamp (float).
- `utc` (bool): Specifies whether the timestamp should be in UTC time. If `fmt` is `None` (UNIX timestamp), this parameter must be `True` because UNIX timestamps are always based on UTC. Defaults to `True`.
- `key` (str): The key name used to store the timestamp in the event dictionary. Defaults to `"timestamp"`.

---

`__call__()`

**Function**: When called as a processor, adds a timestamp to the event dictionary.

**Function Signature**:
```python
def __call__(
    self, logger: WrappedLogger, name: str, event_dict: EventDict
) -> EventDict:
```

**Parameter Description**:
- `logger` (WrappedLogger): The current logger instance (unused).
- `name` (str): The name of the logging method (e.g., `"info"`, unused).
- `event_dict` (EventDict): The *structlog* event dictionary.

**Return Value**:
- `EventDict`: The event dictionary with the added timestamp key-value pair.

---

`__getstate__()` and `__setstate__()`

**Function**: These two methods enable `TimeStamper` instances to be pickled and unpickled. This is particularly important when using *structlog* in multi-process environments.

- `__getstate__()`: Called during pickling, returns a dictionary containing the instance's configuration (`fmt`, `utc`, `key`).
- `__setstate__()`: Called during unpickling, uses the state dictionary to restore the instance's configuration and internal timestamp generation function.

---

**5.5 StackInfoRenderer Class** - Stack info renderer

**Class Signature**:
```python
from structlog.processors import StackInfoRenderer

class StackInfoRenderer:
    def __init__(self, additional_ignores: Sequence[str] | None = None) -> None:
        # Initialize stack info renderer with optional module ignore list
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
        # Add stack information to event dictionary if 'stack_info' is True
        # Returns: Modified event dictionary with stack information
```

**Function**: Add stack information to event dictionary.

**Parameter Description**:
- `additional_ignores`: Additional module names to ignore

**Return Value**: Event dictionary with stack information added

---


**5.6 CallsiteParameterAdder Class** - Callsite parameter adder

**Class Signature**:
```python
from structlog.processors import CallsiteParameterAdder

class CallsiteParameterAdder:
    def __init__(
        self,
        parameters: Sequence[CallsiteParameter] | None = None,
        additional_ignores: Sequence[str] | None = None,
    ) -> None:
        # Initialize with parameters to capture and modules to ignore
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
        # Add callsite information (filename, line number, etc.) to event_dict
        # Returns: Event dictionary with callsite parameters
```

**Function**: Add callsite parameters (filename, line number, function name, etc.) to event dictionary.

**Parameter Description**:
- `parameters`: List of callsite parameters to add
- `additional_ignores`: Additional module names to ignore

**Return Value**: Event dictionary with callsite parameters added

---

**5.7 UnicodeEncoder Class** - Unicode encoder

**Class Signature**:
```python
from structlog.processors import UnicodeEncoder

class UnicodeEncoder:
    def __init__(self, encoding: str = "utf-8", errors: str = "backslashreplace") -> None:
        # Initialize encoder with specified encoding and error handling
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
        # Encode Unicode strings in event_dict to byte strings
        # Returns: Event dictionary with encoded strings
```

**Function**: Encode Unicode strings in event dictionary to byte strings.

**Parameter Description**:
- `encoding`: Encoding format
- `errors`: Error handling strategy

**Return Value**: Encoded event dictionary

---

**5.8 UnicodeDecoder Class** - Unicode decoder

**Class Signature**:
```python
from structlog.processors import UnicodeDecoder

class UnicodeDecoder:
    def __init__(self, encoding: str = "utf-8", errors: str = "replace") -> None:
        # Initialize decoder with specified encoding and error handling
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
        # Decode byte strings in event_dict to Unicode strings
        # Returns: Event dictionary with decoded strings
```

**Function**: Decode byte strings in event dictionary to Unicode strings.

**Parameter Description**:
- `encoding`: Encoding format
- `errors`: Error handling strategy

**Return Value**: Decoded event dictionary

---

**5.9 ExceptionPrettyPrinter Class** - Exception pretty printer

**Class Signature**:
```python
from structlog.processors import ExceptionPrettyPrinter

class ExceptionPrettyPrinter:
    def __init__(
        self,
        file: TextIO | None = None,
        exception_formatter: Callable[[TextIO, ExcInfo], None] | None = None,
    ) -> None:
        # Initialize pretty printer with output file and formatter
        # Returns: None (initializer method)
    
    def __call__(self, logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
        # Pretty print exception information to configured output
        # Returns: Unmodified event dictionary
```

**Function**: Pretty print exception information to specified file.

**Parameter Description**:
- `file`: Output file, defaults to stdout
- `exception_formatter`: Custom exception formatter

**Return Value**: Processed event dictionary

#### 6. Standard Library Integration (`stdlib` Submodule)

**6.1 ProcessorFormatter Class** - Processor formatter

**Class Signature**:
```python
from structlog.stdlib import ProcessorFormatter

class ProcessorFormatter(logging.Formatter):
    def __init__(
        self,
        processor: Processor | None = None,
        processors: Sequence[Processor] | None = None,
        foreign_pre_chain: Sequence[Processor] | None = None,
        keep_exc_info: bool = False,
        keep_stack_info: bool = False,
        logger: logging.Logger | None = None,
        pass_foreign_args: bool = False,
        use_get_message: bool = False,
    ) -> None:
        # Initialize formatter with processor chain and logging configuration
        # Returns: None (initializer method)
    
    def format(self, record: logging.LogRecord) -> str:
        # Process and format log record using configured processors
        # Returns: Formatted log message as string
```

**Function**: Integrate structlog processors into standard library logging Formatter.

**Parameter Description**:
- `processor`: Single processor
- `processors`: List of processors
- `foreign_pre_chain`: External pre-processor chain
- `keep_exc_info`: Whether to keep exception information
- `keep_stack_info`: Whether to keep stack information
- `logger`: Associated logger
- `pass_foreign_args`: Whether to pass external arguments
- `use_get_message`: Whether to use get_message method

**Return Value**: Formatted log string

---

**6.2 LoggerFactory Class** - Logger factory

**Class Signature**:
```python
from structlog.stdlib import LoggerFactory

class LoggerFactory:
    def __init__(self, ignore_frame_names: Sequence[str] | None = None) -> None:
        # Initialize factory with optional frame names to ignore
        # Returns: None (initializer method)
    
    def __call__(self, *args: Any) -> logging.Logger:
        # Create and return a new logging.Logger instance
        # Returns: Configured logging.Logger object
```

**Function**: Factory class for creating standard library logging.Logger instances.

**Parameter Description**:
- `ignore_frame_names`: List of frame names to ignore

**Return Value**: logging.Logger instance

---

**6.3 AsyncBoundLogger Class** - Asynchronous bound logger

**Class Signature**:
```python
from structlog.stdlib import AsyncBoundLogger

class AsyncBoundLogger:
    def __init__(
        self,
        logger: logging.Logger,
        processors: Iterable[Processor],
        context: Context,
        *,
        _sync_bl: Any = None,  # Only as an optimization for binding!
        _loop: Any = None,
    ):
        """Initialize AsyncBoundLogger with logger, processors, and context."""
        
    
    @property
    def _context(self) -> Context:
        """Return the context from the wrapped synchronous logger."""
    
    @property
    def sync_bl(self) -> BoundLogger:
        """The wrapped synchronous logger. Useful for occasional synchronous logging."""
    
    # Context management methods
    def bind(self, **new_values: Any) -> Self:
        """Return a new AsyncBoundLogger with new_values added to the existing context."""
       
    def unbind(self, *keys: str) -> Self:
        """Return a new AsyncBoundLogger with keys removed from the context."""
        
    def try_unbind(self, *keys: str) -> Self:
        """Like unbind, but best effort: missing keys are ignored."""
       
    def new(self, **new_values: Any) -> Self:
        """Clear context and binds initial_values using bind."""
       
    
    # Asynchronous logging methods
    async def debug(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using debug(), but asynchronously in a separate thread."""
        
    async def info(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using info(), but asynchronously in a separate thread."""
        
    async def warning(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using warning(), but asynchronously in a separate thread."""
       
    async def warn(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using warning(), but asynchronously in a separate thread."""
        
    async def error(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using error(), but asynchronously in a separate thread."""
        
    async def critical(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using critical(), but asynchronously in a separate thread."""
        
    async def fatal(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using critical(), but asynchronously in a separate thread."""
        
    async def exception(self, event: str, *args: Any, **kw: Any) -> None:
        """Log using exception(), but asynchronously in a separate thread."""
        
    async def log(self, level: Any, event: str, *args: Any, **kw: Any) -> None:
        """Log using log(), but asynchronously in a separate thread."""
        
```

**Function**: Wraps a BoundLogger & exposes its logging methods as async versions. Instead of blocking the program, they are run asynchronously in a thread pool executor. This means more computational overhead per log call, but also means that the processor chain (e.g. JSON serialization) and I/O won't block your whole application. Only available for Python 3.7 and later.

**Note**: This class is deprecated since version 23.1.0. Use the regular BoundLogger with its a-prefixed methods instead.

**Main Methods**:
- **Context Management**: `bind(**new_values)`, `unbind(*keys)`, `try_unbind(*keys)`, `new(**new_values)`
- **Asynchronous Logging**: `debug/info/warning/warn/error/critical/fatal/exception/log`
- **Properties**: `_context`, `sync_bl`

---

**6.4 recreate_defaults Function** - Recreate default configuration

**Function Signature**:
```python
from structlog.stdlib import recreate_defaults

def recreate_defaults() -> None:
```

**Function**: Recreate default configuration for standard library logging.

**Return Value**: No return value

#### 7. Context Management (`contextvars`/`threadlocal` Submodules)

**7.1 Asynchronous Context Management (contextvars module)**

**7.1.1 bind_contextvars Function** - Bind Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import bind_contextvars

def bind_contextvars(**kw: Any) -> Mapping[str, contextvars.Token[Any]]:
```

**Function**: Bind key-value pairs to asynchronous context variables.

**Parameter Description**:
- `**kw`: Key-value pairs to bind

**Return Value**: Context variable token dictionary for subsequent reset

---

**7.1.2 clear_contextvars Function** - Clear Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import clear_contextvars

def clear_contextvars() -> None:
```

**Function**: Clear the context-local context. The typical use-case for this function is to invoke it early in request-handling code.

**Return Value**: No return value

**Version**: Added in 20.1.0, changed in 21.1.0.

---

**7.1.3 merge_contextvars Function** - Merge asynchronous context

**Function Signature**:
```python
from structlog.contextvars import merge_contextvars

def merge_contextvars(
    logger: WrappedLogger, 
    method_name: str, 
    event_dict: EventDict
) -> EventDict:
```

**Function**: Merge asynchronous context variables into event dictionary.

**Parameter Description**:
- `logger`: Wrapped logger
- `method_name`: Method name
- `event_dict`: Event dictionary

**Return Value**: Event dictionary with merged context

**Version**: Added in 20.1.0, changed in 21.1.0.

----

**7.1.4 get_contextvars Function** - Get Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import get_contextvars

def get_contextvars() -> dict[str, Any]:
```

**Function**: Return a copy of the structlog-specific context-local context.

**Return Value**: Dictionary containing context-local context

**Version**: Added in 21.2.0.

----

**7.1.5 get_merged_contextvars Function** - Get Merged Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import get_merged_contextvars

def get_merged_contextvars(bound_logger: BindableLogger) -> dict[str, Any]:
```

**Function**: Return a copy of the current context-local context merged with the context from bound_logger.

**Parameter Description**:
- `bound_logger`: Bound logger instance

**Return Value**: Dictionary containing merged context

**Version**: Added in 21.2.0.

----

**7.1.6 reset_contextvars Function** - Reset Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import reset_contextvars

def reset_contextvars(**kw: contextvars.Token[Any]) -> None:
```

**Function**: Reset contextvars corresponding to the given Tokens.

**Parameter Description**:
- `**kw`: Context variable tokens to reset

**Return Value**: No return value

**Version**: Added in 21.1.0.

----

**7.1.7 unbind_contextvars Function** - Unbind Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import unbind_contextvars

def unbind_contextvars(*keys: str) -> None:
```

**Function**: Remove keys from the context-local context if they are present. Use this instead of `structlog.BoundLogger.unbind` when you want to remove keys from a global (context-local) context.

**Parameter Description**:
- `*keys`: Keys to remove from context-local context

**Return Value**: No return value

**Version**: Added in 20.1.0, changed in 21.1.0.

----

**7.1.8 bound_contextvars Function** - Context Manager for Asynchronous Context

**Function Signature**:
```python
from structlog.contextvars import bound_contextvars

@contextlib.contextmanager
def bound_contextvars(**kw: Any) -> Generator[None, None, None]:
```

**Function**: Bind kw to the current context-local context. Unbind or restore kw afterwards. Do not affect other keys. Can be used as a context manager or decorator.

**Parameter Description**:
- `**kw`: Key-value pairs to bind to context-local context

**Return Value**: Context manager that yields None

**Version**: Added in 21.4.0.

---

**7.2 Thread-local Context Management (threadlocal module)**

**7.2.1 bind_threadlocal Function** - Bind thread-local context

**Function Signature**:
```python
from structlog.threadlocal import bind_threadlocal

def bind_threadlocal(**kw: Any) -> None:
    _deprecated()
```

**Function**: Bind key-value pairs to thread-local storage.

**Parameter Description**:
- `**kwargs`: Key-value pairs to bind

**Return Value**: No return value

---

**7.2.2 clear_threadlocal Function** - Clear thread-local context

**Function Signature**:
```python
from structlog.threadlocal import clear_threadlocal

def clear_threadlocal() -> None:
    _deprecated()    
```

**Function**: Clear thread-local storage.

**Return Value**: No return value

---

**7.2.3 merge_threadlocal Function** - Merge thread-local context

**Function Signature**:
```python
from structlog.threadlocal import merge_threadlocal

def merge_threadlocal(
    logger: WrappedLogger, 
    method_name: str, 
    event_dict: EventDict
) -> EventDict:
    _deprecated()
```

**Function**: Merge thread-local storage into event dictionary.

**Parameter Description**:
- `logger`: Wrapped logger
- `method_name`: Method name
- `event_dict`: Event dictionary

**Return Value**: Event dictionary with merged thread-local context

**Version**: Added in 19.2.0, changed in 20.1.0, deprecated in 22.1.0.

----

**7.2.4 unbind_threadlocal Function** - Unbind thread-local context

**Function Signature**:
```python
from structlog.threadlocal import unbind_threadlocal

def unbind_threadlocal(*keys: str) -> None:
    _deprecated()
```

**Function**: Tries to remove bound keys from threadlocal logging context if present.

**Parameter Description**:
- `*keys`: Keys to remove from thread-local context

**Return Value**: No return value

**Version**: Added in 20.1.0, deprecated in 22.1.0.

----

**7.2.5 get_threadlocal Function** - Get thread-local context

**Function Signature**:
```python
from structlog.threadlocal import get_threadlocal

def get_threadlocal() -> Context:
    _deprecated()
```

**Function**: Return a copy of the current thread-local context.

**Return Value**: Dictionary containing thread-local context

**Version**: Added in 21.2.0, deprecated in 22.1.0.

----

**7.2.6 get_merged_threadlocal Function** - Get merged thread-local context

**Function Signature**:
```python
from structlog.threadlocal import get_merged_threadlocal

def get_merged_threadlocal(bound_logger: BindableLogger) -> Context:
    _deprecated()
```

**Function**: Return a copy of the current thread-local context merged with the context from bound_logger.

**Parameter Description**:
- `bound_logger`: Bound logger instance

**Return Value**: Dictionary containing merged context

**Version**: Added in 21.2.0, deprecated in 22.1.0.

----

**7.2.7 bound_threadlocal Function** - Context manager for thread-local context

**Function Signature**:
```python
from structlog.threadlocal import bound_threadlocal

@contextlib.contextmanager
def bound_threadlocal(**kw: Any) -> Generator[None, None, None]:
    _deprecated()
```

**Function**: Bind kw to the current thread-local context. Unbind or restore kw afterwards. Do not affect other keys. Can be used as a context manager or decorator.

**Parameter Description**:
- `**kw`: Key-value pairs to bind to thread-local context

**Return Value**: Context manager that yields None

**Version**: Added in 21.4.0, deprecated in 22.1.0.

----

**7.2.8 wrap_dict Function** - Wrap dict-like class for thread-local storage

**Function Signature**:
```python
from structlog.threadlocal import wrap_dict

def wrap_dict(dict_class: type[Context]) -> type[Context]:
    _deprecated()
```

**Function**: Wrap a dict-like class and return the resulting class. The wrapped class is used to keep global state in the current thread.

**Parameter Description**:
- `dict_class`: Class used for keeping context

**Return Value**: Wrapped dict-like class

**Version**: Deprecated in 22.1.0.

----

**7.2.9 as_immutable Function** - Extract immutable logger from thread-local logger

**Function Signature**:
```python
from structlog.threadlocal import as_immutable

def as_immutable(logger: TLLogger) -> TLLogger:
    _deprecated()
```

**Function**: Extract the context from a thread local logger into an immutable logger.

**Parameter Description**:
- `logger`: A logger with possibly thread local state

**Return Value**: BoundLogger with an immutable context

**Version**: Deprecated in 22.1.0.

----

**7.2.10 tmp_bind Function** - Temporary binding context manager

**Function Signature**:
```python
from structlog.threadlocal import tmp_bind

@contextlib.contextmanager
def tmp_bind(logger: TLLogger, **tmp_values: Any) -> Generator[TLLogger, None, None]:
    _deprecated()    
```

**Function**: Bind tmp_values to logger & memorize current state. Rewind afterwards. Only works with `structlog.threadlocal.wrap_dict`-based contexts.

**Parameter Description**:
- `logger`: Logger instance
- `**tmp_values`: Temporary values to bind

**Return Value**: Context manager that yields logger with temporary binding

**Version**: Deprecated in 22.1.0.

**Note**: The entire threadlocal module is deprecated since version 22.1.0. Please use `structlog.contextvars` instead.

#### 8. Output System

##### 8.1. PrintLogger Class - Print Logger

**Function**:
`PrintLogger` is a simple logger that uses the built-in `print` function to output log events directly to a specified file. It is very useful for testing, example code, and scenarios that follow certain logging best practices. This class supports pickling and deep copying, but only for instances bound to standard output (`sys.stdout`) or standard error (`sys.stderr`).

**Class Definition**:
```python
class PrintLogger:
    def __init__(self, file: TextIO | None = None):
     

    def __getstate__(self) -> str:
      

    def __setstate__(self, state: Any) -> None:
        

    def __deepcopy__(self, memodict: dict[str, object]) -> PrintLogger:
       
    def __repr__(self) -> str:
        

    def msg(self, message: str) -> None:
        

    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg
```

---

`__init__()`

**Function**: Initialize a `PrintLogger` instance.

**Function Signature**:
```python
def __init__(self, file: TextIO | None = None):
```

**Parameter Description**:
- `file` (TextIO | None): The target file object for log output. If `None`, defaults to `sys.stdout`.

---

`msg()`

**Function**: Print the given message to the file. This is the core logging method.

**Function Signature**:
```python
def msg(self, message: str) -> None:
```

**Parameter Description**:
- `message` (str): The log message string to be recorded.

**Other Logging Methods**:
For convenience, `PrintLogger` aliases several standard log level methods (such as `info`, `debug`, `warning`, `error`, etc.) to the `msg` method. This means that calling `logger.info("hello")` has exactly the same effect as calling `logger.msg("hello")`.

---

Special Methods

###### `__repr__()`
**Function**: Return the official string representation of the `PrintLogger` instance, typically used for debugging.
**Function Signature**:
```python
def __repr__(self) -> str:
```

###### `__getstate__()` and `__setstate__()`
**Function**: These two methods enable `PrintLogger` instances to be pickled. This operation is only supported when the logger is bound to `sys.stdout` or `sys.stderr`; otherwise, a `PicklingError` is raised.
**Function Signature**:
```python
def __getstate__(self) -> str:

def __setstate__(self, state: Any) -> None:
```

###### `__deepcopy__()`
**Function**: Create a deep copy of the `PrintLogger` instance. Similar to serialization, this operation is also limited to instances bound to `sys.stdout` or `sys.stderr`.
**Function Signature**:
```python
def __deepcopy__(self, memodict: dict[str, object]) -> PrintLogger:
```
---


##### 8.2. BytesLogger Class - Bytes Logger

**Function**:
`BytesLogger` is used to write byte strings (`bytes`) to a file. This is particularly useful when combined with renderers that return byte strings (such as `JSONRenderer` using `orjson`), as it avoids unnecessary encoding and decoding steps, thereby improving performance. Similar to `PrintLogger` and `WriteLogger`, it also supports pickling and deep copying, but only for instances bound to standard output (`sys.stdout.buffer`) or standard error (`sys.stderr.buffer`).

**Class Definition**:
```python
class BytesLogger:
    __slots__ = ("_file", "_flush", "_lock", "_write")

    def __init__(self, file: BinaryIO | None = None):
     

    def __getstate__(self) -> str:
       

    def __setstate__(self, state: Any) -> None:
       

    def __deepcopy__(self, memodict: dict[str, object]) -> BytesLogger:
      

    def __repr__(self) -> str:
       

    def msg(self, message: bytes) -> None:
     

    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg
```

---

`__init__()`

**Function**: Initialize a `BytesLogger` instance.

**Function Signature**:
```python
def __init__(self, file: BinaryIO | None = None):
```

**Parameter Description**:
- `file` (BinaryIO | None): The target binary file object for log output. If `None`, defaults to `sys.stdout.buffer`.

---

`msg()`

**Function**: Write the given byte message to the file and immediately flush the buffer.

**Function Signature**:
```python
def msg(self, message: bytes) -> None:
```

**Parameter Description**:
- `message` (bytes): The log message byte string to be recorded.

**Other Logging Methods**:
`BytesLogger` similarly aliases several standard log level methods (such as `info`, `debug`, `error`, etc.) to the `msg` method.

---

Special Methods

`__repr__()`
**Function**: Return the official string representation of the `BytesLogger` instance.
**Function Signature**:
```python
def __repr__(self) -> str:
```

`__getstate__()` and `__setstate__()`
**Function**: Support pickling of `BytesLogger` instances. Only valid when the logger is bound to `sys.stdout.buffer` or `sys.stderr.buffer`.
**Function Signature**:
```python
def __getstate__(self) -> str:

def __setstate__(self, state: Any) -> None:
```

`__deepcopy__()`
**Function**: Create a deep copy of the `BytesLogger` instance. Also limited to instances bound to `sys.stdout.buffer` or `sys.stderr.buffer`.
**Function Signature**:
```python
def __deepcopy__(self, memodict: dict[str, object]) -> BytesLogger:
```

---

**8.3 PrintLoggerFactory Class** - Print logger factory

**Class Signature**:
```python
from structlog._output import PrintLoggerFactory

class PrintLoggerFactory:
    def __init__(self, file: TextIO | None = None):
        # Initialize with the specified file or use sys.stdout as default
        pass
    
    def __call__(self, *args: Any) -> PrintLogger:
        # Create and return a new PrintLogger instance
        # args are passed through to the PrintLogger constructor
```

**Function**: Factory class for creating PrintLogger instances.

**Parameter Description**:
- `file`: Output file stream

**Return Value**: PrintLogger instance

---
**8.4 WriteLoggerFactory Class** - Write logger factory

**Class Signature**:
```python
from structlog._output import WriteLoggerFactory

class WriteLoggerFactory:
    def __init__(self, file: TextIO | None = None):
        # Initialize with the specified file or use sys.stdout as default
        pass
    
    def __call__(self, *args: Any) -> WriteLogger:
        # Create and return a new WriteLogger instance
        # args are passed through to the WriteLogger constructor
```

**Function**: Factory class for creating WriteLogger instances.

**Parameter Description**:
- `file`: Output file stream

**Return Value**: WriteLogger instance

---

**8.5 BytesLoggerFactory Class** - Bytes logger factory

**Class Signature**:
```python
from structlog._output import BytesLoggerFactory

class BytesLoggerFactory:
    def __init__(self, file: BinaryIO | None = None):
        # Initialize the BytesLoggerFactory with an optional binary output file
        # If file is None, uses sys.stderr.buffer by default
    
    def __call__(self, *args: Any) -> BytesLogger:
        # Create and return a new BytesLogger instance
        # args are passed through to the BytesLogger constructor
```

**Function**: Factory class for creating BytesLogger instances.

**Parameter Description**:
- `file`: Output file stream

**Return Value**: BytesLogger instance

#### 9. Testing Tools (`testing` Submodule)

**9.1 ReturnLogger Class** - Return logger

**Class Signature**:
```python
from structlog.testing import ReturnLogger

class ReturnLogger:
    def msg(self, message: str) -> str:
        # Return the message string directly for testing purposes
```

**Function**: Logger for testing purposes that returns log messages instead of outputting them.

**Main Methods**:
- `msg(message)`: Return message string

---

**9.2 ReturnLoggerFactory Class** - Return logger factory

**Class Signature**:
```python
from structlog.testing import ReturnLoggerFactory

class ReturnLoggerFactory:
    def __init__(self) -> None:
        # Initialize the ReturnLoggerFactory instance
    
    def __call__(self, *args: Any) -> ReturnLogger:
        # Create and return a new ReturnLogger instance
```

**Function**: Factory class for creating ReturnLogger instances.

**Return Value**: ReturnLogger instance

---

**9.3 CapturingLogger Class** - Capturing logger

**Class Signature**:
```python
from structlog.testing import CapturingLogger

class CapturingLogger:
    def __init__(self) -> None:
        # Initialize CapturingLogger with an empty calls list
    
    def __getattr__(self, name: str) -> Callable[..., None]:
        # Return a callable that captures method calls and their arguments
```

**Function**: Logger that captures log calls for testing verification.

**Main Attributes**:
- `calls`: List of captured log calls

---

**9.4 CapturingLoggerFactory Class** - Capturing logger factory

**Class Signature**:
```python
from structlog.testing import CapturingLoggerFactory

class CapturingLoggerFactory:
    def __init__(self) -> None:
        # Initialize the CapturingLoggerFactory instance
    
    def __call__(self, *args: Any) -> CapturingLogger:
        # Create and return a new CapturingLogger instance
```

**Function**: Factory class for creating CapturingLogger instances.

**Return Value**: CapturingLogger instance


---


**9.4 CapturingLoggerFactory Class** - Capturing logger factory

**Class Signature**:
```python
from structlog.testing import CapturingLoggerFactory

class CapturingLoggerFactory:
    def __init__(self) -> None:
        # Initialize the CapturingLoggerFactory instance
    
    def __call__(self, *args: Any) -> CapturingLogger:
        # Create and return a new CapturingLogger instance
```

**Function**: Factory class for creating CapturingLogger instances.

**Return Value**: CapturingLogger instance

---

**9.5 CapturedCall Class** - Captured call

**Class Signature**:
```python
from structlog.testing import CapturedCall

class CapturedCall(NamedTuple):
    method_name: str
    args: tuple[Any, ...]
    kwargs: dict[str, Any]
```

**Function**: Represents a captured log call.

**Field Description**:
- `method_name`: Called method name
- `args`: Positional arguments
- `kwargs`: Keyword arguments

---

**9.6 `capture_logs` Function - Log Capture

**Function**: Context manager that appends all logging statements to its yielded list while it is active. Disables all configured processors for the duration of the context manager.

**Function Signature**:
```python
@contextmanager
def capture_logs(
    processors: Iterable[Processor] = (),
) -> Generator[list[EventDict], None, None]:
```

**Parameter Description**:
- `processors` (Iterable[Processor], optional): Processors to apply before the logs are captured. Defaults to `()`.

**Return Value**:
A generator that yields a `list[EventDict]` containing the captured log entries.

#### 10. Exception Handling

**10.1 DropEvent Exception Class** - Drop event exception

**Class Signature**:
```python
from structlog.exceptions import DropEvent

class DropEvent(BaseException):
    pass
```

**Function**: Exception thrown when a processor needs to drop the current event.

**Use Case**: In the processor chain, when a processor decides not to process the current event, it can throw this exception to drop the event.

---

**10.2 NoConsoleRendererConfiguredError Exception Class** - No console renderer configured exception

**Class Signature**:
```python
from structlog.exceptions import NoConsoleRendererConfiguredError

class NoConsoleRendererConfiguredError(Exception):
    pass
```

**Function**: Exception thrown when trying to get current ConsoleRenderer but none is configured.

---

**10.3 MultipleConsoleRenderersConfiguredError Exception Class** - Multiple console renderers configured exception

**Class Signature**:
```python
from structlog.exceptions import MultipleConsoleRenderersConfiguredError

class MultipleConsoleRenderersConfiguredError(Exception):
    pass
```

**Function**: Exception thrown when multiple ConsoleRenderers are configured.

#### 11. Type System (`types`/`typing` Submodules)

**11.1 EventDict Type Alias** - Event dictionary type

**Type Definition**:
```python
from structlog.typing import EventDict

EventDict = MutableMapping[str, Any]
```

**Function**: Represents the data structure of log events, containing all event information.

---

**11.2 WrappedLogger Type Alias** - Wrapped logger type

**Type Definition**:
```python
from structlog.typing import WrappedLogger

WrappedLogger = Any
```

**Function**: Represents the logger type wrapped by structlog.

---

**11.3 Processor Type Alias** - Processor type

**Type Definition**:
```python
from structlog.typing import Processor

Processor = Callable[[WrappedLogger, str, EventDict], ProcessorReturnValue]
```

**Function**: Represents the function signature type of processor.

**Parameter Description**:
- `WrappedLogger`: Wrapped logger
- `str`: Method name
- `EventDict`: Event dictionary

**Return Value**: Processed result

---

**11.4 Context Type Alias** - Context type

**Type Definition**:
```python
from structlog.typing import Context

Context = Union[Dict[str, Any], Dict[Any, Any]]
```

**Function**: Represents the dictionary type of log context.

---


**11.6 BoundLoggerLazyProxy Class** - Bound logger lazy proxy

**Class Signature**:
```python
from structlog._config import BoundLoggerLazyProxy

class BoundLoggerLazyProxy:
    @property
    def _context(self) -> dict[str, str]:
        # Return the current context dictionary
        
    
    def __init__(
        self,
        logger: WrappedLogger | None,
        wrapper_class: type[BindableLogger] | None = None,
        processors: Iterable[Processor] | None = None,
        context_class: type[Context] | None = None,
        cache_logger_on_first_use: bool | None = None,
        initial_values: dict[str, Any] | None = None,
        logger_factory_args: Any = None,
    ) -> None:
        # Initialize the BoundLoggerLazyProxy with the given parameters
        
    
    def bind(self, **new_values: Any) -> BindableLogger:
        # Bind new key-value pairs to context
    
    def unbind(self, *keys: str) -> BindableLogger:
        # Remove specified keys from context
    
    def try_unbind(self, *keys: str) -> BindableLogger:
        # Safely remove specified keys from context (ignore non-existent keys)
    
    def new(self, **new_values: Any) -> BindableLogger:
        # Clear current context and bind new key-value pairs
```

**Function**: Lazy proxy class that instantiates bound logger on first use, considering configuration and instantiation parameters.

#### 12. Exception Tracing (`tracebacks` Submodule)

**12.1 ExceptionDictTransformer Class** - Exception dictionary transformer

**Class Signature**:
```python
from structlog.tracebacks import ExceptionDictTransformer

class ExceptionDictTransformer:
    def __init__(self) -> None:
        # Initialize the ExceptionDictTransformer instance
        
    
    def __call__(self, exc_info: ExcInfo) -> list[dict[str, Any]]:
        # Convert exception info to a list of dictionaries
       
    
    def _as_dict(self, trace: Trace) -> list[dict[str, Any]]:
        # Convert Trace object to dictionary list format
       
```
**Function**: Convert exception information to structured dictionary format.

**Parameter Description**:
- `exc_info`: Exception information tuple

**Return Value**: Dictionary list containing exception information
---

**12.2 `extract` Function - Extract Traceback Information**

**Function**: Extracts structured traceback information from an exception.

**Function Signature**:
```python
def extract(
    exc_type: type[BaseException],
    exc_value: BaseException,
    traceback: TracebackType | None,
    *,
    show_locals: bool = False,
    locals_max_length: int = 10,
    locals_max_string: int = 80,
    locals_hide_dunder: bool = True,
    locals_hide_sunder: bool = False,
    use_rich: bool = True,
    _seen: set[int] | None = None,
) -> Trace:
```

**Parameter Description**:
- `exc_type` (type[BaseException]): Exception type.
- `exc_value` (BaseException): Exception value.
- `traceback` (TracebackType | None): Python traceback object.
- `show_locals` (bool, optional): Whether to display local variables. Defaults to `False`.
- `locals_max_length` (int, optional): Maximum length of containers before they are abbreviated. Defaults to `10`.
- `locals_max_string` (int, optional): Maximum length of strings before they are truncated. Defaults to `80`.
- `locals_hide_dunder` (bool, optional): Whether to hide local variables starting with double underscores. Defaults to `True`.
- `locals_hide_sunder` (bool, optional): Whether to hide local variables starting with a single underscore. Defaults to `False`.
- `use_rich` (bool, optional): If `True`, uses the `rich` library to compute `repr`. Defaults to `True`.
- `_seen` (set[int] | None, optional): Internal use, used to track seen exceptions to avoid cycles.

**Return Value**:
A `Trace` instance containing structured information about all exceptions.

---

**12.3 safe_str Function** - Safe string conversion

**Function Signature**:
```python
from structlog.tracebacks import safe_str

def safe_str(_object: Any) -> str:
```

**Function**: Safely convert object to string representation.

**Parameter Description**:
- `_object`: Object to convert

**Return Value**: String representation of object

---

**12.4 to_repr Function** - Object safe representation

**Function Signature**:
```python
from structlog.tracebacks import to_repr

def to_repr(
    obj: Any,
    max_length: int = 1000,
    max_string: int = 1000,
    use_rich: bool = False,
) -> str:
    
```

**Function**: Convert object to safe string representation with length limits.

**Parameter Description**:
- `obj`: Object to convert
- `max_length`: Maximum length limit
- `max_string`: Maximum string length
- `use_rich`: Whether to use Rich formatting

**Return Value**: String representation of object

#### 13. Twisted Framework Integration (`twisted` Submodule)

**13.1 BoundLogger Class** - Twisted bound logger

**Class Signature**:
```python
from structlog.twisted import BoundLogger

class BoundLogger(BoundLoggerBase):
    def msg(self, event: str, *args: Any, **kw: Any) -> Any:
        
    def err(self, event: str, *args: Any, **kw: Any) -> Any:
        
```

**Function**: BoundLogger compatible with Twisted async framework, providing Twisted-style logging methods.

**Main Methods**:
- `msg(event, *args, **kw)`: Log message
- `err(event, *args, **kw)`: Log error message

---

**13.2 LoggerFactory Class** - Twisted logger factory

**Class Signature**:
```python
from structlog.twisted import LoggerFactory

class LoggerFactory:
    def __call__(self, *args: Any) -> BoundLogger:
        
```

**Function**: Factory class for creating Twisted BoundLogger instances.

**Return Value**: BoundLogger instance

---

**13.3 EventAdapter Class** - Event adapter

**Class Signature**:
```python
from structlog.twisted import EventAdapter

class EventAdapter:
    def __init__(self, dictRenderer: Callable[..., str]) -> None:
    
    def __call__(
        self, 
        logger: WrappedLogger, 
        name: str, 
        eventDict: EventDict
    ) -> EventDict:
        
```

**Function**: Adapt structlog event dictionary to Twisted log format.

**Parameter Description**:
- `dictRenderer`: Dictionary renderer

**Return Value**: Adapted event dictionary

---

**13.4 JSONRenderer Class** - JSON renderer

**Class Signature**:
```python
from structlog.twisted import JSONRenderer

class JSONRenderer(GenericJSONRenderer):
    def __call__(
        self, 
        logger: WrappedLogger, 
        name: str, 
        eventDict: EventDict
    ) -> str:
        
```

**Function**: Render event dictionary as JSON format string.

**Return Value**: JSON format string
#### 14. get_context() Function - Get the Current Context
**Function**: Get the current context.

**Function Signature**:
```python
from structlog._base import get_context
def get_context(bound_logger: BindableLogger) -> Context:
    """
    Return *bound_logger*'s context.

    The type of *bound_logger* and the type returned depend on your
    configuration.

    Args:
        bound_logger: The bound logger whose context you want.

    Returns:
        The *actual* context from *bound_logger*. It is *not* copied first.

    .. versionadded:: 20.2.0
    """
    # This probably will get more complicated in the future.
    return bound_logger._context
```

**Return Value**: The current context.

#### 15. LOCALS_MAX_STRING constant
**Function**: The maximum number of local variables to store in the context.

**Value**: 80
```python
LOCALS_MAX_STRING = 80
```
#### 16. CallsiteParameter class
**Class Signature**:
```python
class CallsiteParameter(enum.Enum):
```

**Function**: The class that stores the call site parameters.

**Example**:
```python
class CallsiteParameter(enum.Enum):
    """
    Callsite parameters that can be added to an event dictionary with the
    `structlog.processors.CallsiteParameterAdder` processor class.

    The string values of the members of this enum will be used as the keys for
    the callsite parameters in the event dictionary.

    .. versionadded:: 21.5.0
    """

    #: The full path to the python source file of the callsite.
    PATHNAME = "pathname"
    #: The basename part of the full path to the python source file of the
    #: callsite.
    FILENAME = "filename"
    #: The python module the callsite was in. This mimics the module attribute
    #: of `logging.LogRecord` objects and will be the basename, without
    #: extension, of the full path to the python source file of the callsite.
    MODULE = "module"
    #: The name of the function that the callsite was in.
    FUNC_NAME = "func_name"
    #: The line number of the callsite.
    LINENO = "lineno"
    #: The ID of the thread the callsite was executed in.
    THREAD = "thread"
    #: The name of the thread the callsite was executed in.
    THREAD_NAME = "thread_name"
    #: The ID of the process the callsite was executed in.
    PROCESS = "process"
    #: The name of the process the callsite was executed in.
    PROCESS_NAME = "process_name"

```
#### 17. `MaybeTimeStamper` Class - Conditional Timestamp Adder

**Function**: A processor that adds a timestamp only if it's not already present in the event dictionary. This allows you to override the `timestamp` key when events come from another system.

**Class Signature**:
```python
class MaybeTimeStamper:
    def __init__(
        self,
        fmt: str | None = None,
        utc: bool = True,
        key: str = "timestamp",
    ):
```

**Parameter Description**:
- `fmt` (str | None, optional): `strftime` format string, `"iso"` for ISO 8601 format, or `None` for UNIX timestamp. Defaults to `None`.
- `utc` (bool, optional): Whether the timestamp should be in UTC. Defaults to `True`.
- `key` (str, optional): Key used to store the timestamp. Defaults to `"timestamp"`.

**`__call__` Method**:
- **Function**: Checks if the timestamp key exists in the event dictionary. If not present, calls `TimeStamper` to add a timestamp; otherwise, returns the event dictionary directly.
- **Signature**: `def __call__(self, logger: WrappedLogger, name: str, event_dict: EventDict) -> EventDict:`
- **Return Value**: Updated (or unchanged) event dictionary `EventDict`.

#### 18. _CONTEXT_VARS constant
**Example**:
```python
from structlog.contextvars import _CONTEXT_VARS
_CONTEXT_VARS: dict[str, contextvars.ContextVar[Any]] = {}
```
#### 19. make_filtering_bound_logger function
**Function**: Create a bound logger that filters events based on a condition.

**Example**:
```python
from structlog._native import make_filtering_bound_logger
def make_filtering_bound_logger(
    min_level: int | str,
) -> type[FilteringBoundLogger]:
 
    if isinstance(min_level, str):
        min_level = NAME_TO_LEVEL[min_level.lower()]

    return LEVEL_TO_FILTERING_LOGGER[min_level]

```

##### 19.1 BoundLoggerFilteringAtNotset Type Alias
**Function**: Pre-created NOTSET level filtering bound logger type for creating serializable NOTSET level filters.

**Type Definition**:
```python

from structlog._native import BoundLoggerFilteringAtNotset
BoundLoggerFilteringAtNotset = _make_filtering_bound_logger(NOTSET)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(NOTSET)`
- Log level is NOTSET (0), records logs of all levels
- Supports pickle serialization
- Corresponds to NOTSET level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.2 BoundLoggerFilteringAtDebug Type Alias
**Function**: Pre-created DEBUG level filtering bound logger type for creating serializable DEBUG level filters.

**Type Definition**:
```python
from structlog._native import BoundLoggerFilteringAtDebug
BoundLoggerFilteringAtDebug = _make_filtering_bound_logger(DEBUG)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(DEBUG)`
- Log level is DEBUG (10), records logs of DEBUG level and above
- Supports pickle serialization
- Corresponds to DEBUG level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.3 BoundLoggerFilteringAtInfo Type Alias
**Function**: Pre-created INFO level filtering bound logger type for creating serializable INFO level filters.

**Type Definition**:
```python
from structlog._native import BoundLoggerFilteringAtInfo
BoundLoggerFilteringAtInfo = _make_filtering_bound_logger(INFO)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(INFO)`
- Log level is INFO (20), records logs of INFO level and above
- Supports pickle serialization
- Corresponds to INFO level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.4 BoundLoggerFilteringAtWarning Type Alias
**Function**: Pre-created WARNING level filtering bound logger type for creating serializable WARNING level filters.

**Type Definition**:
```python
from structlog._native import BoundLoggerFilteringAtWarning
BoundLoggerFilteringAtWarning = _make_filtering_bound_logger(WARNING)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(WARNING)`
- Log level is WARNING (30), records logs of WARNING level and above
- Supports pickle serialization
- Corresponds to WARNING level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.5 BoundLoggerFilteringAtError Type Alias
**Function**: Pre-created ERROR level filtering bound logger type for creating serializable ERROR level filters.

**Type Definition**:
```python
from structlog._native import BoundLoggerFilteringAtError
BoundLoggerFilteringAtError = _make_filtering_bound_logger(ERROR)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(ERROR)`
- Log level is ERROR (40), records logs of ERROR level and above
- Supports pickle serialization
- Corresponds to ERROR level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.6 BoundLoggerFilteringAtCritical Type Alias
**Function**: Pre-created CRITICAL level filtering bound logger type for creating serializable CRITICAL level filters.

**Type Definition**:
```python
from structlog._native import BoundLoggerFilteringAtCritical
BoundLoggerFilteringAtCritical = _make_filtering_bound_logger(CRITICAL)
```

**Description**: 
- This is a type alias created through `_make_filtering_bound_logger(CRITICAL)`
- Log level is CRITICAL (50), only records logs of CRITICAL level
- Supports pickle serialization
- Corresponds to CRITICAL level type in the `LEVEL_TO_FILTERING_LOGGER` dictionary

---

##### 19.7 LEVEL_TO_FILTERING_LOGGER Constant
**Function**: Mapping dictionary from log level to filtering logger type, used to get corresponding filter type based on log level.

**Constant Definition**:
```python
from structlog._native import LEVEL_TO_FILTERING_LOGGER
LEVEL_TO_FILTERING_LOGGER = {
    CRITICAL: BoundLoggerFilteringAtCritical,
    ERROR: BoundLoggerFilteringAtError,
    WARNING: BoundLoggerFilteringAtWarning,
    INFO: BoundLoggerFilteringAtInfo,
    DEBUG: BoundLoggerFilteringAtDebug,
    NOTSET: BoundLoggerFilteringAtNotset,
}
```

**Description**: 
- Maps integer log levels to pre-created filtering bound logger types
- The `make_filtering_bound_logger()` function uses this dictionary to return corresponding filter types
- All types are pre-created to ensure pickle serializability

---
#### 20. WriteLogger class
**Class Signature**:
```python
from structlog._output import WriteLogger

class WriteLogger:
    def __init__(self, file: TextIO | None = None) -> None:
        # Initialize write logger with specified output file
    
    def __getstate__(self) -> str:
        # Serialization support
    
    def __setstate__(self, state: Any) -> None:
        # Deserialization support
    
    def __deepcopy__(self, memodict: dict[str, object]) -> WriteLogger:
        # Deep copy support
    
    def __repr__(self) -> str:
        # String representation
    
    def msg(self, message: str) -> None:
        # Write and flush message
    
    # All log level methods point to msg method
    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg
```

**Function**: Logger class that writes events to files.

**Parameter Description**:
- `file`: File to write to, defaults to sys.stdout

**Return Value**: No return value, writes directly to file

---
#### 21. get_config function
**Function**: Get the current configuration of the structured logger.

**Function Signature**:
```python
from structlog._config import get_config

def get_config() -> dict[str, Any]:
```

**Function**: Get the current structlog configuration dictionary.

**Return Value**: Dictionary containing current configuration, including configuration items such as processors, context_class, wrapper_class, logger_factory, cache_logger_on_first_use, etc.

**Note**: The returned dictionary is read-only. Modifying it will not affect the actual structlog configuration.

---

##### 21.1 is_configured function
**Function**: Check if structlog has been configured.

**Function Signature**:
```python
from structlog._config import is_configured

def is_configured() -> bool:
```

**Function**: Check if structlog has been configured.

**Return Value**: Returns True if configured, otherwise returns False.

---

##### 21.2 reset_defaults function
**Function**: Reset structlog to default configuration.

**Function Signature**:
```python
from structlog._config import reset_defaults

def reset_defaults() -> None:
```

**Function**: Reset structlog to default configuration state.

**Return Value**: No return value

---

##### 21.3 safe_str function
**Function**: Safely convert an object to string representation.

**Function Signature**:
```python
from structlog.tracebacks import safe_str

def safe_str(_object: Any) -> str:
```

**Function**: Safely convert object to string representation, handling various exception cases.

**Parameter Description**:
- `_object`: Object to convert

**Return Value**: String representation of object

---

##### 21.4 to_repr function
**Function**: Convert an object to a safe string representation.

**Function Signature**:
```python
from structlog.tracebacks import to_repr

def to_repr(
    obj: Any,
    max_length: int = 1000,
    max_string: int = 1000,
    use_rich: bool = False,
) -> str:
```

**Function**: Convert object to safe string representation with length limits and Rich formatting support.

**Parameter Description**:
- `obj`: Object to convert
- `max_length`: Maximum length limit
- `max_string`: Maximum string length
- `use_rich`: Whether to use Rich formatting

**Return Value**: String representation of object


#### 22. Missing Classes and Functions Supplement

**22.1 ColumnFormatter Class** - Column formatter protocol

**Class Signature**:
```python
from structlog.dev import ColumnFormatter

class ColumnFormatter(Protocol):
    def __call__(self, key: str, value: Any) -> str:
        
```

**Function**: Define column formatter protocol type for customizing column formatting in console output.

**Parameter Description**:
- `key`: Column key name
- `value`: Column value

**Return Value**: Formatted string

---

**22.2 KeyValueColumnFormatter Class** - Key-value column formatter

**Class Signature**:
```python
from structlog.dev import KeyValueColumnFormatter

class KeyValueColumnFormatter:
    def __init__(
        self,
        key_style: str = "",
        value_style: str = "",
        reset_style: str = "",
    ):
        # Initialize formatter with style configurations
        # key_style: Style string for keys
        # value_style: Style string for values
        # reset_style: Style string to reset formatting
        pass
    
    def __call__(self, key: str, value: Any) -> str:
        
```

**Function**: Provide styled column formatter for key-value pairs, supporting custom color styles for keys and values.

**Parameter Description**:
- `key_style`: Style string for key
- `value_style`: Style string for value
- `reset_style`: Reset style string

**Return Value**: Formatted key-value pair string

---

**22.3 LogLevelColumnFormatter Class** - Log level column formatter

**Class Signature**:
```python
from structlog.dev import LogLevelColumnFormatter

class LogLevelColumnFormatter:
    def __init__(
        self,
        level_styles: dict[str, str] | None = None,
        reset_style: str = "",
        width: int = 8,
    ):
        # Initialize with level styles and column width
        # level_styles: Dictionary mapping log levels to style strings
        # reset_style: Style string to reset formatting
        # width: Column width for alignment
        pass
    
    def __call__(self, key: str, value: Any) -> str:
        # Format log level with appropriate style based on level
        # Returns: Formatted log level string with padding
        pass
```

**Function**: Column formatter specifically for formatting log levels, supporting different color styles for different levels.

**Parameter Description**:
- `level_styles`: Dictionary of styles corresponding to each level
- `reset_style`: Reset style string
- `width`: Column width

**Return Value**: Formatted log level string

---

**22.4 `SyntaxError_` Class - `SyntaxError` Exception Information**

**Function**: Contains detailed information about a `SyntaxError` exception.

**Class Signature**:
```python
@dataclass
class SyntaxError_:
    offset: int
    filename: str
    line: str
    lineno: int
    msg: str
```

**Parameter Description**:
- `offset` (int): Offset within the line where the error occurred.
- `filename` (str): Filename where the error occurred.
- `line` (str): Source code of the line where the error occurred.
- `lineno` (int): Line number where the error occurred.
- `msg` (str): Error message.
---

**22.5 _Configuration Class** - Configuration management class

**Class Signature**:
```python
from structlog._config import _Configuration

class _Configuration:
    def __init__(self) -> None:
        # Initialize configuration with default values for processors, context class, etc.
        pass
```

**Function**: Manage structlog global configuration state, including configuration items such as processor chain, wrapper class, context class, etc.

**Main Attributes**:
- `default_processors`: Default processor list
- `default_context_class`: Default context class
- `default_wrapper_class`: Default wrapper class
- `logger_factory`: Logger factory
- `cache_logger_on_first_use`: Whether to cache logger on first use

---

**22.6 SomeClass Class** - Example data class

**Class Signature**:
```python
@dataclass
class SomeClass:
    x: int
    y: str
```

**Function**: Example data class for demonstrating structured logging, showing how to log complex objects.

**Use Case**: Used in show_off.py demo script to show how ConsoleRenderer handles custom objects.

---

**22.2 ColumnStyles Class** - Console column styles configuration

**Class Signature**:
```python
@dataclass(frozen=True)
class ColumnStyles:
    reset: str
    bright: str
    level_critical: str
    level_exception: str
    level_error: str
    level_warn: str
    level_info: str
    level_debug: str
    level_notset: str
    timestamp: str
    logger_name: str
    kv_key: str
    kv_value: str
```

**Function**: Define column style settings for console rendering, containing ANSI color codes for different fields.

**Parameter Description**:
- `reset`: ANSI code for reset style
- `bright`: Highlight style
- `level_*`: Styles for each log level
- `timestamp`: Timestamp style
- `logger_name`: Logger name style
- `kv_key`: Style for key in key-value pairs
- `kv_value`: Style for value in key-value pairs

---

**22.3 NoConsoleRendererConfiguredError Exception Class**

**Class Signature**:
```python
class NoConsoleRendererConfiguredError(Exception):
    """
    A user asked for the current `structlog.dev.ConsoleRenderer` but none is
    configured.
    """
```

**Function**: Thrown when user attempts to get current ConsoleRenderer but none is configured.

---

**22.4 MultipleConsoleRenderersConfiguredError Exception Class**

**Class Signature**:
```python
class MultipleConsoleRenderersConfiguredError(Exception):
    """
    A user asked for the current `structlog.dev.ConsoleRenderer` and more than one is configured.
    """
```

**Function**: Thrown when multiple ConsoleRenderers are configured.

---

**22.5 _ThreadLocalDictWrapper Class** - Thread-local dictionary wrapper

**Class Signature**:
```python
class _ThreadLocalDictWrapper:
    """
    Wrap a dict-like class and keep the state *global* but *thread-local*.
    """
    _tl: Any
    _dict_class: type[dict[str, Any]]
    
    def __init__(self, *args: Any, **kw: Any) -> None:
        
```

**Function**: Wrap dictionary class, keeping state global but thread-local. Used to isolate context in multi-threaded environments.

**Method Description**:
- `__init__()`: Initialize wrapper, update internal dictionary
- `_dict`: Property, returns or creates current thread's context dictionary
- Proxy methods: `__iter__`, `__setitem__`, `__delitem__`, `__len__`, `__getattr__`

---

**22.6 `ReprWrapper` Class - String Representation Wrapper**

**Function**: Wraps a string so that its `__repr__` returns the string itself directly, rather than a quoted representation. This is particularly useful for passing formatted strings to the `_stuff` parameter of `twisted.python.log.err`.

**Class Signature**:
```python
class ReprWrapper:
    def __init__(self, string: str) -> None:
```

**Parameter Description**:
- `string` (str): The string to be wrapped.

**`__eq__` Method**:
- **Function**: Checks whether two `ReprWrapper` instances are equal, primarily used for testing.
- **Signature**: `def __eq__(self, other: object) -> bool:`
- **Return Value**: Returns `True` if the `string` attributes of both instances are equal, otherwise returns `False`.

**`__repr__` Method**:
- **Function**: Returns the wrapped string.
- **Signature**: `def __repr__(self) -> str:`
- **Return Value**: The original string `str`.

---

**22.7 PlainFileLogObserver Class** - Twisted log observer

**Class Signature**:
```python
@implementer(ILogObserver)
class PlainFileLogObserver:
    """
    Write only the plain message without timestamps or anything else.
    """
    def __init__(self, file: TextIO) -> None:
        # Initialize with output file stream
        pass
    
    def __call__(self, eventDict: EventDict) -> None:
        # Process and write log event to file
        pass
```

**Function**: Write only plain message to file without timestamps or other information. Used for Twisted log system.

**Parameter Description**:
- `file`: Output file stream

---

**22.8 JSONLogObserverWrapper Class** - Twisted JSON log wrapper

**Class Signature**:
```python
@implementer(ILogObserver)
class JSONLogObserverWrapper:
    """
    Wrap a log *observer* and render non-`JSONRenderer` entries to JSON.
    """
    def __init__(self, observer: Any) -> None:
        # Initialize with the observer to wrap
        pass
    
    def __call__(self, eventDict: EventDict) -> str:
        # Convert log event to JSON string
        pass
```

**Function**: Wrap log observer and render non-JSONRenderer entries to JSON.

**Parameter Description**:
- `observer`: Twisted log observer to wrap

**Return Value**: JSON format log string

---

**22.9 GreenThreadLocal Class** - Greenlet thread-local storage

**Class Signature**:
```python
class GreenThreadLocal:
    """
    threading.local() replacement for greenlets.
    """
    def __init__(self) -> None:
        # Initialize greenlet-local storage
        pass
    
    def __getattr__(self, name: str) -> Any:
        # Get attribute from greenlet-local storage
        pass
    
    def __setattr__(self, name: str, val: Any) -> None:
        # Set attribute in greenlet-local storage
        pass
    
    def __delattr__(self, name: str) -> None:
        # Delete attribute from greenlet-local storage
        pass
```

**Function**: Provide threading.local() replacement implementation for greenlet, supporting thread-local storage in coroutines.

---

**22.10 ExceptionTransformer Type** - Exception transformer

**Type Definition**:
```python
from typing import Protocol
from .typing import ExcInfo

class ExceptionTransformer(Protocol):
    def __call__(self, exc_info: ExcInfo) -> Any:
        # Transform exception info to desired format
        pass
```

**Function**: Define exception transformer protocol type for converting exception information to different formats.

---

**22.11 Key Function Supplement**

**Function: make_call_stack_more_impressive**
```python
def make_call_stack_more_impressive():
    """Demo function in show_off.py"""
    try:
        d = {"x": 42}
        print(SomeClass(d["y"], "foo"))
    except Exception:
        log2.exception("poor me")
    log.info("all better now!", stack_info=True)
```

**Function**: Demo function for showing exception logging and stack info functionality.

---

**Function: _pad**
```python
def _pad(s: str, length: int) -> str:
    """
    Pads *s* to length *length*.
    """
```

**Function**: Pad string to specified length.

**Parameter Description**:
- `s`: String to pad
- `length`: Target length

**Return Value**: Padded string

---

**Function: set_exc_info**
```python
def set_exc_info(
    logger: WrappedLogger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    Set ``event_dict["exc_info"] = True`` if *method_name* is ``"exception"``.
    """
```

**Function**: Set `exc_info` to True if method name is "exception".

**Return Value**: Processed event dictionary

---

**Function: _items_sorter**
```python
def _items_sorter(
    sort_keys: bool,
    key_order: Sequence[str] | None,
    drop_missing: bool,
) -> Callable[[EventDict], list[tuple[str, object]]]:
    """
    Return a function to sort items from an ``event_dict``.
    """
```

**Function**: Return function for sorting items from event dictionary.

**Parameter Description**:
- `sort_keys`: Whether to sort keys
- `key_order`: List of key order
- `drop_missing`: Whether to drop missing keys

**Return Value**: Sort function

---

**Function: _make_stamper**
```python
def _make_stamper(
    fmt: str | None, utc: bool, key: str
) -> Callable[[EventDict], EventDict]:
    """
    Create a stamper function.
    """
```

**Function**: Create timestamp generator function.

**Parameter Description**:
- `fmt`: Time format string
- `utc`: Whether to use UTC time
- `key`: Key name for timestamp in event dictionary

**Return Value**: Timestamp generator function

---

**Function: stamper_fmt_local** (Internal Function)
```python
def stamper_fmt_local(event_dict: EventDict) -> EventDict:
    event_dict[key] = now().astimezone().strftime(fmt)
    return event_dict
```

**Function**: Format timestamp using local timezone.

---

**Function: stamper_fmt_utc** (Internal Function)
```python
def stamper_fmt_utc(event_dict: EventDict) -> EventDict:
    event_dict[key] = now().strftime(fmt)
    return event_dict
```

**Function**: Format timestamp using UTC time.

---

**22.12 Callsite Parameter Getter Function Series**

All these functions are defined in `processors` for extracting callsite information from stack frames:

```python
def _get_callsite_pathname(module: str, frame: FrameType) -> Any:
    # Returns: Full path of the source file where the call was made (e.g., '/path/to/module.py')

def _get_callsite_filename(module: str, frame: FrameType) -> Any:
    # Returns: Base filename of the source file (e.g., 'module.py')

def _get_callsite_module(module: str, frame: FrameType) -> Any:
    # Returns: Module name without extension (e.g., 'module' from 'module.py')

def _get_callsite_func_name(module: str, frame: FrameType) -> Any:
    # Returns: Name of the function where the call was made (e.g., 'my_function')

def _get_callsite_qual_name(module: str, frame: FrameType) -> Any:
    # Returns: Qualified name of the function including class name if applicable (e.g., 'MyClass.my_method')

def _get_callsite_lineno(module: str, frame: FrameType) -> Any:
    # Returns: Line number in the source file where the call was made

def _get_callsite_thread(module: str, frame: FrameType) -> Any:
    # Returns: Thread identifier for the current thread

def _get_callsite_thread_name(module: str, frame: FrameType) -> Any:
    # Returns: Name of the current thread if set, otherwise a default name like 'Thread-N'

def _get_callsite_process(module: str, frame: FrameType) -> Any:
    # Returns: Process ID of the current process

def _get_callsite_process_name(module: str, frame: FrameType) -> Any:
    # Returns: Name of the current process, typically the script name without extension
```

**Function**: These functions extract various callsite information from stack frames (file path, function name, line number, thread/process info, etc.).

---



**22.13 Thread-local Related Functions**

**Function: _determine_threadlocal**
```python
def _determine_threadlocal() -> type[Any]:
    """
    Return a dict-like threadlocal storage depending on whether we run with
    greenlets or not.
    """
```

**Function**: Return appropriate thread-local storage type based on whether running in greenlet environment.

**Return Value**: Thread-local storage class (`GreenThreadLocal` or `threading.local`)

---

**Function: _deprecated**
```python
def _deprecated() -> None:
    """
    Raise a warning with best-effort stacklevel adjustment.
    """
```

**Function**: Emit deprecation warning, automatically adjusting stack level to point to correct call location.

---

**Function: _get_context**
```python
def _get_context() -> Context:
    """Get or create current thread's context"""
```

**Function**: Get or create current thread's context dictionary.

**Return Value**: Current thread's context dictionary

---

**22.14 Twisted Related Functions**

**Function: _extractStuffAndWhy**
```python
def _extractStuffAndWhy(eventDict: EventDict) -> tuple[Any, EventDict]:
    """
    Removes all possible *_why*s and *_stuff*s, analyzes exc_info and returns
    a tuple of ``(_stuff, _why, eventDict)``.
    
    **Modifies** *eventDict*!
    """
```

**Function**: Extract and remove `_why` and `_stuff` parameters from event dictionary, analyze exception information.

**Return Value**: Tuple `(_stuff, _why, eventDict)`

---

**Function: plainJSONStdOutLogger**
```python
def plainJSONStdOutLogger() -> JSONLogObserverWrapper:
    """
    Return a logger that writes only the message to stdout.
    """
```

**Function**: Return logger that only writes messages to stdout, converting non-JSONRenderer messages to JSON.

**Return Value**: JSONLogObserverWrapper instance

---

**22.15 Log Level and Filtering Related Functions**

**Function: map_method_name**
```python
def map_method_name(method_name: str) -> str:
    """Map log method name"""
```

**Function**: Map log method names (e.g., map "warn" to "warning", "exception" to "error").

**Return Value**: Mapped method name

---

**Function: _maybe_interpolate**
```python
def _maybe_interpolate(event: str, args: tuple[Any, ...]) -> str:
    """
    Interpolate the event string with the given arguments.
    """
```

**Function**: Interpolate event string with given arguments (supports positional arguments and dictionary arguments).

**Return Value**: Interpolated string

---

**Function: _make_filtering_bound_logger**
```python
def _make_filtering_bound_logger(min_level: int) -> type[FilteringBoundLogger]:
    """
    Create a new `FilteringBoundLogger` that only logs *min_level* or higher.
    """
```

**Function**: Create new filtering bound logger that only logs min_level or higher level logs.

**Return Value**: FilteringBoundLogger class

---

**Function: make_method** (Internal Function)
```python
def make_method(
    level: int,
) -> tuple[Callable[..., Any], Callable[..., Any]]:
    """Create synchronous and asynchronous log methods"""
```

**Function**: Create synchronous and asynchronous logging methods for specified log level.

**Return Value**: Tuple (synchronous method, asynchronous method)

---

**Function: __getattr__**
```python
def __getattr__(name: str) -> str:
    """Dynamic attribute access"""
```

**Function**: Defined in `__init__.py` for dynamically accessing package metadata attributes (such as `__version__`, `__description__`, etc.).

**Return Value**: Metadata string

---

**22.16 Constant Supplement**

**Constant: STRUCTLOG_KEY_PREFIX**
```python
STRUCTLOG_KEY_PREFIX = "structlog_"
STRUCTLOG_KEY_PREFIX_LEN = len(STRUCTLOG_KEY_PREFIX)
```

**Function**: Key prefix used by structlog in contextvars.

---

**Constant: _ASYNC_CALLING_STACK**
```python
_ASYNC_CALLING_STACK: contextvars.ContextVar[FrameType] = (
    contextvars.ContextVar("_ASYNC_CALLING_STACK")
)
```

**Function**: Context variable for tracking calling stack in asynchronous environment.

---

**Constant: _IS_WINDOWS**
**Dependency Import**
```python
try:
    import colorama
except ImportError:
    colorama = None
```

**_IS_WINDOWS Constant**
**Function**: Detects whether the current operating system is Windows.

**Definition**:
```python
_IS_WINDOWS = sys.platform == "win32"
```

**Description**:
- This is a boolean constant used in the code to check if the current operating system is Windows.
- Its value is `True` on Windows systems and `False` on other systems.
- It is primarily used to conditionally initialize Windows-specific features, such as colored console output.

**Conditional Execution Block**
```python
if _IS_WINDOWS:  # pragma: no cover
    # Windows-specific _init_terminal implementation
else:
    # _init_terminal implementation for non-Windows systems
```

**_init_terminal() Function**
**Function**: Initializes terminal color support on Windows systems.

**Function Signature**:
```python
def _init_terminal(who: str, force_colors: bool) -> None:
    # Checks if colorama is installed, throws SystemError if not
    # If force_colors is True, first calls colorama.deinit() then initializes with strip=False
    # Otherwise, directly calls colorama.init() for initialization
```

**Parameter Description**:
- `who` (str): Caller name, used in error messages.
- `force_colors` (bool):
  - If `True`, forces colored output even in non-interactive environments.
  - If `False`, automatically decides whether to use colored output based on the environment.

**Return Value**:
- No return value (None)

---

**Constant: _MISSING**
```python
_MISSING = "{who} requires the {package} package installed.  "
```

**Function**: Error message template for missing dependency packages.

---

**Constant: _EVENT_WIDTH**
```python
_EVENT_WIDTH = 30  # pad the event name to so many characters
```

**Function**: Default padding width for event names.

---

**Constant: _NOTHING**
```python
_NOTHING = object()
```

**Function**: Sentinel object for representing missing values (distinguished from None).

---

**Constant: _SENTINEL**
```python
_SENTINEL = object()
```

**Function**: Another sentinel object for identifying special states.

---

**Constant: _LOG_RECORD_KEYS**
```python
_LOG_RECORD_KEYS = logging.LogRecord(
    "name", 0, "pathname", 0, "msg", (), None
).__dict__.keys()
```

**Function**: Set of all keys from standard LogRecord object, used to identify extra custom attributes.

---

**Constant: LOG_KWARG_NAMES**
```python
LOG_KWARG_NAMES = ("exc_info", "stack_info", "stacklevel")
```

**Function**: Keyword argument names accepted by standard library logging methods.

---

**Constant: SHOW_LOCALS**
```python
SHOW_LOCALS = True
```

**Function**: Default value for whether to show local variables during exception tracing.

---

**Constant: LOCALS_MAX_LENGTH**
```python
LOCALS_MAX_LENGTH = 10
```

**Function**: Maximum length of local variable container.

---

**Constant: MAX_FRAMES**
```python
MAX_FRAMES = 50
```

**Function**: Maximum number of frames displayed in exception stack.

---

**Constant: _FAIL_TYPES**
```python
_FAIL_TYPES = (BaseException, Failure)
```

**Function**: Tuple of types representing failure in Twisted.

---

**Constant: _BUILTIN_CACHE_LOGGER_ON_FIRST_USE**
```python
_BUILTIN_CACHE_LOGGER_ON_FIRST_USE = False
```

**Function**: Whether to cache logger on first use in built-in default configuration.

---

**Constant: FATAL**
```python
FATAL = CRITICAL
```

**Function**: Alias for CRITICAL (50).

---

**Constant: NOTSET**
```python
NOTSET = 0
```

**Function**: Constant for unset log level.

---

**Constant: _LEVEL_TO_NAME**
```python
_LEVEL_TO_NAME = LEVEL_TO_NAME
```

**Function**: Mapping dictionary from log level to name (backward compatibility alias).

---

**Constant: _NAME_TO_LEVEL**
```python
_NAME_TO_LEVEL = NAME_TO_LEVEL
```

**Function**: Mapping dictionary from name to log level (backward compatibility alias).

---

**22.17 Type Aliases and __all__ Export Lists**

These are mainly `__all__` export lists from various modules, defining the public APIs of modules:

```python
# Example: __all__ in dev.py
__all__ = [
    "ConsoleRenderer",
    "RichTracebackFormatter",
    "better_traceback",
    "plain_traceback",
    "rich_traceback",
]
```

**Function**: Define module's public API. When using `from module import *`, only names listed in `__all__` are imported.

Other type aliases include:
- `_has_colors`: Boolean value indicating whether terminal supports colors
- `_use_colors`: Alias for `_has_colors` (backward compatibility)
- `_colorful_styles`: Colorful style configuration
- `_plain_styles`: Plain text style configuration
- `_ColorfulStyles`: Type alias for `_colorful_styles`
- `_PlainStyles`: Type alias for `_plain_styles`
- `TLLogger`: Thread-local logger type variable
- `OptExcInfo`: Optional exception info type
- `ProcessorReturnValue`: Processor return value type
- `_no_colors`: Check result of NO_COLOR environment variable
- `_force_colors`: Check result of FORCE_COLOR environment variable
- `BoundLoggerFilteringAt*`: Filtering bound logger classes for each level
- `__title__`: Package title "structlog"
- `__author__`: Author "Hynek Schlawack"
- `__license__`: License "MIT or Apache License, Version 2.0"
- `__copyright__`: Copyright information

---

#### 23. `_get_lock_for_file()` Function - Get a Thread Lock for a File

**Function**: Get or create a thread lock (`threading.Lock`) for a given file object. This function ensures that write operations to the same file are safe in a multi-threaded environment. If the file object does not already have an associated lock, it creates a new lock and stores it in the global dictionary `WRITE_LOCKS` for future use.

**Function Signature**:
```python
def _get_lock_for_file(file: IO[Any]) -> threading.Lock:
```

**Parameter Description**:
- `file` (IO[Any]): The file object for which a lock is required. It can be any type of file handle (text or binary).

**Return Value**:
- `threading.Lock`: The thread lock instance associated with the passed file object.



## Detailed Implementation Nodes of Functions

### Node 1: Basic Logger Binding Operations

**Function Description**: Implement the core binding operations of the structured logger, including context binding, unbinding, and creation, to ensure the immutability and state management of the logger.

**Core Algorithms**:
- Context Binding: The `bind()` method adds new key-value pairs to the context.
- Context Unbinding: The `unbind()` method removes specified keys.
- Context Creation: The `new()` method clears the current context and binds new values.
- Try Unbinding: The `try_unbind()` method safely removes keys (ignoring non-existent keys).

**Input-Output Examples**:

```python
from structlog._config import get_logger, configure
from structlog.processors import KeyValueRenderer

# Configure structlog
configure(processors=[KeyValueRenderer(sort_keys=True)])

# Basic binding operations
logger = get_logger()  # logger is an instance of BoundLogger class
logger = logger.bind(x=42, y=23)
logger.info("test")  # Output: x=42 y=23 event='test'

# Independent binding operations
b = logger.bind(foo="bar")
b1 = b.bind(foo="qux")
b2 = b.bind(foo="baz")
assert b._context != b1._context != b2._context  # Ensure immutability

# Create a new context
logger = logger.bind(x=42)
assert 42 == logger._context["x"]
logger = logger.new()  # Clear the context
assert {} == dict(logger._context)

# Unbinding operations
logger = logger.bind(x=42, y=23, z=10)
logger = logger.unbind("x", "y")  # Remove x and y
assert "z" in logger._context
assert "x" not in logger._context

# Try unbinding (safe operation)
logger = logger.bind(a=1, b=2)
logger = logger.try_unbind("a", "c")  # c does not exist but no error will be reported
assert "b" in logger._context
assert "a" not in logger._context
```

### Node 2: Processor Chain Event Processing

**Function Description**: Implement the processing of log events by the processor chain, including the passing, transformation, and final output formatting of event dictionaries.

**Processing Flow**:
- Event Dictionary Copying: Copy the context before processing to avoid modifying the original data.
- Processor Chain Execution: Execute each processor in sequence.
- Exception Handling: Capture exceptions in the processor chain and handle them gracefully.
- Output Formatting: The final processor returns string or byte data.

**Input-Output Examples**:

```python
from structlog._config import configure, get_logger
from structlog.processors import KeyValueRenderer, TimeStamper, add_log_level

# Configure the processor chain
configure(
    processors=[
        add_log_level,
        TimeStamper(fmt="%Y-%m-%d %H:%M:%S"),
        KeyValueRenderer(sort_keys=True)
    ]
)

logger = get_logger()

# Empty event string processing
logger.info("")  # Output: level='info' timestamp='2024-01-01 12:00:00' event=''

# Processor chain exception handling
def problematic_processor(logger, method_name, event_dict):
    if "problem" in event_dict:
        raise structlog.exceptions.DropEvent()
    return event_dict

configure(processors=[problematic_processor, KeyValueRenderer()])
logger = get_logger()

# Normal event
logger.info("normal", key="value")  # Normal output

# Problematic event (dropped)
logger.info("problem", key="value")  # No output, event dropped

# Processor chain returning different types
def return_dict(logger, method_name, event_dict):
    return {"processed": True, **event_dict}

def return_string(logger, method_name, event_dict):
    return f"event={event_dict.get('event', '')}"

configure(processors=[return_dict, return_string])
logger = get_logger()
result = logger.info("test")  # Returns a string: "event=test"
```

### Node 3: Configuration Management System

**Function Description**: Manage the global configuration of `structlog`, including the configuration and state management of components such as the processor chain, wrapper class, context class, and logger factory.

**Configuration Components**:
- Processor Chain Configuration: The `processors` parameter.
- Wrapper Class Configuration: The `wrapper_class` parameter.
- Context Class Configuration: The `context_class` parameter.
- Logger Factory Configuration: The `logger_factory` parameter.
- Cache Configuration: The `cache_logger_on_first_use` parameter.

**Input-Output Examples**:

```python
from structlog._config import configure, configure_once, is_configured, get_config, reset_defaults
from structlog.processors import KeyValueRenderer, TimeStamper
from structlog.dev import ConsoleRenderer

# Check the configuration status
print(is_configured())  # False - Using default configuration

# Complete configuration
configure(
    processors=[
        TimeStamper(fmt="%Y-%m-%d %H:%M:%S"),
        KeyValueRenderer(sort_keys=True)
    ],
    wrapper_class=structlog.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=False
)

print(is_configured())  # True - Configured

# Get the current configuration
config = get_config()
print(config)  # A dictionary containing all configuration items

# One-time configuration (avoid duplicate configuration warnings)
configure_once(
    processors=[ConsoleRenderer(colors=False)]
)

# Reset to the default configuration
reset_defaults()
print(is_configured())  # False - Reset to the default state

# Lazy loading proxy test
logger = get_logger(context="initial")
assert {"context": "initial"} == logger._context

# Configuration priority test
class CustomLogger:
    def info(self, msg):
        return f"CUSTOM: {msg}"

configure(logger_factory=lambda: CustomLogger())
logger = get_logger()
result = logger.info("test")  # "CUSTOM: test"
```

### Node 4: Unicode Encoding/Decoding Processing

**Function Description**: Handle the encoding and decoding of Unicode strings in the log event dictionary to ensure character compatibility across platforms and systems.

**Encoding Processing**:
- Unicode Encoding: Convert Unicode strings to byte strings.
- Unicode Decoding: Convert byte strings to Unicode strings.
- Encoding Parameters: Support custom encoding formats and error handling strategies.
- Byte String Handling: Encoded byte strings remain unchanged.

**Input-Output Examples**:

```python
from structlog.processors import UnicodeEncoder, UnicodeDecoder

# Unicode encoding test
encoder = UnicodeEncoder()
result = encoder(None, None, {"foo": "bär"})
print(result)  # {'foo': b'b\xc3\xa4r'}

# Custom encoding parameters
encoder = UnicodeEncoder("latin1", "xmlcharrefreplace")
result = encoder(None, None, {"foo": "–"})
print(result)  # {'foo': b'&#8211;'}

# Byte strings remain unchanged
encoder = UnicodeEncoder()
result = encoder(None, None, {"foo": b"b\xc3\xa4r"})
print(result)  # {'foo': b'b\xc3\xa4r'}

# Unicode decoding test
decoder = UnicodeDecoder()
result = decoder(None, None, {"foo": b"b\xc3\xa4r"})
print(result)  # {'foo': 'bär'}

# Custom decoding parameters
decoder = UnicodeDecoder("utf-8", "ignore")
result = decoder(None, None, {"foo": b"\xa1\xa4"})
print(result)  # {'foo': ''}

# Unicode strings remain unchanged
decoder = UnicodeDecoder()
result = decoder(None, None, {"foo": "b–r"})
print(result)  # {'foo': 'b–r'}
```

### Node 5: Exception Pretty Printing

**Function Description**: Provide formatted printing of exception information, supporting custom exception formatters and output stream configuration.

**Formatting Functions**:
- Exception Information Extraction: Extract exception information from the event dictionary.
- Formatted Output: Use a custom formatter to beautify the exception information.
- Output Stream Configuration: Support custom output streams (default is `stdout`).
- Exception Cleaning: Automatically clean the exception information after printing.

**Input-Output Examples**:

```python
from structlog.processors import ExceptionPrettyPrinter
from io import StringIO

# Create an output stream
sio = StringIO()

# Exception pretty printer
epp = ExceptionPrettyPrinter(file=sio)

# Test exception printing
try:
    raise ValueError("test exception")
except ValueError:
    event_dict = {"event": "error occurred", "exc_info": True}
    result = epp(None, None, event_dict)
    print("Event dict:", result)  # Exception information removed
    print("Output:", sio.getvalue())  # Formatted exception information

# Custom exception formatter
def custom_formatter(exc_info):
    return f"CUSTOM: {exc_info[1]}"

epp = ExceptionPrettyPrinter(file=sio, exception_formatter=custom_formatter)
try:
    raise RuntimeError("custom error")
except RuntimeError:
    event_dict = {"event": "custom error", "exc_info": True}
    epp(None, None, event_dict)
    print("Custom output:", sio.getvalue())  # "CUSTOM: custom error"

# No exception case
event_dict = {"event": "no exception"}
result = epp(None, None, event_dict)
print("No exception result:", result)  # Original event dictionary remains unchanged
```

### Node 6: Stack Information Rendering

**Function Description**: Add stack trace information to log events, supporting custom ignore rules and stack depth control.

**Rendering Functions**:
- Stack Information Extraction: Extract stack information from the current execution context.
- Ignore Rules: Automatically ignore internal frames of `structlog` and support custom ignoring.
- Stack Formatting: Format the stack information into a readable string.
- Conditional Rendering: Add stack information only when `stack_info=True`.

**Input-Output Examples**:

```python
from structlog.processors import StackInfoRenderer

# Basic stack information rendering
sir = StackInfoRenderer()
event_dict = {"event": "test", "stack_info": True}
result = sir(None, None, event_dict)
print("Stack info:", result.get("stack"))  # Contains stack information

# Custom ignore rules
sir = StackInfoRenderer(additional_ignores=["my_module"])
event_dict = {"event": "test", "stack_info": True}
result = sir(None, None, event_dict)
print("Custom ignore result:", result)

# No stack information
event_dict = {"event": "test"}  # No stack_info
result = sir(None, None, event_dict)
print("No stack result:", result)  # Original event dictionary remains unchanged

# Stack information removal
event_dict = {"event": "test", "stack_info": True, "stack": "existing"}
result = sir(None, None, event_dict)
print("Stack removed:", "stack_info" not in result)  # True
```

### Node 7: Callsite Parameter Addition

**Function Description**: Add call site information to log events, including detailed information such as file name, line number, function name, and module name.

**Parameter Types**:
- File Information: `pathname`, `filename`, `module`
- Function Information: `func_name`, `lineno`
- Thread Information: `thread`, `thread_name`
- Process Information: `process`, `process_name`

**Input-Output Examples**:

```python
from structlog.processors import CallsiteParameterAdder, CallsiteParameter

# Add all call site parameters
cpa = CallsiteParameterAdder()
event_dict = {"event": "test"}
result = cpa(None, None, event_dict)
print("All parameters:", result)

# Add specific parameters
cpa = CallsiteParameterAdder([
    CallsiteParameter.FILENAME,
    CallsiteParameter.LINENO,
    CallsiteParameter.FUNC_NAME
])
event_dict = {"event": "test"}
result = cpa(None, None, event_dict)
print("Specific parameters:", result)

# Custom ignore rules
cpa = CallsiteParameterAdder(
    additional_ignores=["my_module", "test_module"]
)
event_dict = {"event": "test"}
result = cpa(None, None, event_dict)
print("Custom ignore result:", result)

# Asynchronous method test
from structlog.stdlib import BoundLogger

async def test_async():
    logger = BoundLogger(None, [], {})
    cpa = CallsiteParameterAdder()
    event_dict = {"event": "async test"}
    result = cpa(None, None, event_dict)
    print("Async result:", result)

# Serializability test
cpa = CallsiteParameterAdder()
pickled = pickle.dumps(cpa)
unpickled = pickle.loads(pickled)
print("Pickle test:", unpickled is not None)
```

### Node 8: Event Renaming

**Function Description**: Rename key names in log events, supporting key name replacement and value renaming.

**Renaming Functions**:
- Key Name Replacement: Rename specified keys to new key names.
- Value Renaming: Rename the values of keys to new values.
- Chained Renaming: Support multiple renaming operations.
- Conditional Renaming: Only perform renaming when the key exists.

**Input-Output Examples**:

```python
from structlog.processors import EventRenamer

# Basic renaming
er = EventRenamer("event", "message")
event_dict = {"event": "test", "level": "info"}
result = er(None, None, event_dict)
print("Basic rename:", result)  # {'message': 'test', 'level': 'info'}

# Value renaming
er = EventRenamer("event", "message", replace_by="new_value")
event_dict = {"event": "test", "level": "info"}
result = er(None, None, event_dict)
print("Value rename:", result)  # {'message': 'new_value', 'level': 'info'}

# Chained renaming
event_dict = {"event": "test", "level": "info"}
er1 = EventRenamer("event", "message")
er2 = EventRenamer("level", "severity")
result = er2(None, None, er1(None, None, event_dict))
print("Chain rename:", result)  # {'message': 'test', 'severity': 'info'}

# Key does not exist
er = EventRenamer("nonexistent", "new_key")
event_dict = {"event": "test"}
result = er(None, None, event_dict)
print("Non-existent key:", result)  # {'event': 'test'} - No change
```

### Node 9: Console Renderer

**Function Description**: Provide colored console output rendering, supporting custom color styles, column formatting, and exception formatting.

**Rendering Functions**:
- Colored Output: Support different color styles for different levels.
- Column Formatting: Support custom column layouts and formatting.
- Exception Formatting: Support `Rich` and `better_exceptions` exception formatting.
- Event Padding: Support fixed-width padding for event names.

**Input-Output Examples**:

```python
from structlog.dev import ConsoleRenderer, RichTracebackFormatter
from io import StringIO

# Basic console rendering
cr = ConsoleRenderer(colors=False)
event_dict = {"event": "test"}
result = cr(None, None, event_dict)
print("Basic render:", result)  # "test                 event='test'"

# Rendering with timestamp
event_dict = {"event": "test", "timestamp": 42}
result = cr(None, None, event_dict)
print("With timestamp:", result)  # "42 test                 event='test'"

# Rendering with level
event_dict = {"event": "test", "level": "info"}
result = cr(None, None, event_dict)
print("With level:", result)  # "[info] test                 event='test'"

# Rendering with key-value pairs
event_dict = {"event": "test", "user": "john", "action": "login"}
result = cr(None, None, event_dict)
print("With key-values:", result)  # "test                 event='test' user='john' action='login'"

# Exception rendering
try:
    raise ValueError("test error")
except ValueError:
    event_dict = {"event": "error", "exc_info": True}
    result = cr(None, None, event_dict)
    print("With exception:", result)

# Rich exception formatting
rtf = RichTracebackFormatter()
sio = StringIO()
try:
    raise ValueError("rich error")
except ValueError:
    rtf(sio, (ValueError, ValueError("rich error"), None))
    print("Rich traceback:", sio.getvalue())

# Custom column formatting
from structlog.dev import Column, KeyValueColumnFormatter
formatter = KeyValueColumnFormatter(
    key_style="\033[36m",  # Cyan keys
    value_style="\033[35m",  # Magenta values
    reset_style="\033[0m"
)
column = Column("user", formatter)
cr = ConsoleRenderer(colors=True, columns=[column])
event_dict = {"event": "test", "user": "john"}
result = cr(None, None, event_dict)
print("Custom column:", result)
```

### Node 10: Standard Library Integration

**Function Description**: Provide in-depth integration with the Python standard library `logging` module, offering compatible APIs and functions.

**Integration Functions**:
- `BoundLogger`: A standard library-compatible bound logger.
- `AsyncBoundLogger`: An asynchronous bound logger.
- `ProcessorFormatter`: A processor formatter.
- `LoggerFactory`: A logger factory.

**Input-Output Examples**:

```python
from structlog.stdlib import BoundLogger, AsyncBoundLogger, ProcessorFormatter
from structlog.dev import ConsoleRenderer

# Standard library BoundLogger
logger = BoundLogger(None, [], {})  # logger is an instance of BoundLogger class
logger.info("test", user="john")  # Calls the standard library logging

# Asynchronous BoundLogger
async def test_async():
    logger = AsyncBoundLogger(None, [], {})  # logger is an instance of AsyncBoundLogger class
    await logger.ainfo("async test", user="john")
    return logger.sync_bl  # Returns the synchronous logger

# ProcessorFormatter integration
formatter = ProcessorFormatter(
    processor=ConsoleRenderer(colors=False),
    foreign_pre_chain=[
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name
    ]
)

handler = logging.StreamHandler()
handler.setFormatter(formatter)
logger = logging.getLogger("test")
logger.addHandler(handler)
logger.setLevel(logging.INFO)

logger.info("test message", extra={"user": "john"})

# Filter test
from structlog.stdlib import filter_by_level
event_dict = {"level": "info"}
result = filter_by_level(None, "info", event_dict)
print("Filter result:", result)

# Add log level
from structlog.stdlib import add_log_level
event_dict = {"event": "test"}
result = add_log_level(None, "info", event_dict)
print("Level added:", result)  # {'event': 'test', 'level': 'info'}

# Add logger name
from structlog.stdlib import add_logger_name
event_dict = {"event": "test"}
result = add_logger_name(None, "info", event_dict)
print("Logger name added:", result)  # {'event': 'test', 'logger_name': 'test'}
```

### Node 11: Context Variables Management

**Function Description**: Manage asynchronous context variables, supporting context passing and binding across coroutines.

**Management Functions**:
- Context Binding: `bind_contextvars()` binds the asynchronous context.
- Context Cleaning: `clear_contextvars()` clears the asynchronous context.
- Context Merging: `merge_contextvars()` merges context variables.
- Context Retrieval: `get_contextvars()` retrieves the current context.

**Input-Output Examples**:

```python
from structlog.contextvars import (
    bind_contextvars, clear_contextvars, merge_contextvars, get_contextvars
)

async def test_contextvars():
    # Bind context variables
    bind_contextvars(user_id=123, session_id="abc")

    # Get the context
    context = get_contextvars()
    print("Context:", context)  # {'user_id': 123, 'session_id': 'abc'}

    # Merge the context
    event_dict = {"event": "test"}
    result = merge_contextvars(None, None, event_dict)
    print("Merged:", result)  # {'event': 'test', 'user_id': 123, 'session_id': 'abc'}

    # Nested context
    tokens = bind_contextvars(user_id=456, request_id="def")
    print("Nested context:", get_contextvars())

    # Reset the context
    clear_contextvars(**tokens)
    print("After reset:", get_contextvars())

    # Clear all contexts
    clear_contextvars()
    print("After clear:", get_contextvars())

# Run the asynchronous test
asyncio.run(test_contextvars())

# Parallel context test
async def parallel_test():
    async def task1():
        bind_contextvars(task="task1")
        await asyncio.sleep(0.1)
        return get_contextvars()

    async def task2():
        bind_contextvars(task="task2")
        await asyncio.sleep(0.1)
        return get_contextvars()

    results = await asyncio.gather(task1(), task2())
    print("Parallel results:", results)
```

### Node 12: Thread Local Storage

**Function Description**: Manage thread-local storage, supporting context isolation in a multi-threaded environment.

**Storage Functions**:
- Thread Binding: `bind_threadlocal()` binds thread-local variables.
- Thread Cleaning: `clear_threadlocal()` clears thread-local variables.
- Thread Merging: `merge_threadlocal()` merges thread-local variables.
- Temporary Binding: `tmp_bind()` temporarily binds the context.

**Input-Output Examples**:

```python
from structlog.threadlocal import (
    bind_threadlocal, clear_threadlocal, merge_threadlocal, tmp_bind
)

def test_threadlocal():
    # Bind thread-local variables
    bind_threadlocal(user_id=123, thread_id=threading.get_ident())

    # Merge into the event dictionary
    event_dict = {"event": "test"}
    result = merge_threadlocal(None, None, event_dict)
    print("Thread local merged:", result)

    # Temporary binding
    with tmp_bind(None, temp_key="temp_value"):
        event_dict = {"event": "temp"}
        result = merge_threadlocal(None, None, event_dict)
        print("Temp bind result:", result)

    # Clear thread-local variables
    clear_threadlocal()
    event_dict = {"event": "after_clear"}
    result = merge_threadlocal(None, None, event_dict)
    print("After clear:", result)

# Multi-threaded test
def worker(thread_id):
    bind_threadlocal(worker_id=thread_id)
    event_dict = {"event": f"from_worker_{thread_id}"}
    result = merge_threadlocal(None, None, event_dict)
    print(f"Worker {thread_id}:", result)

threads = []
for i in range(3):
    t = threading.Thread(target=worker, args=(i,))
    threads.append(t)
    t.start()

for t in threads:
    t.join()
```

### Node 13: Exception Tracing System

**Function Description**: Provide complete exception tracing and formatting functions, supporting structured exception information and JSON format output.

**Tracing Functions**:
- Exception Extraction: `extract()` extracts exception information.
- Exception Transformation: `ExceptionDictTransformer` transforms exceptions into dictionaries.
- Stack Tracing: `Trace`, `Stack`, `Frame` structured stack information.
- Syntax Error: Special handling for `SyntaxError_`.

**Input-Output Examples**:

```python
from structlog.tracebacks import extract, ExceptionDictTransformer

# Exception extraction
try:
    raise ValueError("test error")
except ValueError:
    exc_info = (ValueError, ValueError("test error"), None)
    result = extract(*exc_info)
    print("Extract result:", result)

# Exception dictionary transformation
transformer = ExceptionDictTransformer()
try:
    raise RuntimeError("runtime error")
except RuntimeError:
    exc_info = (RuntimeError, RuntimeError("runtime error"), None)
    result = transformer(*exc_info)
    print("Transformer result:", result)

# JSON format exception
try:
    raise TypeError("type error")
except TypeError:
    exc_info = (TypeError, TypeError("type error"), None)
    result = extract(*exc_info)
    json_result = json.dumps(result, indent=2)
    print("JSON exception:", json_result)

# Syntax error handling
try:
    compile("invalid syntax", "<string>", "exec")
except SyntaxError as e:
    result = extract(type(e), e, e.__traceback__)
    print("Syntax error:", result)

# Complex exception chain
try:
    try:
        raise ValueError("inner error")
    except ValueError:
        raise RuntimeError("outer error") from ValueError("inner error")
except RuntimeError:
    exc_info = (RuntimeError, RuntimeError("outer error"), None)
    result = extract(*exc_info)
    print("Exception chain:", result)
```

### Node 14: Testing Framework Tools

**Function Description**: Provide a complete set of testing tools, supporting log capturing, verification, and simulation.

**Testing Functions**:
- Log Capturing: `capture_logs()` captures log outputs.
- Return Logger: `ReturnLogger` returns log contents.
- Capturing Logger: `CapturingLogger` captures log calls.
- Log Verification: `CapturedCall` verifies log calls.

**Input-Output Examples**:

```python
from structlog.testing import capture_logs, ReturnLogger, CapturingLogger, CapturedCall

# Log capturing test
with capture_logs() as captured:
    logger = get_logger()
    logger.info("test message", user="john")
    logger.error("error message", error_code=500)

print("Captured logs:", captured)
# Output: [{'event': 'test message', 'user': 'john'}, {'event': 'error message', 'error_code': 500}]

# ReturnLogger test
logger = ReturnLogger()  # logger is an instance of ReturnLogger class
result = logger.info("test", user="john")
print("ReturnLogger result:", result)  # "test"

# CapturingLogger test
cl = CapturingLogger()  # cl is an instance of CapturingLogger class
cl.info("test message")
cl.info("another message", extra="data")

print("Captured calls:", cl.calls)
# Output: [CapturedCall(method_name='info', args=('test message',), kwargs={}),
#        CapturedCall(method_name='info', args=('another message',), kwargs={'extra': 'data'})]

# Log verification
def test_log_calls():
    cl = CapturingLogger()  # cl is an instance of CapturingLogger class
    cl.info("test", user="john")

    assert len(cl.calls) == 1
    call = cl.calls[0]
    assert call.method_name == "info"
    assert call.args == ("test",)
    assert call.kwargs == {"user": "john"}

test_log_calls()
print("Log verification passed")

# Factory test
from structlog.testing import ReturnLoggerFactory
factory = ReturnLoggerFactory()  # factory is an instance of ReturnLoggerFactory class
logger = factory("test_logger")  # logger is an instance of ReturnLogger class
result = logger.info("factory test")
print("Factory result:", result)
```

### Node 15: Output System

**Function Description**: Provide support for multiple output formats, including print output, file output, and byte output.

**Output Types**:
- `PrintLogger`: Print to standard output.
- `WriteLogger`: Write to a specified stream.
- `BytesLogger`: Byte output.
- Factory Classes: Corresponding factory classes.

**Input-Output Examples**:

```python
from structlog._output import PrintLogger, WriteLogger, BytesLogger
from structlog._output import PrintLoggerFactory, WriteLoggerFactory, BytesLoggerFactory
from io import StringIO, BytesIO

# PrintLogger test
pl = PrintLogger()  # pl is an instance of PrintLogger class
result = pl.msg("test message")
print("PrintLogger result:", result)  # None (printed to stdout)

# WriteLogger test
sio = StringIO()
wl = WriteLogger(sio)
result = wl.msg("test message")
print("WriteLogger output:", sio.getvalue())  # "test message\n"

# BytesLogger test
bio = BytesIO()
bl = BytesLogger(bio)
result = bl.msg("test message")
print("BytesLogger output:", bio.getvalue())  # b"test message\n"

# Factory class test
plf = PrintLoggerFactory()
logger = plf("test")
result = logger.msg("factory test")

wlf = WriteLoggerFactory(sio)
logger = wlf("test")
result = logger.msg("write factory test")

blf = BytesLoggerFactory(bio)
logger = blf("test")
result = logger.msg("bytes factory test")

# Error handling test
pl = PrintLogger()
try:
    pl.err("error message")
except Exception as e:
    print("Error handling:", e)

# Log level test
pl = PrintLogger()
pl.debug("debug message")
pl.info("info message")
pl.warning("warning message")
pl.error("error message")
pl.critical("critical message")
```

### Node 16: Type System

**Function Description**: Provide complete type annotations and type checking support to ensure type safety and IDE intelligent prompts.

**Type Definitions**:
- `EventDict`: Event dictionary type.
- `WrappedLogger`: Wrapped logger type.
- `Processor`: Processor type.
- `Context`: Context type.
- `BindableLogger`: Bindable logger protocol.

**Input-Output Examples**:

```python
from structlog.typing import EventDict, WrappedLogger, Processor, Context, BindableLogger
from typing import Any

# EventDict type
event_dict: EventDict = {"event": "test", "level": "info", "user": "john"}
print("EventDict:", event_dict)

# WrappedLogger type
class CustomLogger:
    def msg(self, message: str) -> None:
        print(f"CUSTOM: {message}")

wrapped_logger: WrappedLogger = CustomLogger()
wrapped_logger.msg("test message")

# Processor type
def custom_processor(logger: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
    event_dict["processed"] = True
    return event_dict

processor: Processor = custom_processor
result = processor(None, "info", {"event": "test"})
print("Processor result:", result)

# Context type
context: Context = {"user_id": 123, "session_id": "abc"}
print("Context:", context)

# BindableLogger protocol
class MyLogger(BindableLogger):
    def __init__(self, wrapped_logger: WrappedLogger, processors: list[Processor], context: Context):
        self._logger = wrapped_logger
        self._processors = processors
        self._context = context

    def bind(self, **new_values: Any) -> "MyLogger":
        new_context = dict(self._context, **new_values)
        return MyLogger(self._logger, self._processors, new_context)

    def unbind(self, *keys: str) -> "MyLogger":
        new_context = dict(self._context)
        for key in keys:
            new_context.pop(key, None)
        return MyLogger(self._logger, self._processors, new_context)

    def new(self, **new_values: Any) -> "MyLogger":
        return MyLogger(self._logger, self._processors, new_values)

# Type checking test
def type_check_test(logger: BindableLogger) -> None:
    bound_logger = logger.bind(user="john")
    unbound_logger = bound_logger.unbind("user")
    new_logger = logger.new(session="new")

type_check_test(MyLogger(None, [], {}))
print("Type check passed")
```

### Node 17: Twisted Framework Integration

**Function Description**: Provide in-depth integration with the Twisted asynchronous framework, offering asynchronous logging and event loop integration.

**Integration Functions**:
- `TwistedLogger`: A Twisted-compatible logger.
- `TwistedLoggerFactory`: A Twisted logger factory.
- `EventAdapter`: An event adapter.
- `JSONRenderer`: A JSON renderer.

**Input-Output Examples**:

```python
# Note: You need to install Twisted to run these examples
try:
    from structlog.twisted import (
        BoundLogger, LoggerFactory, EventAdapter, JSONRenderer
    )

    # TwistedLogger test
    logger = BoundLogger(None, [], {})
    result = logger.msg("test message", user="john")
    print("TwistedLogger result:", result)

    # LoggerFactory test
    factory = LoggerFactory()
    twisted_logger = factory("test_logger")
    print("Twisted logger:", twisted_logger)

    # EventAdapter test
    adapter = EventAdapter()
    event_dict = {"event": "test", "user": "john"}
    result = adapter(None, None, event_dict)
    print("EventAdapter result:", result)

    # JSONRenderer test
    renderer = JSONRenderer()
    event_dict = {"event": "test", "user": "john", "level": "info"}
    result = renderer(None, None, event_dict)
    print("JSONRenderer result:", result)

except ImportError:
    print("Twisted not available, skipping Twisted integration tests")
```

### Node 18: Utility Functions

**Function Description**: Provide various utility functions to support functions such as process name retrieval, exception formatting, and stack formatting.

**Utility Functions**:
- `get_processname()`: Get the process name.
- `_format_exception()`: Format exceptions.
- `_format_stack()`: Format stacks.
- `_find_first_app_frame_and_name()`: Find the application frame.

**Input-Output Examples**:

```python
from structlog._utils import get_processname
from structlog._frames import _format_exception, _format_stack, _find_first_app_frame_and_name

# Process name retrieval
process_name = get_processname()
print("Process name:", process_name)

# Exception formatting
try:
    raise ValueError("test exception")
except ValueError:
    exc_info = (ValueError, ValueError("test exception"), None)
    formatted = _format_exception(exc_info)
    print("Formatted exception:", formatted)

# Stack formatting
stack = traceback.extract_stack()
formatted_stack = _format_stack(stack)
print("Formatted stack:", formatted_stack)

# Application frame finding
frame, name = _find_first_app_frame_and_name()
print("App frame:", frame)
print("App name:", name)

# Utility function integration test
def test_utility_integration():
    # Use utility functions in a processor
    def custom_processor(logger, method_name, event_dict):
        event_dict["process_name"] = get_processname()
        return event_dict

    configure(processors=[custom_processor, KeyValueRenderer()])
    logger = get_logger()
    result = logger.info("test")
    print("Utility integration result:", result)

test_utility_integration()
```

### Node 19: TimeStamper System

**Function Description**: Provide flexible timestamp processing functions, supporting multiple time formats and conditional timestamp addition.

**Timestamp Functions**:
- **TimeStamper**: Always add a timestamp to the event dictionary.
- **MaybeTimeStamper**: Add a timestamp only if there is no existing timestamp.
- **Time Format Support**: ISO 8601, UNIX timestamps, custom `strftime` formats.
- **Time Zone Handling**: Support UTC and local time.
- **Serialization Support**: Support `pickle` serialization.

**Input-Output Examples**:

```python
from structlog.processors import TimeStamper, MaybeTimeStamper

# TimeStamper - Always add a timestamp
@freeze_time("2024-01-01 12:00:00")
def test_timestamper():
    ts = TimeStamper(fmt="%Y-%m-%d %H:%M:%S", utc=True)
    event_dict = {"event": "test"}
    result = ts(None, None, event_dict)
    print("TimeStamper result:", result)  # {'event': 'test', 'timestamp': '2024-01-01 12:00:00'}

# Custom time format
ts_custom = TimeStamper(fmt="%Y-%m-%d", key="date")
event_dict = {"event": "test"}
result = ts_custom(None, None, event_dict)
print("Custom format:", result)  # {'event': 'test', 'date': '2024-01-01'}

# UNIX timestamp
ts_unix = TimeStamper(fmt=None, utc=True)
event_dict = {"event": "test"}
result = ts_unix(None, None, event_dict)
print("UNIX timestamp:", result)  # {'event': 'test', 'timestamp': 1704110400.0}

# MaybeTimeStamper - Conditional timestamp
mts = MaybeTimeStamper(fmt="%Y-%m-%d %H:%M:%S")

# Add when there is no existing timestamp
event_dict = {"event": "test"}
result = mts(None, None, event_dict)
print("MaybeTimeStamper - no existing:", result)  # Timestamp added

# Keep when there is an existing timestamp
event_dict = {"event": "test", "timestamp": "existing"}
result = mts(None, None, event_dict)
print("MaybeTimeStamper - existing:", result)  # {'event': 'test', 'timestamp': 'existing'}

# Serialization test
ts = TimeStamper(fmt="%Y-%m-%d", utc=True)
pickled = pickle.dumps(ts)
unpickled = pickle.loads(pickled)
print("Pickle test:", unpickled is not None)  # True
```

### Node 20: Exception Renderer System

**Function Description**: Provide structured exception handling and rendering functions, supporting the extraction, formatting, and cleaning of exception information.

**Exception Handling Functions**:
- **ExceptionRenderer**: A structured exception renderer.
- **format_exc_info**: An exception formatting function.
- **Exception Information Extraction**: Extract exception information from the event dictionary.
- **Exception Cleaning**: Automatically clean the exception information after processing.
- **Custom Formatter**: Support custom exception formatting functions.

**Input-Output Examples**:

```python
from structlog.processors import ExceptionRenderer, format_exc_info

# ExceptionRenderer - Basic exception handling
er = ExceptionRenderer()
try:
    raise ValueError("test error")
except ValueError:
    event_dict = {"event": "error occurred", "exc_info": True}
    result = er(None, None, event_dict)
    print("ExceptionRenderer result:", result)  # Exception information removed
    print("Exception added:", "exception" in result)  # True

# Custom exception formatter
def custom_formatter(exc_info):
    return f"CUSTOM: {exc_info[1]}"

er_custom = ExceptionRenderer(exception_formatter=custom_formatter)
try:
    raise RuntimeError("custom error")
except RuntimeError:
    event_dict = {"event": "custom error", "exc_info": True}
    result = er_custom(None, None, event_dict)
    print("Custom formatter result:", result)

# format_exc_info - Direct exception formatting
try:
    raise TypeError("type error")
except TypeError:
    result = format_exc_info(None, None, {"event": "test"})
    print("format_exc_info result:", result)

# Exception information cleaning test
er = ExceptionRenderer()
event_dict = {"event": "test", "exc_info": True}
result = er(None, None, event_dict)
print("exc_info removed:", "exc_info" not in result)  # True

# No exception case
event_dict = {"event": "no exception"}
result = er(None, None, event_dict)
print("No exception result:", result)  # Original event dictionary remains unchanged
```

### Node 21: Renderer System

**Function Description**: Provide renderers for multiple output formats, supporting log outputs in formats such as key-value pairs, logfmt, and JSON.

**Renderer Types**:
- **KeyValueRenderer**: Key-value pair format renderer.
- **LogfmtRenderer**: logfmt format renderer.
- **JSONRenderer**: JSON format renderer.
- **Renderer Configuration**: Sorting, key order, handling of missing keys, handling of boolean values.

**Input-Output Examples**:

```python
from structlog.processors import KeyValueRenderer, LogfmtRenderer, JSONRenderer

# KeyValueRenderer - Key-value pair format
kvr = KeyValueRenderer(sort_keys=True)
event_dict = {"event": "test", "user": "john", "level": "info"}
result = kvr(None, None, event_dict)
print("KeyValueRenderer:", result)  # "event='test' level='info' user='john'"

# Custom key order
kvr_ordered = KeyValueRenderer(key_order=["level", "event", "user"])
result = kvr_ordered(None, None, event_dict)
print("Ordered keys:", result)  # "level='info' event='test' user='john'"

# Handling of missing keys
kvr_missing = KeyValueRenderer(key_order=["missing", "event", "user"], drop_missing=True)
result = kvr_missing(None, None, event_dict)
print("Missing keys dropped:", result)  # "event='test' user='john'"

# LogfmtRenderer - logfmt format
lfr = LogfmtRenderer()
event_dict = {"event": "test", "user": "john", "active": True}
result = lfr(None, None, event_dict)
print("LogfmtRenderer:", result)  # "event=test user=john active"

# Boolean values as flags
lfr_bool = LogfmtRenderer(bool_as_flag=True)
event_dict = {"event": "test", "debug": True, "verbose": False}
result = lfr_bool(None, None, event_dict)
print("Boolean flags:", result)  # "event=test debug verbose=false"

# JSONRenderer - JSON format
jr = JSONRenderer()
event_dict = {"event": "test", "user": "john", "data": {"id": 123}}
result = jr(None, None, event_dict)
print("JSONRenderer:", result)  # '{"event": "test", "user": "john", "data": {"id": 123}}'

# Custom JSON serializer
def custom_serializer(obj):
    if isinstance(obj, set):
        return list(obj)
    return str(obj)

jr_custom = JSONRenderer(serializer=custom_serializer)
event_dict = {"event": "test", "tags": {"a", "b", "c"}}
result = jr_custom(None, None, event_dict)
print("Custom serializer:", result)  # '{"event": "test", "tags": ["a", "b", "c"]}'

# Handling of complex objects
class CustomObject:
    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f"CustomObject({self.value})"

event_dict = {"event": "test", "obj": CustomObject(42)}
result = jr(None, None, event_dict)
print("Complex object:", result)  # Contains the JSON representation of the object
```

### Node 22: Native Logging System

**Function Description**: Provide high-performance native logging functions, supporting log level filtering and asynchronous logging.

**Native Functions**:
- **make_filtering_bound_logger**: Create a filtering bound logger.
- **Log Level Filtering**: Intelligent filtering based on log levels.
- **Asynchronous Logging Support**: Asynchronous logging methods.
- **Performance Optimization**: Native performance optimization features.
- **Context Variable Integration**: In-depth integration with `contextvars`.

**Input-Output Examples**:

```python
from structlog._native import make_filtering_bound_logger

# Create a filtering logger
bl = make_filtering_bound_logger(logging.INFO)
logger = bl(None, [], {})

# Log level filtering test
logger.debug("debug message")    # Filtered, no output
logger.info("info message")      # Output
logger.warning("warning message")  # Output
logger.error("error message")    # Output

# Asynchronous logging support
async def test_async_logging():
    await logger.ainfo("async info message")
    await logger.awarning("async warning message")
    await logger.aerror("async error message")

    # Asynchronous exception recording
    try:
        raise ValueError("async exception")
    except ValueError:
        await logger.aexception("async exception occurred")

# Run the asynchronous test
asyncio.run(test_async_logging())

# Log level check
assert logger.is_enabled_for(logging.INFO)     # True
assert logger.is_enabled_for(logging.DEBUG)    # False
assert logger.is_enabled_for(logging.WARNING)  # True

# Get the effective log level
effective_level = logger.get_effective_level()
print("Effective level:", effective_level)  # 20 (INFO)

# Support for string levels
bl_str = make_filtering_bound_logger("wArNiNg")
logger_str = bl_str(None, [], {})
logger_str.info("info message")     # Filtered
logger_str.warning("warning message")  # Output

# Context variable integration
from structlog.contextvars import bind_contextvars, merge_contextvars

async def test_context_integration():
    bind_contextvars(user_id=123, session="abc")

    # Asynchronous logs will automatically merge the context
    await logger.ainfo("user action", action="login")

    # The context will be automatically included in the logs
    event_dict = {"event": "test"}
    result = merge_contextvars(None, None, event_dict)
    print("Context merged:", result)  # {'event': 'test', 'user_id': 123, 'session': 'abc'}

# Serialization support
bl_pickle = make_filtering_bound_logger(logging.ERROR)
logger_pickle = bl_pickle(None, [], {})
pickled = pickle.dumps(logger_pickle)
unpickled = pickle.loads(pickled)
print("Pickle test:", unpickled is not None)  # True
```

### Node 23: Advanced Development Tools

**Function Description**: Provide advanced development tools, including Rich exception formatting, `better-exceptions` integration, and a custom column formatting system.

**Advanced Functions**:
- **RichTracebackFormatter**: A Rich exception formatter.
- **better_traceback**: A `better-exceptions` formatter.
- **Column System**: Custom column formatting.
- **LogLevelColumnFormatter**: A log level column formatter.
- **Exception Formatters**: Multiple exception formatting options.

**Input-Output Examples**:

```python
from structlog.dev import (
    RichTracebackFormatter, better_traceback, Column, 
    LogLevelColumnFormatter, ConsoleRenderer
)
from io import StringIO

# RichTracebackFormatter - Rich exception formatting
rtf = RichTracebackFormatter()
sio = StringIO()

try:
    raise ValueError("rich error with details")
except ValueError:
    rtf(sio, sys.exc_info())
    rich_output = sio.getvalue()
    print("Rich traceback length:", len(rich_output))  # Contains rich formatted output

# Rich formatter with custom width
rtf_custom = RichTracebackFormatter(width=80)
sio_custom = StringIO()
try:
    raise RuntimeError("custom width error")
except RuntimeError:
    rtf_custom(sio_custom, sys.exc_info())
    print("Custom width output:", len(sio_custom.getvalue()))

# better_traceback - better-exceptions formatter
sio_better = StringIO()
try:
    raise TypeError("better exceptions error")
except TypeError:
    better_traceback(sio_better, sys.exc_info())
    better_output = sio_better.getvalue()
    print("Better exceptions output:", len(better_output))

# Column System - Custom column formatting
def custom_formatter(key, value):
    return f"[{key.upper()}: {value}]"

column = Column("user", custom_formatter)
cr = ConsoleRenderer(colors=False, columns=[column])

event_dict = {"event": "test", "user": "john"}
result = cr(None, None, event_dict)
print("Custom column:", result)  # Contains the custom-formatted user column

# LogLevelColumnFormatter - Log level column formatting
llcf = LogLevelColumnFormatter(None, "")
level_column = Column("level", llcf)
cr_level = ConsoleRenderer(colors=True, columns=[level_column])

event_dict = {"event": "test", "level": "error"}
result = cr_level(None, None, event_dict)
print("Level column:", result)  # Contains the formatted log level

# Combination of multiple columns
def timestamp_formatter(key, value):
    return f"TIME: {value}"

timestamp_column = Column("timestamp", timestamp_formatter)
user_column = Column("user", custom_formatter)

cr_multi = ConsoleRenderer(
    colors=False, 
    columns=[timestamp_column, level_column, user_column]
)

event_dict = {
    "event": "multi-column test",
    "timestamp": "2024-01-01 12:00:00",
    "level": "info",
    "user": "admin"
}
result = cr_multi(None, None, event_dict)
print("Multi-column:", result)

# Exception formatter integration
def custom_exception_formatter(exc_info):
    return f"CUSTOM EXCEPTION: {exc_info[1]}"

cr_exception = ConsoleRenderer(
    colors=False,
    exception_formatter=custom_exception_formatter
)

try:
    raise ValueError("custom exception")
except ValueError:
    event_dict = {"event": "exception test", "exc_info": True}
    result = cr_exception(None, None, event_dict)
    print("Custom exception formatter:", result)
```

### Node 24: Generic Bound Logger

**Function Description**: Provides a generic implementation of a bound logger, supporting method caching, serialization, and deep copying functions.

**Generic Features**:
- **BoundLogger**: Generic implementation of a bound logger
- **Method Caching**: Dynamic caching mechanism for logging methods
- **Serialization Support**: Full pickle serialization support
- **Deep Copying**: Support for deep copying functions
- **Type Preservation**: Binding operations preserve the original type

**Input-Output Examples**:

```python
from structlog._generic import BoundLogger
from structlog.testing import ReturnLogger
from structlog._config import _CONFIG

# Creation of a generic bound logger
bl = BoundLogger(
    ReturnLogger(),
    _CONFIG.default_processors,
    _CONFIG.default_context_class(),
)

# Basic logging
result = bl.info("test message", user="john")
print("Basic logging:", result)  # "test message"

# Context binding
bound_logger = bl.bind(user_id=123, session="abc")
result = bound_logger.info("bound message")
print("Bound logging:", result)  # "bound message"

# Method caching test
# The first call will cache the info method
bound_logger.info("first call")
# The second call uses the cached method
bound_logger.info("second call")

# Check if the method is cached
assert "info" in bound_logger.__dict__  # True

# Serialization support
logger_with_context = bl.bind(x=42, y=23)
pickled = pickle.dumps(logger_with_context)
unpickled = pickle.loads(pickled)

# Verify the functionality after serialization
result_original = logger_with_context.info("original")
result_unpickled = unpickled.info("unpickled")
print("Serialization test:", result_original == result_unpickled)  # True

# Deep copy support
logger_copy = copy.deepcopy(logger_with_context)
result_copy = logger_copy.info("copied")
print("Deep copy test:", result_copy)  # "copied"

# Type preservation test
class CustomLogger(BoundLogger):
    def custom_method(self):
        return "custom"

custom_bl = CustomLogger(ReturnLogger(), [], {})
bound_custom = custom_bl.bind(user="john")

# Preserve the original type after binding
assert isinstance(bound_custom, CustomLogger)  # True
result_custom = bound_custom.custom_method()
print("Type preservation:", result_custom)  # "custom"

# Context immutability test
original_context = dict(bound_logger._context)
new_bound = bound_logger.bind(additional="value")

# The original context should not be modified
assert bound_logger._context == original_context  # True
assert new_bound._context != original_context     # True

# Method proxy test
# Test all standard logging methods
methods = ["debug", "info", "warning", "error", "critical", "exception"]
for method in methods:
    if hasattr(bound_logger, method):
        result = getattr(bound_logger, method)(f"{method} test")
        print(f"{method} method:", result)

# Context merging test
logger1 = bl.bind(a=1, b=2)
logger2 = logger1.bind(b=3, c=4)  # b is overwritten, c is added

expected_context = {"a": 1, "b": 3, "c": 4}
assert logger2._context == expected_context  # True
```

### Node 25: Package Metadata System

**Function Description**: Provides package metadata access functionality, supporting the retrieval of metadata such as version information, package description, project URI, etc.

**Metadata Features**:
- **Version Information**: `__version__` to get the current version
- **Package Description**: `__description__` to get the package description
- **Project URI**: `__uri__` to get the project URL
- **Author Email**: `__email__` to get the author's email
- **Metadata Compatibility**: Backward-compatible metadata access method

**Input-Output Examples**:

```python
import structlog
from importlib import metadata

# Retrieve version information
version = structlog.__version__
print("Structlog version:", version)  # e.g., "25.4.1.dev6"

# Verify version information
metadata_version = metadata.version("structlog")
assert version == metadata_version
print("Version verification:", version == metadata_version)  # True

# Retrieve package description
description = structlog.__description__
print("Package description:", description)  # "Structured Logging for Python"

# Retrieve project URI
uri = structlog.__uri__
print("Project URI:", uri)  # "https://www.structlog.org/"

# Retrieve author email
email = structlog.__email__
print("Author email:", email)  # "hs@ox.cx"

# Metadata compatibility test
try:
    # Use importlib.metadata to retrieve metadata
    metadata_description = metadata.metadata("structlog")["Summary"]
    assert description == metadata_description
    print("Metadata compatibility:", True)
except Exception as e:
    print("Metadata compatibility error:", e)

# Test for non-existent metadata attributes
try:
    non_existent = structlog.__nonexistent__
except AttributeError as e:
    print("Non-existent attribute error:", e)  # Correct error handling

# Metadata access performance test

# Direct access
start_time = time.time()
for _ in range(1000):
    version = structlog.__version__
direct_time = time.time() - start_time

# importlib.metadata access
start_time = time.time()
for _ in range(1000):
    version = metadata.version("structlog")
metadata_time = time.time() - start_time

print(f"Direct access time: {direct_time:.4f}s")
print(f"Metadata access time: {metadata_time:.4f}s")
print(f"Performance ratio: {metadata_time/direct_time:.2f}x")

# Metadata integrity verification
required_attributes = ["__version__", "__description__", "__uri__", "__email__"]
missing_attributes = []

for attr in required_attributes:
    try:
        getattr(structlog, attr)
    except AttributeError:
        missing_attributes.append(attr)

if missing_attributes:
    print("Missing attributes:", missing_attributes)
else:
    print("All required attributes present")

# Version comparison function
def version_compare(version1, version2):
    """Simple version comparison function"""
    from packaging import version as pkg_version
    return pkg_version.parse(version1) >= pkg_version.parse(version2)

current_version = structlog.__version__
print("Current version:", current_version)
print("Is version >= 20.0.0:", version_compare(current_version, "20.0.0"))
print("Is version >= 30.0.0:", version_compare(current_version, "30.0.0"))

# Metadata caching test
# Multiple accesses should return the same result
version1 = structlog.__version__
version2 = structlog.__version__
assert version1 == version2
print("Metadata caching test:", version1 == version2)  # True
```

---
