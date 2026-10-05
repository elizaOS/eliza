# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import functools
import json
import re
from abc import ABC, abstractmethod
from collections.abc import Iterable
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, Mapping, Optional, Type, TypeVar, Union

from httpx import Client as httpxClient
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, ValidationInfo, field_serializer, field_validator

if TYPE_CHECKING:
    from .oai.client import ModelClient

    _KT = TypeVar("_KT")
    _VT = TypeVar("_VT")

__all__ = [
    "LLMConfig",
    "LLMConfigEntry",
    "register_llm_config",
]


def _add_default_api_type(d: dict[str, Any]) -> dict[str, Any]:
    if "api_type" not in d:
        d["api_type"] = "openai"
    return d


# Meta class to allow LLMConfig.current and LLMConfig.default to be used as class properties
class MetaLLMConfig(type):
    def __init__(cls, *args: Any, **kwargs: Any) -> None:
        pass

    @property
    def current(cls) -> "LLMConfig":
        current_llm_config = LLMConfig.get_current_llm_config(llm_config=None)
        if current_llm_config is None:
            raise ValueError("No current LLMConfig set. Are you inside a context block?")
        return current_llm_config  # type: ignore[return-value]

    @property
    def default(cls) -> "LLMConfig":
        return cls.current


class LLMConfig(metaclass=MetaLLMConfig):
    _current_llm_config: ContextVar["LLMConfig"] = ContextVar("current_llm_config")

    def __init__(self, **kwargs: Any) -> None:
        outside_properties = list((self._get_base_model_class()).model_json_schema()["properties"].keys())
        outside_properties.remove("config_list")

        if "config_list" in kwargs and isinstance(kwargs["config_list"], dict):
            kwargs["config_list"] = [kwargs["config_list"]]

        modified_kwargs = (
            kwargs
            if "config_list" in kwargs
            else {
                **{
                    "config_list": [
                        {k: v for k, v in kwargs.items() if k not in outside_properties},
                    ]
                },
                **{k: v for k, v in kwargs.items() if k in outside_properties},
            }
        )

        modified_kwargs["config_list"] = [
            _add_default_api_type(v) if isinstance(v, dict) else v for v in modified_kwargs["config_list"]
        ]
        for x in ["max_tokens", "top_p"]:
            if x in modified_kwargs:
                modified_kwargs["config_list"] = [{**v, x: modified_kwargs[x]} for v in modified_kwargs["config_list"]]
                modified_kwargs.pop(x)

        self._model = self._get_base_model_class()(**modified_kwargs)

    # used by BaseModel to create instance variables
    def __enter__(self) -> "LLMConfig":
        # Store previous context and set self as current
        self._token = LLMConfig._current_llm_config.set(self)
        return self

    def __exit__(self, exc_type: Type[Exception], exc_val: Exception, exc_tb: Any) -> None:
        LLMConfig._current_llm_config.reset(self._token)

    @classmethod
    def get_current_llm_config(cls, llm_config: "Optional[LLMConfig]" = None) -> "Optional[LLMConfig]":
        if llm_config is not None:
            return llm_config
        try:
            return (LLMConfig._current_llm_config.get()).copy()
        except LookupError:
            return None

    def _satisfies_criteria(self, value: Any, criteria_values: Any) -> bool:
        if value is None:
            return False

        if isinstance(value, list):
            return bool(set(value) & set(criteria_values))  # Non-empty intersection
        else:
            return value in criteria_values

    @classmethod
    def from_json(
        cls,
        *,
        env: Optional[str] = None,
        path: Optional[Union[str, Path]] = None,
        file_location: Optional[str] = None,
        **kwargs: Any,
    ) -> "LLMConfig":
        from .oai.openai_utils import config_list_from_json

        if env is None and path is None:
            raise ValueError("Either 'env' or 'path' must be provided")
        if env is not None and path is not None:
            raise ValueError("Only one of 'env' or 'path' can be provided")

        config_list = config_list_from_json(
            env_or_file=env if env is not None else str(path), file_location=file_location
        )
        return LLMConfig(config_list=config_list, **kwargs)

    def where(self, *, exclude: bool = False, **kwargs: Any) -> "LLMConfig":
        from .oai.openai_utils import filter_config

        filtered_config_list = filter_config(config_list=self.config_list, filter_dict=kwargs, exclude=exclude)
        if len(filtered_config_list) == 0:
            raise ValueError(f"No config found that satisfies the filter criteria: {kwargs}")

        kwargs = self.model_dump()
        kwargs["config_list"] = filtered_config_list

        return LLMConfig(**kwargs)

    # @functools.wraps(BaseModel.model_dump)
    def model_dump(self, *args: Any, exclude_none: bool = True, **kwargs: Any) -> dict[str, Any]:
        d = self._model.model_dump(*args, exclude_none=exclude_none, **kwargs)
        return {k: v for k, v in d.items() if not (isinstance(v, list) and len(v) == 0)}

    # @functools.wraps(BaseModel.model_dump_json)
    def model_dump_json(self, *args: Any, exclude_none: bool = True, **kwargs: Any) -> str:
        # return self._model.model_dump_json(*args, exclude_none=exclude_none, **kwargs)
        d = self.model_dump(*args, exclude_none=exclude_none, **kwargs)
        return json.dumps(d)

    # @functools.wraps(BaseModel.model_validate)
    def model_validate(self, *args: Any, **kwargs: Any) -> Any:
        return self._model.model_validate(*args, **kwargs)

    @functools.wraps(BaseModel.model_validate_json)
    def model_validate_json(self, *args: Any, **kwargs: Any) -> Any:
        return self._model.model_validate_json(*args, **kwargs)

    @functools.wraps(BaseModel.model_validate_strings)
    def model_validate_strings(self, *args: Any, **kwargs: Any) -> Any:
        return self._model.model_validate_strings(*args, **kwargs)

    def __eq__(self, value: Any) -> bool:
        return hasattr(value, "_model") and self._model == value._model

    def _getattr(self, o: object, name: str) -> Any:
        val = getattr(o, name)
        return val

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        val = getattr(self._model, key, default)
        return val

    def __getitem__(self, key: str) -> Any:
        try:
            return self._getattr(self._model, key)
        except AttributeError:
            raise KeyError(f"Key '{key}' not found in {self.__class__.__name__}")

    def __setitem__(self, key: str, value: Any) -> None:
        try:
            setattr(self._model, key, value)
        except ValueError:
            raise ValueError(f"'{self.__class__.__name__}' object has no field '{key}'")

    def __getattr__(self, name: Any) -> Any:
        try:
            return self._getattr(self._model, name)
        except AttributeError:
            raise AttributeError(f"'{self.__class__.__name__}' object has no attribute '{name}'")

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_model":
            object.__setattr__(self, name, value)
        else:
            setattr(self._model, name, value)

    def __contains__(self, key: str) -> bool:
        return hasattr(self._model, key)

    def __repr__(self) -> str:
        d = self.model_dump()
        r = [f"{k}={repr(v)}" for k, v in d.items()]

        s = f"LLMConfig({', '.join(r)})"
        # Replace any keys ending with 'key' or 'token' values with stars for security
        s = re.sub(
            r"(['\"])(\w*(key|token))\1:\s*(['\"])([^'\"]*)(?:\4)", r"\1\2\1: \4**********\4", s, flags=re.IGNORECASE
        )
        return s

    def __copy__(self) -> "LLMConfig":
        return LLMConfig(**self.model_dump())

    def __deepcopy__(self, memo: Optional[dict[int, Any]] = None) -> "LLMConfig":
        return self.__copy__()

    def copy(self) -> "LLMConfig":
        return self.__copy__()

    def deepcopy(self, memo: Optional[dict[int, Any]] = None) -> "LLMConfig":
        return self.__deepcopy__(memo)

    def __str__(self) -> str:
        return repr(self)

    def items(self) -> Iterable[tuple[str, Any]]:
        d = self.model_dump()
        return d.items()

    def keys(self) -> Iterable[str]:
        d = self.model_dump()
        return d.keys()

    def values(self) -> Iterable[Any]:
        d = self.model_dump()
        return d.values()

    _base_model_classes: dict[tuple[Type["LLMConfigEntry"], ...], Type[BaseModel]] = {}

    @classmethod
    def _get_base_model_class(cls) -> Type["BaseModel"]:
        def _get_cls(llm_config_classes: tuple[Type[LLMConfigEntry], ...]) -> Type[BaseModel]:
            if llm_config_classes in LLMConfig._base_model_classes:
                return LLMConfig._base_model_classes[llm_config_classes]

            class _LLMConfig(BaseModel):
                temperature: Optional[float] = None
                check_every_ms: Optional[int] = None
                max_new_tokens: Optional[int] = None
                seed: Optional[int] = None
                allow_format_str_template: Optional[bool] = None
                response_format: Optional[Union[str, dict[str, Any], BaseModel, Type[BaseModel]]] = None
                timeout: Optional[int] = None
                cache_seed: Optional[int] = None

                tools: list[Any] = Field(default_factory=list)
                functions: list[Any] = Field(default_factory=list)
                parallel_tool_calls: Optional[bool] = None

                config_list: Annotated[  # type: ignore[valid-type]
                    list[Annotated[Union[llm_config_classes], Field(discriminator="api_type")]],
                    Field(default_factory=list, min_length=1),
                ]

                # Following field is configuration for pydantic to disallow extra fields
                model_config = ConfigDict(extra="forbid")

            LLMConfig._base_model_classes[llm_config_classes] = _LLMConfig

            return _LLMConfig

        return _get_cls(tuple(_llm_config_classes))


class LLMConfigEntry(BaseModel, ABC):
    api_type: str
    model: str = Field(..., min_length=1)
    api_key: Optional[SecretStr] = None
    api_version: Optional[str] = None
    max_tokens: Optional[int] = None
    base_url: Optional[HttpUrl] = None
    voice: Optional[str] = None
    model_client_cls: Optional[str] = None
    http_client: Optional[httpxClient] = None
    response_format: Optional[Union[str, dict[str, Any], BaseModel, Type[BaseModel]]] = None
    default_headers: Optional[Mapping[str, Any]] = None
    tags: list[str] = Field(default_factory=list)

    # Following field is configuration for pydantic to disallow extra fields
    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    @abstractmethod
    def create_client(self) -> "ModelClient": ...

    @field_validator("base_url", mode="before")
    @classmethod
    def check_base_url(cls, v: Any, info: ValidationInfo) -> Any:
        if not str(v).startswith("https://") and not str(v).startswith("http://"):
            v = f"http://{str(v)}"
        return v

    @field_serializer("base_url")
    def serialize_base_url(self, v: Any) -> Any:
        return str(v)

    @field_serializer("api_key", when_used="unless-none")
    def serialize_api_key(self, v: SecretStr) -> Any:
        return v.get_secret_value()

    def model_dump(self, *args: Any, exclude_none: bool = True, **kwargs: Any) -> dict[str, Any]:
        return BaseModel.model_dump(self, exclude_none=exclude_none, *args, **kwargs)

    def model_dump_json(self, *args: Any, exclude_none: bool = True, **kwargs: Any) -> str:
        return BaseModel.model_dump_json(self, exclude_none=exclude_none, *args, **kwargs)

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        val = getattr(self, key, default)
        if isinstance(val, SecretStr):
            return val.get_secret_value()
        return val

    def __getitem__(self, key: str) -> Any:
        try:
            val = getattr(self, key)
            if isinstance(val, SecretStr):
                return val.get_secret_value()
            return val
        except AttributeError:
            raise KeyError(f"Key '{key}' not found in {self.__class__.__name__}")

    def __setitem__(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def __contains__(self, key: str) -> bool:
        return hasattr(self, key)

    def items(self) -> Iterable[tuple[str, Any]]:
        d = self.model_dump()
        return d.items()

    def keys(self) -> Iterable[str]:
        d = self.model_dump()
        return d.keys()

    def values(self) -> Iterable[Any]:
        d = self.model_dump()
        return d.values()

    def __repr__(self) -> str:
        # Override to eliminate none values from the repr
        d = self.model_dump()
        r = [f"{k}={repr(v)}" for k, v in d.items()]

        s = f"{self.__class__.__name__}({', '.join(r)})"

        # Replace any keys ending with '_key' or '_token' values with stars for security
        # This regex will match any key ending with '_key' or '_token' and its value, and replace the value with stars
        # It also captures the type of quote used (single or double) and reuses it in the replacement
        s = re.sub(r'(\w+_(key|token)\s*=\s*)([\'"]).*?\3', r"\1\3**********\3", s, flags=re.IGNORECASE)

        return s

    def __str__(self) -> str:
        return repr(self)


_llm_config_classes: list[Type[LLMConfigEntry]] = []


def register_llm_config(cls: Type[LLMConfigEntry]) -> Type[LLMConfigEntry]:
    if isinstance(cls, type) and issubclass(cls, LLMConfigEntry):
        _llm_config_classes.append(cls)
    else:
        raise TypeError(f"Expected a subclass of LLMConfigEntry, got {cls}")
    return cls
