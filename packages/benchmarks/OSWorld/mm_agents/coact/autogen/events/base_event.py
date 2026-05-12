# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


from abc import ABC
from typing import Annotated, Any, Callable, Literal, Optional, Union
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, create_model

from ..doc_utils import export_module

__all__ = ["BaseEvent", "get_annotated_type_for_event_classes", "get_event_classes", "wrap_event"]


@export_module("autogen.events")
class BaseEvent(BaseModel, ABC):
    uuid: UUID

    def __init__(self, uuid: Optional[UUID] = None, **kwargs: Any) -> None:
        uuid = uuid or uuid4()
        super().__init__(uuid=uuid, **kwargs)

    def print(self, f: Optional[Callable[..., Any]] = None) -> None:
        """Print event

        Args:
            f (Optional[Callable[..., Any]], optional): Print function. If none, python's default print will be used.
        """
        ...


def camel2snake(name: str) -> str:
    return "".join(["_" + i.lower() if i.isupper() else i for i in name]).lstrip("_")


_event_classes: dict[str, type[BaseModel]] = {}


@export_module("autogen.events")
def wrap_event(event_cls: type[BaseEvent]) -> type[BaseModel]:
    """Wrap a event class with a type field to be used in a union type

    This is needed for proper serialization and deserialization of events in a union type.

    Args:
        event_cls (type[BaseEvent]): Event class to wrap
    """
    global _event_classes

    if not event_cls.__name__.endswith("Event"):
        raise ValueError("Event class name must end with 'Event'")

    type_name = camel2snake(event_cls.__name__)
    type_name = type_name[: -len("_event")]

    class WrapperBase(BaseModel):
        # these types are generated dynamically so we need to disable the type checker
        type: Literal[type_name] = type_name  # type: ignore[valid-type]
        content: event_cls  # type: ignore[valid-type]

        def __init__(self, *args: Any, **data: Any):
            if set(data.keys()) == {"type", "content"} and "content" in data:
                super().__init__(*args, **data)
            else:
                if "content" in data:
                    content = data.pop("content")
                    super().__init__(*args, content=event_cls(*args, **data, content=content), **data)
                else:
                    super().__init__(content=event_cls(*args, **data), **data)

        def print(self, f: Optional[Callable[..., Any]] = None) -> None:
            self.content.print(f)  # type: ignore[attr-defined]

    wrapper_cls = create_model(event_cls.__name__, __base__=WrapperBase)

    # Preserve the original class's docstring and other attributes
    wrapper_cls.__doc__ = event_cls.__doc__
    wrapper_cls.__module__ = event_cls.__module__

    # Copy any other relevant attributes/metadata from the original class
    if hasattr(event_cls, "__annotations__"):
        wrapper_cls.__annotations__ = event_cls.__annotations__

    _event_classes[type_name] = wrapper_cls

    return wrapper_cls


@export_module("autogen.events")
def get_annotated_type_for_event_classes() -> type[Any]:
    # this is a dynamic type so we need to disable the type checker
    union_type = Union[tuple(_event_classes.values())]  # type: ignore[valid-type]
    return Annotated[union_type, Field(discriminator="type")]  # type: ignore[return-value]


def get_event_classes() -> dict[str, type[BaseModel]]:
    return _event_classes
