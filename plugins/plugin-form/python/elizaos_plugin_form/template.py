"""
Simple template resolution for form-controlled prompts.

Templates use ``{{ variable }}`` syntax (Mustache-like).
"""

from __future__ import annotations

import re
from copy import deepcopy

from .types import FormControl, FormSession

TEMPLATE_PATTERN = r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}"

_COMPILED_PATTERN = re.compile(TEMPLATE_PATTERN)


def build_template_values(session: FormSession) -> dict[str, str]:
    """Build a values dict from session fields and context."""
    values: dict[str, str] = {}

    for key, state in session.fields.items():
        val = state.value
        if isinstance(val, str):
            values[key] = val
        elif isinstance(val, (int, float, bool)):
            values[key] = str(val)

    if session.context and isinstance(session.context, dict):
        for key, val in session.context.items():
            if isinstance(val, str):
                values[key] = val
            elif isinstance(val, (int, float, bool)):
                values[key] = str(val)

    return values


def render_template(
    template: str | None,
    values: dict[str, str],
) -> str | None:
    """Render a template string, substituting ``{{ key }}`` placeholders.

    Returns ``None`` if *template* is ``None``.  Unresolved placeholders
    are left in place.
    """
    if template is None:
        return None

    def _replacer(m: re.Match[str]) -> str:
        key = m.group(1)
        replacement = values.get(key)
        return replacement if replacement is not None else m.group(0)

    return _COMPILED_PATTERN.sub(_replacer, template)


def resolve_control_templates(
    control: FormControl,
    values: dict[str, str],
) -> FormControl:
    """Return a *new* ``FormControl`` with templates resolved."""
    # Resolve simple string fields
    new_label = render_template(control.label, values) or control.label
    new_description = render_template(control.description, values)
    new_ask_prompt = render_template(control.ask_prompt, values)
    new_example = render_template(control.example, values)

    # Resolve extract hints
    new_hints: list[str] | None = None
    if control.extract_hints:
        new_hints = [render_template(h, values) or h for h in control.extract_hints]

    # Resolve options
    new_options = None
    if control.options:
        from .types import FormControlOption

        new_options = []
        for opt in control.options:
            new_options.append(
                FormControlOption(
                    value=opt.value,
                    label=render_template(opt.label, values) or opt.label,
                    description=render_template(opt.description, values),
                )
            )

    # Resolve nested fields
    new_fields = None
    if control.fields:
        new_fields = [resolve_control_templates(f, values) for f in control.fields]

    return FormControl(
        key=control.key,
        label=new_label,
        type=control.type,
        required=control.required,
        multiple=control.multiple,
        readonly=control.readonly,
        hidden=control.hidden,
        sensitive=control.sensitive,
        dbbind=control.dbbind,
        pattern=control.pattern,
        min=control.min,
        max=control.max,
        min_length=control.min_length,
        max_length=control.max_length,
        enum=control.enum,
        options=new_options if new_options is not None else control.options,
        file=control.file,
        default_value=control.default_value,
        depends_on=control.depends_on,
        roles=control.roles,
        description=new_description,
        ask_prompt=new_ask_prompt,
        extract_hints=new_hints if new_hints is not None else control.extract_hints,
        confirm_threshold=control.confirm_threshold,
        example=new_example,
        ui=control.ui,
        i18n=control.i18n,
        fields=new_fields if new_fields is not None else control.fields,
        meta=control.meta,
    )
