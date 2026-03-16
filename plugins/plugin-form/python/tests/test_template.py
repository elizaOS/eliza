"""Tests for the template module."""

from __future__ import annotations

import pytest

from elizaos_plugin_form.template import (
    TEMPLATE_PATTERN,
    build_template_values,
    render_template,
    resolve_control_templates,
)
from elizaos_plugin_form.types import (
    FieldState,
    FormControl,
    FormControlOption,
    FormSession,
    SessionEffort,
)


def _session(
    fields: dict[str, FieldState] | None = None,
    context: dict[str, object] | None = None,
) -> FormSession:
    return FormSession(
        id="sess-1",
        form_id="form-1",
        fields=fields or {},
        context=context,
        effort=SessionEffort(),
    )


# ============================================================================
# BUILD TEMPLATE VALUES
# ============================================================================


class TestBuildTemplateValues:
    def test_string_value(self):
        session = _session(fields={"name": FieldState(value="Alice")})
        vals = build_template_values(session)
        assert vals["name"] == "Alice"

    def test_number_value(self):
        session = _session(fields={"age": FieldState(value=30)})
        vals = build_template_values(session)
        assert vals["age"] == "30"

    def test_boolean_value(self):
        session = _session(fields={"agree": FieldState(value=True)})
        vals = build_template_values(session)
        assert vals["agree"] == "True"

    def test_none_value_excluded(self):
        session = _session(fields={"empty": FieldState(value=None)})
        vals = build_template_values(session)
        assert "empty" not in vals

    def test_context_values(self):
        session = _session(context={"order_id": "ORD-123"})
        vals = build_template_values(session)
        assert vals["order_id"] == "ORD-123"

    def test_context_number(self):
        session = _session(context={"qty": 5})
        vals = build_template_values(session)
        assert vals["qty"] == "5"

    def test_context_overrides_not_applied(self):
        """Both sources contribute independently."""
        session = _session(
            fields={"email": FieldState(value="a@b.com")},
            context={"ref": "REF-1"},
        )
        vals = build_template_values(session)
        assert vals["email"] == "a@b.com"
        assert vals["ref"] == "REF-1"


# ============================================================================
# RENDER TEMPLATE
# ============================================================================


class TestRenderTemplate:
    def test_simple_substitution(self):
        result = render_template("Hello {{ name }}!", {"name": "Alice"})
        assert result == "Hello Alice!"

    def test_multiple_substitutions(self):
        result = render_template(
            "{{ greeting }}, {{ name }}!",
            {"greeting": "Hi", "name": "Bob"},
        )
        assert result == "Hi, Bob!"

    def test_missing_key_left_in_place(self):
        result = render_template("Hello {{ unknown }}!", {})
        assert result == "Hello {{ unknown }}!"

    def test_none_template(self):
        assert render_template(None, {"key": "val"}) is None

    def test_no_placeholders(self):
        result = render_template("Just text", {"key": "val"})
        assert result == "Just text"

    def test_whitespace_variants(self):
        result = render_template("{{name}} and {{ name }} and {{  name  }}", {"name": "A"})
        assert result == "A and A and A"

    def test_dotted_keys(self):
        result = render_template("{{ user.name }}", {"user.name": "Alice"})
        assert result == "Alice"


# ============================================================================
# RESOLVE CONTROL TEMPLATES
# ============================================================================


class TestResolveControlTemplates:
    def test_label_resolved(self):
        ctrl = FormControl(key="greeting", label="Hello {{ name }}")
        result = resolve_control_templates(ctrl, {"name": "Alice"})
        assert result.label == "Hello Alice"

    def test_description_resolved(self):
        ctrl = FormControl(key="k", label="L", description="For {{ purpose }}")
        result = resolve_control_templates(ctrl, {"purpose": "testing"})
        assert result.description == "For testing"

    def test_ask_prompt_resolved(self):
        ctrl = FormControl(key="k", label="L", ask_prompt="What is your {{ field }}?")
        result = resolve_control_templates(ctrl, {"field": "email"})
        assert result.ask_prompt == "What is your email?"

    def test_example_resolved(self):
        ctrl = FormControl(key="k", label="L", example="{{ sample }}")
        result = resolve_control_templates(ctrl, {"sample": "test@example.com"})
        assert result.example == "test@example.com"

    def test_extract_hints_resolved(self):
        ctrl = FormControl(key="k", label="L", extract_hints=["{{ hint1 }}", "static"])
        result = resolve_control_templates(ctrl, {"hint1": "dynamic"})
        assert result.extract_hints == ["dynamic", "static"]

    def test_options_resolved(self):
        ctrl = FormControl(
            key="k",
            label="L",
            options=[
                FormControlOption(value="v1", label="{{ opt_label }}", description="{{ opt_desc }}"),
            ],
        )
        result = resolve_control_templates(ctrl, {"opt_label": "Option 1", "opt_desc": "Desc 1"})
        assert result.options is not None
        assert result.options[0].label == "Option 1"
        assert result.options[0].description == "Desc 1"

    def test_nested_fields_resolved(self):
        child = FormControl(key="child", label="{{ child_label }}")
        parent = FormControl(key="parent", label="Parent", fields=[child])
        result = resolve_control_templates(parent, {"child_label": "Child Label"})
        assert result.fields is not None
        assert result.fields[0].label == "Child Label"

    def test_original_preserved_on_no_match(self):
        ctrl = FormControl(key="k", label="No templates here")
        result = resolve_control_templates(ctrl, {"unused": "val"})
        assert result.label == "No templates here"

    def test_key_and_type_unchanged(self):
        ctrl = FormControl(key="mykey", label="L", type="email")
        result = resolve_control_templates(ctrl, {"mykey": "ignored"})
        assert result.key == "mykey"
        assert result.type == "email"
