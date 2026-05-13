# Introduction to the Tenacity Project

## Overview
Tenacity is a general-purpose Python retry library designed to automatically add a **failure retry** mechanism to various functions or operations. It supports both synchronous and asynchronous (asyncio, trio, tornado) scenarios, allowing users to flexibly configure retry conditions, stop strategies, wait strategies, exception handling, etc.
The core features include: supporting the addition of automatic retry functionality to any function through the decorator (`@retry`); customizing retry stop conditions (such as maximum number of attempts, maximum time, etc.); customizing the wait strategy for each retry (such as fixed interval, random interval, exponential backoff, etc.); supporting retry determination based on specific exceptions, return values, etc.; supporting the retry of asynchronous functions; supporting custom callbacks before and after retry, and before waiting (such as logging); providing detailed retry statistics.
In short, Tenacity is committed to providing developers with a flexible, powerful, and easy-to-use automatic retry solution, which is widely used in error-prone scenarios such as network requests, database operations, and distributed systems.

## Natural Language Instruction (Prompt)

Please create a Python project named Tenacity to implement a general-purpose automatic retry library. The project should include the following core features:

1. **Retry Decorator and Core Mechanism**: Implement the `@retry` decorator to automatically add a retry mechanism to any synchronous or asynchronous function. Support multiple modes such as infinite retry, limited number of retries, and timeout retry, and be able to automatically track the number of attempts, exception chain, and statistical information.

2. **Stop Condition Strategy**: Support multiple strategies to stop retrying, including maximum number of attempts (`stop_after_attempt`), maximum retry duration (`stop_after_delay`), early termination (`stop_before_delay`), and multi-condition combinations (AND/OR).

3. **Wait Strategy**: Support multiple wait strategies such as fixed wait, incremental wait, random wait, exponential backoff, jitter, and chained wait. All wait strategies can be flexibly combined to adapt to different business scenarios.

4. **Retry Condition Strategy**: Support custom retry conditions based on exception type, exception message, return value, etc., support multi-condition combinations (AND/OR/NOT), and flexibly control the retry logic.

5. **Asynchronous and Multi-Ecosystem Support**: Support the retry of asynchronous scenarios such as `asyncio`, `trio`, and `tornado`, automatically identify synchronous/asynchronous functions and schedule their execution to ensure that the event loop is not blocked.

6. **Callback and Logging Mechanism**: Support custom callbacks before, after, and before waiting for retry (such as logging, statistics, external notifications, etc.), and flexibly insert custom logic to improve observability and debuggability.

7. **Context Manager and Code Block Retry**: Implement the `Retrying` and `AsyncRetrying` classes to support the retry of any code block using the for/with structure, which is convenient for multi-step operations and resource management.

8. **Dynamic Parameters and Advanced Usage**: Support the dynamic modification of retry parameters at runtime (`retry_with`), and support advanced testing scenarios such as custom callbacks, mock sleep, mock logger, retry_error_callback, and custom exception chain.

9. **Statistics and Monitoring**: Each function decorated with `@retry` has a `statistics` attribute, which records information such as the number of retries, start time, and elapsed time, facilitating the monitoring of retry behavior, alarm, and performance analysis.

10. **Type Safety and Compatibility**: Support type annotations, mypy/typeguard checks, and be compatible with Python 3.9+ and mainstream asynchronous ecosystems.

11. **Error Handling and Boundary Scenarios**: Support `reraise=True`, actively trigger retry with `TryAgain`, make `RetryError` serializable, and track the exception chain, which is suitable for complex exception handling and distributed scenarios.

12. **Core File Requirements**: The project must include a complete `pyproject.toml` file to declare the project as an installable package (supporting 'pip installation') and fully declare dependencies. `tenacity/__init__. py ` should be used as a unified API entry to import and export classes such as ` retry `, ` Retrating `, ` AsyncRetring `, etc., and provide version information so that all major features can be accessed through simple ` from tenacity import xxx ` or `import tenacity`.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
attrs             25.3.0
exceptiongroup    1.3.0
idna              3.10
iniconfig         2.1.0
outcome           1.3.0.post0
packaging         25.0
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
setuptools        65.5.1
sniffio           1.3.1
sortedcontainers  2.4.0
tomli             2.2.1
tornado           6.5.1
trio              0.30.0
typeguard         4.4.4
typing_extensions 4.14.1
wheel             0.40.0
```

## Tenacity Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .editorconfig
├── .gitignore
├── .mergify.yml
├── .readthedocs.yml
├── LICENSE
├── README.rst
├── doc
│   ├── source
│   │   ├── api.rst
│   │   ├── changelog.rst
│   │   ├── conf.py
│   │   └── index.rst
├── pyproject.toml
├── releasenotes
│   ├── notes
│   │   ├── Fix-tests-for-typeguard-3.x-6eebfea546b6207e.yaml
│   │   ├── Use--for-formatting-and-validate-using-black-39ec9d57d4691778.yaml
│   │   ├── add-async-actions-b249c527d99723bb.yaml
│   │   ├── add-re-pattern-to-match-types-6a4c1d9e64e2a5e1.yaml
│   │   ├── add-reno-d1ab5710f272650a.yaml
│   │   ├── add-retry_except_exception_type-31b31da1924d55f4.yaml
│   │   ├── add-stop-before-delay-a775f88ac872c923.yaml
│   │   ├── add-test-extra-55e869261b03e56d.yaml
│   │   ├── add_omitted_modules_to_import_all-2ab282f20a2c22f7.yaml
│   │   ├── add_retry_if_exception_cause_type-d16b918ace4ae0ad.yaml
│   │   ├── added_a_link_to_documentation-eefaf8f074b539f8.yaml
│   │   ├── after_log-50f4d73b24ce9203.yaml
│   │   ├── allow-mocking-of-nap-sleep-6679c50e702446f1.yaml
│   │   ├── annotate_code-197b93130df14042.yaml
│   │   ├── before_sleep_log-improvements-d8149274dfb37d7c.yaml
│   │   ├── clarify-reraise-option-6829667eacf4f599.yaml
│   │   ├── dependabot-for-github-actions-4d2464f3c0928463.yaml
│   │   ├── do_not_package_tests-fe5ac61940b0a5ed.yaml
│   │   ├── drop-deprecated-python-versions-69a05cb2e0f1034c.yaml
│   │   ├── drop_deprecated-7ea90b212509b082.yaml
│   │   ├── export-convenience-symbols-981d9611c8b754f3.yaml
│   │   ├── fix-async-loop-with-result-f68e913ccb425aca.yaml
│   │   ├── fix-local-context-overwrite-94190ba06a481631.yaml
│   │   ├── fix-retry-wrapper-attributes-f7a3a45b8e90f257.yaml
│   │   ├── fix-setuptools-config-3af71aa3592b6948.yaml
│   │   ├── fix-wait-typing-b26eecdb6cc0a1de.yaml
│   │   ├── fix_async-52b6594c8e75c4bc.yaml
│   │   ├── make-logger-more-compatible-5da1ddf1bab77047.yaml
│   │   ├── no-async-iter-6132a42e52348a75.yaml
│   │   ├── pr320-py3-only-wheel-tag.yaml
│   │   ├── py36_plus-c425fb3aa17c6682.yaml
│   │   ├── remove-py36-876c0416cf279d15.yaml
│   │   ├── retrycallstate-repr-94947f7b00ee15e1.yaml
│   │   ├── some-slug-for-preserve-defaults-86682846dfa18005.yaml
│   │   ├── sphinx_define_error-642c9cd5c165d39a.yaml
│   │   ├── support-py3.14-14928188cab53b99.yaml
│   │   ├── support-timedelta-wait-unit-type-5ba1e9fc0fe45523.yaml
│   │   ├── timedelta-for-stop-ef6bf71b88ce9988.yaml
│   │   ├── trio-support-retry-22bd544800cd1f36.yaml
│   │   ├── wait-random-exponential-min-2a4b7eed9f002436.yaml
│   │   └── wait_exponential_jitter-6ffc81dddcbaa6d3.yaml
├── reno.yaml
├── tenacity
│   ├── __init__.py
│   ├── _utils.py
│   ├── after.py
│   ├── asyncio
│   │   ├── __init__.py
│   │   └── retry.py
│   ├── before.py
│   ├── before_sleep.py
│   ├── nap.py
│   ├── py.typed
│   ├── retry.py
│   ├── stop.py
│   ├── tornadoweb.py
│   └── wait.py
└── tox.ini

```

## API Usage Guide

### 1. Module Import

```python
import tenacity
from tenacity import AsyncRetrying, RetryError, retry, retry_if_exception, retry_if_result, stop_after_attempt, after_log, RetryCallState, Retrying
from tenacity import asyncio as tasyncio
from tenacity import tornadoweb
from tenacity.wait import wait_fixed
```

### 2. Core API

#### 2.1 `retry` Decorator

Decorate a function to automatically retry when an exception occurs.

```python
@t.overload
def retry(func: WrappedFn) -> WrappedFn: ...


@t.overload
def retry(
    sleep: t.Callable[[t.Union[int, float]], t.Union[None, t.Awaitable[None]]] = sleep,
    stop: "StopBaseT" = stop_never,
    wait: "WaitBaseT" = wait_none(),
    retry: "t.Union[RetryBaseT, tasyncio.retry.RetryBaseT]" = retry_if_exception_type(),
    before: t.Callable[
        ["RetryCallState"], t.Union[None, t.Awaitable[None]]
    ] = before_nothing,
    after: t.Callable[
        ["RetryCallState"], t.Union[None, t.Awaitable[None]]
    ] = after_nothing,
    before_sleep: t.Optional[
        t.Callable[["RetryCallState"], t.Union[None, t.Awaitable[None]]]
    ] = None,
    reraise: bool = False,
    retry_error_cls: t.Type["RetryError"] = RetryError,
    retry_error_callback: t.Optional[
        t.Callable[["RetryCallState"], t.Union[t.Any, t.Awaitable[t.Any]]]
    ] = None,
) -> t.Callable[[WrappedFn], WrappedFn]: ...
```

**Parameter Description:**
    - `sleep`: Sleep function for implementing the wait logic
    - `stop`: Stop strategy for determining whether to stop retrying
    - `wait`: Wait strategy for implementing the wait logic
    - `retry`: Retry strategy for determining whether to retry
    - `before`: Callback function before retry
    - `after`: Callback function after retry
    - `before_sleep`: Callback function before waiting for retry
    - `reraise`: Whether to re-raise the last exception
    - `retry_error_cls`: Exception class to be thrown when all retries are exhausted
    - `retry_error_callback`: Callback function for retry errors

## 2. Core Classes

### 2.1 `Retrying` Class
The main class for implementing the retry logic.

```python
class Retrying(BaseRetrying):
    """Retrying controller."""

    def __call__(
        self,
        fn: t.Callable[..., WrappedFnReturnT],
        *args: t.Any,
        **kwargs: t.Any,
    ) -> WrappedFnReturnT:
        self.begin()

        retry_state = RetryCallState(retry_object=self, fn=fn, args=args, kwargs=kwargs)
        while True:
            do = self.iter(retry_state=retry_state)
            if isinstance(do, DoAttempt):
                try:
                    result = fn(*args, **kwargs)
                except BaseException:  # noqa: B902
                    retry_state.set_exception(sys.exc_info())  # type: ignore[arg-type]
                else:
                    retry_state.set_result(result)
            elif isinstance(do, DoSleep):
                retry_state.prepare_for_next_attempt()
                self.sleep(do)
            else:
                return do  # type: ignore[no-any-return]

```

**Methods:**
- `__call__(fn, *args, **kwargs)`: Call the wrapped function using the retry logic
    - `fn`: The function to be retried
    - `args`: Positional arguments
    - `kwargs`: Keyword arguments
- `BaseRetrying`: Base retry class


### 2.2 `RetryCallState` Class
Stores the state of a retryable function call.
```python

class RetryCallState:
    """State related to a single call wrapped with Retrying."""

    def __init__(
        self,
        retry_object: BaseRetrying,
        fn: t.Optional[WrappedFn],
        args: t.Any,
        kwargs: t.Any,
    ) -> None:
        #: Retry call start timestamp
        self.start_time = time.monotonic()
        #: Retry manager object
        self.retry_object = retry_object
        #: Function wrapped by this retry call
        self.fn = fn
        #: Arguments of the function wrapped by this retry call
        self.args = args
        #: Keyword arguments of the function wrapped by this retry call
        self.kwargs = kwargs

        #: The number of the current attempt
        self.attempt_number: int = 1
        #: Last outcome (result or exception) produced by the function
        self.outcome: t.Optional[Future] = None
        #: Timestamp of the last outcome
        self.outcome_timestamp: t.Optional[float] = None
        #: Time spent sleeping in retries
        self.idle_for: float = 0.0
        #: Next action as decided by the retry manager
        self.next_action: t.Optional[RetryAction] = None
        #: Next sleep time as decided by the retry manager.
        self.upcoming_sleep: float = 0.0

```
**Attributes:**
- `__init__`: Initialize the retry state
    - `retry_object`: Retry manager object
    - `fn`: The function to be retried
    - `args`: Positional arguments
    - `kwargs`: Keyword arguments
- `start_time`: Retry start timestamp
- `retry_object`: Retry manager object
- `fn`: The function to be retried
- `args`: Positional arguments
- `kwargs`: Keyword arguments
- `attempt_number`: Current number of attempts
- `outcome`: Result of the last attempt
- `outcome_timestamp`: Time when the last attempt was completed
- `idle_for`: Waiting time between retries
- `next_action`: Next action to be executed
- `upcoming_sleep`: Waiting time before the next retry

## 3. Retry Conditions

### 3.1 `retry_if_exception`
Retry when an exception meets the predicate condition.

```python

class retry_if_exception(retry_base):
    """Retry strategy that retries if an exception verifies a predicate."""

    def __init__(self, predicate: typing.Callable[[BaseException], bool]) -> None:
        self.predicate = predicate

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.outcome is None:
            raise RuntimeError("__call__() called before outcome was set")

        if retry_state.outcome.failed:
            exception = retry_state.outcome.exception()
            if exception is None:
                raise RuntimeError("outcome failed but the exception is None")
            return self.predicate(exception)
        else:
            return False

```

### 3.2 `retry_if_exception_type`
Retry when an exception of the specified type is thrown.

```python
class retry_if_exception_type(retry_if_exception):
    """Retries if an exception has been raised of one or more types."""

    def __init__(
        self,
        exception_types: typing.Union[
            typing.Type[BaseException],
            typing.Tuple[typing.Type[BaseException], ...],
        ] = Exception,
    ) -> None:
        self.exception_types = exception_types
        super().__init__(lambda e: isinstance(e, exception_types))

```

### 3.3 `retry_unless_exception_type`
Retry when the thrown exception is not of the specified type.

```python
class retry_unless_exception_type(retry_if_exception):
    """Retries until an exception is raised of one or more types."""

    def __init__(
        self,
        exception_types: typing.Union[
            typing.Type[BaseException],
            typing.Tuple[typing.Type[BaseException], ...],
        ] = Exception,
    ) -> None:
        self.exception_types = exception_types
        super().__init__(lambda e: not isinstance(e, exception_types))

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.outcome is None:
            raise RuntimeError("__call__() called before outcome was set")

        # always retry if no exception was raised
        if not retry_state.outcome.failed:
            return True

        exception = retry_state.outcome.exception()
        if exception is None:
            raise RuntimeError("outcome failed but the exception is None")
        return self.predicate(exception)
```

### 3.4 `retry_if_result`
Retry when the function return value meets the predicate condition.

```python
class retry_if_result(retry_base):
    """Retries if the result verifies a predicate."""

    def __init__(self, predicate: typing.Callable[[typing.Any], bool]) -> None:
        self.predicate = predicate

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.outcome is None:
            raise RuntimeError("__call__() called before outcome was set")

        if not retry_state.outcome.failed:
            return self.predicate(retry_state.outcome.result())
        else:
            return False
```

### 3.5 `retry_if_not_result`
Retry when the function return value does not meet the predicate condition.

```python
class retry_if_not_result(retry_base):
    """Retries if the result refutes a predicate."""

    def __init__(self, predicate: typing.Callable[[typing.Any], bool]) -> None:
        self.predicate = predicate

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.outcome is None:
            raise RuntimeError("__call__() called before outcome was set")

        if not retry_state.outcome.failed:
            return not self.predicate(retry_state.outcome.result())
        else:
            return False

```

#### 3.6 `retry_if_exception_message`
```python
class retry_if_exception_message(retry_if_exception):
    """Retries if an exception message equals or matches."""

    def __init__(
        self,
        message: typing.Optional[str] = None,
        match: typing.Union[None, str, typing.Pattern[str]] = None,
    ) -> None:
        if message and match:
            raise TypeError(
                f"{self.__class__.__name__}() takes either 'message' or 'match', not both"
            )

        # set predicate
        if message:

            def message_fnc(exception: BaseException) -> bool:
                return message == str(exception)

            predicate = message_fnc
        elif match:
            prog = re.compile(match)

            def match_fnc(exception: BaseException) -> bool:
                return bool(prog.match(str(exception)))

            predicate = match_fnc
        else:
            raise TypeError(
                f"{self.__class__.__name__}() missing 1 required argument 'message' or 'match'"
            )

        super().__init__(predicate)
```

### 3.6 `retry_any` 
Retry when any one of the conditions is met.

```python
class retry_any(retry_base):
    """Retries if any of the retries condition is valid."""

    def __init__(self, *retries: retry_base) -> None:
        self.retries = retries

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return any(r(retry_state) for r in self.retries)

```

### 3.7 `retry_all`
Retry when all conditions are met.

```python
class retry_all(retry_base):
    """Retries if all the retries condition are valid."""

    def __init__(self, *retries: retry_base) -> None:
        self.retries = retries

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return all(r(retry_state) for r in self.retries)

```
### 3.8 `retry_never`
```python
class _retry_never(retry_base):
    """Retry strategy that never rejects any result."""

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return False


retry_never = _retry_never()
```
### 3.9 `retry_if_exception_cause_type`
```python
lass retry_if_exception_cause_type(retry_base):
    """Retries if any of the causes of the raised exception is of one or more types.

    The check on the type of the cause of the exception is done recursively (until finding
    an exception in the chain that has no `__cause__`)
    """

    def __init__(
        self,
        exception_types: typing.Union[
            typing.Type[BaseException],
            typing.Tuple[typing.Type[BaseException], ...],
        ] = Exception,
    ) -> None:
        self.exception_cause_types = exception_types
```

### 3.10 `retry_if_not_exception_type`
```python
class retry_if_not_exception_type(retry_if_exception):
    """Retries except an exception has been raised of one or more types."""

    def __init__(
        self,
        exception_types: typing.Union[
            typing.Type[BaseException],
            typing.Tuple[typing.Type[BaseException], ...],
        ] = Exception,
    ) -> None:
        self.exception_types = exception_types
        super().__init__(lambda e: not isinstance(e, exception_types))

```

### 3.11 `retry_if_not_exception_message`
```python
class retry_if_not_exception_message(retry_if_exception_message):
    """Retries until an exception message equals or matches."""

    def __init__(
        self,
        message: typing.Optional[str] = None,
        match: typing.Union[None, str, typing.Pattern[str]] = None,
    ) -> None:
        super().__init__(message, match)
        # invert predicate
        if_predicate = self.predicate
        self.predicate = lambda *args_, **kwargs_: not if_predicate(*args_, **kwargs_)

```

### 3.12 `TryAgain`
```python
class TryAgain(Exception):
    """Always retry the executed function when raised."""
```



## 4. Stop Conditions

### 4.1 `stop_after_attempt`
Stop after the specified number of attempts.

```python
class stop_after_attempt(stop_base):
    """Stop when the previous attempt >= max_attempt."""

    def __init__(self, max_attempt_number: int) -> None:
        self.max_attempt_number = max_attempt_number

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return retry_state.attempt_number >= self.max_attempt_number

```

### 4.2 `stop_after_delay`
Stop retrying after the specified time (in seconds).

```python
class stop_after_delay(stop_base):
    """
    Stop when the time from the first attempt >= limit.

    Note: `max_delay` will be exceeded, so when used with a `wait`, the actual total delay will be greater
    than `max_delay` by some of the final sleep period before `max_delay` is exceeded.

    If you need stricter timing with waits, consider `stop_before_delay` instead.
    """

    def __init__(self, max_delay: _utils.time_unit_type) -> None:
        self.max_delay = _utils.to_seconds(max_delay)

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.seconds_since_start is None:
            raise RuntimeError("__call__() called but seconds_since_start is not set")
        return retry_state.seconds_since_start >= self.max_delay

```

### 4.3 `stop_before_delay`
Stop retrying before the specified time (in seconds).

```python
class stop_before_delay(stop_base):
    """
    Stop right before the next attempt would take place after the time from the first attempt >= limit.

    Most useful when you are using with a `wait` function like wait_random_exponential, but need to make
    sure that the max_delay is not exceeded.
    """

    def __init__(self, max_delay: _utils.time_unit_type) -> None:
        self.max_delay = _utils.to_seconds(max_delay)

    def __call__(self, retry_state: "RetryCallState") -> bool:
        if retry_state.seconds_since_start is None:
            raise RuntimeError("__call__() called but seconds_since_start is not set")
        return (
            retry_state.seconds_since_start + retry_state.upcoming_sleep
            >= self.max_delay
        )

```

### 4.4 `stop_when_event_set`
Stop retrying when the event is set.

```python
class stop_when_event_set(stop_base):
    """Stop when the given event is set."""

    def __init__(self, event: "threading.Event") -> None:
        self.event = event

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return self.event.is_set()
```

### 4.5 `stop_any`
Stop if any of the stop condition is valid.

```python
class stop_any(stop_base):
    """Stop if any of the stop condition is valid."""

    def __init__(self, *stops: stop_base) -> None:
        self.stops = stops

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return any(x(retry_state) for x in self.stops)

```

### 4.6 `stop_all`
Stop if all the stop conditions are valid.
```python
class stop_all(stop_base):
    """Stop if all the stop conditions are valid."""

    def __init__(self, *stops: stop_base) -> None:
        self.stops = stops

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return all(x(retry_state) for x in self.stops)
```
## 5. Wait Strategies

### 5.1 `wait_fixed`
Retry at a fixed time interval.

```python
class wait_fixed(wait_base):
    """Wait strategy that waits a fixed amount of time between each retry."""

    def __init__(self, wait: _utils.time_unit_type) -> None:
        self.wait_fixed = _utils.to_seconds(wait)

    def __call__(self, retry_state: "RetryCallState") -> float:
        return self.wait_fixed

```

### 5.2 `wait_random`
Wait randomly between the minimum and maximum times.

```python
class wait_random(wait_base):
    """Wait strategy that waits a random amount of time between min/max."""

    def __init__(
        self, min: _utils.time_unit_type = 0, max: _utils.time_unit_type = 1
    ) -> None:  # noqa
        self.wait_random_min = _utils.to_seconds(min)
        self.wait_random_max = _utils.to_seconds(max)

    def __call__(self, retry_state: "RetryCallState") -> float:
        return self.wait_random_min + (
            random.random() * (self.wait_random_max - self.wait_random_min)
        )

```

### 5.3 `wait_exponential`
Exponential backoff wait strategy.

```python
class wait_exponential(wait_base):
    """Wait strategy that applies exponential backoff.

    It allows for a customized multiplier and an ability to restrict the
    upper and lower limits to some maximum and minimum value.

    The intervals are fixed (i.e. there is no jitter), so this strategy is
    suitable for balancing retries against latency when a required resource is
    unavailable for an unknown duration, but *not* suitable for resolving
    contention between multiple processes for a shared resource. Use
    wait_random_exponential for the latter case.
    """

    def __init__(
        self,
        multiplier: typing.Union[int, float] = 1,
        max: _utils.time_unit_type = _utils.MAX_WAIT,  # noqa
        exp_base: typing.Union[int, float] = 2,
        min: _utils.time_unit_type = 0,  # noqa
    ) -> None:
        self.multiplier = multiplier
        self.min = _utils.to_seconds(min)
        self.max = _utils.to_seconds(max)
        self.exp_base = exp_base
```

### 5.4 `wait_combine`
Combine multiple wait strategies.

```python
class wait_combine(wait_base):
    """Combine several waiting strategies."""

    def __init__(self, *strategies: wait_base) -> None:
        self.wait_funcs = strategies

    def __call__(self, retry_state: "RetryCallState") -> float:
        return sum(x(retry_state=retry_state) for x in self.wait_funcs)

```

### 5.5 `wait_chain`
Chain two or more waiting strategies.
```python
class wait_chain(wait_base):
    """Chain two or more waiting strategies.

    If all strategies are exhausted, the very last strategy is used
    thereafter.

    For example::

        @retry(wait=wait_chain(*[wait_fixed(1) for i in range(3)] +
                               [wait_fixed(2) for j in range(5)] +
                               [wait_fixed(5) for k in range(4)))
        def wait_chained():
            print("Wait 1s for 3 attempts, 2s for 5 attempts and 5s
                   thereafter.")
    """

    def __init__(self, *strategies: wait_base) -> None:
        self.strategies = strategies

    def __call__(self, retry_state: "RetryCallState") -> float:
        wait_func_no = min(max(retry_state.attempt_number, 1), len(self.strategies))
        wait_func = self.strategies[wait_func_no - 1]
        return wait_func(retry_state=retry_state)
```

### 5.6 `wait_random_exponential`
```python
class wait_random_exponential(wait_exponential):
    """Random wait with exponentially widening window."""
    def __call__(self, retry_state: "RetryCallState") -> float:
        high = super().__call__(retry_state=retry_state)
        return random.uniform(self.min, high)

```

### 5.7 `wait_none`
```python

class wait_none(wait_fixed):
    """Wait strategy that doesn't wait at all before retrying."""

    def __init__(self) -> None:
        super().__init__(0)
```

### 5.8 `wait_exponential_jitter`
```python
class wait_exponential_jitter(wait_base):
    """Wait strategy that applies exponential backoff and jitter.
    It allows for a customized initial wait, maximum wait and jitter.
    The wait time is min(initial * 2**n + random.uniform(0, jitter), maximum)
    where n is the retry count.
    """

    def __init__(
        self,
        initial: float = 1,
        max: float = _utils.MAX_WAIT,  # noqa
        exp_base: float = 2,
        jitter: float = 1,
    ) -> None:
        self.initial = initial
        self.max = max
        self.exp_base = exp_base
        self.jitter = jitter
```

#### 5.9 `wait_incrementing`
```python
class wait_incrementing(wait_base):
    """Wait an incremental amount of time after each attempt.

    Starting at a starting value and incrementing by a value for each attempt
    (and restricting the upper limit to some maximum value).
    """

    def __init__(
        self,
        start: _utils.time_unit_type = 0,
        increment: _utils.time_unit_type = 100,
        max: _utils.time_unit_type = _utils.MAX_WAIT,  # noqa
    ) -> None:
        self.start = _utils.to_seconds(start)
        self.increment = _utils.to_seconds(increment)
        self.max = _utils.to_seconds(max)

```

#### 5.10 `wait_full_jitter`
```python
from .wait import wait_random_exponential as wait_full_jitter
```

## 6. Asynchronous Support

### 6.1 `AsyncRetrying`
Asynchronous version of the `Retrying` class.

```python
   def __init__(
        self,
        sleep: t.Callable[
            [t.Union[int, float]], t.Union[None, t.Awaitable[None]]
        ] = _portable_async_sleep,
        stop: "StopBaseT" = tenacity.stop.stop_never,
        wait: "WaitBaseT" = tenacity.wait.wait_none(),
        retry: "t.Union[SyncRetryBaseT, RetryBaseT]" = tenacity.retry_if_exception_type(),
        before: t.Callable[
            ["RetryCallState"], t.Union[None, t.Awaitable[None]]
        ] = before_nothing,
        after: t.Callable[
            ["RetryCallState"], t.Union[None, t.Awaitable[None]]
        ] = after_nothing,
        before_sleep: t.Optional[
            t.Callable[["RetryCallState"], t.Union[None, t.Awaitable[None]]]
        ] = None,
        reraise: bool = False,
        retry_error_cls: t.Type["RetryError"] = RetryError,
        retry_error_callback: t.Optional[
            t.Callable[["RetryCallState"], t.Union[t.Any, t.Awaitable[t.Any]]]
        ] = None,
    ) -> None:
```


## 7. Error Handling

### 7.1 `RetryError`
Thrown when all retries are exhausted.

```python
class RetryError(Exception):
    """Encapsulates the last attempt instance right before giving up."""

    def __init__(self, last_attempt: "Future") -> None:
        self.last_attempt = last_attempt
        super().__init__(last_attempt)

    def reraise(self) -> t.NoReturn:
        if self.last_attempt.failed:
            raise self.last_attempt.result()
        raise self

    def __str__(self) -> str:
        return f"{self.__class__.__name__}[{self.last_attempt}]"


```

## 8. Advanced Usage

### 8.1 Custom Retry Conditions
Create custom retry conditions by implementing the `retry_base` interface.

```python
class _retry_never(retry_base):
    """Retry strategy that never rejects any result."""

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return False


retry_never = _retry_never()

class _retry_always(retry_base):
    """Retry strategy that always rejects any result."""

    def __call__(self, retry_state: "RetryCallState") -> bool:
        return True


retry_always = _retry_always()

```

### 8.2 `Future` - class
```python
class Future(FutureGenericT):
    """Encapsulates a (future or past) attempted call to a target function."""

    def __init__(self, attempt_number: int) -> None:
        super().__init__()
        self.attempt_number = attempt_number

    @property
    def failed(self) -> bool:
        """Return whether a exception is being held in this future."""
        return self.exception() is not None

    @classmethod
    def construct(
        cls, attempt_number: int, value: t.Any, has_exception: bool
    ) -> "Future":
        """Construct a new Future object."""
        fut = cls(attempt_number)
        if has_exception:
            fut.set_exception(value)
        else:
            fut.set_result(value)
        return fut
```

## 9. Log information
### 9.1 `before_sleep_log`

### 9.2 `after_log`


## Detailed Implementation Nodes of Functions

### Node 1: Basic Retry Mechanism

**Function Description**
Automatically add a retry mechanism to a function. Retry automatically when an exception occurs until it succeeds or the stop condition is met. Support synchronous and asynchronous functions, and support custom exception types.

**Implementation Points**
- Wrap the function into a retry loop through the `@retry` decorator to automatically track the number of attempts, exception chain, and results.
- Support the automatic identification of synchronous and asynchronous functions and schedule their execution respectively.
- After each failure, determine whether to continue according to the strategy, and finally return the successful result or throw a `RetryError`.

**Input-Output Examples**

```python

async def _async_function(thing):
    await asyncio.sleep(0.00001)
    return thing.go()

@retry(stop=stop_after_attempt(2))
async def _retryable_coroutine_with_2_attempts(thing):
    await asyncio.sleep(0.00001)
    return thing.go()

@asynctest
async def test_retry_using_async_retying(self):
    thing = NoIOErrorAfterCount(5)
    retrying = AsyncRetrying()
    await retrying(_async_function, thing)
    assert thing.counter == thing.count

```

### Node 2: Stop Conditions

**Function Description**
Support multiple strategies to stop retrying, including maximum number of attempts, maximum retry duration, early termination, and multi-condition combinations (AND/OR).

**Implementation Points**
- Stop conditions are implemented by stop strategy objects, such as `stop_after_attempt`, `stop_after_delay`, `stop_before_delay`.
- Support multi-condition combinations, combining multiple stop strategies through logical AND/OR operators to achieve flexible termination control.
- After each retry, the stop strategy determines whether to terminate based on the current state (such as the number of attempts and the elapsed time).

**Input-Output Examples**

```python

@asynctest
async def test_stop_after_attempt(self):
    thing = NoIOErrorAfterCount(2)
    try:
        await _retryable_coroutine_with_2_attempts(thing)
    except RetryError:
        assert thing.counter == 2
def test_stop_after_delay(self):
        for delay in (1, datetime.timedelta(seconds=1)):
            with self.subTest():
                r = Retrying(stop=tenacity.stop_after_delay(delay))
                self.assertFalse(r.stop(make_retry_state(2, 0.999)))
                self.assertTrue(r.stop(make_retry_state(2, 1)))
                self.assertTrue(r.stop(make_retry_state(2, 1.001)))

def test_stop_before_delay(self):
    for delay in (1, datetime.timedelta(seconds=1)):
        with self.subTest():
            r = Retrying(stop=tenacity.stop_before_delay(delay))
            self.assertFalse(
                r.stop(make_retry_state(2, 0.999, upcoming_sleep=0.0001))
            )
            self.assertTrue(r.stop(make_retry_state(2, 1, upcoming_sleep=0.001)))
            self.assertTrue(r.stop(make_retry_state(2, 1, upcoming_sleep=1)))

            # It should act the same as stop_after_delay if upcoming sleep is 0
            self.assertFalse(r.stop(make_retry_state(2, 0.999, upcoming_sleep=0)))
            self.assertTrue(r.stop(make_retry_state(2, 1, upcoming_sleep=0)))
            self.assertTrue(r.stop(make_retry_state(2, 1.001, upcoming_sleep=0)))

```

### Node 3: Wait Strategies

**Function Description**
Support multiple wait strategies, including fixed wait, incremental wait, random wait, exponential backoff, jitter, chained wait, etc. Multiple wait methods can be combined to adapt to different business scenarios.

**Implementation Points**
- Wait strategies are implemented by wait objects, such as `wait_fixed`, `wait_random`, `wait_exponential`, `wait_chain`, etc.
- Support the addition and chaining combination of wait strategies to flexibly adapt to different retry requirements.
- Jitter introduces random perturbations on the basis of exponential backoff to reduce retry storms.

**Input-Output Examples**

```python
def test_fixed_sleep(self):
        for wait in (1, datetime.timedelta(seconds=1)):
            with self.subTest():
                r = Retrying(wait=tenacity.wait_fixed(wait))
                self.assertEqual(1, r.wait(make_retry_state(12, 6546)))
def test_random_sleep(self):
        for min_, max_ in (
            (1, 20),
            (datetime.timedelta(seconds=1), datetime.timedelta(seconds=20)),
        ):
            with self.subTest():
                r = Retrying(wait=tenacity.wait_random(min=min_, max=max_))
                times = set()
                for _ in range(1000):
                    times.add(r.wait(make_retry_state(1, 6546)))

                # this is kind of non-deterministic...
                self.assertTrue(len(times) > 1)
                for t in times:
                    self.assertTrue(t >= 1)
                    self.assertTrue(t < 20)

 def test_exponential(self):
        r = Retrying(wait=tenacity.wait_exponential())
        self.assertEqual(r.wait(make_retry_state(1, 0)), 1)
        self.assertEqual(r.wait(make_retry_state(2, 0)), 2)
        self.assertEqual(r.wait(make_retry_state(3, 0)), 4)
        self.assertEqual(r.wait(make_retry_state(4, 0)), 8)
        self.assertEqual(r.wait(make_retry_state(5, 0)), 16)
        self.assertEqual(r.wait(make_retry_state(6, 0)), 32)
        self.assertEqual(r.wait(make_retry_state(7, 0)), 64)
        self.assertEqual(r.wait(make_retry_state(8, 0)), 128)
def test_wait_chain(self):
        r = Retrying(
            wait=tenacity.wait_chain(
                *[tenacity.wait_fixed(1) for i in range(2)]
                + [tenacity.wait_fixed(4) for i in range(2)]
                + [tenacity.wait_fixed(8) for i in range(1)]
            )
        )

        for i in range(10):
            w = r.wait(make_retry_state(i + 1, 1))
            if i < 2:
                self._assert_range(w, 1, 2)
            elif i < 4:
                self._assert_range(w, 4, 5)
            else:
                self._assert_range(w, 8, 9)
```

### Node 4: Retry Conditions

**Function Description**
Support multiple retry conditions, including by exception type, by return value, by exception message, etc. Multiple conditions can be combined to achieve flexible retry logic.

**Implementation Points**
- Retry conditions are specified through the `retry` parameter, such as `retry_if_exception_type`, `retry_if_result`, `retry_if_exception_message`, etc.
- Support multi-condition combinations, combining multiple retry conditions through logical AND/OR operators.
- Custom retry conditions can be implemented through functions that receive a `RetryCallState` object and return a boolean value to determine whether to retry.

**Input-Output Examples**

```python
class retry_if_exception_type(retry_if_exception):
    """Retries if an exception has been raised of one or more types."""

    def __init__(
        self,
        exception_types: typing.Union[
            typing.Type[BaseException],
            typing.Tuple[typing.Type[BaseException], ...],
        ] = Exception,
    ) -> None:
        self.exception_types = exception_types
        super().__init__(lambda e: isinstance(e, exception_types))

def waitfunc(retry_state):
    raise ExtractCallState(retry_state)

retrying = Retrying(
    wait=waitfunc,
    retry=(
                tenacity.retry_if_exception_type()
                | tenacity.retry_if_result(lambda result: result == 123)
            ),
        )

@retry(retry=tenacity.retry_if_exception_type(IOError))
def _retryable_test_with_exception_type_io(thing):
    return thing.go()


def test_retry_if_result(self):
    retry = tenacity.retry_if_result(lambda x: x == 1)

    def r(fut):
        retry_state = make_retry_state(1, 1.0, last_result=fut)
        return retry(retry_state)

    self.assertTrue(r(tenacity.Future.construct(1, 1, False)))
    self.assertFalse(r(tenacity.Future.construct(1, 2, False)))
def test_retry_if_exception_message(self):
    try:
        self.assertTrue(
            _retryable_test_if_exception_message_message(NoCustomErrorAfterCount(3))
        )
    except CustomError:
        print(_retryable_test_if_exception_message_message.statistics)
        self.fail("CustomError should've been retried from errormessage")

```
### Node 5: Async Retry

**Function Description**
Support the retry of asynchronous scenarios such as `async/await`, `trio`, and `tornado`. Asynchronous waiting is fully compatible with synchronous waiting.

**Implementation Points**
- Automatically detect whether the decorated function is an asynchronous function and use asynchronous retry scheduling.
- Support asynchronous frameworks such as `asyncio` and `trio`, and be fully compatible with the synchronous retry API.
- Asynchronous waiting uses `asyncio.sleep` or `trio.sleep` and will not block the event loop.

**Input-Output Examples**

```python
async def _async_function(thing):
    await asyncio.sleep(0.00001)
    return thing.go()

@asynctest
async def test_retry(self):
    thing = NoIOErrorAfterCount(5)
    await _retryable_coroutine(thing)
    assert thing.counter == thing.count
@asynctest
async def test_retry(self):
    thing = NoIOErrorAfterCount(5)
    await _retryable_coroutine(thing)
    assert thing.counter == thing.count
@retry
async def trio_function():
    await trio.sleep(0.00001)
    return thing.go()

```

### Node 6: Callbacks and Logging

**Function Description**
Support custom callbacks before, after, and before waiting for retry (such as logging, statistics, external notifications, etc.), and flexibly insert custom logic.

**Implementation Points**
- Support callback parameters such as `before`, `after`, and `before_sleep`, which will be called before, after, and before waiting for retry respectively.
- The callback function receives the current retry state and can access context information such as the number of attempts, exceptions, and results.
- Can be used in scenarios such as logging, statistics, and external notifications to enhance observability and debuggability.

#### `after_log` Function

`after_log` is a built-in callback function generator that creates standardized logging callbacks for retry operations.

**Function Signature:**
```python
def after_log(
    logger: logging.Logger,
    log_level: int,
    sec_format: str = "%.3g"
) -> typing.Callable[["RetryCallState"], None]:
    """After call strategy that logs to some logger the finished attempt."""

    def log_it(retry_state: "RetryCallState") -> None:
        if retry_state.fn is None:
            # NOTE(sileht): can't really happen, but we must please mypy
            fn_name = "<unknown>"
        else:
            fn_name = _utils.get_callback_name(retry_state.fn)
        logger.log(
            log_level,
            f"Finished call to '{fn_name}' "
            f"after {sec_format % retry_state.seconds_since_start}(s), "
            f"this was the {_utils.to_ordinal(retry_state.attempt_number)} time calling it.",
        )

    return log_it
```

**Parameters:**
- `logger`: A standard Python logger instance to write log messages
- `log_level`: The logging level (e.g., `logging.INFO`, `logging.WARNING`, etc.)
- `sec_format`: Format string for displaying elapsed time in seconds (default: "%.3g")

**Functionality:**
- Returns a callback function that logs information after each retry attempt completes
- Log message includes:
  - Function name (or `<unknown>` if unavailable)
  - Total elapsed time since first attempt (formatted according to `sec_format`)
  - Ordinal attempt number (1st, 2nd, 3rd, etc.)

**Usage Example:**
```python
import logging
from tenacity import retry, after_log, stop_after_attempt, wait_fixed

# Setup logger
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Use after_log with default format
@retry(
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    after=after_log(logger, logging.INFO)
)
def example_function():
    print("Attempting operation...")
    raise Exception("Simulated failure")

# Use after_log with custom time format
@retry(
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    after=after_log(logger, logging.WARNING, sec_format="%.1f")
)
def example_with_custom_format():
    print("Attempting operation...")
    raise Exception("Simulated failure")

# Example log output:
# INFO:__main__:Finished call to 'example_function' after 1.05(s), this was the 2nd time calling it.
# WARNING:__main__:Finished call to 'example_with_custom_format' after 2.1(s), this was the 3rd time calling it.
```


**Input-Output Examples**

```python
def test_before_attempts(self):
        TestBeforeAfterAttempts._attempt_number = 0

        def _before(retry_state):
            TestBeforeAfterAttempts._attempt_number = retry_state.attempt_number

        @retry(
            wait=tenacity.wait_fixed(1),
            stop=tenacity.stop_after_attempt(1),
            before=_before,
        )
        def _test_before():
            pass

        _test_before()

        self.assertTrue(TestBeforeAfterAttempts._attempt_number == 1)

def test_after_attempts(self):
    TestBeforeAfterAttempts._attempt_number = 0

    def _after(retry_state):
        TestBeforeAfterAttempts._attempt_number = retry_state.attempt_number

    @retry(
        wait=tenacity.wait_fixed(0.1),
        stop=tenacity.stop_after_attempt(3),
        after=_after,
    )
    def _test_after():
        if TestBeforeAfterAttempts._attempt_number < 2:
            raise Exception("testing after_attempts handler")
        else:
            pass

    _test_after()

    self.assertTrue(TestBeforeAfterAttempts._attempt_number == 2)

def test_before_sleep(self):
    def _before_sleep(retry_state):
        self.assertGreater(retry_state.next_action.sleep, 0)
        _before_sleep.attempt_number = retry_state.attempt_number

    @retry(
        wait=tenacity.wait_fixed(0.01),
        stop=tenacity.stop_after_attempt(3),
        before_sleep=_before_sleep,
    )
    def _test_before_sleep():
        if _before_sleep.attempt_number < 2:
            raise Exception("testing before_sleep_attempts handler")

    _test_before_sleep()
    self.assertEqual(_before_sleep.attempt_number, 2)


```

### Node 7: Statistics and State

**Function Description**
Obtain retry statistics (such as the number of attempts, total elapsed time, etc.) and support custom error callbacks for easy monitoring and debugging.

**Implementation Points**
- Each function decorated with `@retry` maintains a `statistics` attribute, which records information such as the number of retries, start time, and elapsed time.
- The statistical information is automatically updated after each retry and when the final failure occurs, facilitating external access and monitoring.
- Support custom error callbacks (`retry_error_callback`), which return custom results when the final failure occurs.

**Input-Output Examples**

```python

def test_retry_error_callback(self):
    num_attempts = 3

    def retry_error_callback(retry_state):
        retry_error_callback.called_times += 1
        return retry_state.outcome

    retry_error_callback.called_times = 0

    @retry(
        stop=tenacity.stop_after_attempt(num_attempts),
        retry_error_callback=retry_error_callback,
    )
    def _foobar():
        self._attempt_number += 1
        raise Exception("This exception should not be raised")

    result = _foobar()

    self.assertEqual(retry_error_callback.called_times, 1)
    self.assertEqual(num_attempts, self._attempt_number)
    self.assertIsInstance(result, tenacity.Future)

```

### Node 8: Context Manager Retry

**Function Description**
Support the retry of code blocks for easy reuse of context and resource management, suitable for scenarios requiring multi-step operations.

**Implementation Points**
- Provide the `Retrying` and `AsyncRetrying` classes, supporting the retry of any code block using the for/with structure.
- Each loop generates an `attempt` object. Exceptions can be caught and automatically retried within the `with attempt` statement block.
- Support accessing `attempt.retry_state` to obtain detailed information about the current attempt.
- Suitable for complex scenarios requiring multi-step operations and sharing context within the same scope.

**Input-Output Examples**

```python
def test_context_manager_retry_one(self):
    from tenacity import Retrying

    raise_ = True

    for attempt in Retrying():
        with attempt:
            if raise_:
                raise_ = False
                raise Exception("Retry it!")
@asynctest
async def test_retry_with_result(self):
    async def test():
        attempts = 0

        # mypy doesn't have great lambda support
        def lt_3(x: float) -> bool:
            return x < 3

        async for attempt in tasyncio.AsyncRetrying(retry=retry_if_result(lt_3)):
            with attempt:
                attempts += 1
            attempt.retry_state.set_result(attempts)
        return attempts

    result = await test()

    self.assertEqual(3, result)
```

### Node 9: Dynamic Retry Parameters

**Function Description**
Support the dynamic modification of retry parameters at runtime for flexible adjustment of the retry strategy in different scenarios.

**Implementation Points**
- Each function decorated with `@retry` has a `retry_with` method, which can temporarily override parameters such as `stop`, `wait`, `retry`, and callbacks.
- `retry_with` returns a new retry wrapper, and the parameters only take effect for this call and do not affect the original decorator.
- Support multi-parameter override, comparison with the original decorator behavior, and dynamic switching of the retry strategy.

**Input-Output Examples**

```python
def test_retry_error_cls_should_be_preserved(self):
    @retry(stop=tenacity.stop_after_attempt(10), retry_error_cls=ValueError)
    def _retryable():
        raise Exception("raised for test purposes")

    with pytest.raises(Exception) as exc_ctx:
        _retryable.retry_with(stop=tenacity.stop_after_attempt(2))()

    assert exc_ctx.type is ValueError, "Should remap to specific exception type"
def test_retry_error_callback_should_be_preserved(self):
    def return_text(retry_state):
        return "Calling {} keeps raising errors after {} attempts".format(
            retry_state.fn.__name__,
            retry_state.attempt_number,
        )

    @retry(stop=tenacity.stop_after_attempt(10), retry_error_callback=return_text)
    def _retryable():
        raise Exception("raised for test purposes")

    result = _retryable.retry_with(stop=tenacity.stop_after_attempt(5))()
    assert result == "Calling _retryable keeps raising errors after 5 attempts"

```

### Node 10: Utility Functions and Type Detection

**Function Description**
Provide utility functions such as `is_coroutine_callable` to assist in determining the function type for automatic adaptation of synchronous/asynchronous logic.

**Implementation Points**
- `is_coroutine_callable` checks whether an object is a coroutine function or a callable coroutine object.
- Support the determination of multiple types such as ordinary functions, lambdas, partials, class instances, asynchronous classes, and decorator-wrapped objects.
- Ensure that the retry mechanism automatically adapts to synchronous/asynchronous operations and avoids type misjudgment.

**Input-Output Examples**

```python

def test_is_coroutine_callable() -> None:
    async def async_func() -> None:
        pass

    def sync_func() -> None:
        pass

    class AsyncClass:
        async def __call__(self) -> None:
            pass

    class SyncClass:
        def __call__(self) -> None:
            pass

    lambda_fn = lambda: None  # noqa: E731

    partial_async_func = functools.partial(async_func)
    partial_sync_func = functools.partial(sync_func)
    partial_async_class = functools.partial(AsyncClass().__call__)
    partial_sync_class = functools.partial(SyncClass().__call__)
    partial_lambda_fn = functools.partial(lambda_fn)

    assert _utils.is_coroutine_callable(async_func) is True
    assert _utils.is_coroutine_callable(sync_func) is False
    assert _utils.is_coroutine_callable(AsyncClass) is False
    assert _utils.is_coroutine_callable(AsyncClass()) is True
    assert _utils.is_coroutine_callable(SyncClass) is False
    assert _utils.is_coroutine_callable(SyncClass()) is False
    assert _utils.is_coroutine_callable(lambda_fn) is False

    assert _utils.is_coroutine_callable(partial_async_func) is True
    assert _utils.is_coroutine_callable(partial_sync_func) is False
    assert _utils.is_coroutine_callable(partial_async_class) is True
    assert _utils.is_coroutine_callable(partial_sync_class) is False
    assert _utils.is_coroutine_callable(partial_lambda_fn) is False

```

### Node 11: Advanced Usage (Custom Callbacks, Error Handling, Mock, etc.)

**Function Description**
Support advanced testing scenarios such as custom callbacks, error handling, mock sleep, mock logger, `retry_error_callback`, and custom exception chain for easy expansion and integration.

**Implementation Points**
- Support custom callback functions (such as `after`, `before`, `before_sleep`) to implement functions such as logging, monitoring, and external notifications.
- Support methods such as mock sleep and mock logger for easy testing and debugging of retry behavior.
- Support `retry_error_callback`, which returns custom results or processing logic when all retries fail.
- Support advanced extensions such as custom exception types and error callbacks.

**Input-Output Examples**

```python
def test_retry_error_callback(self):
    num_attempts = 3

    def retry_error_callback(retry_state):
        retry_error_callback.called_times += 1
        return retry_state.outcome

    retry_error_callback.called_times = 0

    @retry(
        stop=tenacity.stop_after_attempt(num_attempts),
        retry_error_callback=retry_error_callback,
    )
    def _foobar():
        self._attempt_number += 1
        raise Exception("This exception should not be raised")

    result = _foobar()

    self.assertEqual(retry_error_callback.called_times, 1)
    self.assertEqual(num_attempts, self._attempt_number)
    self.assertIsInstance(result, tenacity.Future)

```

### Node 12: Special Cases

**Function Description**
Support exception chain judgment, exception message matching, and serializability of `RetryError`, suitable for complex exception handling and distributed scenarios.

**Implementation Points**
- Support retry judgment based on exception message content through strategies such as `retry_if_exception_message`.
- `RetryError` and related state objects support serialization and can be used in distributed or persistent scenarios.
- Support exception chain tracking for easy debugging and error analysis.
- Support type annotations, mypy/typeguard checks, and other type-safe scenarios.

**Input-Output Examples**

```python

def test_retry_if_exception_message(self):
        try:
            self.assertTrue(
                _retryable_test_if_exception_message_message(NoCustomErrorAfterCount(3))
            )
        except CustomError:
            print(_retryable_test_if_exception_message_message.statistics)
            self.fail("CustomError should've been retried from errormessage")

def test_retry_error(self):
    def f():
        f.calls.append(len(f.calls) + 1)
        raise Exception("Retry it!")

    f.calls = []

    retry = Retrying(stop=tenacity.stop_after_attempt(2))
    with pytest.raises(RetryError):
        self.invoke(retry, f)
    assert f.calls == [1, 2]

```

### Node 13: Complex Business Logic & Regression

**Function Description**
Support custom retry logic (such as fix-and-retry) in complex business processes, suitable for regression testing and special issues.

**Implementation Points**
- Support custom `retry` callback functions to dynamically decide whether to continue retrying or execute repair logic based on the current retry state.
- Business repair and compensation operations can be embedded in the `retry` callback to achieve flexible business process control.
- Support both synchronous and asynchronous modes, suitable for complex processes such as multi-branch business, asynchronous repair, and combination with `retry`/`stop`/`wait`.

**Input-Output Examples**

```python
import asyncio
import random
from tenacity import (
    retry, 
    RetryCallState, 
    retry_if_exception_type, 
    stop_after_attempt, 
    wait_exponential,
    retry_if_exception
)

# 1. Fix-and-retry logic in synchronous mode
def test_fix_and_retry_sync():
    results = []
    MAX_RETRY_FIX_ATTEMPTS = 2

    def do_retry(retry_state: RetryCallState) -> bool:
        outcome = retry_state.outcome
        assert outcome
        ex = outcome.exception()
        subject = retry_state.args[0]  # Get the current operation subject

        if subject == "Fix":  # Do not retry the fix operation
            return False

        if retry_state.attempt_number >= MAX_RETRY_FIX_ATTEMPTS:
            return False  # Reached the maximum number of retry attempts

        if ex:
            do_fix_work()  # Perform the fix operation
            return True  # Retry after the fix
        return False

    @retry(reraise=True, retry=do_retry)
    def _do_work(subject: str) -> None:
        if subject == "Error":
            results.append(f"{subject} is not working")
            raise Exception(f"{subject} is not working")
        results.append(f"{subject} is working")

    def do_any_work(subject: str) -> None:
        _do_work(subject)

    def do_fix_work() -> None:
        _do_work("Fix")  # Perform the fix operation

    # Test execution
    try:
        do_any_work("Error")
    except Exception as exc:
        assert str(exc) == "Error is not working"
    else:
        assert False, "Expected exception not raised"

    # Verify the execution flow
    assert results == [
        "Error is not working",  # First failure
        "Fix is working",        # Perform the fix
        "Error is not working",  # Still fails after retry
    ]

# 2. Fix-and-retry logic in asynchronous mode
def test_fix_and_retry_async():
    results = []
    MAX_RETRY_FIX_ATTEMPTS = 2

    async def do_retry(retry_state: RetryCallState) -> bool:
        outcome = retry_state.outcome
        assert outcome
        ex = outcome.exception()
        subject = retry_state.args[0]

        if subject == "Fix":
            return False

        if retry_state.attempt_number >= MAX_RETRY_FIX_ATTEMPTS:
            return False

        if ex:
            await do_fix_work()
            return True
        return False

    @retry(reraise=True, retry=do_retry)
    async def _do_work(subject: str) -> None:
        if subject == "Error":
            results.append(f"{subject} is not working")
            raise Exception(f"{subject} is not working")
        results.append(f"{subject} is working")

    async def do_any_work(subject: str) -> None:
        await _do_work(subject)

    async def do_fix_work() -> None:
        await _do_work("Fix")

    # Test execution
    async def run_test():
        try:
            await do_any_work("Error")
        except Exception as exc:
            assert str(exc) == "Error is not working"
        else:
            assert False, "Expected exception not raised"

        # Verify the execution flow
        assert results == [
            "Error is not working",
            "Fix is working",
            "Error is not working",
        ]

    asyncio.run(run_test())

# 3. Complex business scenario with combined retry strategies
def test_complex_retry_strategy():
    class BusinessError(Exception):
        pass

    class RateLimitError(Exception):
        pass

    def is_business_error(e: Exception) -> bool:
        return isinstance(e, BusinessError)

    def is_rate_limit_error(e: Exception) -> bool:
        return isinstance(e, RateLimitError)

    # Combined retry strategy: retry 3 times for business errors, use exponential backoff for rate limit errors
    retry_strategy = (
        retry_if_exception(is_business_error) 
        | retry_if_exception(is_rate_limit_error)
    )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_strategy,
        reraise=True
    )
    def business_operation():
        # Simulate business logic
        if random.random() < 0.7:
            raise BusinessError("Temporary business error")
        return "Operation succeeded"

    # Test execution
    result = business_operation()
    assert result == "Operation succeeded"
```