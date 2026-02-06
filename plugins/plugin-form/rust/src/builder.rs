//! Fluent builder API for defining forms and controls.
//!
//! ```rust
//! use elizaos_plugin_form::builder::{ControlBuilder, FormBuilder};
//!
//! let form = FormBuilder::create("contact")
//!     .name("Contact Form")
//!     .control(ControlBuilder::email("email").required())
//!     .control(ControlBuilder::text("message").required())
//!     .build();
//! ```

use crate::defaults::prettify;
use crate::types::{
    FormControl, FormControlDependency, FormControlOption, FormDefinition, FormDefinitionHooks,
    FormDefinitionTTL,
};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

// ============================================================================
// CONTROL BUILDER
// ============================================================================

/// Fluent builder for FormControl.
pub struct ControlBuilder {
    control: FormControl,
}

impl ControlBuilder {
    /// Create a new ControlBuilder with the given key.
    pub fn new(key: &str) -> Self {
        Self {
            control: FormControl {
                key: key.to_string(),
                ..Default::default()
            },
        }
    }

    // ═══ STATIC FACTORIES ═══

    /// Create a generic field builder.
    pub fn field(key: &str) -> Self {
        Self::new(key)
    }

    /// Create a text field.
    pub fn text(key: &str) -> Self {
        Self::new(key).type_name("text")
    }

    /// Create an email field.
    pub fn email(key: &str) -> Self {
        Self::new(key).type_name("email")
    }

    /// Create a number field.
    pub fn number(key: &str) -> Self {
        Self::new(key).type_name("number")
    }

    /// Create a boolean (yes/no) field.
    pub fn boolean(key: &str) -> Self {
        Self::new(key).type_name("boolean")
    }

    /// Create a select field with options.
    pub fn select(key: &str, options: Vec<FormControlOption>) -> Self {
        let mut b = Self::new(key).type_name("select");
        b.control.options = Some(options);
        b
    }

    /// Create a date field.
    pub fn date(key: &str) -> Self {
        Self::new(key).type_name("date")
    }

    /// Create a file upload field.
    pub fn file(key: &str) -> Self {
        Self::new(key).type_name("file")
    }

    // ═══ TYPE ═══

    /// Set the field type.
    pub fn type_name(mut self, type_name: &str) -> Self {
        self.control.type_name = type_name.to_string();
        self
    }

    // ═══ BEHAVIOR ═══

    /// Mark field as required.
    pub fn required(mut self) -> Self {
        self.control.required = true;
        self
    }

    /// Mark field as optional (default).
    pub fn optional(mut self) -> Self {
        self.control.required = false;
        self
    }

    /// Mark field as hidden.
    pub fn hidden(mut self) -> Self {
        self.control.hidden = Some(true);
        self
    }

    /// Mark field as sensitive.
    pub fn sensitive(mut self) -> Self {
        self.control.sensitive = Some(true);
        self
    }

    /// Mark field as readonly.
    pub fn readonly(mut self) -> Self {
        self.control.readonly = Some(true);
        self
    }

    /// Mark field as accepting multiple values.
    pub fn multiple(mut self) -> Self {
        self.control.multiple = Some(true);
        self
    }

    // ═══ VALIDATION ═══

    /// Set regex pattern.
    pub fn pattern(mut self, regex: &str) -> Self {
        self.control.pattern = Some(regex.to_string());
        self
    }

    /// Set minimum value (for numbers).
    pub fn min(mut self, n: f64) -> Self {
        self.control.min = Some(n);
        self
    }

    /// Set maximum value (for numbers).
    pub fn max(mut self, n: f64) -> Self {
        self.control.max = Some(n);
        self
    }

    /// Set minimum string length.
    pub fn min_length(mut self, n: usize) -> Self {
        self.control.min_length = Some(n);
        self
    }

    /// Set maximum string length.
    pub fn max_length(mut self, n: usize) -> Self {
        self.control.max_length = Some(n);
        self
    }

    /// Set allowed values (enum).
    pub fn enum_values(mut self, values: Vec<String>) -> Self {
        self.control.enum_values = Some(values);
        self
    }

    /// Set select options.
    pub fn options(mut self, opts: Vec<FormControlOption>) -> Self {
        self.control.options = Some(opts);
        self
    }

    // ═══ AGENT HINTS ═══

    /// Set human-readable label.
    pub fn label(mut self, label: &str) -> Self {
        self.control.label = label.to_string();
        self
    }

    /// Set custom prompt for asking this field.
    pub fn ask(mut self, prompt: &str) -> Self {
        self.control.ask_prompt = Some(prompt.to_string());
        self
    }

    /// Set description for LLM context.
    pub fn description(mut self, desc: &str) -> Self {
        self.control.description = Some(desc.to_string());
        self
    }

    /// Add extraction hints (keywords).
    pub fn hint(mut self, hints: Vec<String>) -> Self {
        self.control.extract_hints = Some(hints);
        self
    }

    /// Set example value.
    pub fn example(mut self, value: &str) -> Self {
        self.control.example = Some(value.to_string());
        self
    }

    /// Set confidence threshold for auto-acceptance.
    pub fn confirm_threshold(mut self, n: f64) -> Self {
        self.control.confirm_threshold = Some(n);
        self
    }

    // ═══ FILE OPTIONS ═══

    /// Set accepted MIME types.
    pub fn accept(mut self, mime_types: Vec<String>) -> Self {
        let file = self.control.file.get_or_insert(Default::default());
        file.accept = Some(mime_types);
        self
    }

    /// Set maximum file size in bytes.
    pub fn max_size(mut self, bytes: u64) -> Self {
        let file = self.control.file.get_or_insert(Default::default());
        file.max_size = Some(bytes);
        self
    }

    /// Set maximum number of files.
    pub fn max_files(mut self, n: usize) -> Self {
        let file = self.control.file.get_or_insert(Default::default());
        file.max_files = Some(n);
        self
    }

    // ═══ ACCESS ═══

    /// Set roles that can see/fill this field.
    pub fn roles(mut self, roles: Vec<String>) -> Self {
        self.control.roles = Some(roles);
        self
    }

    // ═══ DEFAULTS & CONDITIONS ═══

    /// Set default value.
    pub fn default_value(mut self, value: JsonValue) -> Self {
        self.control.default_value = Some(value);
        self
    }

    /// Set dependency on another field.
    pub fn depends_on(mut self, dep: FormControlDependency) -> Self {
        self.control.depends_on = Some(dep);
        self
    }

    // ═══ DATABASE ═══

    /// Set database column name.
    pub fn dbbind(mut self, column: &str) -> Self {
        self.control.dbbind = Some(column.to_string());
        self
    }

    // ═══ UI ═══

    /// Set section name.
    pub fn section(mut self, name: &str) -> Self {
        let ui = self.control.ui.get_or_insert(Default::default());
        ui.section = Some(name.to_string());
        self
    }

    /// Set display order.
    pub fn order(mut self, n: i32) -> Self {
        let ui = self.control.ui.get_or_insert(Default::default());
        ui.order = Some(n);
        self
    }

    /// Set placeholder text.
    pub fn placeholder(mut self, text: &str) -> Self {
        let ui = self.control.ui.get_or_insert(Default::default());
        ui.placeholder = Some(text.to_string());
        self
    }

    /// Set help text.
    pub fn help_text(mut self, text: &str) -> Self {
        let ui = self.control.ui.get_or_insert(Default::default());
        ui.help_text = Some(text.to_string());
        self
    }

    /// Set custom widget type.
    pub fn widget(mut self, type_name: &str) -> Self {
        let ui = self.control.ui.get_or_insert(Default::default());
        ui.widget = Some(type_name.to_string());
        self
    }

    // ═══ I18N ═══

    /// Add localized text for a locale.
    pub fn i18n(mut self, locale: &str, translations: crate::types::FormControlI18n) -> Self {
        let map = self.control.i18n.get_or_insert_with(HashMap::new);
        map.insert(locale.to_string(), translations);
        self
    }

    // ═══ META ═══

    /// Add custom metadata.
    pub fn meta(mut self, key: &str, value: JsonValue) -> Self {
        let map = self.control.meta.get_or_insert_with(HashMap::new);
        map.insert(key.to_string(), value);
        self
    }

    // ═══ BUILD ═══

    /// Build the final FormControl with defaults applied.
    pub fn build(mut self) -> FormControl {
        if self.control.label.is_empty() {
            self.control.label = prettify(&self.control.key);
        }
        if self.control.type_name.is_empty() {
            self.control.type_name = "text".to_string();
        }
        self.control
    }
}

// ============================================================================
// FORM BUILDER
// ============================================================================

/// Fluent builder for FormDefinition.
pub struct FormBuilder {
    form: FormDefinition,
}

impl FormBuilder {
    /// Create a new FormBuilder.
    pub fn create(id: &str) -> Self {
        Self {
            form: FormDefinition {
                id: id.to_string(),
                name: String::new(),
                controls: Vec::new(),
                description: None,
                version: None,
                status: None,
                roles: None,
                allow_multiple: None,
                ux: None,
                ttl: None,
                nudge: None,
                hooks: None,
                debug: None,
                i18n: None,
                meta: None,
            },
        }
    }

    // ═══ METADATA ═══

    /// Set form name.
    pub fn name(mut self, name: &str) -> Self {
        self.form.name = name.to_string();
        self
    }

    /// Set form description.
    pub fn description(mut self, desc: &str) -> Self {
        self.form.description = Some(desc.to_string());
        self
    }

    /// Set form version.
    pub fn version(mut self, v: u32) -> Self {
        self.form.version = Some(v);
        self
    }

    // ═══ CONTROLS ═══

    /// Add a control (from ControlBuilder or FormControl).
    pub fn control(mut self, builder: ControlBuilder) -> Self {
        self.form.controls.push(builder.build());
        self
    }

    /// Add a pre-built FormControl directly.
    pub fn control_raw(mut self, control: FormControl) -> Self {
        self.form.controls.push(control);
        self
    }

    /// Add multiple controls.
    pub fn controls(mut self, builders: Vec<ControlBuilder>) -> Self {
        for b in builders {
            self.form.controls.push(b.build());
        }
        self
    }

    // ═══ SHORTHAND CONTROLS ═══

    /// Add required text fields by key.
    pub fn required(mut self, keys: &[&str]) -> Self {
        for key in keys {
            self.form.controls.push(ControlBuilder::field(key).required().build());
        }
        self
    }

    /// Add optional text fields by key.
    pub fn optional(mut self, keys: &[&str]) -> Self {
        for key in keys {
            self.form.controls.push(ControlBuilder::field(key).build());
        }
        self
    }

    // ═══ PERMISSIONS ═══

    /// Set roles that can start this form.
    pub fn roles(mut self, roles: Vec<String>) -> Self {
        self.form.roles = Some(roles);
        self
    }

    /// Allow multiple submissions per user.
    pub fn allow_multiple(mut self) -> Self {
        self.form.allow_multiple = Some(true);
        self
    }

    // ═══ UX ═══

    /// Disable undo.
    pub fn no_undo(mut self) -> Self {
        let ux = self.form.ux.get_or_insert(Default::default());
        ux.allow_undo = Some(false);
        self
    }

    /// Disable skip.
    pub fn no_skip(mut self) -> Self {
        let ux = self.form.ux.get_or_insert(Default::default());
        ux.allow_skip = Some(false);
        self
    }

    /// Disable autofill.
    pub fn no_autofill(mut self) -> Self {
        let ux = self.form.ux.get_or_insert(Default::default());
        ux.allow_autofill = Some(false);
        self
    }

    /// Set maximum undo steps.
    pub fn max_undo_steps(mut self, n: usize) -> Self {
        let ux = self.form.ux.get_or_insert(Default::default());
        ux.max_undo_steps = Some(n);
        self
    }

    // ═══ TTL ═══

    /// Configure TTL settings.
    pub fn ttl(mut self, config: FormDefinitionTTL) -> Self {
        self.form.ttl = Some(config);
        self
    }

    // ═══ NUDGE ═══

    /// Disable nudge messages.
    pub fn no_nudge(mut self) -> Self {
        let nudge = self.form.nudge.get_or_insert(Default::default());
        nudge.enabled = Some(false);
        self
    }

    /// Set inactivity hours before nudge.
    pub fn nudge_after(mut self, hours: f64) -> Self {
        let nudge = self.form.nudge.get_or_insert(Default::default());
        nudge.after_inactive_hours = Some(hours);
        self
    }

    /// Set custom nudge message.
    pub fn nudge_message(mut self, message: &str) -> Self {
        let nudge = self.form.nudge.get_or_insert(Default::default());
        nudge.message = Some(message.to_string());
        self
    }

    // ═══ HOOKS ═══

    pub fn on_start(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_start = Some(worker.to_string());
        self
    }

    pub fn on_field_change(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_field_change = Some(worker.to_string());
        self
    }

    pub fn on_ready(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_ready = Some(worker.to_string());
        self
    }

    pub fn on_submit(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_submit = Some(worker.to_string());
        self
    }

    pub fn on_cancel(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_cancel = Some(worker.to_string());
        self
    }

    pub fn on_expire(mut self, worker: &str) -> Self {
        let hooks = self.form.hooks.get_or_insert(Default::default());
        hooks.on_expire = Some(worker.to_string());
        self
    }

    /// Set multiple hooks at once.
    pub fn hooks(mut self, hooks: FormDefinitionHooks) -> Self {
        self.form.hooks = Some(hooks);
        self
    }

    // ═══ DEBUG ═══

    /// Enable debug mode.
    pub fn debug(mut self) -> Self {
        self.form.debug = Some(true);
        self
    }

    // ═══ I18N ═══

    /// Add localized form text.
    pub fn i18n(mut self, locale: &str, translations: crate::types::FormDefinitionI18n) -> Self {
        let map = self.form.i18n.get_or_insert_with(HashMap::new);
        map.insert(locale.to_string(), translations);
        self
    }

    // ═══ META ═══

    /// Add custom metadata.
    pub fn meta(mut self, key: &str, value: JsonValue) -> Self {
        let map = self.form.meta.get_or_insert_with(HashMap::new);
        map.insert(key.to_string(), value);
        self
    }

    // ═══ BUILD ═══

    /// Build the final FormDefinition with defaults applied.
    pub fn build(mut self) -> FormDefinition {
        if self.form.name.is_empty() {
            self.form.name = prettify(&self.form.id);
        }
        self.form
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DependencyCondition;
    use serde_json::json;

    // ═══ CONTROL BUILDER FACTORIES ═══

    #[test]
    fn test_text_factory() {
        let c = ControlBuilder::text("name").build();
        assert_eq!(c.key, "name");
        assert_eq!(c.type_name, "text");
    }

    #[test]
    fn test_email_factory() {
        let c = ControlBuilder::email("email").build();
        assert_eq!(c.type_name, "email");
    }

    #[test]
    fn test_number_factory() {
        let c = ControlBuilder::number("age").build();
        assert_eq!(c.type_name, "number");
    }

    #[test]
    fn test_boolean_factory() {
        let c = ControlBuilder::boolean("agree").build();
        assert_eq!(c.type_name, "boolean");
    }

    #[test]
    fn test_select_factory() {
        let opts = vec![FormControlOption {
            value: "red".to_string(),
            label: "Red".to_string(),
            description: None,
        }];
        let c = ControlBuilder::select("color", opts).build();
        assert_eq!(c.type_name, "select");
        assert_eq!(c.options.unwrap().len(), 1);
    }

    #[test]
    fn test_date_factory() {
        let c = ControlBuilder::date("dob").build();
        assert_eq!(c.type_name, "date");
    }

    #[test]
    fn test_file_factory() {
        let c = ControlBuilder::file("avatar").build();
        assert_eq!(c.type_name, "file");
    }

    #[test]
    fn test_field_factory() {
        let c = ControlBuilder::field("custom").build();
        assert_eq!(c.key, "custom");
        assert_eq!(c.type_name, "text"); // default
    }

    // ═══ BEHAVIOR METHODS ═══

    #[test]
    fn test_required() {
        let c = ControlBuilder::text("name").required().build();
        assert!(c.required);
    }

    #[test]
    fn test_optional() {
        let c = ControlBuilder::text("name").required().optional().build();
        assert!(!c.required);
    }

    #[test]
    fn test_hidden() {
        let c = ControlBuilder::text("secret").hidden().build();
        assert_eq!(c.hidden, Some(true));
    }

    #[test]
    fn test_sensitive() {
        let c = ControlBuilder::text("password").sensitive().build();
        assert_eq!(c.sensitive, Some(true));
    }

    #[test]
    fn test_readonly() {
        let c = ControlBuilder::text("id").readonly().build();
        assert_eq!(c.readonly, Some(true));
    }

    #[test]
    fn test_multiple() {
        let c = ControlBuilder::text("tags").multiple().build();
        assert_eq!(c.multiple, Some(true));
    }

    // ═══ VALIDATION METHODS ═══

    #[test]
    fn test_pattern() {
        let c = ControlBuilder::text("code").pattern("^[A-Z]{3}$").build();
        assert_eq!(c.pattern, Some("^[A-Z]{3}$".to_string()));
    }

    #[test]
    fn test_min_max() {
        let c = ControlBuilder::number("age").min(18.0).max(120.0).build();
        assert_eq!(c.min, Some(18.0));
        assert_eq!(c.max, Some(120.0));
    }

    #[test]
    fn test_min_max_length() {
        let c = ControlBuilder::text("name").min_length(2).max_length(50).build();
        assert_eq!(c.min_length, Some(2));
        assert_eq!(c.max_length, Some(50));
    }

    #[test]
    fn test_enum_values() {
        let c = ControlBuilder::text("size")
            .enum_values(vec!["S".into(), "M".into(), "L".into()])
            .build();
        assert_eq!(c.enum_values.unwrap().len(), 3);
    }

    // ═══ AGENT HINT METHODS ═══

    #[test]
    fn test_label() {
        let c = ControlBuilder::text("fname").label("First Name").build();
        assert_eq!(c.label, "First Name");
    }

    #[test]
    fn test_ask() {
        let c = ControlBuilder::text("email").ask("What's your email?").build();
        assert_eq!(c.ask_prompt, Some("What's your email?".to_string()));
    }

    #[test]
    fn test_description() {
        let c = ControlBuilder::text("name").description("Full legal name").build();
        assert_eq!(c.description, Some("Full legal name".to_string()));
    }

    #[test]
    fn test_hint() {
        let c = ControlBuilder::text("addr")
            .hint(vec!["wallet".into(), "address".into()])
            .build();
        assert_eq!(c.extract_hints.unwrap().len(), 2);
    }

    #[test]
    fn test_example() {
        let c = ControlBuilder::email("email").example("user@example.com").build();
        assert_eq!(c.example, Some("user@example.com".to_string()));
    }

    #[test]
    fn test_confirm_threshold() {
        let c = ControlBuilder::text("name").confirm_threshold(0.95).build();
        assert_eq!(c.confirm_threshold, Some(0.95));
    }

    // ═══ FILE METHODS ═══

    #[test]
    fn test_accept() {
        let c = ControlBuilder::file("doc")
            .accept(vec!["image/*".into()])
            .build();
        assert!(c.file.is_some());
        assert_eq!(c.file.unwrap().accept.unwrap(), vec!["image/*"]);
    }

    #[test]
    fn test_max_size() {
        let c = ControlBuilder::file("doc").max_size(1024).build();
        assert_eq!(c.file.unwrap().max_size, Some(1024));
    }

    #[test]
    fn test_max_files() {
        let c = ControlBuilder::file("docs").max_files(5).build();
        assert_eq!(c.file.unwrap().max_files, Some(5));
    }

    // ═══ OTHER METHODS ═══

    #[test]
    fn test_roles() {
        let c = ControlBuilder::text("secret")
            .roles(vec!["admin".into()])
            .build();
        assert_eq!(c.roles.unwrap(), vec!["admin"]);
    }

    #[test]
    fn test_default_value() {
        let c = ControlBuilder::text("country")
            .default_value(json!("US"))
            .build();
        assert_eq!(c.default_value, Some(json!("US")));
    }

    #[test]
    fn test_depends_on() {
        let c = ControlBuilder::text("state")
            .depends_on(FormControlDependency {
                field: "country".to_string(),
                condition: DependencyCondition::Equals,
                value: Some(json!("US")),
            })
            .build();
        let dep = c.depends_on.unwrap();
        assert_eq!(dep.field, "country");
        assert_eq!(dep.condition, DependencyCondition::Equals);
    }

    #[test]
    fn test_dbbind() {
        let c = ControlBuilder::text("firstName")
            .dbbind("first_name")
            .build();
        assert_eq!(c.dbbind, Some("first_name".to_string()));
    }

    #[test]
    fn test_section() {
        let c = ControlBuilder::text("name").section("Personal").build();
        assert_eq!(c.ui.unwrap().section, Some("Personal".to_string()));
    }

    #[test]
    fn test_meta() {
        let c = ControlBuilder::text("field")
            .meta("priority", json!(1))
            .build();
        assert_eq!(c.meta.unwrap().get("priority"), Some(&json!(1)));
    }

    #[test]
    fn test_auto_label_from_key() {
        let c = ControlBuilder::text("first_name").build();
        assert_eq!(c.label, "First Name");
    }

    // ═══ FORM BUILDER ═══

    #[test]
    fn test_form_create() {
        let f = FormBuilder::create("test").build();
        assert_eq!(f.id, "test");
        assert_eq!(f.name, "Test");
    }

    #[test]
    fn test_form_name() {
        let f = FormBuilder::create("test").name("My Form").build();
        assert_eq!(f.name, "My Form");
    }

    #[test]
    fn test_form_description() {
        let f = FormBuilder::create("test").description("A test form").build();
        assert_eq!(f.description, Some("A test form".to_string()));
    }

    #[test]
    fn test_form_version() {
        let f = FormBuilder::create("test").version(2).build();
        assert_eq!(f.version, Some(2));
    }

    #[test]
    fn test_form_control() {
        let f = FormBuilder::create("test")
            .control(ControlBuilder::text("name"))
            .build();
        assert_eq!(f.controls.len(), 1);
        assert_eq!(f.controls[0].key, "name");
    }

    #[test]
    fn test_form_controls_multiple() {
        let f = FormBuilder::create("test")
            .controls(vec![
                ControlBuilder::text("name"),
                ControlBuilder::email("email"),
            ])
            .build();
        assert_eq!(f.controls.len(), 2);
    }

    #[test]
    fn test_form_required_shorthand() {
        let f = FormBuilder::create("test").required(&["name", "email"]).build();
        assert_eq!(f.controls.len(), 2);
        assert!(f.controls[0].required);
        assert!(f.controls[1].required);
    }

    #[test]
    fn test_form_optional_shorthand() {
        let f = FormBuilder::create("test").optional(&["bio"]).build();
        assert_eq!(f.controls.len(), 1);
        assert!(!f.controls[0].required);
    }

    #[test]
    fn test_form_roles() {
        let f = FormBuilder::create("test")
            .roles(vec!["admin".into()])
            .build();
        assert_eq!(f.roles.unwrap(), vec!["admin"]);
    }

    #[test]
    fn test_form_allow_multiple() {
        let f = FormBuilder::create("test").allow_multiple().build();
        assert_eq!(f.allow_multiple, Some(true));
    }

    #[test]
    fn test_form_no_undo_no_skip() {
        let f = FormBuilder::create("test").no_undo().no_skip().build();
        let ux = f.ux.unwrap();
        assert_eq!(ux.allow_undo, Some(false));
        assert_eq!(ux.allow_skip, Some(false));
    }

    #[test]
    fn test_form_ttl() {
        let f = FormBuilder::create("test")
            .ttl(FormDefinitionTTL {
                min_days: Some(7.0),
                max_days: Some(30.0),
                effort_multiplier: None,
            })
            .build();
        let ttl = f.ttl.unwrap();
        assert_eq!(ttl.min_days, Some(7.0));
    }

    #[test]
    fn test_form_hooks() {
        let f = FormBuilder::create("test")
            .on_submit("handle_submit")
            .on_cancel("handle_cancel")
            .build();
        let hooks = f.hooks.unwrap();
        assert_eq!(hooks.on_submit, Some("handle_submit".to_string()));
        assert_eq!(hooks.on_cancel, Some("handle_cancel".to_string()));
    }

    #[test]
    fn test_form_hooks_struct() {
        let f = FormBuilder::create("test")
            .hooks(FormDefinitionHooks {
                on_start: Some("start".into()),
                on_submit: Some("submit".into()),
                ..Default::default()
            })
            .build();
        let hooks = f.hooks.unwrap();
        assert_eq!(hooks.on_start, Some("start".to_string()));
    }

    #[test]
    fn test_form_debug() {
        let f = FormBuilder::create("test").debug().build();
        assert_eq!(f.debug, Some(true));
    }

    #[test]
    fn test_form_no_nudge() {
        let f = FormBuilder::create("test").no_nudge().build();
        assert_eq!(f.nudge.unwrap().enabled, Some(false));
    }

    #[test]
    fn test_form_nudge_after() {
        let f = FormBuilder::create("test").nudge_after(24.0).build();
        assert_eq!(f.nudge.unwrap().after_inactive_hours, Some(24.0));
    }

    #[test]
    fn test_form_no_autofill() {
        let f = FormBuilder::create("test").no_autofill().build();
        assert_eq!(f.ux.unwrap().allow_autofill, Some(false));
    }

    #[test]
    fn test_form_meta() {
        let f = FormBuilder::create("test").meta("category", json!("support")).build();
        assert_eq!(f.meta.unwrap().get("category"), Some(&json!("support")));
    }

    #[test]
    fn test_form_chaining_full() {
        let f = FormBuilder::create("registration")
            .name("User Registration")
            .description("Create your account")
            .version(1)
            .control(
                ControlBuilder::email("email")
                    .required()
                    .ask("What email should we use?")
                    .example("user@example.com"),
            )
            .control(
                ControlBuilder::text("username")
                    .required()
                    .min_length(3)
                    .max_length(20)
                    .pattern("^[a-z0-9_]+$"),
            )
            .control(ControlBuilder::number("age").min(13.0))
            .on_submit("handle_registration")
            .ttl(FormDefinitionTTL {
                min_days: Some(7.0),
                max_days: Some(30.0),
                effort_multiplier: None,
            })
            .build();

        assert_eq!(f.id, "registration");
        assert_eq!(f.name, "User Registration");
        assert_eq!(f.controls.len(), 3);
        assert!(f.controls[0].required);
        assert_eq!(f.controls[1].min_length, Some(3));
        assert_eq!(f.hooks.unwrap().on_submit, Some("handle_registration".to_string()));
    }

    #[test]
    fn test_form_auto_name_from_id() {
        let f = FormBuilder::create("user_registration").build();
        assert_eq!(f.name, "User Registration");
    }

    #[test]
    fn test_form_max_undo_steps() {
        let f = FormBuilder::create("test").max_undo_steps(10).build();
        assert_eq!(f.ux.unwrap().max_undo_steps, Some(10));
    }
}
