# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/https://github.com/Lancetnik/FastDepends are under the MIT License.
# SPDX-License-Identifier: MIT

import asyncio
import functools
import inspect
from contextlib import AsyncExitStack, ExitStack, asynccontextmanager, contextmanager
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncGenerator,
    AsyncIterable,
    Awaitable,
    Callable,
    ContextManager,
    Dict,
    ForwardRef,
    List,
    Tuple,
    TypeVar,
    Union,
    cast,
)

import anyio
from typing_extensions import (
    Annotated,
    ParamSpec,
    get_args,
    get_origin,
)

from ._compat import evaluate_forwardref

if TYPE_CHECKING:
    from types import FrameType

P = ParamSpec("P")
T = TypeVar("T")


async def run_async(
    func: Union[
        Callable[P, T],
        Callable[P, Awaitable[T]],
    ],
    *args: P.args,
    **kwargs: P.kwargs,
) -> T:
    if is_coroutine_callable(func):
        return await cast(Callable[P, Awaitable[T]], func)(*args, **kwargs)
    else:
        return await run_in_threadpool(cast(Callable[P, T], func), *args, **kwargs)


async def run_in_threadpool(func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    if kwargs:
        func = functools.partial(func, **kwargs)
    return await anyio.to_thread.run_sync(func, *args)


async def solve_generator_async(
    *sub_args: Any, call: Callable[..., Any], stack: AsyncExitStack, **sub_values: Any
) -> Any:
    if is_gen_callable(call):
        cm = contextmanager_in_threadpool(contextmanager(call)(**sub_values))
    elif is_async_gen_callable(call):  # pragma: no branch
        cm = asynccontextmanager(call)(*sub_args, **sub_values)
    return await stack.enter_async_context(cm)


def solve_generator_sync(*sub_args: Any, call: Callable[..., Any], stack: ExitStack, **sub_values: Any) -> Any:
    cm = contextmanager(call)(*sub_args, **sub_values)
    return stack.enter_context(cm)


def get_typed_signature(call: Callable[..., Any]) -> Tuple[inspect.Signature, Any]:
    signature = inspect.signature(call)

    locals = collect_outer_stack_locals()

    # We unwrap call to get the original unwrapped function
    call = inspect.unwrap(call)

    globalns = getattr(call, "__globals__", {})
    typed_params = [
        inspect.Parameter(
            name=param.name,
            kind=param.kind,
            default=param.default,
            annotation=get_typed_annotation(
                param.annotation,
                globalns,
                locals,
            ),
        )
        for param in signature.parameters.values()
    ]

    return inspect.Signature(typed_params), get_typed_annotation(
        signature.return_annotation,
        globalns,
        locals,
    )


def collect_outer_stack_locals() -> Dict[str, Any]:
    frame = inspect.currentframe()

    frames: List[FrameType] = []
    while frame is not None:
        if "fast_depends" not in frame.f_code.co_filename:
            frames.append(frame)
        frame = frame.f_back

    locals = {}
    for f in frames[::-1]:
        locals.update(f.f_locals)

    return locals


def get_typed_annotation(
    annotation: Any,
    globalns: Dict[str, Any],
    locals: Dict[str, Any],
) -> Any:
    if isinstance(annotation, str):
        annotation = ForwardRef(annotation)

    if isinstance(annotation, ForwardRef):
        annotation = evaluate_forwardref(annotation, globalns, locals)

    if get_origin(annotation) is Annotated and (args := get_args(annotation)):
        solved_args = [get_typed_annotation(x, globalns, locals) for x in args]
        annotation.__origin__, annotation.__metadata__ = solved_args[0], tuple(solved_args[1:])

    return annotation


@asynccontextmanager
async def contextmanager_in_threadpool(
    cm: ContextManager[T],
) -> AsyncGenerator[T, None]:
    exit_limiter = anyio.CapacityLimiter(1)
    try:
        yield await run_in_threadpool(cm.__enter__)
    except Exception as e:
        ok = bool(await anyio.to_thread.run_sync(cm.__exit__, type(e), e, None, limiter=exit_limiter))
        if not ok:  # pragma: no branch
            raise e
    else:
        await anyio.to_thread.run_sync(cm.__exit__, None, None, None, limiter=exit_limiter)


def is_gen_callable(call: Callable[..., Any]) -> bool:
    if inspect.isgeneratorfunction(call):
        return True
    dunder_call = getattr(call, "__call__", None)  # noqa: B004
    return inspect.isgeneratorfunction(dunder_call)


def is_async_gen_callable(call: Callable[..., Any]) -> bool:
    if inspect.isasyncgenfunction(call):
        return True
    dunder_call = getattr(call, "__call__", None)  # noqa: B004
    return inspect.isasyncgenfunction(dunder_call)


def is_coroutine_callable(call: Callable[..., Any]) -> bool:
    if inspect.isclass(call):
        return False

    if asyncio.iscoroutinefunction(call):
        return True

    dunder_call = getattr(call, "__call__", None)  # noqa: B004
    return asyncio.iscoroutinefunction(dunder_call)


async def async_map(func: Callable[..., T], async_iterable: AsyncIterable[Any]) -> AsyncIterable[T]:
    async for i in async_iterable:
        yield func(i)
