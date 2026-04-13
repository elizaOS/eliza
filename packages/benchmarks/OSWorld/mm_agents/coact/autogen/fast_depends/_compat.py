# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/https://github.com/Lancetnik/FastDepends are under the MIT License.
# SPDX-License-Identifier: MIT

import sys
from importlib.metadata import version as get_version
from typing import Any, Dict, Optional, Tuple, Type

from pydantic import BaseModel, create_model
from pydantic.version import VERSION as PYDANTIC_VERSION

__all__ = (
    "PYDANTIC_V2",
    "BaseModel",
    "ConfigDict",
    "ExceptionGroup",
    "create_model",
    "evaluate_forwardref",
    "get_config_base",
)


PYDANTIC_V2 = PYDANTIC_VERSION.startswith("2.")

default_pydantic_config = {"arbitrary_types_allowed": True}

evaluate_forwardref: Any
# isort: off
if PYDANTIC_V2:
    from pydantic import ConfigDict
    from pydantic._internal._typing_extra import (  # type: ignore[no-redef]
        eval_type_lenient as evaluate_forwardref,
    )

    def model_schema(model: Type[BaseModel]) -> Dict[str, Any]:
        return model.model_json_schema()

    def get_config_base(config_data: Optional[ConfigDict] = None) -> ConfigDict:
        return config_data or ConfigDict(**default_pydantic_config)  # type: ignore[typeddict-item]

    def get_aliases(model: Type[BaseModel]) -> Tuple[str, ...]:
        return tuple(f.alias or name for name, f in model.model_fields.items())

    class CreateBaseModel(BaseModel):
        """Just to support FastStream < 0.3.7."""

        model_config = ConfigDict(arbitrary_types_allowed=True)

else:
    from pydantic.typing import evaluate_forwardref as evaluate_forwardref  # type: ignore[no-redef]
    from pydantic.config import get_config, ConfigDict, BaseConfig

    def get_config_base(config_data: Optional[ConfigDict] = None) -> Type[BaseConfig]:  # type: ignore[misc,no-any-unimported]
        return get_config(config_data or ConfigDict(**default_pydantic_config))  # type: ignore[typeddict-item,no-any-unimported,no-any-return]

    def model_schema(model: Type[BaseModel]) -> Dict[str, Any]:
        return model.schema()

    def get_aliases(model: Type[BaseModel]) -> Tuple[str, ...]:
        return tuple(f.alias or name for name, f in model.__fields__.items())  # type: ignore[attr-defined]

    class CreateBaseModel(BaseModel):  # type: ignore[no-redef]
        """Just to support FastStream < 0.3.7."""

        class Config:
            arbitrary_types_allowed = True


ANYIO_V3 = get_version("anyio").startswith("3.")

if ANYIO_V3:
    from anyio import ExceptionGroup as ExceptionGroup  # type: ignore[attr-defined]
else:
    if sys.version_info < (3, 11):
        from exceptiongroup import ExceptionGroup as ExceptionGroup
    else:
        ExceptionGroup = ExceptionGroup
