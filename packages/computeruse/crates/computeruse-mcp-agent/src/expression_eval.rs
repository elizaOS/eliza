use serde_json::Value;
use tracing::warn;

/// Normalizes an expression by replacing smart quotes and other Unicode characters
/// with their ASCII equivalents to handle copy-paste from various sources.
fn normalize_expression(expr: &str) -> String {
    expr
        // Normalize smart quotes to straight quotes
        .replace(['\u{2018}', '\u{2019}'], "'") // Smart single quotes
        .replace(['\u{201C}', '\u{201D}'], "\"") // Smart double quotes
        .replace('`', "'") // Backticks to single quotes
        // Normalize Unicode spaces
        .replace(['\u{00A0}', '\u{2009}', '\u{202F}'], " ") // Various Unicode spaces
        .trim()
        .to_string()
}

// Helper to get a value from the variables JSON.
pub fn get_value<'a>(path: &str, variables: &'a Value) -> Option<&'a Value> {
    // Support dot notation for nested access
    if !path.contains('.') {
        return variables.get(path); // Fast path for simple keys
    }

    let mut current = variables;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

// Main evaluation function.
pub fn evaluate(expression: &str, variables: &Value) -> bool {
    // Normalize the expression to handle smart quotes and other Unicode characters
    let normalized = normalize_expression(expression);
    evaluate_internal(&normalized, variables)
}

// Internal evaluation function that works with normalized expressions
fn evaluate_internal(expression: &str, variables: &Value) -> bool {
    // Trim whitespace
    let expr = expression.trim();

    // Handle negation operator
    if let Some(inner_expr) = expr.strip_prefix('!') {
        let inner_expr = inner_expr.trim();
        return !evaluate_internal(inner_expr, variables);
    }

    // Handle logical operators (&&, ||) with proper precedence
    if let Some(pos) = expr.find("&&") {
        let left = &expr[..pos].trim();
        let right = &expr[pos + 2..].trim();
        return evaluate_internal(left, variables) && evaluate_internal(right, variables);
    }

    if let Some(pos) = expr.find("||") {
        let left = &expr[..pos].trim();
        let right = &expr[pos + 2..].trim();
        return evaluate_internal(left, variables) || evaluate_internal(right, variables);
    }

    // Try parsing function-based expressions first, e.g., contains(vars, 'value')
    if let Some(result) = parse_and_evaluate_function(expr, variables) {
        return result;
    }

    // Fallback to simple binary expressions, e.g., vars == 'value'
    if let Some(result) = parse_and_evaluate_binary_expression(expr, variables) {
        return result;
    }

    // Handle literal boolean values
    if expr == "true" {
        return true;
    }
    if expr == "false" {
        return false;
    }

    // Handle simple variable references (evaluate to their boolean truthiness)
    // This allows expressions like "env.troubleshooting" or "!env.troubleshooting"
    // where troubleshooting is a boolean
    if let Some(value) = get_value(expr, variables) {
        return match value {
            Value::Bool(b) => *b,
            Value::String(s) => !s.is_empty() && s != "false" && s != "0",
            Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
            Value::Null => false,
            Value::Array(arr) => !arr.is_empty(),
            Value::Object(obj) => !obj.is_empty(),
        };
    }

    warn!(
        "Could not parse expression: '{}'. Defaulting to false.",
        expression
    );
    false
}

// Parses expressions like "contains(policy.product_types, 'FEX')"
fn parse_and_evaluate_function(expr: &str, variables: &Value) -> Option<bool> {
    let (func_name, args_str) = expr.split_once('(')?;
    if !args_str.ends_with(')') {
        return None;
    }
    let args_str = &args_str[..args_str.len() - 1]; // Remove trailing ')'

    match func_name.trim() {
        "always" => {
            // always() function takes no arguments and always returns true
            if args_str.trim().is_empty() {
                Some(true)
            } else {
                None // always() should not have arguments
            }
        }
        _ => {
            // For other functions, we need exactly 2 arguments
            let args: Vec<&str> = args_str.split(',').map(|s| s.trim()).collect();
            if args.len() != 2 {
                return None;
            }

            let val1 = get_value(args[0], variables)?;
            let val2_str = args[1].trim_matches('\''); // Remove single quotes

            match func_name.trim() {
                "contains" => Some(evaluate_contains(val1, val2_str)),
                "startsWith" => Some(val1.as_str()?.starts_with(val2_str)),
                "endsWith" => Some(val1.as_str()?.ends_with(val2_str)),
                _ => None,
            }
        }
    }
}

// Evaluates the 'contains' function for different types.
fn evaluate_contains(collection: &Value, item: &str) -> bool {
    match collection {
        Value::Array(arr) => arr.iter().any(|v| v.as_str() == Some(item)),
        Value::String(s) => s.contains(item),
        _ => false,
    }
}

// Parses simple expressions like "variable == 'value'" or "variable == true"
fn parse_and_evaluate_binary_expression(expr: &str, variables: &Value) -> Option<bool> {
    // Try to parse comparison operators in order of longest first to avoid partial matches
    let (var_path, op, raw_rhs) = if let Some(pos) = expr.find(">=") {
        (&expr[..pos], ">=", &expr[pos + 2..])
    } else if let Some(pos) = expr.find("<=") {
        (&expr[..pos], "<=", &expr[pos + 2..])
    } else if let Some(pos) = expr.find("==") {
        (&expr[..pos], "==", &expr[pos + 2..])
    } else if let Some(pos) = expr.find("!=") {
        (&expr[..pos], "!=", &expr[pos + 2..])
    } else if let Some(pos) = expr.find('>') {
        (&expr[..pos], ">", &expr[pos + 1..])
    } else if let Some(pos) = expr.find('<') {
        (&expr[..pos], "<", &expr[pos + 1..])
    } else {
        return None;
    };

    let var_path = var_path.trim();
    let raw_rhs = raw_rhs.trim();

    // Try to get the left-hand side value
    // Check if LHS is a coalesce() function call
    let lhs = if var_path.contains("coalesce(") {
        evaluate_coalesce_to_value(var_path, variables)
    } else {
        get_value(var_path, variables).cloned()
    };

    // Handle undefined variables gracefully
    if lhs.is_none() {
        // For equality operators, undefined is never equal to anything
        // For inequality operators, undefined is always not equal to anything
        // For numeric comparisons, undefined is treated as less than any value
        return Some(match op {
            "==" => false, // undefined == anything → false
            "!=" => true,  // undefined != anything → true
            ">" => false,  // undefined > anything → false
            "<" => true,   // undefined < anything → true (treat as 0 or null)
            ">=" => false, // undefined >= anything → false
            "<=" => true,  // undefined <= anything → true
            _ => false,
        });
    }

    let lhs = &lhs.unwrap();

    // For equality/inequality operators, use smart comparison
    if op == "==" || op == "!=" {
        let are_equal = match raw_rhs {
            "true" => lhs.as_bool() == Some(true),
            "false" => lhs.as_bool() == Some(false),
            _ if raw_rhs.starts_with('\'') && raw_rhs.ends_with('\'') => {
                let rhs_str = raw_rhs.trim_matches('\'');
                compare_values_smart(lhs, rhs_str)
            }
            _ if raw_rhs.starts_with('"') && raw_rhs.ends_with('"') => {
                let rhs_str = raw_rhs.trim_matches('"');
                compare_values_smart(lhs, rhs_str)
            }
            _ => {
                // Try as bare number or literal
                compare_values_smart(lhs, raw_rhs)
            }
        };

        return match op {
            "==" => Some(are_equal),
            "!=" => Some(!are_equal),
            _ => None,
        };
    }

    // For numeric comparison operators (>, <, >=, <=)
    // Only numeric operators reach here, equality operators already returned

    // Try to extract numeric value from LHS
    let lhs_num = match lhs {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        Value::Null => Some(0.0),
        _ => None,
    };

    // Try to extract numeric value from RHS
    let rhs_num = if raw_rhs == "true" {
        Some(1.0)
    } else if raw_rhs == "false" || raw_rhs == "null" {
        Some(0.0)
    } else if raw_rhs.starts_with('\'') && raw_rhs.ends_with('\'') {
        raw_rhs.trim_matches('\'').parse::<f64>().ok()
    } else if raw_rhs.starts_with('"') && raw_rhs.ends_with('"') {
        raw_rhs.trim_matches('"').parse::<f64>().ok()
    } else {
        // Try parsing as bare number
        raw_rhs.parse::<f64>().ok()
    };

    // Both sides must be numeric for comparison
    if let (Some(l), Some(r)) = (lhs_num, rhs_num) {
        return Some(match op {
            ">" => l > r,
            "<" => l < r,
            ">=" => l >= r,
            "<=" => l <= r,
            _ => false,
        });
    }

    // If we can't parse as numbers, the comparison fails
    None
}

// Smart comparison that handles type coercion between strings and booleans
fn compare_values_smart(lhs: &Value, rhs_str: &str) -> bool {
    match lhs {
        Value::String(s) => s == rhs_str,
        Value::Bool(true) => rhs_str == "true" || rhs_str == "1",
        Value::Bool(false) => rhs_str == "false" || rhs_str == "0",
        Value::Number(n) => rhs_str.parse::<f64>().ok() == Some(n.as_f64().unwrap_or(0.0)),
        _ => false,
    }
}

/// Helper to check if a value is truthy
fn is_truthy(val: &Value) -> bool {
    match val {
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty() && s != "false" && s != "0",
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::Null => false,
        Value::Array(arr) => !arr.is_empty(),
        Value::Object(obj) => !obj.is_empty(),
    }
}

/// Helper to parse a literal string as a Value
fn parse_literal_value(literal: &str) -> Value {
    // Try parsing as number
    if let Ok(n) = literal.parse::<i64>() {
        return Value::Number(n.into());
    }
    if let Ok(n) = literal.parse::<f64>() {
        if let Some(num) = serde_json::Number::from_f64(n) {
            return Value::Number(num);
        }
    }

    // Parse as boolean
    match literal {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => Value::String(literal.to_string()),
    }
}

/// Evaluates coalesce() and returns the actual Value
/// Returns the first truthy value from variables, or the last argument as default
fn evaluate_coalesce_to_value(expr: &str, variables: &Value) -> Option<Value> {
    // Extract function call: "coalesce(x, y, z, default)"
    let func_start = expr.find("coalesce(")?;
    let args_start = func_start + "coalesce(".len();
    let args_end = expr[args_start..].find(')')?;
    let args_str = &expr[args_start..args_start + args_end];

    let args: Vec<&str> = args_str.split(',').map(|s| s.trim()).collect();

    if args.len() < 2 {
        return None;
    }

    // coalesce(a, b, c, default) semantics:
    // - Check ALL arguments (including last) as potential variables
    // - Return the first one that exists AND is truthy
    // - If none are truthy, return the last argument (as variable or literal)

    for arg in &args {
        if let Some(val) = get_value(arg, variables) {
            // Variable exists - check if it's truthy
            if is_truthy(val) {
                return Some(val.clone());
            }
            // Variable exists but is falsy - continue to next argument
        }
        // Variable doesn't exist - continue to next argument
    }

    // No truthy variables found, use last argument as default
    let default_arg = args.last()?.trim_matches(|c| c == '\'' || c == '"');

    // Try as variable first (might be a falsy variable that we'll return anyway)
    if let Some(val) = get_value(default_arg, variables) {
        return Some(val.clone());
    }

    // Not a variable, parse as literal
    Some(parse_literal_value(default_arg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_coalesce_basic() {
        let vars = json!({"x": 5});
        assert!(evaluate("coalesce(x, 0) > 0", &vars));

        let vars = json!({});
        assert!(!evaluate("coalesce(x, 0) > 0", &vars));
    }

    #[test]
    fn test_coalesce_with_undefined() {
        let vars = json!({});
        assert!(!evaluate("coalesce(missing, 0) > 5", &vars));
        assert!(evaluate("coalesce(missing, 10) > 5", &vars));
    }

    #[test]
    fn test_coalesce_string_default() {
        let vars = json!({"status": null});
        assert!(evaluate("coalesce(status, 'pending') == 'pending'", &vars));

        let vars = json!({});
        assert!(evaluate("coalesce(status, 'pending') == 'pending'", &vars));
    }

    #[test]
    fn test_coalesce_multiple_args() {
        let vars = json!({"a": null, "b": 0, "c": 5});
        // coalesce(a, b, c, 10) should return c (first truthy)
        assert!(evaluate("coalesce(a, b, c, 10) == 5", &vars));
    }

    #[test]
    fn test_coalesce_all_falsy() {
        let vars = json!({"a": null, "b": 0, "c": false});
        // All falsy, should use default (100)
        assert!(evaluate("coalesce(a, b, c, 100) == 100", &vars));
    }

    #[test]
    fn test_coalesce_first_truthy() {
        let vars = json!({"a": null, "b": 42, "c": 5});
        // Should return b (first truthy)
        assert!(evaluate("coalesce(a, b, c, 10) == 42", &vars));
    }

    #[test]
    fn test_coalesce_with_numeric_comparison() {
        let vars = json!({"fields_checked": 3});
        assert!(evaluate("coalesce(fields_checked, 0) > 0", &vars));

        let vars = json!({});
        assert!(!evaluate("coalesce(fields_checked, 0) > 0", &vars));
    }

    #[test]
    fn test_coalesce_with_string_comparison() {
        let vars = json!({"status": "executed_without_error"});
        assert!(evaluate(
            "coalesce(status, 'pending') == 'executed_without_error'",
            &vars
        ));

        let vars = json!({});
        assert!(evaluate("coalesce(status, 'pending') == 'pending'", &vars));
    }

    #[test]
    fn test_coalesce_inequality() {
        let vars = json!({"retry_count": 5});
        assert!(!evaluate("coalesce(retry_count, 0) < 3", &vars));

        let vars = json!({});
        assert!(evaluate("coalesce(retry_count, 0) < 3", &vars));
    }

    #[test]
    fn test_coalesce_with_logical_operators() {
        let vars = json!({"x": 5, "y": null});
        assert!(evaluate("coalesce(x, 0) > 0 && coalesce(y, 10) > 5", &vars));
    }

    #[test]
    fn test_coalesce_empty_string_is_falsy() {
        let vars = json!({"status": ""});
        // Empty string is falsy, should use default
        assert!(evaluate("coalesce(status, 'default') == 'default'", &vars));
    }

    #[test]
    fn test_coalesce_zero_is_falsy() {
        let vars = json!({"count": 0});
        // Zero is falsy, should use default
        assert!(evaluate("coalesce(count, 10) == 10", &vars));
    }

    #[test]
    fn test_coalesce_false_is_falsy() {
        let vars = json!({"flag": false});
        // False is falsy, should use default
        assert!(evaluate("coalesce(flag, true) == true", &vars));
    }
}
