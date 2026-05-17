# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/https://github.com/Lancetnik/FastDepends are under the MIT License.
# SPDX-License-Identifier: MIT

from typing import Any, Dict, List, Optional

from ._compat import PYDANTIC_V2, create_model, model_schema
from .core import CallModel


def get_schema(
    call: CallModel[Any, Any],
    embed: bool = False,
    resolve_refs: bool = False,
) -> Dict[str, Any]:
    assert call.model, "Call should has a model"
    params_model = create_model(  # type: ignore[call-overload]
        call.model.__name__, **call.flat_params
    )

    body: Dict[str, Any] = model_schema(params_model)

    if not call.flat_params:
        body = {"title": body["title"], "type": "null"}

    if resolve_refs:
        pydantic_key = "$defs" if PYDANTIC_V2 else "definitions"
        body = _move_pydantic_refs(body, pydantic_key)
        body.pop(pydantic_key, None)

    if embed and len(body["properties"]) == 1:
        body = list(body["properties"].values())[0]

    return body


def _move_pydantic_refs(original: Any, key: str, refs: Optional[Dict[str, Any]] = None) -> Any:
    if not isinstance(original, Dict):
        return original

    data = original.copy()

    if refs is None:
        raw_refs = data.get(key, {})
        refs = _move_pydantic_refs(raw_refs, key, raw_refs)

    name: Optional[str] = None
    for k in data:
        if k == "$ref":
            name = data[k].replace(f"#/{key}/", "")

        elif isinstance(data[k], dict):
            data[k] = _move_pydantic_refs(data[k], key, refs)

        elif isinstance(data[k], List):
            for i in range(len(data[k])):
                data[k][i] = _move_pydantic_refs(data[k][i], key, refs)

    if name:
        assert refs, "Smth wrong"
        data = refs[name]

    return data
