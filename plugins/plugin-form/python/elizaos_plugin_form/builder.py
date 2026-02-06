"""
Fluent builder API for defining forms and controls.

Shorthand exports:
- ``Form`` = ``FormBuilder``
- ``C`` = ``ControlBuilder``

Example::

    form = Form.create('contact') \\
        .name('Contact Form') \\
        .control(C.email('email').required()) \\
        .control(C.text('message').required()) \\
        .build()
"""

from __future__ import annotations

import re
from typing import Union

from .types import (
    FormControl,
    FormControlDependency,
    FormControlFileOptions,
    FormControlI18n,
    FormControlOption,
    FormControlUI,
    FormDefinition,
    FormDefinitionHooks,
    FormDefinitionNudge,
    FormDefinitionTTL,
    FormDefinitionUX,
    JsonValue,
)


def _prettify(key: str) -> str:
    spaced = re.sub(r"[-_]", " ", key)
    return re.sub(r"\b\w", lambda m: m.group().upper(), spaced)


# ============================================================================
# CONTROL BUILDER
# ============================================================================


class ControlBuilder:
    """Fluent builder for :class:`FormControl`."""

    def __init__(self, key: str) -> None:
        self._key = key
        self._type: str | None = None
        self._label: str | None = None
        self._required: bool | None = None
        self._multiple: bool | None = None
        self._readonly: bool | None = None
        self._hidden: bool | None = None
        self._sensitive: bool | None = None
        self._dbbind: str | None = None
        self._pattern: str | None = None
        self._min: float | None = None
        self._max: float | None = None
        self._min_length: int | None = None
        self._max_length: int | None = None
        self._enum: list[str] | None = None
        self._options: list[FormControlOption] | None = None
        self._file: FormControlFileOptions | None = None
        self._default_value: JsonValue = None
        self._depends_on: FormControlDependency | None = None
        self._roles: list[str] | None = None
        self._description: str | None = None
        self._ask_prompt: str | None = None
        self._extract_hints: list[str] | None = None
        self._confirm_threshold: float | None = None
        self._example: str | None = None
        self._ui: FormControlUI | None = None
        self._i18n: dict[str, FormControlI18n] | None = None
        self._meta: dict[str, JsonValue] | None = None
        self._fields: list[FormControl] | None = None

    # ═══ STATIC FACTORIES ═══

    @staticmethod
    def field(key: str) -> ControlBuilder:
        return ControlBuilder(key)

    @staticmethod
    def text(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "text"
        return b

    @staticmethod
    def email(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "email"
        return b

    @staticmethod
    def number(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "number"
        return b

    @staticmethod
    def boolean_(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "boolean"
        return b

    @staticmethod
    def select(key: str, options: list[FormControlOption] | None = None) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "select"
        if options:
            b._options = options
        return b

    @staticmethod
    def date(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "date"
        return b

    @staticmethod
    def file(key: str) -> ControlBuilder:
        b = ControlBuilder(key)
        b._type = "file"
        return b

    # ═══ TYPE ═══

    def type(self, type_name: str) -> ControlBuilder:
        self._type = type_name
        return self

    # ═══ BEHAVIOR ═══

    def required(self) -> ControlBuilder:
        self._required = True
        return self

    def optional(self) -> ControlBuilder:
        self._required = False
        return self

    def hidden(self) -> ControlBuilder:
        self._hidden = True
        return self

    def sensitive(self) -> ControlBuilder:
        self._sensitive = True
        return self

    def readonly(self) -> ControlBuilder:
        self._readonly = True
        return self

    def multiple(self) -> ControlBuilder:
        self._multiple = True
        return self

    # ═══ VALIDATION ═══

    def pattern(self, regex: str) -> ControlBuilder:
        self._pattern = regex
        return self

    def min(self, n: float) -> ControlBuilder:
        self._min = n
        return self

    def max(self, n: float) -> ControlBuilder:
        self._max = n
        return self

    def min_length(self, n: int) -> ControlBuilder:
        self._min_length = n
        return self

    def max_length(self, n: int) -> ControlBuilder:
        self._max_length = n
        return self

    def enum(self, values: list[str]) -> ControlBuilder:
        self._enum = values
        return self

    # ═══ AGENT HINTS ═══

    def label(self, lbl: str) -> ControlBuilder:
        self._label = lbl
        return self

    def ask(self, prompt: str) -> ControlBuilder:
        self._ask_prompt = prompt
        return self

    def description(self, desc: str) -> ControlBuilder:
        self._description = desc
        return self

    def hint(self, *hints: str) -> ControlBuilder:
        self._extract_hints = list(hints)
        return self

    def example(self, value: str) -> ControlBuilder:
        self._example = value
        return self

    def confirm_threshold(self, n: float) -> ControlBuilder:
        self._confirm_threshold = n
        return self

    # ═══ FILE OPTIONS ═══

    def accept(self, mime_types: list[str]) -> ControlBuilder:
        if self._file is None:
            self._file = FormControlFileOptions()
        self._file.accept = mime_types
        return self

    def max_size(self, num_bytes: int) -> ControlBuilder:
        if self._file is None:
            self._file = FormControlFileOptions()
        self._file.max_size = num_bytes
        return self

    def max_files(self, n: int) -> ControlBuilder:
        if self._file is None:
            self._file = FormControlFileOptions()
        self._file.max_files = n
        return self

    # ═══ ACCESS ═══

    def roles(self, *role_names: str) -> ControlBuilder:
        self._roles = list(role_names)
        return self

    def default(self, value: JsonValue) -> ControlBuilder:
        self._default_value = value
        return self

    def depends_on(
        self,
        field_key: str,
        condition: str = "exists",
        value: JsonValue = None,
    ) -> ControlBuilder:
        self._depends_on = FormControlDependency(field=field_key, condition=condition, value=value)  # type: ignore[arg-type]
        return self

    def dbbind(self, column_name: str) -> ControlBuilder:
        self._dbbind = column_name
        return self

    # ═══ UI ═══

    def section(self, name: str) -> ControlBuilder:
        if self._ui is None:
            self._ui = FormControlUI()
        self._ui.section = name
        return self

    def order(self, n: int) -> ControlBuilder:
        if self._ui is None:
            self._ui = FormControlUI()
        self._ui.order = n
        return self

    def placeholder(self, text: str) -> ControlBuilder:
        if self._ui is None:
            self._ui = FormControlUI()
        self._ui.placeholder = text
        return self

    def help_text(self, text: str) -> ControlBuilder:
        if self._ui is None:
            self._ui = FormControlUI()
        self._ui.help_text = text
        return self

    def widget(self, widget_type: str) -> ControlBuilder:
        if self._ui is None:
            self._ui = FormControlUI()
        self._ui.widget = widget_type
        return self

    # ═══ I18N ═══

    def i18n(
        self,
        locale: str,
        translations: dict[str, str | None],
    ) -> ControlBuilder:
        if self._i18n is None:
            self._i18n = {}
        self._i18n[locale] = FormControlI18n(
            label=translations.get("label"),
            description=translations.get("description"),
            ask_prompt=translations.get("ask_prompt"),
            help_text=translations.get("help_text"),
        )
        return self

    # ═══ META ═══

    def meta(self, key: str, value: JsonValue) -> ControlBuilder:
        if self._meta is None:
            self._meta = {}
        self._meta[key] = value
        return self

    # ═══ BUILD ═══

    def build(self) -> FormControl:
        """Build the final ``FormControl``."""
        return FormControl(
            key=self._key,
            label=self._label or _prettify(self._key),
            type=self._type or "text",
            required=self._required or False,
            multiple=self._multiple or False,
            readonly=self._readonly or False,
            hidden=self._hidden or False,
            sensitive=self._sensitive or False,
            dbbind=self._dbbind,
            pattern=self._pattern,
            min=self._min,
            max=self._max,
            min_length=self._min_length,
            max_length=self._max_length,
            enum=self._enum,
            options=self._options,
            file=self._file,
            default_value=self._default_value,
            depends_on=self._depends_on,
            roles=self._roles,
            description=self._description,
            ask_prompt=self._ask_prompt,
            extract_hints=self._extract_hints,
            confirm_threshold=self._confirm_threshold,
            example=self._example,
            ui=self._ui,
            i18n=self._i18n,
            meta=self._meta,
            fields=self._fields,
        )


# ============================================================================
# FORM BUILDER
# ============================================================================


class FormBuilder:
    """Fluent builder for :class:`FormDefinition`."""

    def __init__(self, form_id: str) -> None:
        self._id = form_id
        self._name: str | None = None
        self._description: str | None = None
        self._version: int | None = None
        self._controls: list[FormControl] = []
        self._roles: list[str] | None = None
        self._allow_multiple: bool = False
        self._ux: FormDefinitionUX | None = None
        self._ttl_cfg: FormDefinitionTTL | None = None
        self._nudge_cfg: FormDefinitionNudge | None = None
        self._hooks: FormDefinitionHooks | None = None
        self._debug: bool = False
        self._i18n: dict[str, dict[str, str | None]] | None = None
        self._meta: dict[str, JsonValue] | None = None

    # ═══ STATIC FACTORY ═══

    @staticmethod
    def create(form_id: str) -> FormBuilder:
        return FormBuilder(form_id)

    # ═══ METADATA ═══

    def name(self, name: str) -> FormBuilder:
        self._name = name
        return self

    def description(self, desc: str) -> FormBuilder:
        self._description = desc
        return self

    def version(self, v: int) -> FormBuilder:
        self._version = v
        return self

    # ═══ CONTROLS ═══

    def control(self, builder: Union[ControlBuilder, FormControl]) -> FormBuilder:
        ctrl = builder.build() if isinstance(builder, ControlBuilder) else builder
        self._controls.append(ctrl)
        return self

    def controls(self, *builders: Union[ControlBuilder, FormControl]) -> FormBuilder:
        for b in builders:
            self.control(b)
        return self

    def required(self, *keys: str) -> FormBuilder:
        for key in keys:
            self.control(ControlBuilder.field(key).required())
        return self

    def optional(self, *keys: str) -> FormBuilder:
        for key in keys:
            self.control(ControlBuilder.field(key))
        return self

    # ═══ PERMISSIONS ═══

    def roles(self, *role_names: str) -> FormBuilder:
        self._roles = list(role_names)
        return self

    def allow_multiple(self) -> FormBuilder:
        self._allow_multiple = True
        return self

    # ═══ UX ═══

    def no_undo(self) -> FormBuilder:
        if self._ux is None:
            self._ux = FormDefinitionUX()
        self._ux.allow_undo = False
        return self

    def no_skip(self) -> FormBuilder:
        if self._ux is None:
            self._ux = FormDefinitionUX()
        self._ux.allow_skip = False
        return self

    def no_autofill(self) -> FormBuilder:
        if self._ux is None:
            self._ux = FormDefinitionUX()
        self._ux.allow_autofill = False
        return self

    def max_undo_steps(self, n: int) -> FormBuilder:
        if self._ux is None:
            self._ux = FormDefinitionUX()
        self._ux.max_undo_steps = n
        return self

    # ═══ TTL ═══

    def ttl(
        self,
        min_days: int | None = None,
        max_days: int | None = None,
        effort_multiplier: float | None = None,
    ) -> FormBuilder:
        if self._ttl_cfg is None:
            self._ttl_cfg = FormDefinitionTTL()
        if min_days is not None:
            self._ttl_cfg.min_days = min_days
        if max_days is not None:
            self._ttl_cfg.max_days = max_days
        if effort_multiplier is not None:
            self._ttl_cfg.effort_multiplier = effort_multiplier
        return self

    # ═══ NUDGE ═══

    def no_nudge(self) -> FormBuilder:
        if self._nudge_cfg is None:
            self._nudge_cfg = FormDefinitionNudge()
        self._nudge_cfg.enabled = False
        return self

    def nudge_after(self, hours: int) -> FormBuilder:
        if self._nudge_cfg is None:
            self._nudge_cfg = FormDefinitionNudge()
        self._nudge_cfg.after_inactive_hours = hours
        return self

    def nudge_message(self, message: str) -> FormBuilder:
        if self._nudge_cfg is None:
            self._nudge_cfg = FormDefinitionNudge()
        self._nudge_cfg.message = message
        return self

    # ═══ HOOKS ═══

    def on_start(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_start = worker_name
        return self

    def on_field_change(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_field_change = worker_name
        return self

    def on_ready(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_ready = worker_name
        return self

    def on_submit(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_submit = worker_name
        return self

    def on_cancel(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_cancel = worker_name
        return self

    def on_expire(self, worker_name: str) -> FormBuilder:
        if self._hooks is None:
            self._hooks = FormDefinitionHooks()
        self._hooks.on_expire = worker_name
        return self

    # ═══ DEBUG ═══

    def debug(self) -> FormBuilder:
        self._debug = True
        return self

    # ═══ I18N ═══

    def i18n(self, locale: str, translations: dict[str, str | None]) -> FormBuilder:
        if self._i18n is None:
            self._i18n = {}
        self._i18n[locale] = translations
        return self

    # ═══ META ═══

    def meta(self, key: str, value: JsonValue) -> FormBuilder:
        if self._meta is None:
            self._meta = {}
        self._meta[key] = value
        return self

    # ═══ BUILD ═══

    def build(self) -> FormDefinition:
        """Build the final ``FormDefinition``."""
        from .types import FormDefinitionI18n as _FI18n

        i18n_map: dict[str, _FI18n] | None = None
        if self._i18n:
            i18n_map = {
                loc: _FI18n(name=vals.get("name"), description=vals.get("description"))
                for loc, vals in self._i18n.items()
            }

        return FormDefinition(
            id=self._id,
            name=self._name or _prettify(self._id),
            controls=self._controls,
            description=self._description,
            version=self._version or 1,
            status="active",
            roles=self._roles,
            allow_multiple=self._allow_multiple,
            ux=self._ux,
            ttl=self._ttl_cfg,
            nudge=self._nudge_cfg,
            hooks=self._hooks,
            debug=self._debug,
            i18n=i18n_map,
            meta=self._meta,
        )


# ============================================================================
# SHORTHAND EXPORTS
# ============================================================================

Form = FormBuilder
"""Alias for :class:`FormBuilder`."""

C = ControlBuilder
"""Alias for :class:`ControlBuilder`."""
