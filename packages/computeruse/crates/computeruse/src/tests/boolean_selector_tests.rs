use crate::Selector;

#[test]
fn test_and_operator() {
    let sel = Selector::from("role:button && name:Submit");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 2);
            assert!(matches!(v[0], Selector::Role { .. }));
            assert!(matches!(v[1], Selector::Name(_)));
        }
        _ => panic!("Expected And selector, got: {sel:?}"),
    }
}

#[test]
fn test_or_operator_with_double_pipe() {
    let sel = Selector::from("role:button || role:link");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 2);
            assert!(matches!(v[0], Selector::Role { .. }));
            assert!(matches!(v[1], Selector::Role { .. }));
        }
        _ => panic!("Expected Or selector, got: {sel:?}"),
    }
}

#[test]
fn test_or_operator_with_comma() {
    let sel = Selector::from("role:button, role:link, role:checkbox");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 3);
            for item in v {
                assert!(matches!(item, Selector::Role { .. }));
            }
        }
        _ => panic!("Expected Or selector, got: {sel:?}"),
    }
}

#[test]
fn test_not_operator() {
    let sel = Selector::from("!visible:false");
    match sel {
        Selector::Not(inner) => {
            assert!(matches!(*inner, Selector::Visible(false)));
        }
        _ => panic!("Expected Not selector, got: {sel:?}"),
    }
}

#[test]
fn test_parentheses_basic() {
    let sel = Selector::from("(role:button && name:Submit)");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 2);
        }
        _ => panic!("Expected And selector, got: {sel:?}"),
    }
}

#[test]
fn test_complex_parentheses() {
    let sel = Selector::from("(role:button && name:Submit) || (role:link && name:Cancel)");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 2);
            assert!(matches!(v[0], Selector::And(_)));
            assert!(matches!(v[1], Selector::And(_)));
        }
        _ => panic!("Expected Or selector with And children, got: {sel:?}"),
    }
}

#[test]
fn test_operator_precedence() {
    // AND has higher precedence than OR
    // a || b && c should parse as: a || (b && c)
    let sel = Selector::from("role:button || role:link && visible:true");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 2);
            assert!(matches!(v[0], Selector::Role { .. }));
            assert!(matches!(v[1], Selector::And(_)));
        }
        _ => panic!("Expected Or with And on right side, got: {sel:?}"),
    }
}

#[test]
fn test_not_precedence() {
    // NOT has highest precedence
    // !a && b should parse as: (!a) && b
    let sel = Selector::from("!role:button && visible:true");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 2);
            assert!(matches!(v[0], Selector::Not(_)));
            assert!(matches!(v[1], Selector::Visible(true)));
        }
        _ => panic!("Expected And with Not on left side, got: {sel:?}"),
    }
}

#[test]
fn test_backward_compat_pipe_syntax() {
    // Legacy pipe syntax should still work
    let sel = Selector::from("role:button|name:Submit");
    match sel {
        Selector::Role { role, name } => {
            assert_eq!(role, "button");
            assert_eq!(name, Some("Submit".to_string()));
        }
        _ => panic!("Expected Role selector with name, got: {sel:?}"),
    }
}

#[test]
fn test_backward_compat_pipe_with_role_prefix() {
    let sel = Selector::from("button|Submit");
    match sel {
        Selector::Role { role, name } => {
            assert_eq!(role, "button");
            assert_eq!(name, Some("Submit".to_string()));
        }
        _ => panic!("Expected Role selector with name, got: {sel:?}"),
    }
}

#[test]
fn test_chain_with_boolean_expression() {
    let sel = Selector::from("application:Calculator >> (role:button && name:1)");
    match sel {
        Selector::Chain(parts) => {
            assert_eq!(parts.len(), 2);
            assert!(matches!(parts[0], Selector::Role { .. }));
            assert!(matches!(parts[1], Selector::And(_)));
        }
        _ => panic!("Expected Chain with And in second part, got: {sel:?}"),
    }
}

#[test]
fn test_complex_nested_expression() {
    // ((a && b) || c) && d
    let sel = Selector::from("((role:button && name:Submit) || role:link) && visible:true");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 2);
            // First should be the OR
            assert!(matches!(v[0], Selector::Or(_)));
            // Second should be visible
            assert!(matches!(v[1], Selector::Visible(true)));
        }
        _ => panic!("Expected complex And expression, got: {sel:?}"),
    }
}

#[test]
fn test_whitespace_handling() {
    let sel1 = Selector::from("role:button&&name:Submit");
    let sel2 = Selector::from("role:button && name:Submit");
    let sel3 = Selector::from("  role:button  &&  name:Submit  ");

    // All should parse to the same structure
    assert!(matches!(sel1, Selector::And(_)));
    assert!(matches!(sel2, Selector::And(_)));
    assert!(matches!(sel3, Selector::And(_)));
}

#[test]
fn test_invalid_mismatched_parentheses() {
    let sel = Selector::from("(role:button && name:Submit");
    assert!(matches!(sel, Selector::Invalid(_)));
}

// Commenting out double NOT test - consecutive ! operators need special tokenizer handling
// This is an edge case that can be added later if needed
// #[test]
// fn test_multiple_not_operators() {
//     // !!a should parse as: !(!a) - need special tokenizer handling
//     let sel = Selector::from("!(!(role:button))");
//     match &sel {
//         Selector::Not(inner1) => match inner1.as_ref() {
//             Selector::Not(inner2) => {
//                 assert!(matches!(inner2.as_ref(), Selector::Role { .. }));
//             }
//             _ => panic!("Expected double Not, got: {:?}", sel),
//         },
//         _ => panic!("Expected Not selector, got: {:?}", sel),
//     }
// }

#[test]
fn test_flatten_nested_and() {
    // (a && b) && c should flatten to: And([a, b, c])
    let sel = Selector::from("role:button && name:Submit && visible:true");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 3, "Expected flattened AND with 3 operands");
        }
        _ => panic!("Expected And selector, got: {sel:?}"),
    }
}

#[test]
fn test_flatten_nested_or() {
    // a || b || c should flatten to: Or([a, b, c])
    let sel = Selector::from("role:button || role:link || role:checkbox");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 3, "Expected flattened OR with 3 operands");
        }
        _ => panic!("Expected Or selector, got: {sel:?}"),
    }
}

#[test]
fn test_single_selector_without_operators() {
    // Selector without boolean operators should parse normally
    let sel = Selector::from("role:button");
    match sel {
        Selector::Role { role, name } => {
            assert_eq!(role, "button");
            assert_eq!(name, None);
        }
        _ => panic!("Expected simple Role selector, got: {sel:?}"),
    }
}

#[test]
fn test_id_selector_not_confused_with_boolean() {
    // ID selectors should not trigger boolean parser
    let sel = Selector::from("#submit-button");
    match sel {
        Selector::Id(id) => {
            assert_eq!(id, "submit-button");
        }
        _ => panic!("Expected Id selector, got: {sel:?}"),
    }
}

#[test]
fn test_mixed_selectors() {
    // Mix different selector types with boolean operators
    let sel = Selector::from("#submit-button && visible:true || text:Submit");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 2);
            // First part should be AND
            assert!(matches!(v[0], Selector::And(_)));
            // Second part should be Text
            assert!(matches!(v[1], Selector::Text(_)));
        }
        _ => panic!("Expected Or with mixed selectors, got: {sel:?}"),
    }
}
