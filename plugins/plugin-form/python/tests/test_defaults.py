"""Tests for the defaults module."""

from __future__ import annotations

import pytest

from elizaos_plugin_form.defaults import apply_control_defaults, apply_form_defaults, prettify


# ============================================================================
# PRETTIFY
# ============================================================================


class TestPrettify:
    def test_snake_case(self):
        assert prettify("first_name") == "First Name"

    def test_kebab_case(self):
        assert prettify("email-address") == "Email Address"

    def test_single_word(self):
        assert prettify("email") == "Email"

    def test_multiple_underscores(self):
        assert prettify("home_phone_number") == "Home Phone Number"

    def test_already_title_case(self):
        assert prettify("Email") == "Email"

    def test_empty_string(self):
        assert prettify("") == ""

    def test_mixed_separators(self):
        assert prettify("user_first-name") == "User First Name"


# ============================================================================
# APPLY CONTROL DEFAULTS
# ============================================================================


class TestApplyControlDefaults:
    def test_minimal_control(self):
        result = apply_control_defaults({"key": "email"})
        assert result["key"] == "email"
        assert result["label"] == "Email"
        assert result["type"] == "text"
        assert result["required"] is False
        assert result["confirm_threshold"] == 0.8

    def test_custom_label_preserved(self):
        result = apply_control_defaults({"key": "email", "label": "Your Email"})
        assert result["label"] == "Your Email"

    def test_custom_type_preserved(self):
        result = apply_control_defaults({"key": "email", "type": "email"})
        assert result["type"] == "email"

    def test_required_preserved(self):
        result = apply_control_defaults({"key": "name", "required": True})
        assert result["required"] is True

    def test_extra_fields_preserved(self):
        result = apply_control_defaults({
            "key": "age",
            "type": "number",
            "min": 0,
            "max": 150,
            "description": "Your age",
        })
        assert result["min"] == 0
        assert result["max"] == 150
        assert result["description"] == "Your age"

    def test_confirm_threshold_override(self):
        result = apply_control_defaults({"key": "k", "confirm_threshold": 0.95})
        assert result["confirm_threshold"] == 0.95


# ============================================================================
# APPLY FORM DEFAULTS
# ============================================================================


class TestApplyFormDefaults:
    def test_minimal_form(self):
        result = apply_form_defaults({"id": "contact"})
        assert result["id"] == "contact"
        assert result["name"] == "Contact"
        assert result["version"] == 1
        assert result["status"] == "active"
        assert result["debug"] is False
        # UX defaults
        ux = result["ux"]
        assert ux["allow_undo"] is True
        assert ux["allow_skip"] is True
        assert ux["max_undo_steps"] == 5
        # TTL defaults
        ttl = result["ttl"]
        assert ttl["min_days"] == 14
        assert ttl["max_days"] == 90
        assert ttl["effort_multiplier"] == 0.5
        # Nudge defaults
        nudge = result["nudge"]
        assert nudge["enabled"] is True
        assert nudge["after_inactive_hours"] == 48
        assert nudge["max_nudges"] == 3

    def test_custom_name_preserved(self):
        result = apply_form_defaults({"id": "contact", "name": "Contact Us"})
        assert result["name"] == "Contact Us"

    def test_custom_version_preserved(self):
        result = apply_form_defaults({"id": "contact", "version": 5})
        assert result["version"] == 5

    def test_controls_get_defaults(self):
        result = apply_form_defaults({
            "id": "form1",
            "controls": [{"key": "email"}],
        })
        controls = result["controls"]
        assert len(controls) == 1
        assert controls[0]["label"] == "Email"
        assert controls[0]["type"] == "text"

    def test_partial_ux_merged(self):
        result = apply_form_defaults({
            "id": "form1",
            "ux": {"allow_undo": False},
        })
        ux = result["ux"]
        assert ux["allow_undo"] is False
        assert ux["allow_skip"] is True  # default

    def test_partial_ttl_merged(self):
        result = apply_form_defaults({
            "id": "form1",
            "ttl": {"min_days": 7},
        })
        ttl = result["ttl"]
        assert ttl["min_days"] == 7
        assert ttl["max_days"] == 90  # default

    def test_partial_nudge_merged(self):
        result = apply_form_defaults({
            "id": "form1",
            "nudge": {"max_nudges": 5},
        })
        nudge = result["nudge"]
        assert nudge["max_nudges"] == 5
        assert nudge["enabled"] is True  # default

    def test_extra_fields_preserved(self):
        result = apply_form_defaults({
            "id": "form1",
            "description": "A test form",
            "roles": ["admin"],
        })
        assert result["description"] == "A test form"
        assert result["roles"] == ["admin"]
