from __future__ import annotations
"""actions.py  ▸  Unified Action primitives with helper registry
-------------------------------------------------------------------
This module defines *declarative* GUI/OS operations as tiny dataclasses
("Actions").  An **Action** describes *what* should be done — **not** *how* it
is executed.  Concrete back‑ends (PyAutoGUI, ADB, cloud device API …) are free
to translate the intent into platform‑specific commands.

Key features
============
1. **Registry‑based reflection** – Every Action subclass registers itself in
   `Action._registry` at import‑time.
2. **(De)serialisation** – Each Action can be converted to / from a plain
   `dict` (JSON‑safe) via `to_dict()` / `from_dict()`.
3. **Type safety & docs** – `dataclass`+`Enum` give IDE hints & runtime checks.

Typical workflow
----------------
```python
>>> from actions import click, drag, action
>>> a1 = click(x = 200, y = 300)
>>> payload = a1.to_dict()          # ➜ {"type": "click", "x": 200, "y": 300], ...}
>>> a2 = Action.from_dict(payload)  # ➜ click(x=200, y=300, ...)
>>> assert a1 == a2
```
The registry makes the last line work without an if‑else chain.
"""

from abc import ABC
from dataclasses import dataclass, field, fields, asdict
from enum import Enum, auto
from typing import Any, Dict, List, Tuple, Type, TypeVar, ClassVar

__all__ = [
    "Action",
    # concrete actions ↓
    "Click",
    "DoubleClick",
    "Move",
    "Scroll",
    "Drag",
    "TypeText",
    "Hotkey",
    "Wait",
    "Done",
    "Failed",
    "Screenshot",
    "Memorize",
    "SetCellValues",
    "SwitchApplications",
    "Open",
]

T_Action = TypeVar("T_Action", bound="Action")


# ---------------------------------------------------------------------------
#  Action base‑class with helper registry
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Action(ABC):
    """Abstract base for every declarative GUI operation."""

    # Global registry  {"Click": Click, ...}
    _registry: ClassVar[Dict[str, Type["Action"]]] = {}

    # ---------------------------------------------------------------------
    #  Reflection helpers
    # ---------------------------------------------------------------------
    def __init_subclass__(cls, **kwargs):  # noqa: D401 (docstring from base)
        # super().__init_subclass__(**kwargs)
        Action._registry[cls.__name__] = cls

    # ------------------------------------------------------------------
    #  (de)serialisation utilities
    # ------------------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        """Return a JSON‑serialisable dict with a "type" discriminator."""
        data = {"type": self.__class__.__name__}
        for f in fields(self):
            val = getattr(self, f.name)
            data[f.name] = _enum_to_name(val)
        return data

    @classmethod
    def from_dict(cls: Type[T_Action],
                  data: Dict[str, Any]) -> T_Action:  # noqa: N802 (cls)
        if "type" not in data:
            raise ValueError("Missing 'type' key in action dict")
        typ = data["type"]
        if typ not in cls._registry:
            raise ValueError(
                f"Unknown action type '{typ}' (registry size={len(cls._registry)})"
            )
        target_cls = cls._registry[typ]

        # Convert strings back to Enum instances where needed
        kwargs = {}
        for f in fields(target_cls):
            raw = data.get(f.name)
            kwargs[f.name] = _name_to_enum(f.type, raw)
        return target_cls(**kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
#  Helper functions for Enum <-> str
# ---------------------------------------------------------------------------


def _enum_to_name(val: Any) -> Any:
    if isinstance(val, Enum):
        return val.name
    if isinstance(val, tuple):
        return list(val)  # json‑friendly
    if isinstance(val, list):
        return [_enum_to_name(v) for v in val]
    return val


def _name_to_enum(expected_type: Any, raw: Any) -> Any:
    """Convert *raw* back to Enum or original type depending on *expected_type*."""
    origin = getattr(expected_type, "__origin__", None)
    if origin is list:
        sub_type = expected_type.__args__[0]
        return [_name_to_enum(sub_type, r) for r in raw] if isinstance(
            raw, list) else raw

    if isinstance(expected_type, type) and issubclass(expected_type, Enum):
        return expected_type[raw] if isinstance(raw, str) else raw
    # Fallback – pass through unchanged
    return raw


# ---------------------------------------------------------------------------
#  Concrete Action subclasses
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Click(Action):
    x: int
    y: int
    element_description: str
    button: int = 0
    holdKey: List[str] = field(default_factory=list)


@dataclass(slots=True)
class DoubleClick(Action):
    x: int
    y: int
    element_description: str
    button: int = 0
    holdKey: List[str] = field(default_factory=list)


@dataclass(slots=True)
class Move(Action):
    x: int
    y: int
    element_description: str
    holdKey: List[str] = field(default_factory=list)


@dataclass(slots=True)
class Scroll(Action):
    x: int
    y: int
    element_description: str
    stepVertical: int | None = None
    stepHorizontal: int | None = None
    holdKey: List[str] = field(default_factory=list)


# TODO Drag是否需要区分左中右键
@dataclass(slots=True)
class Drag(Action):
    startX: int
    startY: int
    endX: int
    endY: int
    holdKey: List[str]
    starting_description: str
    ending_description: str


@dataclass(slots=True)
class TypeText(Action):
    text: str
    x: int | None = None
    y: int | None = None
    element_description: str | None = None
    overwrite: bool = False
    enter: bool = False


@dataclass(slots=True)
class Hotkey(Action):
    keys: List[str]
    duration: int | None = None


@dataclass(slots=True)
class Wait(Action):
    duration: int


@dataclass(slots=True)
class Done(Action):
    return_value: Any | None = None


@dataclass(slots=True)
class Failed(Action):
    message: str = ''


@dataclass(slots=True)
class Memorize(Action):
    information: str


@dataclass(slots=True)
class Screenshot(Action):
    pass


# New actions integrated from Agent-S s2.5 grounding
@dataclass(slots=True)
class SetCellValues(Action):
    cell_values: Dict[str, Any]
    app_name: str
    sheet_name: str


@dataclass(slots=True)
class SwitchApplications(Action):
    app_code: str


@dataclass(slots=True)
class Open(Action):
    app_or_filename: str
