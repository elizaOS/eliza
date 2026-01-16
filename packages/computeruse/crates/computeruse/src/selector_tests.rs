use super::*;

#[test]
fn test_basic_role_selector() {
    let selector = Selector::from("role:Button");
    match selector {
        Selector::Role { role, name } => {
            assert_eq!(role, "Button");
            assert_eq!(name, None);
        }
        _ => panic!("Expected Role selector"),
    }
}

#[test]
fn test_role_with_name() {
    // Use && syntax instead of deprecated | syntax
    let selector = Selector::from("role:Button && name:Calculate");
    match selector {
        Selector::And(selectors) => {
            assert_eq!(selectors.len(), 2);
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector"),
            }
            match &selectors[1] {
                Selector::Name(name) => assert_eq!(name, "Calculate"),
                _ => panic!("Expected Name selector"),
            }
        }
        _ => panic!("Expected And selector"),
    }
}

#[test]
fn test_and_selector() {
    let selector = Selector::from("role:Button && name:Calculate");
    match selector {
        Selector::And(selectors) => {
            assert_eq!(selectors.len(), 2);
            // First should be role:Button
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector"),
            }
            // Second should be name:Calculate
            match &selectors[1] {
                Selector::Name(name) => assert_eq!(name, "Calculate"),
                _ => panic!("Expected Name selector"),
            }
        }
        _ => panic!("Expected And selector, got: {selector:?}"),
    }
}

#[test]
fn test_or_selector() {
    let selector = Selector::from("role:Button || role:Link");
    match selector {
        Selector::Or(selectors) => {
            assert_eq!(selectors.len(), 2);
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector"),
            }
            match &selectors[1] {
                Selector::Role { role, .. } => assert_eq!(role, "Link"),
                _ => panic!("Expected Role selector"),
            }
        }
        _ => panic!("Expected Or selector"),
    }
}

#[test]
fn test_parentheses_with_and() {
    let selector = Selector::from("(role:Window && name:Calculator)");
    match selector {
        Selector::And(selectors) => {
            assert_eq!(selectors.len(), 2);
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Window"),
                _ => panic!("Expected Role selector"),
            }
            match &selectors[1] {
                Selector::Name(name) => assert_eq!(name, "Calculator"),
                _ => panic!("Expected Name selector"),
            }
        }
        _ => panic!("Expected And selector"),
    }
}

#[test]
fn test_chain_selector() {
    let selector = Selector::from("role:Window >> role:Button");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Window"),
                _ => panic!("Expected Role selector"),
            }
            match &selectors[1] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}

#[test]
fn test_chain_with_parentheses_and_boolean() {
    // This is the problematic case
    let selector = Selector::from("(role:Window && name:Calculator) >> role:Button");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            // First part should be an AND selector
            match &selectors[0] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Window"),
                        _ => panic!("Expected Role selector in AND"),
                    }
                    match &and_parts[1] {
                        Selector::Name(name) => assert_eq!(name, "Calculator"),
                        _ => panic!("Expected Name selector in AND"),
                    }
                }
                _ => panic!("Expected And selector as first part of chain"),
            }
            // Second part should be role:Button
            match &selectors[1] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector as second part of chain"),
            }
        }
        _ => panic!("Expected Chain selector, got: {selector:?}"),
    }
}

#[test]
fn test_complex_chain_with_multiple_boolean() {
    let selector = Selector::from("(role:Window && name:Calculator) >> (role:Button && name:Plus)");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            // Both parts should be AND selectors
            match &selectors[0] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                }
                _ => panic!("Expected And selector as first part"),
            }
            match &selectors[1] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                }
                _ => panic!("Expected And selector as second part"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}

#[test]
fn test_nativeid_selector() {
    let selector = Selector::from("nativeid:button-plus");
    match selector {
        Selector::NativeId(id) => {
            assert_eq!(id, "button-plus");
        }
        _ => panic!("Expected NativeId selector"),
    }
}

#[test]
fn test_chain_with_nativeid() {
    let selector = Selector::from("(role:Window && name:Calculator) >> nativeid:button-plus");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            // First part should be AND
            match &selectors[0] {
                Selector::And(_) => {}
                _ => panic!("Expected And selector as first part"),
            }
            // Second part should be nativeid
            match &selectors[1] {
                Selector::NativeId(id) => assert_eq!(id, "button-plus"),
                _ => panic!("Expected NativeId selector as second part"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}

#[test]
fn test_nth_selector() {
    let selector = Selector::from("role:Button >> nth:2");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            match &selectors[1] {
                Selector::Nth(n) => assert_eq!(*n, 2),
                _ => panic!("Expected Nth selector"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}

#[test]
fn test_not_selector() {
    let selector = Selector::from("!name:Cancel");
    match selector {
        Selector::Not(inner) => match inner.as_ref() {
            Selector::Name(name) => assert_eq!(name, "Cancel"),
            _ => panic!("Expected Name selector inside Not"),
        },
        _ => panic!("Expected Not selector"),
    }
}

#[test]
fn test_complex_boolean_expression() {
    let selector = Selector::from("(role:Button && name:OK) || (role:Link && name:Submit)");
    match selector {
        Selector::Or(or_parts) => {
            assert_eq!(or_parts.len(), 2);
            // Both parts should be AND selectors
            match &or_parts[0] {
                Selector::And(and_parts) => assert_eq!(and_parts.len(), 2),
                _ => panic!("Expected And selector in first OR part"),
            }
            match &or_parts[1] {
                Selector::And(and_parts) => assert_eq!(and_parts.len(), 2),
                _ => panic!("Expected And selector in second OR part"),
            }
        }
        _ => panic!("Expected Or selector at top level"),
    }
}

#[test]
fn test_text_selector() {
    let selector = Selector::from("text:Calculate");
    match selector {
        Selector::Text(text) => assert_eq!(text, "Calculate"),
        _ => panic!("Expected Text selector"),
    }
}

#[test]
fn test_text_selector_with_special_chars() {
    // Test that text: selector works with parentheses, exclamation marks, etc.
    let selector = Selector::from("text:Test 1: DEFAULT (focus+click) SUCCESS!");
    match selector {
        Selector::Text(text) => assert_eq!(text, "Test 1: DEFAULT (focus+click) SUCCESS!"),
        _ => panic!("Expected Text selector, got {selector:?}"),
    }
}

#[test]
fn test_text_selector_with_comma() {
    let selector = Selector::from("text:Hello, world!");
    match selector {
        Selector::Text(text) => assert_eq!(text, "Hello, world!"),
        _ => panic!("Expected Text selector, got {selector:?}"),
    }
}

#[test]
fn test_id_selector_with_hash() {
    let selector = Selector::from("#button-123");
    match selector {
        Selector::Id(id) => assert_eq!(id, "button-123"),
        _ => panic!("Expected Id selector"),
    }
}

#[test]
fn test_visible_selector() {
    let selector = Selector::from("visible:true");
    match selector {
        Selector::Visible(v) => assert!(v),
        _ => panic!("Expected Visible selector"),
    }
}

#[test]
fn test_classname_selector() {
    let selector = Selector::from("classname:btn-primary");
    match selector {
        Selector::ClassName(class) => assert_eq!(class, "btn-primary"),
        _ => panic!("Expected ClassName selector"),
    }
}

#[test]
fn test_comma_as_or() {
    let selector = Selector::from("role:Button, role:Link");
    match selector {
        Selector::Or(selectors) => {
            assert_eq!(selectors.len(), 2);
        }
        _ => panic!("Expected Or selector from comma"),
    }
}

#[test]
fn test_invalid_selector() {
    // Test various invalid patterns
    // Empty selector after &&
    let selector = Selector::from("role:Button &&");
    match selector {
        Selector::Invalid(msg) => {
            assert!(
                msg.contains("Parse error")
                    || msg.contains("Unknown selector")
                    || msg.contains("Expected selector")
            );
        }
        _ => panic!("Expected Invalid selector for trailing &&"),
    }

    // Unbalanced parentheses
    let selector2 = Selector::from("(role:Button && name:Test");
    match selector2 {
        Selector::Invalid(msg) => {
            assert!(msg.contains("Unmatched") || msg.contains("parenthes"));
        }
        _ => panic!("Expected Invalid selector for unbalanced parens"),
    }
}

#[test]
fn test_best_plan_pro_selector() {
    // Test the actual problematic selector from Best Plan Pro
    let selector = Selector::from("(role:Window && name:Best Plan Pro) >> nativeid:dob");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);
            // First part: parenthesized AND
            match &selectors[0] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Window"),
                        _ => panic!("Expected Role selector"),
                    }
                    match &and_parts[1] {
                        Selector::Name(name) => assert_eq!(name, "Best Plan Pro"),
                        _ => panic!("Expected Name selector"),
                    }
                }
                _ => panic!("Expected And selector"),
            }
            // Second part: nativeid
            match &selectors[1] {
                Selector::NativeId(id) => assert_eq!(id, "dob"),
                _ => panic!("Expected NativeId selector"),
            }
        }
        Selector::Invalid(msg) => {
            panic!("Selector parsing failed with: {msg}");
        }
        _ => panic!("Expected Chain selector, got: {selector:?}"),
    }
}

#[test]
fn test_chained_and_with_role_and_nativeid() {
    // Test: "(role:Window && name:Best Plan Pro) >> (role:Edit && nativeid:dob)"
    let selector =
        Selector::from("(role:Window && name:Best Plan Pro) >> (role:Edit && nativeid:dob)");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);

            // First part: (role:Window && name:Best Plan Pro)
            match &selectors[0] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Window"),
                        _ => panic!("Expected Role selector in first AND"),
                    }
                    match &and_parts[1] {
                        Selector::Name(name) => assert_eq!(name, "Best Plan Pro"),
                        _ => panic!("Expected Name selector in first AND"),
                    }
                }
                _ => panic!("Expected first chain element to be And selector"),
            }

            // Second part: (role:Edit && nativeid:dob)
            match &selectors[1] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Edit"),
                        _ => panic!("Expected Role selector in second AND"),
                    }
                    match &and_parts[1] {
                        Selector::NativeId(id) => assert_eq!(id, "dob"),
                        _ => panic!("Expected NativeId selector in second AND"),
                    }
                }
                _ => panic!("Expected second chain element to be And selector"),
            }
        }
        Selector::Invalid(msg) => {
            panic!("Selector parsing failed with: {msg}");
        }
        _ => panic!("Expected Chain selector, got: {selector:?}"),
    }
}

#[test]
fn test_calculator_window_selector() {
    let selector = Selector::from("(role:Window && name:Calculator)");
    match selector {
        Selector::And(selectors) => {
            assert_eq!(selectors.len(), 2);
        }
        _ => panic!("Expected And selector"),
    }
}

#[test]
fn test_multiple_and_conditions() {
    let selector = Selector::from("role:Button && name:Plus && visible:true");
    match selector {
        Selector::And(selectors) => {
            assert_eq!(selectors.len(), 3);
            match &selectors[0] {
                Selector::Role { role, .. } => assert_eq!(role, "Button"),
                _ => panic!("Expected Role selector"),
            }
            match &selectors[1] {
                Selector::Name(name) => assert_eq!(name, "Plus"),
                _ => panic!("Expected Name selector"),
            }
            match &selectors[2] {
                Selector::Visible(v) => assert!(v),
                _ => panic!("Expected Visible selector"),
            }
        }
        _ => panic!("Expected And selector with 3 conditions"),
    }
}

#[test]
fn test_calculator_chain_with_parentheses_runtime() {
    // This is the exact selector pattern that failed at runtime with Calculator
    // Original error: Role: '(role', Name: Some("Window && name:Calculator)")
    let selector =
        Selector::from("(role:Window && name:Calculator) >> (role:Custom && nativeid:NavView)");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 2);

            // First part: (role:Window && name:Calculator)
            match &selectors[0] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Window"),
                        _ => panic!("Expected Role selector for Window, got: {:?}", and_parts[0]),
                    }
                    match &and_parts[1] {
                        Selector::Name(name) => assert_eq!(name, "Calculator"),
                        _ => panic!(
                            "Expected Name selector for Calculator, got: {:?}",
                            and_parts[1]
                        ),
                    }
                }
                _ => panic!(
                    "Expected And selector for first chain part, got: {:?}",
                    selectors[0]
                ),
            }

            // Second part: (role:Custom && nativeid:NavView)
            match &selectors[1] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                    match &and_parts[0] {
                        Selector::Role { role, .. } => assert_eq!(role, "Custom"),
                        _ => panic!("Expected Role selector for Custom, got: {:?}", and_parts[0]),
                    }
                    match &and_parts[1] {
                        Selector::NativeId(id) => assert_eq!(id, "NavView"),
                        _ => panic!(
                            "Expected NativeId selector for NavView, got: {:?}",
                            and_parts[1]
                        ),
                    }
                }
                _ => panic!(
                    "Expected And selector for second chain part, got: {:?}",
                    selectors[1]
                ),
            }
        }
        Selector::Invalid(msg) => {
            panic!("Selector parsing failed with error: {msg}");
        }
        _ => panic!("Expected Chain selector, got: {selector:?}"),
    }
}

#[test]
fn test_nested_parentheses() {
    let selector = Selector::from("((role:Button && name:OK) || (role:Link && name:Submit))");
    match selector {
        Selector::Or(or_parts) => {
            assert_eq!(or_parts.len(), 2);
        }
        _ => panic!("Expected Or selector"),
    }
}

#[test]
fn test_chain_with_multiple_operators() {
    let selector = Selector::from("role:Window >> role:Group >> (role:Button && name:Calculate)");
    match selector {
        Selector::Chain(selectors) => {
            assert_eq!(selectors.len(), 3);
            // Third part should be AND
            match &selectors[2] {
                Selector::And(and_parts) => assert_eq!(and_parts.len(), 2),
                _ => panic!("Expected And selector as third part"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}
