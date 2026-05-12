# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/https://github.com/Lancetnik/FastDepends are under the MIT License.
# SPDX-License-Identifier: MIT

from collections import namedtuple
from contextlib import AsyncExitStack, ExitStack
from functools import partial
from inspect import Parameter, unwrap
from itertools import chain
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Generator,
    Generic,
    Iterable,
    List,
    Optional,
    Sequence,
    Tuple,
    Type,
    TypeVar,
    Union,
)

import anyio
from typing_extensions import ParamSpec

from .._compat import BaseModel, ExceptionGroup, get_aliases
from ..library import CustomField
from ..utils import (
    async_map,
    is_async_gen_callable,
    is_coroutine_callable,
    is_gen_callable,
    run_async,
    solve_generator_async,
    solve_generator_sync,
)

P = ParamSpec("P")
T = TypeVar("T")


PriorityPair = namedtuple("PriorityPair", ("call", "dependencies_number", "dependencies_names"))


class ResponseModel(BaseModel, Generic[T]):
    response: T


class CallModel(Generic[P, T]):
    call: Union[
        Callable[P, T],
        Callable[P, Awaitable[T]],
    ]
    is_async: bool
    is_generator: bool
    model: Optional[Type[BaseModel]]
    response_model: Optional[Type[ResponseModel[T]]]

    params: Dict[str, Tuple[Any, Any]]
    alias_arguments: Tuple[str, ...]

    dependencies: Dict[str, "CallModel[..., Any]"]
    extra_dependencies: Iterable["CallModel[..., Any]"]
    sorted_dependencies: Tuple[Tuple["CallModel[..., Any]", int], ...]
    custom_fields: Dict[str, CustomField]
    keyword_args: Tuple[str, ...]
    positional_args: Tuple[str, ...]
    var_positional_arg: Optional[str]
    var_keyword_arg: Optional[str]

    # Dependencies and custom fields
    use_cache: bool
    cast: bool

    __slots__ = (
        "call",
        "is_async",
        "is_generator",
        "model",
        "response_model",
        "params",
        "alias_arguments",
        "keyword_args",
        "positional_args",
        "var_positional_arg",
        "var_keyword_arg",
        "dependencies",
        "extra_dependencies",
        "sorted_dependencies",
        "custom_fields",
        "use_cache",
        "cast",
    )

    @property
    def call_name(self) -> str:
        call = unwrap(self.call)
        return getattr(call, "__name__", type(call).__name__)

    @property
    def flat_params(self) -> Dict[str, Tuple[Any, Any]]:
        params = self.params
        for d in (*self.dependencies.values(), *self.extra_dependencies):
            params.update(d.flat_params)
        return params

    @property
    def flat_dependencies(
        self,
    ) -> Dict[
        Callable[..., Any],
        Tuple[
            "CallModel[..., Any]",
            Tuple[Callable[..., Any], ...],
        ],
    ]:
        flat: Dict[
            Callable[..., Any],
            Tuple[
                CallModel[..., Any],
                Tuple[Callable[..., Any], ...],
            ],
        ] = {}

        for i in (*self.dependencies.values(), *self.extra_dependencies):
            flat.update({
                i.call: (
                    i,
                    tuple(j.call for j in i.dependencies.values()),
                )
            })

            flat.update(i.flat_dependencies)

        return flat

    def __init__(
        self,
        /,
        call: Union[
            Callable[P, T],
            Callable[P, Awaitable[T]],
        ],
        model: Optional[Type[BaseModel]],
        params: Dict[str, Tuple[Any, Any]],
        response_model: Optional[Type[ResponseModel[T]]] = None,
        use_cache: bool = True,
        cast: bool = True,
        is_async: bool = False,
        is_generator: bool = False,
        dependencies: Optional[Dict[str, "CallModel[..., Any]"]] = None,
        extra_dependencies: Optional[Iterable["CallModel[..., Any]"]] = None,
        keyword_args: Optional[List[str]] = None,
        positional_args: Optional[List[str]] = None,
        var_positional_arg: Optional[str] = None,
        var_keyword_arg: Optional[str] = None,
        custom_fields: Optional[Dict[str, CustomField]] = None,
    ):
        self.call = call
        self.model = model

        if model:
            self.alias_arguments = get_aliases(model)
        else:  # pragma: no cover
            self.alias_arguments = ()

        self.keyword_args = tuple(keyword_args or ())
        self.positional_args = tuple(positional_args or ())
        self.var_positional_arg = var_positional_arg
        self.var_keyword_arg = var_keyword_arg
        self.response_model = response_model
        self.use_cache = use_cache
        self.cast = cast
        self.is_async = is_async or is_coroutine_callable(call) or is_async_gen_callable(call)
        self.is_generator = is_generator or is_gen_callable(call) or is_async_gen_callable(call)

        self.dependencies = dependencies or {}
        self.extra_dependencies = extra_dependencies or ()
        self.custom_fields = custom_fields or {}

        sorted_dep: List[CallModel[..., Any]] = []
        flat = self.flat_dependencies
        for calls in flat.values():
            _sort_dep(sorted_dep, calls, flat)

        self.sorted_dependencies = tuple((i, len(i.sorted_dependencies)) for i in sorted_dep if i.use_cache)
        for name in chain(self.dependencies.keys(), self.custom_fields.keys()):
            params.pop(name, None)
        self.params = params

    def _solve(
        self,
        /,
        *args: Tuple[Any, ...],
        cache_dependencies: Dict[
            Union[
                Callable[P, T],
                Callable[P, Awaitable[T]],
            ],
            T,
        ],
        dependency_overrides: Optional[
            Dict[
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
            ]
        ] = None,
        **kwargs: Dict[str, Any],
    ) -> Generator[
        Tuple[
            Sequence[Any],
            Dict[str, Any],
            Callable[..., Any],
        ],
        Any,
        T,
    ]:
        if dependency_overrides:
            call = dependency_overrides.get(self.call, self.call)
            assert self.is_async or not is_coroutine_callable(call), (
                f"You cannot use async dependency `{self.call_name}` at sync main"
            )

        else:
            call = self.call

        if self.use_cache and call in cache_dependencies:
            return cache_dependencies[call]

        kw: Dict[str, Any] = {}

        for arg in self.keyword_args:
            if (v := kwargs.pop(arg, Parameter.empty)) is not Parameter.empty:
                kw[arg] = v

        if self.var_keyword_arg is not None:
            kw[self.var_keyword_arg] = kwargs
        else:
            kw.update(kwargs)

        for arg in self.positional_args:
            if args:
                kw[arg], args = args[0], args[1:]
            else:
                break

        keyword_args: Iterable[str]
        if self.var_positional_arg is not None:
            kw[self.var_positional_arg] = args
            keyword_args = self.keyword_args

        else:
            keyword_args = self.keyword_args + self.positional_args
            for arg in keyword_args:
                if not self.cast and arg in self.params:
                    kw[arg] = self.params[arg][1]

                if not args:
                    break

                if arg not in self.dependencies:
                    kw[arg], args = args[0], args[1:]

        solved_kw: Dict[str, Any]
        solved_kw = yield args, kw, call

        args_: Sequence[Any]
        if self.cast:
            assert self.model, "Cast should be used only with model"
            casted_model = self.model(**solved_kw)

            kwargs_ = {arg: getattr(casted_model, arg, solved_kw.get(arg)) for arg in keyword_args}
            if self.var_keyword_arg:
                kwargs_.update(getattr(casted_model, self.var_keyword_arg, {}))

            if self.var_positional_arg is not None:
                args_ = [getattr(casted_model, arg, solved_kw.get(arg)) for arg in self.positional_args]
                args_.extend(getattr(casted_model, self.var_positional_arg, ()))
            else:
                args_ = ()

        else:
            kwargs_ = {arg: solved_kw.get(arg) for arg in keyword_args}

            args_ = tuple(map(solved_kw.get, self.positional_args)) if self.var_positional_arg is None else ()

        response: T
        response = yield args_, kwargs_, call

        if self.cast and not self.is_generator:
            response = self._cast_response(response)

        if self.use_cache:  # pragma: no branch
            cache_dependencies[call] = response

        return response

    def _cast_response(self, /, value: Any) -> Any:
        if self.response_model is not None:
            return self.response_model(response=value).response
        else:
            return value

    def solve(
        self,
        /,
        *args: Any,
        stack: ExitStack,
        cache_dependencies: Dict[
            Union[
                Callable[P, T],
                Callable[P, Awaitable[T]],
            ],
            T,
        ],
        dependency_overrides: Optional[
            Dict[
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
            ]
        ] = None,
        nested: bool = False,
        **kwargs: Any,
    ) -> T:
        cast_gen = self._solve(
            *args,
            cache_dependencies=cache_dependencies,
            dependency_overrides=dependency_overrides,
            **kwargs,
        )
        try:
            args, kwargs, _ = next(cast_gen)  # type: ignore[assignment]
        except StopIteration as e:
            cached_value: T = e.value
            return cached_value

        # Heat cache and solve extra dependencies
        for dep, _ in self.sorted_dependencies:
            dep.solve(
                *args,
                stack=stack,
                cache_dependencies=cache_dependencies,
                dependency_overrides=dependency_overrides,
                nested=True,
                **kwargs,
            )

        # Always get from cache
        for dep in self.extra_dependencies:
            dep.solve(
                *args,
                stack=stack,
                cache_dependencies=cache_dependencies,
                dependency_overrides=dependency_overrides,
                nested=True,
                **kwargs,
            )

        for dep_arg, dep in self.dependencies.items():
            kwargs[dep_arg] = dep.solve(
                stack=stack,
                cache_dependencies=cache_dependencies,
                dependency_overrides=dependency_overrides,
                nested=True,
                **kwargs,
            )

        for custom in self.custom_fields.values():
            if custom.field:
                custom.use_field(kwargs)
            else:
                kwargs = custom.use(**kwargs)

        final_args, final_kwargs, call = cast_gen.send(kwargs)

        if self.is_generator and nested:
            response = solve_generator_sync(
                *final_args,
                call=call,
                stack=stack,
                **final_kwargs,
            )

        else:
            response = call(*final_args, **final_kwargs)

        try:
            cast_gen.send(response)
        except StopIteration as e:
            value: T = e.value

            if not self.cast or nested or not self.is_generator:
                return value

            else:
                return map(self._cast_response, value)  # type: ignore[no-any-return, call-overload]

        raise AssertionError("unreachable")

    async def asolve(
        self,
        /,
        *args: Any,
        stack: AsyncExitStack,
        cache_dependencies: Dict[
            Union[
                Callable[P, T],
                Callable[P, Awaitable[T]],
            ],
            T,
        ],
        dependency_overrides: Optional[
            Dict[
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
                Union[
                    Callable[P, T],
                    Callable[P, Awaitable[T]],
                ],
            ]
        ] = None,
        nested: bool = False,
        **kwargs: Any,
    ) -> T:
        cast_gen = self._solve(
            *args,
            cache_dependencies=cache_dependencies,
            dependency_overrides=dependency_overrides,
            **kwargs,
        )
        try:
            args, kwargs, _ = next(cast_gen)  # type: ignore[assignment]
        except StopIteration as e:
            cached_value: T = e.value
            return cached_value

        # Heat cache and solve extra dependencies
        dep_to_solve: List[Callable[..., Awaitable[Any]]] = []
        try:
            async with anyio.create_task_group() as tg:
                for dep, subdep in self.sorted_dependencies:
                    solve = partial(
                        dep.asolve,
                        *args,
                        stack=stack,
                        cache_dependencies=cache_dependencies,
                        dependency_overrides=dependency_overrides,
                        nested=True,
                        **kwargs,
                    )
                    if not subdep:
                        tg.start_soon(solve)
                    else:
                        dep_to_solve.append(solve)
        except ExceptionGroup as exgr:
            for ex in exgr.exceptions:
                raise ex from None

        for i in dep_to_solve:
            await i()

        # Always get from cache
        for dep in self.extra_dependencies:
            await dep.asolve(
                *args,
                stack=stack,
                cache_dependencies=cache_dependencies,
                dependency_overrides=dependency_overrides,
                nested=True,
                **kwargs,
            )

        for dep_arg, dep in self.dependencies.items():
            kwargs[dep_arg] = await dep.asolve(
                stack=stack,
                cache_dependencies=cache_dependencies,
                dependency_overrides=dependency_overrides,
                nested=True,
                **kwargs,
            )

        custom_to_solve: List[CustomField] = []

        try:
            async with anyio.create_task_group() as tg:
                for custom in self.custom_fields.values():
                    if custom.field:
                        tg.start_soon(run_async, custom.use_field, kwargs)
                    else:
                        custom_to_solve.append(custom)

        except ExceptionGroup as exgr:
            for ex in exgr.exceptions:
                raise ex from None

        for j in custom_to_solve:
            kwargs = await run_async(j.use, **kwargs)

        final_args, final_kwargs, call = cast_gen.send(kwargs)

        if self.is_generator and nested:
            response = await solve_generator_async(
                *final_args,
                call=call,
                stack=stack,
                **final_kwargs,
            )
        else:
            response = await run_async(call, *final_args, **final_kwargs)

        try:
            cast_gen.send(response)
        except StopIteration as e:
            value: T = e.value

            if not self.cast or nested or not self.is_generator:
                return value

            else:
                return async_map(self._cast_response, value)  # type: ignore[return-value, arg-type]

        raise AssertionError("unreachable")


def _sort_dep(
    collector: List["CallModel[..., Any]"],
    items: Tuple[
        "CallModel[..., Any]",
        Tuple[Callable[..., Any], ...],
    ],
    flat: Dict[
        Callable[..., Any],
        Tuple[
            "CallModel[..., Any]",
            Tuple[Callable[..., Any], ...],
        ],
    ],
) -> None:
    model, calls = items

    if model in collector:
        return

    if not calls:
        position = -1

    else:
        for i in calls:
            sub_model, _ = flat[i]
            if sub_model not in collector:  # pragma: no branch
                _sort_dep(collector, flat[i], flat)

        position = max(collector.index(flat[i][0]) for i in calls)

    collector.insert(position + 1, model)
