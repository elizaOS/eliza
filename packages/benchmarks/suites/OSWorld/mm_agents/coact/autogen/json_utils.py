# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

from .import_utils import optional_import_block, require_optional_import

with optional_import_block():
    from jsonschema import Draft7Validator, RefResolver

__all__ = ["resolve_json_references"]


@require_optional_import("jsonschema", "gemini")
def resolve_json_references(schema: dict[str, Any]) -> dict[str, Any]:
    """
    Resolve JSON references in the given schema.

    Args:
        schema (dict): The JSON schema with references.

    Returns:
        dict: The JSON schema with resolved references.
    """
    resolver = RefResolver.from_schema(schema)
    validator = Draft7Validator(schema, resolver=resolver)
    resolved_schema = validator.schema

    def resolve_refs(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                ref = node["$ref"]
                with resolver.resolving(ref) as resolved:
                    return resolve_refs(resolved)
            else:
                return {k: resolve_refs(v) for k, v in node.items()}
        elif isinstance(node, list):
            return [resolve_refs(item) for item in node]
        else:
            return node

    return resolve_refs(resolved_schema)  # type: ignore[no-any-return]
