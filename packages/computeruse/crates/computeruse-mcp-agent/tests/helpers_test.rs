// Import the functions to be tested
use serde_json::json;
use computeruse_mcp_agent::helpers::substitute_variables;

#[test]
fn test_substitute_no_variables() {
    let mut args = json!({"key": "value"});
    let variables = json!({});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "value"}));
}

#[test]
fn test_substitute_simple_string() {
    let mut args = json!({"key": "{{var}}"});
    let variables = json!({"var": "result"});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "result"}));
}

#[test]
fn test_substitute_full_replacement_with_number() {
    let mut args = json!({"key": "{{var}}"});
    let variables = json!({"var": 123});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": 123}));
}

#[test]
fn test_substitute_partial_string() {
    let mut args = json!({"key": "The value is {{var}}"});
    let variables = json!({"var": "test"});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "The value is test"}));
}

#[test]
fn test_substitute_nested_variable() {
    let mut args = json!({"key": "My name is {{person.name}}"});
    let variables = json!({
        "person": {
            "name": "John"
        }
    });
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "My name is John"}));
}

#[test]
fn test_substitute_deeply_nested_variable() {
    let mut args = json!({"key": "The setting is {{config.database.host}}"});
    let variables = json!({
        "config": {
            "database": {
                "host": "localhost"
            }
        }
    });
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "The setting is localhost"}));
}

#[test]
fn test_substitute_in_array() {
    let mut args = json!(["{{a}}", "{{b}}"]);
    let variables = json!({"a": 1, "b": 2});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!([1, 2]));
}

#[test]
fn test_substitute_non_existent_variable() {
    let mut args = json!({"key": "value {{missing}}"});
    let variables = json!({"var": "test"});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "value {{missing}}"}));
}

#[test]
fn test_dot_to_underscore_fallback_is_removed() {
    // This test ensures that the old fallback logic of converting 'person.name' to 'person_name' is no longer active.
    let mut args = json!({"key": "{{person.name}}"});
    let variables = json!({
        "person_name": "Should not be found"
    });
    substitute_variables(&mut args, &variables);
    // The placeholder should remain unchanged because 'person.name' does not exist as a nested structure.
    assert_eq!(args, json!({"key": "{{person.name}}"}));
}

#[test]
fn test_substitute_partial_with_number() {
    let mut args = json!({"key": "The number is {{var}}"});
    let variables = json!({"var": 123});
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "The number is 123"}));
}

#[test]
fn test_substitute_multiple_in_one_string() {
    let mut args = json!({"key": "Hello {{user.name}}, welcome to {{place}}!"});
    let variables = json!({
        "user": { "name": "Alex" },
        "place": "the machine"
    });
    substitute_variables(&mut args, &variables);
    assert_eq!(args, json!({"key": "Hello Alex, welcome to the machine!"}));
}
