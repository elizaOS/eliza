"""Tests for the builder module."""

from __future__ import annotations

import pytest

from elizaos_plugin_form.builder import C, ControlBuilder, Form, FormBuilder
from elizaos_plugin_form.types import FormControlOption


# ============================================================================
# CONTROL BUILDER – STATIC FACTORIES
# ============================================================================


class TestControlBuilderFactories:
    def test_text(self):
        ctrl = C.text("name").build()
        assert ctrl.key == "name"
        assert ctrl.type == "text"

    def test_email(self):
        ctrl = C.email("email").build()
        assert ctrl.type == "email"

    def test_number(self):
        ctrl = C.number("age").build()
        assert ctrl.type == "number"

    def test_boolean(self):
        ctrl = C.boolean_("agree").build()
        assert ctrl.type == "boolean"

    def test_select(self):
        opts = [FormControlOption(value="a", label="A")]
        ctrl = C.select("choice", opts).build()
        assert ctrl.type == "select"
        assert ctrl.options is not None
        assert len(ctrl.options) == 1

    def test_date(self):
        ctrl = C.date("dob").build()
        assert ctrl.type == "date"

    def test_file(self):
        ctrl = C.file("attachment").build()
        assert ctrl.type == "file"

    def test_field_generic(self):
        ctrl = C.field("custom").type("phone").build()
        assert ctrl.type == "phone"


# ============================================================================
# CONTROL BUILDER – CHAINING
# ============================================================================


class TestControlBuilderChaining:
    def test_required(self):
        ctrl = C.text("name").required().build()
        assert ctrl.required is True

    def test_optional(self):
        ctrl = C.text("name").required().optional().build()
        assert ctrl.required is False

    def test_hidden(self):
        ctrl = C.text("secret").hidden().build()
        assert ctrl.hidden is True

    def test_sensitive(self):
        ctrl = C.text("pwd").sensitive().build()
        assert ctrl.sensitive is True

    def test_readonly(self):
        ctrl = C.text("id").readonly().build()
        assert ctrl.readonly is True

    def test_multiple(self):
        ctrl = C.text("tags").multiple().build()
        assert ctrl.multiple is True

    def test_validation_chain(self):
        ctrl = (
            C.text("username")
            .required()
            .pattern(r"^[a-z]+$")
            .min_length(3)
            .max_length(20)
            .build()
        )
        assert ctrl.required is True
        assert ctrl.pattern == r"^[a-z]+$"
        assert ctrl.min_length == 3
        assert ctrl.max_length == 20

    def test_enum(self):
        ctrl = C.text("size").enum(["s", "m", "l"]).build()
        assert ctrl.enum == ["s", "m", "l"]

    def test_min_max(self):
        ctrl = C.number("age").min(0).max(150).build()
        assert ctrl.min == 0
        assert ctrl.max == 150

    def test_label(self):
        ctrl = C.text("fn").label("First Name").build()
        assert ctrl.label == "First Name"

    def test_ask(self):
        ctrl = C.text("email").ask("What is your email?").build()
        assert ctrl.ask_prompt == "What is your email?"

    def test_description(self):
        ctrl = C.text("bio").description("Tell us about yourself").build()
        assert ctrl.description == "Tell us about yourself"

    def test_hint(self):
        ctrl = C.text("wallet").hint("solana", "base58").build()
        assert ctrl.extract_hints == ["solana", "base58"]

    def test_example(self):
        ctrl = C.email("email").example("user@example.com").build()
        assert ctrl.example == "user@example.com"

    def test_confirm_threshold(self):
        ctrl = C.text("amount").confirm_threshold(0.95).build()
        assert ctrl.confirm_threshold == 0.95

    def test_file_options(self):
        ctrl = (
            C.file("docs")
            .accept(["application/pdf"])
            .max_size(1024)
            .max_files(3)
            .build()
        )
        assert ctrl.file is not None
        assert ctrl.file.accept == ["application/pdf"]
        assert ctrl.file.max_size == 1024
        assert ctrl.file.max_files == 3

    def test_roles(self):
        ctrl = C.text("discount").roles("admin", "sales").build()
        assert ctrl.roles == ["admin", "sales"]

    def test_default(self):
        ctrl = C.text("country").default("US").build()
        assert ctrl.default_value == "US"

    def test_depends_on(self):
        ctrl = C.text("state").depends_on("country", "equals", "US").build()
        assert ctrl.depends_on is not None
        assert ctrl.depends_on.field == "country"
        assert ctrl.depends_on.condition == "equals"
        assert ctrl.depends_on.value == "US"

    def test_dbbind(self):
        ctrl = C.text("email").dbbind("email_address").build()
        assert ctrl.dbbind == "email_address"

    def test_ui_options(self):
        ctrl = (
            C.text("name")
            .section("Personal")
            .order(1)
            .placeholder("Enter name")
            .help_text("Your full name")
            .widget("input")
            .build()
        )
        assert ctrl.ui is not None
        assert ctrl.ui.section == "Personal"
        assert ctrl.ui.order == 1
        assert ctrl.ui.placeholder == "Enter name"
        assert ctrl.ui.help_text == "Your full name"
        assert ctrl.ui.widget == "input"

    def test_i18n(self):
        ctrl = C.text("name").i18n("es", {"label": "Nombre"}).build()
        assert ctrl.i18n is not None
        assert "es" in ctrl.i18n
        assert ctrl.i18n["es"].label == "Nombre"

    def test_meta(self):
        ctrl = C.text("field").meta("priority", 1).build()
        assert ctrl.meta is not None
        assert ctrl.meta["priority"] == 1

    def test_auto_label_from_key(self):
        ctrl = C.text("first_name").build()
        assert ctrl.label == "First Name"


# ============================================================================
# FORM BUILDER
# ============================================================================


class TestFormBuilder:
    def test_create(self):
        form = Form.create("contact").build()
        assert form.id == "contact"
        assert form.name == "Contact"

    def test_name(self):
        form = Form.create("f").name("My Form").build()
        assert form.name == "My Form"

    def test_description(self):
        form = Form.create("f").description("A form").build()
        assert form.description == "A form"

    def test_version(self):
        form = Form.create("f").version(2).build()
        assert form.version == 2

    def test_control(self):
        form = Form.create("f").control(C.text("name")).build()
        assert len(form.controls) == 1
        assert form.controls[0].key == "name"

    def test_controls(self):
        form = (
            Form.create("f")
            .controls(C.text("name"), C.email("email"))
            .build()
        )
        assert len(form.controls) == 2

    def test_required_shorthand(self):
        form = Form.create("f").required("name", "email").build()
        assert len(form.controls) == 2
        assert all(c.required for c in form.controls)

    def test_optional_shorthand(self):
        form = Form.create("f").optional("notes").build()
        assert len(form.controls) == 1
        assert form.controls[0].required is False

    def test_roles(self):
        form = Form.create("f").roles("admin").build()
        assert form.roles == ["admin"]

    def test_allow_multiple(self):
        form = Form.create("f").allow_multiple().build()
        assert form.allow_multiple is True

    def test_no_undo(self):
        form = Form.create("f").no_undo().build()
        assert form.ux is not None
        assert form.ux.allow_undo is False

    def test_no_skip(self):
        form = Form.create("f").no_skip().build()
        assert form.ux is not None
        assert form.ux.allow_skip is False

    def test_no_autofill(self):
        form = Form.create("f").no_autofill().build()
        assert form.ux is not None
        assert form.ux.allow_autofill is False

    def test_max_undo_steps(self):
        form = Form.create("f").max_undo_steps(10).build()
        assert form.ux is not None
        assert form.ux.max_undo_steps == 10

    def test_ttl(self):
        form = Form.create("f").ttl(min_days=7, max_days=30).build()
        assert form.ttl is not None
        assert form.ttl.min_days == 7
        assert form.ttl.max_days == 30

    def test_no_nudge(self):
        form = Form.create("f").no_nudge().build()
        assert form.nudge is not None
        assert form.nudge.enabled is False

    def test_nudge_after(self):
        form = Form.create("f").nudge_after(24).build()
        assert form.nudge is not None
        assert form.nudge.after_inactive_hours == 24

    def test_nudge_message(self):
        form = Form.create("f").nudge_message("Hey!").build()
        assert form.nudge is not None
        assert form.nudge.message == "Hey!"

    def test_hooks(self):
        form = (
            Form.create("f")
            .on_start("start_worker")
            .on_field_change("field_worker")
            .on_ready("ready_worker")
            .on_submit("submit_worker")
            .on_cancel("cancel_worker")
            .on_expire("expire_worker")
            .build()
        )
        assert form.hooks is not None
        assert form.hooks.on_start == "start_worker"
        assert form.hooks.on_field_change == "field_worker"
        assert form.hooks.on_ready == "ready_worker"
        assert form.hooks.on_submit == "submit_worker"
        assert form.hooks.on_cancel == "cancel_worker"
        assert form.hooks.on_expire == "expire_worker"

    def test_debug(self):
        form = Form.create("f").debug().build()
        assert form.debug is True

    def test_i18n(self):
        form = Form.create("f").i18n("es", {"name": "Formulario"}).build()
        assert form.i18n is not None
        assert "es" in form.i18n
        assert form.i18n["es"].name == "Formulario"

    def test_meta(self):
        form = Form.create("f").meta("category", "support").build()
        assert form.meta is not None
        assert form.meta["category"] == "support"


# ============================================================================
# ALIASES
# ============================================================================


class TestAliases:
    def test_form_alias(self):
        assert Form is FormBuilder

    def test_c_alias(self):
        assert C is ControlBuilder
