# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import enum
import warnings
from typing import Any, Optional, Type, TypeVar, Union, get_args, get_origin

from pydantic import BaseModel as BaseModel
from pydantic import ConfigDict, Field, alias_generators


def _remove_extra_fields(model: Any, response: dict[str, object]) -> None:
    """Removes extra fields from the response that are not in the model.

    Mutates the response in place.
    """

    key_values = list(response.items())

    for key, value in key_values:
        # Need to convert to snake case to match model fields names
        # ex: UsageMetadata
        alias_map = {field_info.alias: key for key, field_info in model.model_fields.items()}

        if key not in model.model_fields and key not in alias_map:
            response.pop(key)
            continue

        key = alias_map.get(key, key)

        annotation = model.model_fields[key].annotation

        # Get the BaseModel if Optional
        if get_origin(annotation) is Union:
            annotation = get_args(annotation)[0]

        # if dict, assume BaseModel but also check that field type is not dict
        # example: FunctionCall.args
        if isinstance(value, dict) and get_origin(annotation) is not dict:
            _remove_extra_fields(annotation, value)
        elif isinstance(value, list):
            for item in value:
                # assume a list of dict is list of BaseModel
                if isinstance(item, dict):
                    _remove_extra_fields(get_args(annotation)[0], item)


T = TypeVar("T", bound="BaseModel")


class CommonBaseModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=alias_generators.to_camel,
        populate_by_name=True,
        from_attributes=True,
        protected_namespaces=(),
        extra="forbid",
        # This allows us to use arbitrary types in the model. E.g. PIL.Image.
        arbitrary_types_allowed=True,
        ser_json_bytes="base64",
        val_json_bytes="base64",
        ignored_types=(TypeVar,),
    )

    @classmethod
    def _from_response(cls: Type[T], *, response: dict[str, object], kwargs: dict[str, object]) -> T:
        # To maintain forward compatibility, we need to remove extra fields from
        # the response.
        # We will provide another mechanism to allow users to access these fields.
        _remove_extra_fields(cls, response)
        validated_response = cls.model_validate(response)
        return validated_response

    def to_json_dict(self) -> dict[str, object]:
        return self.model_dump(exclude_none=True, mode="json")


class CaseInSensitiveEnum(str, enum.Enum):
    """Case insensitive enum."""

    @classmethod
    def _missing_(cls, value: Any) -> Optional["CaseInSensitiveEnum"]:
        try:
            return cls[value.upper()]  # Try to access directly with uppercase
        except KeyError:
            try:
                return cls[value.lower()]  # Try to access directly with lowercase
            except KeyError:
                warnings.warn(f"{value} is not a valid {cls.__name__}")
                try:
                    # Creating a enum instance based on the value
                    # We need to use super() to avoid infinite recursion.
                    unknown_enum_val = super().__new__(cls, value)
                    unknown_enum_val._name_ = str(value)  # pylint: disable=protected-access
                    unknown_enum_val._value_ = value  # pylint: disable=protected-access
                    return unknown_enum_val
                except:  # noqa: E722
                    return None


class FunctionCallingConfigMode(CaseInSensitiveEnum):
    """Config for the function calling config mode."""

    MODE_UNSPECIFIED = "MODE_UNSPECIFIED"
    AUTO = "AUTO"
    ANY = "ANY"
    NONE = "NONE"


class LatLng(CommonBaseModel):
    """An object that represents a latitude/longitude pair.

    This is expressed as a pair of doubles to represent degrees latitude and
    degrees longitude. Unless specified otherwise, this object must conform to the
    <a href="https://en.wikipedia.org/wiki/World_Geodetic_System#1984_version">
    WGS84 standard</a>. Values must be within normalized ranges.
    """

    latitude: Optional[float] = Field(
        default=None,
        description="""The latitude in degrees. It must be in the range [-90.0, +90.0].""",
    )
    longitude: Optional[float] = Field(
        default=None,
        description="""The longitude in degrees. It must be in the range [-180.0, +180.0]""",
    )


class FunctionCallingConfig(CommonBaseModel):
    """Function calling config."""

    mode: Optional[FunctionCallingConfigMode] = Field(default=None, description="""Optional. Function calling mode.""")
    allowed_function_names: Optional[list[str]] = Field(
        default=None,
        description="""Optional. Function names to call. Only set when the Mode is ANY. Function names should match [FunctionDeclaration.name]. With mode set to ANY, model will predict a function call from the set of function names provided.""",
    )


class RetrievalConfig(CommonBaseModel):
    """Retrieval config."""

    lat_lng: Optional[LatLng] = Field(default=None, description="""Optional. The location of the user.""")
    language_code: Optional[str] = Field(default=None, description="""The language code of the user.""")


class ToolConfig(CommonBaseModel):
    """Tool config.

    This config is shared for all tools provided in the request.
    """

    function_calling_config: Optional[FunctionCallingConfig] = Field(
        default=None, description="""Optional. Function calling config."""
    )
    retrieval_config: Optional[RetrievalConfig] = Field(default=None, description="""Optional. Retrieval config.""")
