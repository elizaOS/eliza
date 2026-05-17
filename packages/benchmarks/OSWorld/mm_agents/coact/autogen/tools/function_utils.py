# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import functools
import inspect
import json
from logging import getLogger
from typing import Annotated, Any, Callable, ForwardRef, Optional, TypeVar, Union

from packaging.version import parse
from pydantic import BaseModel, Field, TypeAdapter
from pydantic import __version__ as pydantic_version
from pydantic.json_schema import JsonSchemaValue
from typing_extensions import Literal, get_args, get_origin

from ..doc_utils import export_module
from .dependency_injection import Field as AG2Field

if parse(pydantic_version) < parse("2.10.2"):
    from pydantic._internal._typing_extra import eval_type_lenient as try_eval_type
else:
    from pydantic._internal._typing_extra import try_eval_type


__all__ = ["get_function_schema", "load_basemodels_if_needed", "serialize_to_str"]

logger = getLogger(__name__)

T = TypeVar("T")


def get_typed_annotation(annotation: Any, globalns: dict[str, Any]) -> Any:
    """Get the type annotation of a parameter.

    Args:
        annotation: The annotation of the parameter
        globalns: The global namespace of the function

    Returns:
        The type annotation of the parameter
    """
    if isinstance(annotation, AG2Field):
        annotation = annotation.description
    if isinstance(annotation, str):
        annotation = ForwardRef(annotation)
        annotation, _ = try_eval_type(annotation, globalns, globalns)
    return annotation


def get_typed_signature(call: Callable[..., Any]) -> inspect.Signature:
    """Get the signature of a function with type annotations.

    Args:
        call: The function to get the signature for

    Returns:
        The signature of the function with type annotations
    """
    signature = inspect.signature(call)
    globalns = getattr(call, "__globals__", {})
    typed_params = [
        inspect.Parameter(
            name=param.name,
            kind=param.kind,
            default=param.default,
            annotation=get_typed_annotation(param.annotation, globalns),
        )
        for param in signature.parameters.values()
    ]
    typed_signature = inspect.Signature(typed_params)
    return typed_signature


def get_typed_return_annotation(call: Callable[..., Any]) -> Any:
    """Get the return annotation of a function.

    Args:
        call: The function to get the return annotation for

    Returns:
        The return annotation of the function
    """
    signature = inspect.signature(call)
    annotation = signature.return_annotation

    if annotation is inspect.Signature.empty:
        return None

    globalns = getattr(call, "__globals__", {})
    return get_typed_annotation(annotation, globalns)


def get_param_annotations(typed_signature: inspect.Signature) -> dict[str, Union[Annotated[type[Any], str], type[Any]]]:
    """Get the type annotations of the parameters of a function

    Args:
        typed_signature: The signature of the function with type annotations

    Returns:
        A dictionary of the type annotations of the parameters of the function
    """
    return {
        k: v.annotation for k, v in typed_signature.parameters.items() if v.annotation is not inspect.Signature.empty
    }


class Parameters(BaseModel):
    """Parameters of a function as defined by the OpenAI API"""

    type: Literal["object"] = "object"
    properties: dict[str, JsonSchemaValue]
    required: list[str]


class Function(BaseModel):
    """A function as defined by the OpenAI API"""

    description: Annotated[str, Field(description="Description of the function")]
    name: Annotated[str, Field(description="Name of the function")]
    parameters: Annotated[Parameters, Field(description="Parameters of the function")]


class ToolFunction(BaseModel):
    """A function under tool as defined by the OpenAI API."""

    type: Literal["function"] = "function"
    function: Annotated[Function, Field(description="Function under tool")]


def get_parameter_json_schema(k: str, v: Any, default_values: dict[str, Any]) -> JsonSchemaValue:
    """Get a JSON schema for a parameter as defined by the OpenAI API

    Args:
        k: The name of the parameter
        v: The type of the parameter
        default_values: The default values of the parameters of the function

    Returns:
        A Pydanitc model for the parameter
    """

    def type2description(k: str, v: Union[Annotated[type[Any], str], type[Any]]) -> str:
        if not hasattr(v, "__metadata__"):
            return k

        # handles Annotated
        retval = v.__metadata__[0]
        if isinstance(retval, AG2Field):
            return retval.description  # type: ignore[return-value]
        else:
            raise ValueError(f"Invalid {retval} for parameter {k}, should be a DescriptionField, got {type(retval)}")

    schema = TypeAdapter(v).json_schema()
    if k in default_values:
        dv = default_values[k]
        schema["default"] = dv

    schema["description"] = type2description(k, v)

    return schema


def get_required_params(typed_signature: inspect.Signature) -> list[str]:
    """Get the required parameters of a function

    Args:
        typed_signature: The signature of the function as returned by inspect.signature

    Returns:
        A list of the required parameters of the function
    """
    return [k for k, v in typed_signature.parameters.items() if v.default == inspect.Signature.empty]


def get_default_values(typed_signature: inspect.Signature) -> dict[str, Any]:
    """Get default values of parameters of a function

    Args:
        typed_signature: The signature of the function as returned by inspect.signature

    Returns:
        A dictionary of the default values of the parameters of the function
    """
    return {k: v.default for k, v in typed_signature.parameters.items() if v.default != inspect.Signature.empty}


def get_parameters(
    required: list[str],
    param_annotations: dict[str, Union[Annotated[type[Any], str], type[Any]]],
    default_values: dict[str, Any],
) -> Parameters:
    """Get the parameters of a function as defined by the OpenAI API

    Args:
        required: The required parameters of the function
        param_annotations: The type annotations of the parameters of the function
        default_values: The default values of the parameters of the function

    Returns:
        A Pydantic model for the parameters of the function
    """
    return Parameters(
        properties={
            k: get_parameter_json_schema(k, v, default_values)
            for k, v in param_annotations.items()
            if v is not inspect.Signature.empty
        },
        required=required,
    )


def get_missing_annotations(typed_signature: inspect.Signature, required: list[str]) -> tuple[set[str], set[str]]:
    """Get the missing annotations of a function

    Ignores the parameters with default values as they are not required to be annotated, but logs a warning.

    Args:
        typed_signature: The signature of the function with type annotations
        required: The required parameters of the function

    Returns:
        A set of the missing annotations of the function
    """
    all_missing = {k for k, v in typed_signature.parameters.items() if v.annotation is inspect.Signature.empty}
    missing = all_missing.intersection(set(required))
    unannotated_with_default = all_missing.difference(missing)
    return missing, unannotated_with_default


@export_module("autogen.tools")
def get_function_schema(f: Callable[..., Any], *, name: Optional[str] = None, description: str) -> dict[str, Any]:
    """Get a JSON schema for a function as defined by the OpenAI API

    Args:
        f: The function to get the JSON schema for
        name: The name of the function
        description: The description of the function

    Returns:
        A JSON schema for the function

    Raises:
        TypeError: If the function is not annotated

    Examples:
    ```python
    def f(a: Annotated[str, "Parameter a"], b: int = 2, c: Annotated[float, "Parameter c"] = 0.1) -> None:
        pass


    get_function_schema(f, description="function f")

    #   {'type': 'function',
    #    'function': {'description': 'function f',
    #        'name': 'f',
    #        'parameters': {'type': 'object',
    #           'properties': {'a': {'type': 'str', 'description': 'Parameter a'},
    #               'b': {'type': 'int', 'description': 'b'},
    #               'c': {'type': 'float', 'description': 'Parameter c'}},
    #           'required': ['a']}}}
    ```

    """
    typed_signature = get_typed_signature(f)
    required = get_required_params(typed_signature)
    default_values = get_default_values(typed_signature)
    param_annotations = get_param_annotations(typed_signature)
    return_annotation = get_typed_return_annotation(f)
    missing, unannotated_with_default = get_missing_annotations(typed_signature, required)

    if return_annotation is None:
        logger.warning(
            f"The return type of the function '{f.__name__}' is not annotated. Although annotating it is "
            + "optional, the function should return either a string, a subclass of 'pydantic.BaseModel'."
        )

    if unannotated_with_default != set():
        unannotated_with_default_s = [f"'{k}'" for k in sorted(unannotated_with_default)]
        logger.warning(
            f"The following parameters of the function '{f.__name__}' with default values are not annotated: "
            + f"{', '.join(unannotated_with_default_s)}."
        )

    if missing != set():
        missing_s = [f"'{k}'" for k in sorted(missing)]
        raise TypeError(
            f"All parameters of the function '{f.__name__}' without default values must be annotated. "
            + f"The annotations are missing for the following parameters: {', '.join(missing_s)}"
        )

    fname = name if name else f.__name__

    parameters = get_parameters(required, param_annotations, default_values=default_values)

    function = ToolFunction(
        function=Function(
            description=description,
            name=fname,
            parameters=parameters,
        )
    )

    return function.model_dump()


def get_load_param_if_needed_function(t: Any) -> Optional[Callable[[dict[str, Any], type[BaseModel]], BaseModel]]:
    """Get a function to load a parameter if it is a Pydantic model

    Args:
        t: The type annotation of the parameter

    Returns:
        A function to load the parameter if it is a Pydantic model, otherwise None

    """
    origin = get_origin(t)

    if origin is Annotated:
        args = get_args(t)
        if args:
            return get_load_param_if_needed_function(args[0])
        else:
            # Invalid Annotated usage
            return None

    # Handle generic types (list[str], dict[str,Any], Union[...], etc.) or where t is not a type at all
    # This means it's not a BaseModel subclass
    if origin is not None or not isinstance(t, type):
        return None

    def load_base_model(v: dict[str, Any], model_type: type[BaseModel]) -> BaseModel:
        return model_type(**v)

    # Check if it's a class and a subclass of BaseModel
    if issubclass(t, BaseModel):
        return load_base_model
    else:
        return None


@export_module("autogen.tools")
def load_basemodels_if_needed(func: Callable[..., Any]) -> Callable[..., Any]:
    """A decorator to load the parameters of a function if they are Pydantic models

    Args:
        func: The function with annotated parameters

    Returns:
        A function that loads the parameters before calling the original function

    """
    # get the type annotations of the parameters
    typed_signature = get_typed_signature(func)
    param_annotations = get_param_annotations(typed_signature)

    # get functions for loading BaseModels when needed based on the type annotations
    kwargs_mapping_with_nones = {k: get_load_param_if_needed_function(t) for k, t in param_annotations.items()}

    # remove the None values
    kwargs_mapping = {k: f for k, f in kwargs_mapping_with_nones.items() if f is not None}

    # a function that loads the parameters before calling the original function
    @functools.wraps(func)
    def _load_parameters_if_needed(*args: Any, **kwargs: Any) -> Any:
        # load the BaseModels if needed
        for k, f in kwargs_mapping.items():
            kwargs[k] = f(kwargs[k], param_annotations[k])

        # call the original function
        return func(*args, **kwargs)

    @functools.wraps(func)
    async def _a_load_parameters_if_needed(*args: Any, **kwargs: Any) -> Any:
        # load the BaseModels if needed
        for k, f in kwargs_mapping.items():
            kwargs[k] = f(kwargs[k], param_annotations[k])

        # call the original function
        return await func(*args, **kwargs)

    if inspect.iscoroutinefunction(func):
        return _a_load_parameters_if_needed
    else:
        return _load_parameters_if_needed


class _SerializableResult(BaseModel):
    result: Any


@export_module("autogen.tools")
def serialize_to_str(x: Any) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, BaseModel):
        return x.model_dump_json()

    retval_model = _SerializableResult(result=x)
    try:
        return str(retval_model.model_dump()["result"])
    except Exception:
        pass

    # try json.dumps() and then just return str(x) if that fails too
    try:
        return json.dumps(x, ensure_ascii=False)
    except Exception:
        return str(x)
