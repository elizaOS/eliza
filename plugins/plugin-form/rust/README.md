# elizaos-plugin-form

**Version:** 2.0.0-alpha.1

Rust port of the elizaOS plugin-form system — guardrails for agent-guided user journeys.

## Overview

Forms are guardrails that help AI agents collect structured data from users in conversational interfaces. Instead of freeform chat, forms define what information is needed, how to validate it, and how the agent should ask for it.

- **FormDefinition** — The journey map (what stops are required)
- **FormControl** — A stop on the journey (what info to collect)
- **FormSession** — Progress through the journey (where we are)
- **FormSubmission** — Journey complete (the outcome)

## Modules

| Module       | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| `types`      | Core type definitions: FormDefinition, FormControl, FormSession, FormSubmission, FieldState, intents, validation results |
| `validation` | Field validation, custom type handlers, value parsing and formatting        |
| `intent`     | Two-tier intent detection (regex fast path + LLM fallback)                  |
| `ttl`        | Smart TTL management — effort-based session retention                       |
| `defaults`   | Default value application for forms and controls                            |
| `builder`    | Fluent builder API for defining forms and controls                          |
| `template`   | Template resolution using `{{ key }}` syntax                                |
| `builtins`   | Seven built-in control types: text, number, email, boolean, select, date, file |
| `service`    | In-memory form management service with full session lifecycle               |

## Usage

### Building a Form

```rust
use elizaos_plugin_form::builder::{FormBuilder, ControlBuilder};

let form = FormBuilder::create("registration")
    .name("User Registration")
    .control(ControlBuilder::email("email").required().ask("What's your email?"))
    .control(ControlBuilder::text("username").required().min_length(3).max_length(20))
    .control(ControlBuilder::number("age").min(13.0))
    .on_submit("handle_registration")
    .build();
```

### Validating Fields

```rust
use elizaos_plugin_form::validation::validate_field;
use elizaos_plugin_form::types::FormControl;
use serde_json::json;

let control = FormControl {
    key: "email".into(),
    label: "Email".into(),
    type_name: "email".into(),
    required: true,
    ..Default::default()
};

let result = validate_field(&json!("user@example.com"), &control);
assert!(result.valid);
```

### Detecting Intent

```rust
use elizaos_plugin_form::intent::quick_intent_detect;
use elizaos_plugin_form::types::FormIntent;

assert_eq!(quick_intent_detect("I'm done"), Some(FormIntent::Submit));
assert_eq!(quick_intent_detect("save for later"), Some(FormIntent::Stash));
assert_eq!(quick_intent_detect("my email is user@example.com"), None); // data, not intent
```

### Using the Service

```rust
use elizaos_plugin_form::service::FormService;
use elizaos_plugin_form::builder::{FormBuilder, ControlBuilder};
use serde_json::json;

let mut svc = FormService::new();

// Register a form
let form = FormBuilder::create("contact")
    .name("Contact Form")
    .control(ControlBuilder::text("name").required())
    .control(ControlBuilder::email("email").required())
    .build();
svc.register_form(form);

// Start a session
let now_ms: i64 = 1_700_000_000_000;
let session_id = svc.start_session("contact", "user-1", "room-1", now_ms).unwrap();

// Fill fields
svc.set_field(&session_id, "name", json!("Alice"), now_ms + 1000).unwrap();
svc.set_field(&session_id, "email", json!("alice@example.com"), now_ms + 2000).unwrap();

// Check readiness and submit
assert!(svc.is_ready(&session_id));
let submission = svc.submit(&session_id, now_ms + 3000).unwrap();
```

## Running Tests

```bash
cargo test
```

## Dependencies

| Crate        | Version | Purpose                                            |
|--------------|---------|----------------------------------------------------|
| `serde`      | 1       | Serialization/deserialization with derive macros    |
| `serde_json` | 1       | JSON value handling                                 |
| `regex`      | 1       | Pattern matching for validation and intent detection|
| `chrono`     | 0.4     | Date parsing and formatting                         |
| `uuid`       | 1       | Session and submission ID generation (v4)           |
| `thiserror`  | 2       | Error type derivation                               |

## License

MIT
