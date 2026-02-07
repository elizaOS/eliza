//! Default value application for forms and controls.
//!
//! Minimal definitions like `{ id: "contact", controls: [{ key: "email" }] }`
//! get expanded with sensible defaults for all optional fields.

use crate::types::{
    FormControl, FormDefinition, FormDefinitionNudge, FormDefinitionTTL, FormDefinitionUX,
    FormStatus, DEFAULT_CONFIRM_THRESHOLD, DEFAULT_NUDGE_AFTER_INACTIVE_HOURS,
    DEFAULT_NUDGE_MAX_NUDGES, DEFAULT_TTL_EFFORT_MULTIPLIER, DEFAULT_TTL_MAX_DAYS,
    DEFAULT_TTL_MIN_DAYS,
};

/// Convert snake_case or kebab-case to Title Case.
///
/// ```
/// use elizaos_plugin_form::defaults::prettify;
/// assert_eq!(prettify("first_name"), "First Name");
/// assert_eq!(prettify("email-address"), "Email Address");
/// ```
pub fn prettify(key: &str) -> String {
    key.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => {
                    let mut s = c.to_uppercase().to_string();
                    s.extend(chars);
                    s
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Apply defaults to a FormControl.
pub fn apply_control_defaults(mut control: FormControl) -> FormControl {
    if control.label.is_empty() {
        control.label = prettify(&control.key);
    }
    if control.type_name.is_empty() {
        control.type_name = "text".to_string();
    }
    if control.confirm_threshold.is_none() {
        control.confirm_threshold = Some(DEFAULT_CONFIRM_THRESHOLD);
    }
    control
}

/// Apply defaults to a FormDefinition.
pub fn apply_form_defaults(mut form: FormDefinition) -> FormDefinition {
    if form.name.is_empty() {
        form.name = prettify(&form.id);
    }
    if form.version.is_none() {
        form.version = Some(1);
    }
    if form.status.is_none() {
        form.status = Some(FormStatus::Active);
    }

    // Apply defaults to controls
    form.controls = form.controls.into_iter().map(apply_control_defaults).collect();

    // UX defaults
    let ux = form.ux.get_or_insert(FormDefinitionUX {
        allow_undo: None,
        allow_skip: None,
        max_undo_steps: None,
        show_examples: None,
        show_explanations: None,
        allow_autofill: None,
    });
    if ux.allow_undo.is_none() {
        ux.allow_undo = Some(true);
    }
    if ux.allow_skip.is_none() {
        ux.allow_skip = Some(true);
    }
    if ux.max_undo_steps.is_none() {
        ux.max_undo_steps = Some(5);
    }
    if ux.show_examples.is_none() {
        ux.show_examples = Some(true);
    }
    if ux.show_explanations.is_none() {
        ux.show_explanations = Some(true);
    }
    if ux.allow_autofill.is_none() {
        ux.allow_autofill = Some(true);
    }

    // TTL defaults
    let ttl = form.ttl.get_or_insert(FormDefinitionTTL {
        min_days: None,
        max_days: None,
        effort_multiplier: None,
    });
    if ttl.min_days.is_none() {
        ttl.min_days = Some(DEFAULT_TTL_MIN_DAYS);
    }
    if ttl.max_days.is_none() {
        ttl.max_days = Some(DEFAULT_TTL_MAX_DAYS);
    }
    if ttl.effort_multiplier.is_none() {
        ttl.effort_multiplier = Some(DEFAULT_TTL_EFFORT_MULTIPLIER);
    }

    // Nudge defaults
    let nudge = form.nudge.get_or_insert(FormDefinitionNudge {
        enabled: None,
        after_inactive_hours: None,
        max_nudges: None,
        message: None,
    });
    if nudge.enabled.is_none() {
        nudge.enabled = Some(true);
    }
    if nudge.after_inactive_hours.is_none() {
        nudge.after_inactive_hours = Some(DEFAULT_NUDGE_AFTER_INACTIVE_HOURS);
    }
    if nudge.max_nudges.is_none() {
        nudge.max_nudges = Some(DEFAULT_NUDGE_MAX_NUDGES);
    }

    // Debug default
    if form.debug.is_none() {
        form.debug = Some(false);
    }

    form
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ═══ PRETTIFY ═══

    #[test]
    fn test_prettify_snake_case() {
        assert_eq!(prettify("first_name"), "First Name");
    }

    #[test]
    fn test_prettify_kebab_case() {
        assert_eq!(prettify("email-address"), "Email Address");
    }

    #[test]
    fn test_prettify_single_word() {
        assert_eq!(prettify("email"), "Email");
    }

    #[test]
    fn test_prettify_empty() {
        assert_eq!(prettify(""), "");
    }

    #[test]
    fn test_prettify_multiple_separators() {
        assert_eq!(prettify("full_name-display"), "Full Name Display");
    }

    #[test]
    fn test_prettify_already_capitalized() {
        assert_eq!(prettify("Name"), "Name");
    }

    // ═══ CONTROL DEFAULTS ═══

    #[test]
    fn test_control_defaults_label_from_key() {
        let c = apply_control_defaults(FormControl {
            key: "first_name".to_string(),
            ..Default::default()
        });
        assert_eq!(c.label, "First Name");
    }

    #[test]
    fn test_control_defaults_type_text() {
        let c = apply_control_defaults(FormControl {
            key: "field".to_string(),
            ..Default::default()
        });
        assert_eq!(c.type_name, "text");
    }

    #[test]
    fn test_control_defaults_confirm_threshold() {
        let c = apply_control_defaults(FormControl {
            key: "field".to_string(),
            ..Default::default()
        });
        assert_eq!(c.confirm_threshold, Some(0.8));
    }

    #[test]
    fn test_control_defaults_preserves_label() {
        let c = apply_control_defaults(FormControl {
            key: "field".to_string(),
            label: "Custom Label".to_string(),
            ..Default::default()
        });
        assert_eq!(c.label, "Custom Label");
    }

    #[test]
    fn test_control_defaults_preserves_type() {
        let c = apply_control_defaults(FormControl {
            key: "field".to_string(),
            type_name: "email".to_string(),
            ..Default::default()
        });
        assert_eq!(c.type_name, "email");
    }

    #[test]
    fn test_control_defaults_preserves_threshold() {
        let c = apply_control_defaults(FormControl {
            key: "field".to_string(),
            confirm_threshold: Some(0.95),
            ..Default::default()
        });
        assert_eq!(c.confirm_threshold, Some(0.95));
    }

    // ═══ FORM DEFAULTS ═══

    #[test]
    fn test_form_defaults_name_from_id() {
        let f = apply_form_defaults(FormDefinition {
            id: "user_registration".to_string(),
            controls: vec![],
            ..Default::default()
        });
        assert_eq!(f.name, "User Registration");
    }

    #[test]
    fn test_form_defaults_version() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            version: None,
            ..Default::default()
        });
        assert_eq!(f.version, Some(1));
    }

    #[test]
    fn test_form_defaults_status() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            status: None,
            ..Default::default()
        });
        assert_eq!(f.status, Some(FormStatus::Active));
    }

    #[test]
    fn test_form_defaults_ux() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            ux: None,
            ..Default::default()
        });
        let ux = f.ux.unwrap();
        assert_eq!(ux.allow_undo, Some(true));
        assert_eq!(ux.allow_skip, Some(true));
        assert_eq!(ux.max_undo_steps, Some(5));
        assert_eq!(ux.show_examples, Some(true));
        assert_eq!(ux.show_explanations, Some(true));
        assert_eq!(ux.allow_autofill, Some(true));
    }

    #[test]
    fn test_form_defaults_ttl() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            ttl: None,
            ..Default::default()
        });
        let ttl = f.ttl.unwrap();
        assert_eq!(ttl.min_days, Some(14.0));
        assert_eq!(ttl.max_days, Some(90.0));
        assert_eq!(ttl.effort_multiplier, Some(0.5));
    }

    #[test]
    fn test_form_defaults_nudge() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            nudge: None,
            ..Default::default()
        });
        let nudge = f.nudge.unwrap();
        assert_eq!(nudge.enabled, Some(true));
        assert_eq!(nudge.after_inactive_hours, Some(48.0));
        assert_eq!(nudge.max_nudges, Some(3));
    }

    #[test]
    fn test_form_defaults_debug() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            debug: None,
            ..Default::default()
        });
        assert_eq!(f.debug, Some(false));
    }

    #[test]
    fn test_form_defaults_preserves_name() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            name: "My Form".to_string(),
            controls: vec![],
            ..Default::default()
        });
        assert_eq!(f.name, "My Form");
    }

    #[test]
    fn test_form_defaults_applies_to_controls() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![FormControl {
                key: "user_email".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        });
        assert_eq!(f.controls[0].label, "User Email");
        assert_eq!(f.controls[0].confirm_threshold, Some(0.8));
    }

    #[test]
    fn test_form_defaults_partial_ux() {
        let f = apply_form_defaults(FormDefinition {
            id: "form".to_string(),
            controls: vec![],
            ux: Some(FormDefinitionUX {
                allow_undo: Some(false),
                allow_skip: None,
                max_undo_steps: None,
                show_examples: None,
                show_explanations: None,
                allow_autofill: None,
            }),
            ..Default::default()
        });
        let ux = f.ux.unwrap();
        assert_eq!(ux.allow_undo, Some(false)); // preserved
        assert_eq!(ux.allow_skip, Some(true)); // defaulted
    }
}
