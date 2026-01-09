"""pytest-asyncio implementation."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import enum
import functools
import inspect
import socket
import sys
import traceback
import warnings
from asyncio import AbstractEventLoop, AbstractEventLoopPolicy
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Generator,
    Iterable,
    Iterator,
    Sequence,
)
from types import AsyncGeneratorType, CoroutineType
from typing import (
    Any,
    Literal,
    ParamSpec,
    TypeVar,
    overload,
)

import pluggy
import pytest
from _pytest.fixtures import resolve_fixture_function
from _pytest.scope import Scope
from pytest import (
    Config,
    FixtureDef,
    FixtureRequest,
    Function,
    Item,
    Mark,
    MonkeyPatch,
    Parser,
    PytestCollectionWarning,
    PytestDeprecationWarning,
    PytestPluginManager,
)

if sys.version_info >= (3, 11):
    from asyncio import Runner
else:
    from backports.asyncio.runner import Runner

if sys.version_info >= (3, 13):
    from typing import TypeIs
else:
    from typing_extensions import TypeIs

_ScopeName = Literal["session", "package", "module", "class", "function"]
_R = TypeVar("_R", bound=Awaitable[Any] | AsyncIterator[Any])
_P = ParamSpec("_P")
FixtureFunction = Callable[_P, _R]


class PytestAsyncioError(Exception):
    """Base class for exceptions raised by pytest-asyncio"""


class Mode(str, enum.Enum):
    AUTO = "auto"
    STRICT = "strict"


ASYNCIO_MODE_HELP = """\
'auto' - for automatically handling all async functions by the plugin
'strict' - for autoprocessing disabling (useful if different async frameworks \
should be tested together, e.g. \
both pytest-asyncio and pytest-trio are used in the same project)
"""


def pytest_addoption(parser: Parser, pluginmanager: PytestPluginManager) -> None:
    group = parser.getgroup("asyncio")
    group.addoption(
        "--asyncio-mode",
        dest="asyncio_mode",
        default=None,
        metavar="MODE",
        help=ASYNCIO_MODE_HELP,
    )
    group.addoption(
        "--asyncio-debug",
        dest="asyncio_debug",
        action="store_true",
        default=None,
        help="enable asyncio debug mode for the default event loop",
    )
    parser.addini(
        "asyncio_mode",
        help="default value for --asyncio-mode",
        default="strict",
    )
    parser.addini(
        "asyncio_debug",
        help="enable asyncio debug mode for the default event loop",
        type="bool",
        default="false",
    )
    parser.addini(
        "asyncio_default_fixture_loop_scope",
        type="string",
        help="default scope of the asyncio event loop used to execute async fixtures",
        default=None,
    )
    parser.addini(
        "asyncio_default_test_loop_scope",
        type="string",
        help="default scope of the asyncio event loop used to execute tests",
        default="function",
    )


@overload
def fixture(
    fixture_function: FixtureFunction[_P, _R],
    *,
    scope: _ScopeName | Callable[[str, Config], _ScopeName] = ...,
    loop_scope: _ScopeName | None = ...,
    params: Iterable[object] | None = ...,
    autouse: bool = ...,
    ids: (
        Iterable[str | float | int | bool | None]
        | Callable[[Any], object | None]
        | None
    ) = ...,
    name: str | None = ...,
) -> FixtureFunction[_P, _R]: ...


@overload
def fixture(
    fixture_function: None = ...,
    *,
    scope: _ScopeName | Callable[[str, Config], _ScopeName] = ...,
    loop_scope: _ScopeName | None = ...,
    params: Iterable[object] | None = ...,
    autouse: bool = ...,
    ids: (
        Iterable[str | float | int | bool | None]
        | Callable[[Any], object | None]
        | None
    ) = ...,
    name: str | None = None,
) -> Callable[[FixtureFunction[_P, _R]], FixtureFunction[_P, _R]]: ...


def fixture(
    fixture_function: FixtureFunction[_P, _R] | None = None,
    loop_scope: _ScopeName | None = None,
    **kwargs: Any,
) -> (
    FixtureFunction[_P, _R]
    | Callable[[FixtureFunction[_P, _R]], FixtureFunction[_P, _R]]
):
    if fixture_function is not None:
        _make_asyncio_fixture_function(fixture_function, loop_scope)
        return pytest.fixture(fixture_function, **kwargs)

    else:

        @functools.wraps(fixture)
        def inner(fixture_function: FixtureFunction[_P, _R]) -> FixtureFunction[_P, _R]:
            return fixture(fixture_function, loop_scope=loop_scope, **kwargs)

        return inner


def _is_asyncio_fixture_function(obj: Any) -> bool:
    obj = getattr(obj, "__func__", obj)  # instance method maybe?
    return getattr(obj, "_force_asyncio_fixture", False)


def _make_asyncio_fixture_function(obj: Any, loop_scope: _ScopeName | None) -> None:
    if hasattr(obj, "__func__"):
        # instance method, check the function object
        obj = obj.__func__
    obj._force_asyncio_fixture = True
    obj._loop_scope = loop_scope


def _is_coroutine_or_asyncgen(obj: Any) -> bool:
    return inspect.iscoroutinefunction(obj) or inspect.isasyncgenfunction(obj)


def _get_asyncio_mode(config: Config) -> Mode:
    val = config.getoption("asyncio_mode")
    if val is None:
        val = config.getini("asyncio_mode")
    try:
        return Mode(val)
    except ValueError as e:
        modes = ", ".join(m.value for m in Mode)
        raise pytest.UsageError(
            f"{val!r} is not a valid asyncio_mode. Valid modes: {modes}."
        ) from e


def _get_asyncio_debug(config: Config) -> bool:
    val = config.getoption("asyncio_debug")
    if val is None:
        val = config.getini("asyncio_debug")

    if isinstance(val, bool):
        return val
    else:
        return val == "true"


_DEFAULT_FIXTURE_LOOP_SCOPE_UNSET = """\
The configuration option "asyncio_default_fixture_loop_scope" is unset.
The event loop scope for asynchronous fixtures will default to the fixture caching \
scope. Future versions of pytest-asyncio will default the loop scope for asynchronous \
fixtures to function scope. Set the default fixture loop scope explicitly in order to \
avoid unexpected behavior in the future. Valid fixture loop scopes are: \
"function", "class", "module", "package", "session"
"""


def _validate_scope(scope: str | None, option_name: str) -> None:
    if scope is None:
        return
    valid_scopes = [s.value for s in Scope]
    if scope not in valid_scopes:
        raise pytest.UsageError(
            f"{scope!r} is not a valid {option_name}. "
            f"Valid scopes are: {', '.join(valid_scopes)}."
        )


def pytest_configure(config: Config) -> None:
    default_fixture_loop_scope = config.getini("asyncio_default_fixture_loop_scope")
    _validate_scope(default_fixture_loop_scope, "asyncio_default_fixture_loop_scope")
    if not default_fixture_loop_scope:
        warnings.warn(PytestDeprecationWarning(_DEFAULT_FIXTURE_LOOP_SCOPE_UNSET))

    default_test_loop_scope = config.getini("asyncio_default_test_loop_scope")
    _validate_scope(default_test_loop_scope, "asyncio_default_test_loop_scope")
    config.addinivalue_line(
        "markers",
        "asyncio: "
        "mark the test as a coroutine, it will be "
        "run using an asyncio event loop",
    )


@pytest.hookimpl(tryfirst=True)
def pytest_report_header(config: Config) -> list[str]:
    """Add asyncio config to pytest header."""
    mode = _get_asyncio_mode(config)
    debug = _get_asyncio_debug(config)
    default_fixture_loop_scope = config.getini("asyncio_default_fixture_loop_scope")
    default_test_loop_scope = _get_default_test_loop_scope(config)
    header = [
        f"mode={mode}",
        f"debug={debug}",
        f"asyncio_default_fixture_loop_scope={default_fixture_loop_scope}",
        f"asyncio_default_test_loop_scope={default_test_loop_scope}",
    ]
    return [
        "asyncio: " + ", ".join(header),
    ]


def _fixture_synchronizer(
    fixturedef: FixtureDef, runner: Runner, request: FixtureRequest
) -> Callable:
    """Returns a synchronous function evaluating the specified fixture."""
    fixture_function = resolve_fixture_function(fixturedef, request)
    if inspect.isasyncgenfunction(fixturedef.func):
        return _wrap_asyncgen_fixture(fixture_function, runner, request)  # type: ignore[arg-type]
    elif inspect.iscoroutinefunction(fixturedef.func):
        return _wrap_async_fixture(fixture_function, runner, request)  # type: ignore[arg-type]
    else:
        return fixturedef.func


AsyncGenFixtureParams = ParamSpec("AsyncGenFixtureParams")
AsyncGenFixtureYieldType = TypeVar("AsyncGenFixtureYieldType")


def _wrap_asyncgen_fixture(
    fixture_function: Callable[
        AsyncGenFixtureParams, AsyncGeneratorType[AsyncGenFixtureYieldType, Any]
    ],
    runner: Runner,
    request: FixtureRequest,
) -> Callable[AsyncGenFixtureParams, AsyncGenFixtureYieldType]:
    @functools.wraps(fixture_function)
    def _asyncgen_fixture_wrapper(
        *args: AsyncGenFixtureParams.args,
        **kwargs: AsyncGenFixtureParams.kwargs,
    ):
        gen_obj = fixture_function(*args, **kwargs)

        async def setup():
            res = await gen_obj.__anext__()
            return res

        context = contextvars.copy_context()
        result = runner.run(setup(), context=context)

        reset_contextvars = _apply_contextvar_changes(context)

        def finalizer() -> None:
            """Yield again, to finalize."""

            async def async_finalizer() -> None:
                try:
                    await gen_obj.__anext__()
                except StopAsyncIteration:
                    pass
                else:
                    msg = "Async generator fixture didn't stop."
                    msg += "Yield only once."
                    raise ValueError(msg)

            runner.run(async_finalizer(), context=context)
            if reset_contextvars is not None:
                reset_contextvars()

        request.addfinalizer(finalizer)
        return result

    return _asyncgen_fixture_wrapper


AsyncFixtureParams = ParamSpec("AsyncFixtureParams")
AsyncFixtureReturnType = TypeVar("AsyncFixtureReturnType")


def _wrap_async_fixture(
    fixture_function: Callable[
        AsyncFixtureParams, CoroutineType[Any, Any, AsyncFixtureReturnType]
    ],
    runner: Runner,
    request: FixtureRequest,
) -> Callable[AsyncFixtureParams, AsyncFixtureReturnType]:
    @functools.wraps(fixture_function)
    def _async_fixture_wrapper(
        *args: AsyncFixtureParams.args,
        **kwargs: AsyncFixtureParams.kwargs,
    ):
        async def setup():
            res = await fixture_function(*args, **kwargs)
            return res

        context = contextvars.copy_context()
        result = runner.run(setup(), context=context)

        # Copy the context vars modified by the setup task into the current
        # context, and (if needed) add a finalizer to reset them.
        #
        # Note that this is slightly different from the behavior of a non-async
        # fixture, which would rely on the fixture author to add a finalizer
        # to reset the variables. In this case, the author of the fixture can't
        # write such a finalizer because they have no way to capture the Context
        # in which the setup function was run, so we need to do it for them.
        reset_contextvars = _apply_contextvar_changes(context)
        if reset_contextvars is not None:
            request.addfinalizer(reset_contextvars)

        return result

    return _async_fixture_wrapper


def _apply_contextvar_changes(
    context: contextvars.Context,
) -> Callable[[], None] | None:
    """
    Copy contextvar changes from the given context to the current context.

    If any contextvars were modified by the fixture, return a finalizer that
    will restore them.
    """
    context_tokens = []
    for var in context:
        try:
            if var.get() is context.get(var):
                # This variable is not modified, so leave it as-is.
                continue
        except LookupError:
            # This variable isn't yet set in the current context at all.
            pass
        token = var.set(context.get(var))
        context_tokens.append((var, token))

    if not context_tokens:
        return None

    def restore_contextvars():
        while context_tokens:
            (var, token) = context_tokens.pop()
            var.reset(token)

    return restore_contextvars


class PytestAsyncioFunction(Function):
    """Base class for all test functions managed by pytest-asyncio."""

    @classmethod
    def item_subclass_for(cls, item: Function, /) -> type[PytestAsyncioFunction] | None:
        """
        Returns a subclass of PytestAsyncioFunction if there is a specialized subclass
        for the specified function item.

        Return None if no specialized subclass exists for the specified item.
        """
        for subclass in cls.__subclasses__():
            if subclass._can_substitute(item):
                return subclass
        return None

    @classmethod
    def _from_function(cls, function: Function, /) -> Function:
        """
        Instantiates this specific PytestAsyncioFunction type from the specified
        Function item.
        """
        assert function.get_closest_marker("asyncio")
        assert function.parent is not None
        subclass_instance = cls.from_parent(
            function.parent,
            name=function.name,
            callspec=getattr(function, "callspec", None),
            callobj=function.obj,
            fixtureinfo=function._fixtureinfo,
            keywords=function.keywords,
            originalname=function.originalname,
        )
        subclass_instance.own_markers = function.own_markers
        assert subclass_instance.own_markers == function.own_markers
        return subclass_instance

    @staticmethod
    def _can_substitute(item: Function) -> bool:
        """Returns whether the specified function can be replaced by this class"""
        raise NotImplementedError()

    def setup(self) -> None:
        runner_fixture_id = f"_{self._loop_scope}_scoped_runner"
        if runner_fixture_id not in self.fixturenames:
            self.fixturenames.append(runner_fixture_id)
        return super().setup()

    def runtest(self) -> None:
        runner_fixture_id = f"_{self._loop_scope}_scoped_runner"
        runner = self._request.getfixturevalue(runner_fixture_id)
        context = contextvars.copy_context()
        synchronized_obj = _synchronize_coroutine(
            getattr(*self._synchronization_target_attr), runner, context
        )
        with MonkeyPatch.context() as c:
            c.setattr(*self._synchronization_target_attr, synchronized_obj)
            super().runtest()

    @functools.cached_property
    def _loop_scope(self) -> _ScopeName:
        """
        Return the scope of the asyncio event loop this item is run in.

        The effective scope is determined lazily. It is identical to to the
        `loop_scope` value of the closest `asyncio` pytest marker. If no such
        marker is present, the the loop scope is determined by the configuration
        value of `asyncio_default_test_loop_scope`, instead.
        """
        marker = self.get_closest_marker("asyncio")
        assert marker is not None
        default_loop_scope = _get_default_test_loop_scope(self.config)
        return _get_marked_loop_scope(marker, default_loop_scope)

    @property
    def _synchronization_target_attr(self) -> tuple[object, str]:
        """
        Return the coroutine that needs to be synchronized during the test run.

        This method is inteded to be overwritten by subclasses when they need to apply
        the coroutine synchronizer to a value that's different from self.obj
        e.g. the AsyncHypothesisTest subclass.
        """
        return self, "obj"


class Coroutine(PytestAsyncioFunction):
    """Pytest item created by a coroutine"""

    @staticmethod
    def _can_substitute(item: Function) -> bool:
        func = item.obj
        return inspect.iscoroutinefunction(func)


class AsyncGenerator(PytestAsyncioFunction):
    """Pytest item created by an asynchronous generator"""

    @staticmethod
    def _can_substitute(item: Function) -> bool:
        func = item.obj
        return inspect.isasyncgenfunction(func)

    @classmethod
    def _from_function(cls, function: Function, /) -> Function:
        async_gen_item = super()._from_function(function)
        unsupported_item_type_message = (
            f"Tests based on asynchronous generators are not supported. "
            f"{function.name} will be ignored."
        )
        async_gen_item.warn(PytestCollectionWarning(unsupported_item_type_message))
        async_gen_item.add_marker(
            pytest.mark.xfail(run=False, reason=unsupported_item_type_message)
        )
        return async_gen_item


class AsyncStaticMethod(PytestAsyncioFunction):
    """
    Pytest item that is a coroutine or an asynchronous generator
    decorated with staticmethod
    """

    @staticmethod
    def _can_substitute(item: Function) -> bool:
        func = item.obj
        return isinstance(func, staticmethod) and _is_coroutine_or_asyncgen(
            func.__func__
        )


class AsyncHypothesisTest(PytestAsyncioFunction):
    """
    Pytest item that is coroutine or an asynchronous generator decorated by
    @hypothesis.given.
    """

    def setup(self) -> None:
        if not getattr(self.obj, "hypothesis", False) and getattr(
            self.obj, "is_hypothesis_test", False
        ):
            pytest.fail(
                f"test function `{self!r}` is using Hypothesis, but pytest-asyncio "
                "only works with Hypothesis 3.64.0 or later."
            )
        return super().setup()

    @staticmethod
    def _can_substitute(item: Function) -> bool:
        func = item.obj
        return (
            getattr(func, "is_hypothesis_test", False)  # type: ignore[return-value]
            and getattr(func, "hypothesis", None)
            and inspect.iscoroutinefunction(func.hypothesis.inner_test)
        )

    @property
    def _synchronization_target_attr(self) -> tuple[object, str]:
        return self.obj.hypothesis, "inner_test"


# The function name needs to start with "pytest_"
# see https://github.com/pytest-dev/pytest/issues/11307
@pytest.hookimpl(specname="pytest_pycollect_makeitem", hookwrapper=True)
def pytest_pycollect_makeitem_convert_async_functions_to_subclass(
    collector: pytest.Module | pytest.Class, name: str, obj: object
) -> Generator[None, pluggy.Result, None]:
    """
    Converts coroutines and async generators collected as pytest.Functions
    to AsyncFunction items.
    """
    hook_result = yield
    try:
        node_or_list_of_nodes: (
            pytest.Item | pytest.Collector | list[pytest.Item | pytest.Collector] | None
        ) = hook_result.get_result()
    except BaseException as e:
        hook_result.force_exception(e)
        return
    if not node_or_list_of_nodes:
        return
    if isinstance(node_or_list_of_nodes, Sequence):
        node_iterator = iter(node_or_list_of_nodes)
    else:
        # Treat single node as a single-element iterable
        node_iterator = iter((node_or_list_of_nodes,))
    updated_node_collection = []
    for node in node_iterator:
        updated_item = node
        if isinstance(node, Function):
            specialized_item_class = PytestAsyncioFunction.item_subclass_for(node)
            if specialized_item_class:
                if _get_asyncio_mode(
                    node.config
                ) == Mode.AUTO and not node.get_closest_marker("asyncio"):
                    node.add_marker("asyncio")
                if node.get_closest_marker("asyncio"):
                    updated_item = specialized_item_class._from_function(node)
        updated_node_collection.append(updated_item)
    hook_result.force_result(updated_node_collection)


@contextlib.contextmanager
def _temporary_event_loop_policy(policy: AbstractEventLoopPolicy) -> Iterator[None]:
    old_loop_policy = _get_event_loop_policy()
    try:
        old_loop = _get_event_loop_no_warn()
    except RuntimeError:
        old_loop = None
    _set_event_loop_policy(policy)
    try:
        yield
    finally:
        _set_event_loop_policy(old_loop_policy)
        _set_event_loop(old_loop)


def _get_event_loop_policy() -> AbstractEventLoopPolicy:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return asyncio.get_event_loop_policy()


def _set_event_loop_policy(policy: AbstractEventLoopPolicy) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        asyncio.set_event_loop_policy(policy)


def _get_event_loop_no_warn(
    policy: AbstractEventLoopPolicy | None = None,
) -> asyncio.AbstractEventLoop:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        if policy is not None:
            return policy.get_event_loop()
        else:
            return asyncio.get_event_loop()


def _set_event_loop(loop: AbstractEventLoop | None) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        asyncio.set_event_loop(loop)


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_pyfunc_call(pyfuncitem: Function) -> object | None:
    """Pytest hook called before a test case is run."""
    if pyfuncitem.get_closest_marker("asyncio") is not None:
        if is_async_test(pyfuncitem):
            asyncio_mode = _get_asyncio_mode(pyfuncitem.config)
            for fixname, fixtures in pyfuncitem._fixtureinfo.name2fixturedefs.items():
                # name2fixturedefs is a dict between fixture name and a list of matching
                # fixturedefs. The last entry in the list is closest and the one used.
                func = fixtures[-1].func
                if (
                    asyncio_mode == Mode.STRICT
                    and _is_coroutine_or_asyncgen(func)
                    and not _is_asyncio_fixture_function(func)
                ):
                    warnings.warn(
                        PytestDeprecationWarning(
                            f"asyncio test {pyfuncitem.name!r} requested async "
                            "@pytest.fixture "
                            f"{fixname!r} in strict mode. "
                            "You might want to use @pytest_asyncio.fixture or switch "
                            "to auto mode. "
                            "This will become an error in future versions of "
                            "pytest-asyncio."
                        ),
                        stacklevel=1,
                    )
                    # no stacklevel points at the users code, so we set stacklevel=1
                    # so it at least indicates that it's the plugin complaining.
                    # Pytest gives the test file & name in the warnings summary at least

        else:
            pyfuncitem.warn(
                pytest.PytestWarning(
                    f"The test {pyfuncitem} is marked with '@pytest.mark.asyncio' "
                    "but it is not an async function. "
                    "Please remove the asyncio mark. "
                    "If the test is not marked explicitly, "
                    "check for global marks applied via 'pytestmark'."
                )
            )
    yield
    return None


def _synchronize_coroutine(
    func: Callable[..., CoroutineType],
    runner: asyncio.Runner,
    context: contextvars.Context,
):
    """
    Return a sync wrapper around a coroutine executing it in the
    specified runner and context.
    """

    @functools.wraps(func)
    def inner(*args, **kwargs):
        coro = func(*args, **kwargs)
        runner.run(coro, context=context)

    return inner


@pytest.hookimpl(wrapper=True)
def pytest_fixture_setup(fixturedef: FixtureDef, request) -> object | None:
    asyncio_mode = _get_asyncio_mode(request.config)
    if not _is_asyncio_fixture_function(fixturedef.func):
        if asyncio_mode == Mode.STRICT:
            # Ignore async fixtures without explicit asyncio mark in strict mode
            # This applies to pytest_trio fixtures, for example
            return (yield)
        if not _is_coroutine_or_asyncgen(fixturedef.func):
            return (yield)
    default_loop_scope = request.config.getini("asyncio_default_fixture_loop_scope")
    loop_scope = (
        getattr(fixturedef.func, "_loop_scope", None)
        or default_loop_scope
        or fixturedef.scope
    )
    runner_fixture_id = f"_{loop_scope}_scoped_runner"
    runner = request.getfixturevalue(runner_fixture_id)
    synchronizer = _fixture_synchronizer(fixturedef, runner, request)
    _make_asyncio_fixture_function(synchronizer, loop_scope)
    with MonkeyPatch.context() as c:
        c.setattr(fixturedef, "func", synchronizer)
        hook_result = yield
    return hook_result


_DUPLICATE_LOOP_SCOPE_DEFINITION_ERROR = """\
An asyncio pytest marker defines both "scope" and "loop_scope", \
but it should only use "loop_scope".
"""

_MARKER_SCOPE_KWARG_DEPRECATION_WARNING = """\
The "scope" keyword argument to the asyncio marker has been deprecated. \
Please use the "loop_scope" argument instead.
"""


def _get_marked_loop_scope(
    asyncio_marker: Mark, default_loop_scope: _ScopeName
) -> _ScopeName:
    assert asyncio_marker.name == "asyncio"
    if asyncio_marker.args or (
        asyncio_marker.kwargs and set(asyncio_marker.kwargs) - {"loop_scope", "scope"}
    ):
        raise ValueError("mark.asyncio accepts only a keyword argument 'loop_scope'.")
    if "scope" in asyncio_marker.kwargs:
        if "loop_scope" in asyncio_marker.kwargs:
            raise pytest.UsageError(_DUPLICATE_LOOP_SCOPE_DEFINITION_ERROR)
        warnings.warn(PytestDeprecationWarning(_MARKER_SCOPE_KWARG_DEPRECATION_WARNING))
    scope = asyncio_marker.kwargs.get("loop_scope") or asyncio_marker.kwargs.get(
        "scope"
    )
    if scope is None:
        scope = default_loop_scope
    assert scope in {"function", "class", "module", "package", "session"}
    return scope


def _get_default_test_loop_scope(config: Config) -> Any:
    return config.getini("asyncio_default_test_loop_scope")


_RUNNER_TEARDOWN_WARNING = """\
An exception occurred during teardown of an asyncio.Runner. \
The reason is likely that you closed the underlying event loop in a test, \
which prevents the cleanup of asynchronous generators by the runner.
This warning will become an error in future versions of pytest-asyncio. \
Please ensure that your tests don't close the event loop. \
Here is the traceback of the exception triggered during teardown:
%s
"""


def _create_scoped_runner_fixture(scope: _ScopeName) -> Callable:
    @pytest.fixture(
        scope=scope,
        name=f"_{scope}_scoped_runner",
    )
    def _scoped_runner(
        event_loop_policy,
        request: FixtureRequest,
    ) -> Iterator[Runner]:
        new_loop_policy = event_loop_policy
        debug_mode = _get_asyncio_debug(request.config)
        with _temporary_event_loop_policy(new_loop_policy):
            runner = Runner(debug=debug_mode).__enter__()
            try:
                yield runner
            except Exception as e:
                runner.__exit__(type(e), e, e.__traceback__)
            else:
                with warnings.catch_warnings():
                    warnings.filterwarnings(
                        "ignore", ".*BaseEventLoop.shutdown_asyncgens.*", RuntimeWarning
                    )
                    try:
                        runner.__exit__(None, None, None)
                    except RuntimeError:
                        warnings.warn(
                            _RUNNER_TEARDOWN_WARNING % traceback.format_exc(),
                            RuntimeWarning,
                        )

    return _scoped_runner


for scope in Scope:
    globals()[f"_{scope.value}_scoped_runner"] = _create_scoped_runner_fixture(
        scope.value
    )


@pytest.fixture(scope="session", autouse=True)
def event_loop_policy() -> AbstractEventLoopPolicy:
    """Return an instance of the policy used to create asyncio event loops."""
    return _get_event_loop_policy()


def is_async_test(item: Item) -> TypeIs[PytestAsyncioFunction]:
    """Returns whether a test item is a pytest-asyncio test"""
    return isinstance(item, PytestAsyncioFunction)


def _unused_port(socket_type: int) -> int:
    """Find an unused localhost port from 1024-65535 and return it."""
    with contextlib.closing(socket.socket(type=socket_type)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def unused_tcp_port() -> int:
    return _unused_port(socket.SOCK_STREAM)


@pytest.fixture
def unused_udp_port() -> int:
    return _unused_port(socket.SOCK_DGRAM)


@pytest.fixture(scope="session")
def unused_tcp_port_factory() -> Callable[[], int]:
    """A factory function, producing different unused TCP ports."""
    produced = set()

    def factory():
        """Return an unused port."""
        port = _unused_port(socket.SOCK_STREAM)

        while port in produced:
            port = _unused_port(socket.SOCK_STREAM)

        produced.add(port)

        return port

    return factory


@pytest.fixture(scope="session")
def unused_udp_port_factory() -> Callable[[], int]:
    """A factory function, producing different unused UDP ports."""
    produced = set()

    def factory():
        """Return an unused port."""
        port = _unused_port(socket.SOCK_DGRAM)

        while port in produced:
            port = _unused_port(socket.SOCK_DGRAM)

        produced.add(port)

        return port

    return factory
