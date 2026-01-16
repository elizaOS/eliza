use serde_json::json;
use computeruse_mcp_agent::expression_eval::evaluate;

#[test]
fn test_evaluate_binary_expressions() {
    let vars = json!({
        "use_max_budget": false,
        "coverage_type": "Graded"
    });

    assert!(evaluate("use_max_budget == false", &vars));
    assert!(!evaluate("use_max_budget == true", &vars));
    assert!(evaluate("coverage_type == 'Graded'", &vars));
    assert!(evaluate("coverage_type != 'Standard'", &vars));
}

#[test]
fn test_evaluate_contains() {
    let vars = json!({
        "product_types": ["FEX", "Term"],
        "description": "Final Expense"
    });

    assert!(evaluate("contains(product_types, 'FEX')", &vars));
    assert!(!evaluate("contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("contains(description, 'Expense')", &vars));
}

#[test]
fn test_evaluate_starts_with() {
    let vars = json!({ "name": "John Doe" });
    assert!(evaluate("startsWith(name, 'John')", &vars));
    assert!(!evaluate("startsWith(name, 'Doe')", &vars));
}

#[test]
fn test_evaluate_ends_with() {
    let vars = json!({ "name": "John Doe" });
    assert!(evaluate("endsWith(name, 'Doe')", &vars));
    assert!(!evaluate("endsWith(name, 'John')", &vars));
}

#[test]
fn test_string_with_spaces() {
    let vars = json!({
        "quote_type": "Face Amount"
    });

    assert!(evaluate("quote_type == 'Face Amount'", &vars));
    assert!(!evaluate("quote_type == 'Monthly Amount'", &vars));
}

#[test]
fn test_invalid_expressions() {
    let vars = json!({});
    assert!(!evaluate("invalid expression", &vars)); // Invalid format
    assert!(!evaluate("unsupported(a, b)", &vars)); // Unsupported function
    assert!(!evaluate("var.not.found == true", &vars)); // Variable not found
}

#[test]
fn test_negation_contains() {
    let vars = json!({
        "product_types": ["FEX", "Term"],
        "description": "Final Expense"
    });

    assert!(!evaluate("!contains(product_types, 'FEX')", &vars));
    assert!(evaluate("!contains(product_types, 'MedSup')", &vars));
    assert!(!evaluate("!contains(description, 'Expense')", &vars));
    assert!(evaluate("!contains(description, 'Medical')", &vars));
}

#[test]
fn test_negation_starts_with() {
    let vars = json!({ "name": "John Doe" });
    assert!(!evaluate("!startsWith(name, 'John')", &vars));
    assert!(evaluate("!startsWith(name, 'Doe')", &vars));
}

#[test]
fn test_negation_ends_with() {
    let vars = json!({ "name": "John Doe" });
    assert!(!evaluate("!endsWith(name, 'Doe')", &vars));
    assert!(evaluate("!endsWith(name, 'John')", &vars));
}

#[test]
fn test_negation_binary_expressions() {
    let vars = json!({
        "use_max_budget": false,
        "coverage_type": "Graded",
        "enabled": true
    });

    assert!(!evaluate("!use_max_budget == false", &vars));
    assert!(evaluate("!use_max_budget == true", &vars));
    assert!(!evaluate("!coverage_type == 'Graded'", &vars));
    assert!(evaluate("!coverage_type == 'Standard'", &vars));
    assert!(evaluate("!coverage_type != 'Graded'", &vars));
    assert!(!evaluate("!coverage_type != 'Standard'", &vars));
    assert!(!evaluate("!enabled == true", &vars));
    assert!(evaluate("!enabled == false", &vars));
}

#[test]
fn test_negation_with_whitespace() {
    let vars = json!({
        "product_types": ["FEX", "Term"]
    });

    assert!(evaluate("! contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("!  contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("  !contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("  ! contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("  !  contains(product_types, 'MedSup')  ", &vars));
}

#[test]
fn test_double_negation() {
    let vars = json!({
        "product_types": ["FEX", "Term"]
    });

    assert!(evaluate("!!contains(product_types, 'FEX')", &vars));
    assert!(!evaluate("!!contains(product_types, 'MedSup')", &vars));
}

#[test]
fn test_triple_negation() {
    let vars = json!({
        "product_types": ["FEX", "Term"]
    });

    assert!(!evaluate("!!!contains(product_types, 'FEX')", &vars));
    assert!(evaluate("!!!contains(product_types, 'MedSup')", &vars));
}

#[test]
fn test_negation_with_missing_variables() {
    let vars = json!({});
    assert!(evaluate("!contains(missing_var, 'value')", &vars));
    assert!(evaluate("!missing_var == 'value'", &vars));
    assert!(evaluate("!startsWith(missing_var, 'test')", &vars));
}

#[test]
fn test_negation_edge_cases() {
    let vars = json!({
        "empty_array": [],
        "empty_string": "",
        "null_value": null
    });

    assert!(evaluate("!contains(empty_array, 'anything')", &vars));
    assert!(evaluate("!contains(empty_string, 'anything')", &vars));
    assert!(evaluate("!startsWith(empty_string, 'test')", &vars));
    assert!(evaluate("!endsWith(empty_string, 'test')", &vars));
    assert!(evaluate("!null_value == 'test'", &vars));
}

#[test]
fn test_complex_negation_scenarios() {
    let vars = json!({
        "product_types": ["FEX", "Term", "MedSup"],
        "quote_type": "Face Amount",
        "enabled": true,
        "user_name": "John Smith"
    });

    assert!(!evaluate("!contains(product_types, 'FEX')", &vars));
    assert!(evaluate("!contains(product_types, 'Preneed')", &vars));
    assert!(!evaluate("!quote_type == 'Face Amount'", &vars));
    assert!(evaluate("!quote_type == 'Monthly Amount'", &vars));
    assert!(evaluate("!startsWith(user_name, 'Jane')", &vars));
    assert!(!evaluate("!endsWith(user_name, 'Smith')", &vars));
}

#[test]
fn test_negation_preserves_original_functionality() {
    let vars = json!({
        "product_types": ["FEX", "Term"],
        "quote_type": "Face Amount",
        "enabled": true
    });

    assert!(evaluate("contains(product_types, 'FEX')", &vars));
    assert!(!evaluate("contains(product_types, 'MedSup')", &vars));
    assert!(evaluate("quote_type == 'Face Amount'", &vars));
    assert!(!evaluate("quote_type == 'Monthly Amount'", &vars));
    assert!(evaluate("enabled == true", &vars));
    assert!(!evaluate("enabled == false", &vars));

    assert!(!evaluate("!contains(product_types, 'FEX')", &vars));
    assert!(evaluate("!contains(product_types, 'MedSup')", &vars));
    assert!(!evaluate("!quote_type == 'Face Amount'", &vars));
    assert!(evaluate("!quote_type == 'Monthly Amount'", &vars));
    assert!(!evaluate("!enabled == true", &vars));
    assert!(evaluate("!enabled == false", &vars));
}

#[test]
fn test_always_function() {
    let vars = json!({
        "some_var": "some_value"
    });

    assert!(evaluate("always()", &vars));

    let empty_vars = json!({});
    assert!(evaluate("always()", &empty_vars));

    let null_vars = json!(null);
    assert!(evaluate("always()", &null_vars));
}

#[test]
fn test_always_function_with_whitespace() {
    let vars = json!({});

    assert!(evaluate("always()", &vars));
    assert!(evaluate("always( )", &vars));
    assert!(evaluate("always(  )", &vars));
    assert!(evaluate(" always() ", &vars));
    assert!(evaluate("  always()  ", &vars));
}

#[test]
fn test_always_function_with_arguments_should_fail() {
    let vars = json!({});

    assert!(!evaluate("always(arg)", &vars));
    assert!(!evaluate("always('test')", &vars));
    assert!(!evaluate("always(var1, var2)", &vars));
}

#[test]
fn test_negation_of_always() {
    let vars = json!({});

    assert!(!evaluate("!always()", &vars));
    assert!(!evaluate("! always()", &vars));
    assert!(!evaluate("  !always()  ", &vars));
    assert!(evaluate("!!always()", &vars));
}

#[test]
fn test_simple_boolean_variables() {
    let vars = json!({
        "enabled": true,
        "disabled": false,
        "env": {
            "troubleshooting": false,
            "needs_login": "true"
        }
    });

    assert!(evaluate("enabled", &vars));
    assert!(!evaluate("disabled", &vars));
    assert!(!evaluate("!enabled", &vars));
    assert!(evaluate("!disabled", &vars));
    assert!(!evaluate("env.troubleshooting", &vars));
    assert!(evaluate("!env.troubleshooting", &vars));
    assert!(evaluate(
        "env.needs_login == 'true' && !env.troubleshooting",
        &vars
    ));
    assert!(!evaluate(
        "env.needs_login == 'true' && env.troubleshooting",
        &vars
    ));
}

#[test]
fn test_truthiness_of_different_types() {
    let vars = json!({
        "empty_string": "",
        "non_empty_string": "hello",
        "false_string": "false",
        "zero_string": "0",
        "zero_number": 0,
        "positive_number": 42,
        "negative_number": -1,
        "empty_array": [],
        "non_empty_array": [1, 2, 3],
        "empty_object": {},
        "non_empty_object": {"key": "value"},
        "null_value": null
    });

    assert!(!evaluate("empty_string", &vars));
    assert!(evaluate("non_empty_string", &vars));
    assert!(!evaluate("false_string", &vars));
    assert!(!evaluate("zero_string", &vars));
    assert!(!evaluate("zero_number", &vars));
    assert!(evaluate("positive_number", &vars));
    assert!(evaluate("negative_number", &vars));
    assert!(!evaluate("empty_array", &vars));
    assert!(evaluate("non_empty_array", &vars));
    assert!(!evaluate("empty_object", &vars));
    assert!(evaluate("non_empty_object", &vars));
    assert!(!evaluate("null_value", &vars));
}

#[test]
fn test_smart_quotes_normalization() {
    let vars = json!({
        "env": {
            "needs_login": "true",
            "status": "active"
        }
    });

    // Test with smart single quotes (common from copy-paste)
    assert!(evaluate("env.needs_login == \u{2018}true\u{2019}", &vars)); // Left and right smart singles
    assert!(evaluate("env.needs_login == \u{2019}true\u{2018}", &vars)); // Mixed smart singles
    assert!(evaluate("env.status == \u{2018}active\u{2019}", &vars)); // Smart singles

    // Test with regular quotes still work
    assert!(evaluate("env.needs_login == 'true'", &vars));
    assert!(evaluate("env.status == 'active'", &vars));
}

#[test]
fn test_double_quotes_support() {
    let vars = json!({
        "env": {
            "needs_login": "true",
            "status": "active"
        }
    });

    // Test with double quotes
    assert!(evaluate("env.needs_login == \"true\"", &vars));
    assert!(evaluate("env.status == \"active\"", &vars));

    // Test with smart double quotes
    assert!(evaluate("env.needs_login == \u{201C}true\u{201D}", &vars));
    assert!(evaluate("env.status == \u{201C}active\u{201D}", &vars));
}

#[test]
fn test_type_coercion_string_bool() {
    let vars = json!({
        "string_true": "true",
        "string_false": "false",
        "bool_true": true,
        "bool_false": false,
        "string_one": "1",
        "string_zero": "0"
    });

    // String "true" compared with boolean
    assert!(evaluate("string_true == 'true'", &vars));
    assert!(evaluate("string_false == 'false'", &vars));

    // Boolean compared with string (smart comparison)
    assert!(evaluate("bool_true == 'true'", &vars));
    assert!(evaluate("bool_false == 'false'", &vars));
    assert!(evaluate("bool_true == '1'", &vars));
    assert!(evaluate("bool_false == '0'", &vars));
}

#[test]
fn test_backticks_normalized() {
    let vars = json!({
        "env": {
            "needs_login": "true"
        }
    });

    // Test backticks are converted to single quotes
    assert!(evaluate("env.needs_login == `true`", &vars));
}

#[test]
fn test_unicode_spaces_normalized() {
    let vars = json!({
        "env": {
            "status": "active"
        }
    });

    // Test with non-breaking space (common from web copy)
    assert!(evaluate("env.status\u{00A0}==\u{00A0}'active'", &vars));

    // Test with thin space
    assert!(evaluate("env.status\u{2009}==\u{2009}'active'", &vars));
}

#[test]
fn test_undefined_variables_with_equality() {
    let vars = json!({
        "existing_var": "success"
    });

    // Undefined variable with == should return false
    assert!(!evaluate("undefined_var == 'success'", &vars));
    assert!(!evaluate("undefined_var == 'failed'", &vars));
    assert!(!evaluate("undefined_var == true", &vars));
    assert!(!evaluate("undefined_var == false", &vars));

    // Existing variable should work normally
    assert!(evaluate("existing_var == 'success'", &vars));
    assert!(!evaluate("existing_var == 'failed'", &vars));
}

#[test]
fn test_undefined_variables_with_inequality() {
    let vars = json!({
        "existing_var": "success"
    });

    // Undefined variable with != should return true (undefined is always not equal)
    assert!(evaluate("undefined_var != 'success'", &vars));
    assert!(evaluate("undefined_var != 'failed'", &vars));
    assert!(evaluate("undefined_var != true", &vars));
    assert!(evaluate("undefined_var != false", &vars));

    // Existing variable should work normally
    assert!(!evaluate("existing_var != 'success'", &vars));
    assert!(evaluate("existing_var != 'failed'", &vars));
}

#[test]
fn test_workflow_use_case_undefined_status() {
    // Simulates the actual workflow scenario where click_copy_table_status doesn't exist yet
    let vars = json!({
        "right_click_table_status": "success"
    });

    // This is the condition that was failing: click_copy_table_status != "success"
    // When undefined, should return true (not equal to "success")
    assert!(evaluate("click_copy_table_status != \"success\"", &vars));

    // Once the step runs and succeeds
    let vars_after = json!({
        "right_click_table_status": "success",
        "click_copy_table_status": "success"
    });

    // Now it should return false (is equal to "success")
    assert!(!evaluate(
        "click_copy_table_status != \"success\"",
        &vars_after
    ));
}

#[test]
fn test_numeric_comparisons() {
    let vars = json!({
        "count": 5,
        "price": 10.5,
        "zero": 0,
        "negative": -3
    });

    // Greater than
    assert!(evaluate("count > 3", &vars));
    assert!(!evaluate("count > 10", &vars));
    assert!(evaluate("price > 10", &vars));
    assert!(evaluate("price > 10.0", &vars));

    // Less than
    assert!(evaluate("count < 10", &vars));
    assert!(!evaluate("count < 3", &vars));
    assert!(evaluate("negative < 0", &vars));

    // Greater than or equal
    assert!(evaluate("count >= 5", &vars));
    assert!(evaluate("count >= 3", &vars));
    assert!(!evaluate("count >= 10", &vars));

    // Less than or equal
    assert!(evaluate("count <= 5", &vars));
    assert!(evaluate("count <= 10", &vars));
    assert!(!evaluate("count <= 3", &vars));

    // Zero comparisons (use quotes for equality checks with numbers)
    assert!(evaluate("zero == '0'", &vars));
    assert!(evaluate("zero <= 0", &vars));
    assert!(evaluate("zero >= 0", &vars));
    assert!(!evaluate("zero > 0", &vars));
    assert!(!evaluate("zero < 0", &vars));
}

#[test]
fn test_numeric_comparisons_with_strings() {
    let vars = json!({
        "string_number": "42",
        "string_float": "3.14"
    });

    // String numbers should be parsed and compared
    assert!(evaluate("string_number > 40", &vars));
    assert!(evaluate("string_number < 50", &vars));
    assert!(evaluate("string_number >= 42", &vars));
    assert!(evaluate("string_number <= 42", &vars));

    assert!(evaluate("string_float > 3", &vars));
    assert!(evaluate("string_float < 4", &vars));
}

#[test]
fn test_numeric_comparisons_with_quoted_numbers() {
    let vars = json!({
        "value": 10
    });

    // Quoted numbers on RHS should be parsed
    assert!(evaluate("value > '5'", &vars));
    assert!(evaluate("value < '20'", &vars));
    assert!(evaluate("value >= '10'", &vars));
    assert!(evaluate("value <= '10'", &vars));

    // Double quotes too
    assert!(evaluate("value > \"5\"", &vars));
    assert!(evaluate("value < \"20\"", &vars));
}

#[test]
fn test_workflow_parse_float_use_case() {
    // Simulates the workflow condition: parseFloat(balance_difference || "0") > 0.01
    // Note: The parseFloat is done in JavaScript, so we just test the numeric comparison
    let vars = json!({
        "balance_difference": 0.05
    });

    assert!(evaluate("balance_difference > 0.01", &vars));
    assert!(!evaluate("balance_difference < 0.01", &vars));

    let vars_balanced = json!({
        "balance_difference": 0.0
    });

    assert!(!evaluate("balance_difference > 0.01", &vars_balanced));
}

#[test]
fn test_undefined_variables_with_numeric_comparisons() {
    let vars = json!({});

    // Undefined variable in numeric comparison
    // undefined < anything → true (treat as null/0)
    assert!(evaluate("undefined_var < 10", &vars));
    assert!(evaluate("undefined_var <= 10", &vars));

    // undefined > anything → false
    assert!(!evaluate("undefined_var > 10", &vars));
    assert!(!evaluate("undefined_var >= 10", &vars));
}

#[test]
fn test_boolean_to_number_coercion() {
    let vars = json!({
        "is_true": true,
        "is_false": false
    });

    // true should be treated as 1, false as 0
    assert!(evaluate("is_true > 0", &vars));
    assert!(evaluate("is_true >= 1", &vars));
    assert!(!evaluate("is_true > 1", &vars));

    assert!(!evaluate("is_false > 0", &vars));
    assert!(evaluate("is_false >= 0", &vars));
    assert!(evaluate("is_false <= 0", &vars));
}

#[test]
fn test_null_in_numeric_comparisons() {
    let vars = json!({
        "null_value": null
    });

    // null should be treated as 0
    assert!(!evaluate("null_value > 0", &vars));
    assert!(evaluate("null_value >= 0", &vars));
    assert!(evaluate("null_value <= 0", &vars));
    assert!(evaluate("null_value < 1", &vars));
}
