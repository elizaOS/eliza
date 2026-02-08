use crate::Selector;

#[test]
fn test_and_operator_should_match_properties_of_same_element() {
    // This is what "role:Document && name:Text editor" should mean:
    // Find elements that have BOTH role=Document AND name="Text editor"

    let sel = Selector::from("role:Document && name:Text editor");

    match &sel {
        Selector::And(parts) => {
            assert_eq!(parts.len(), 2);

            // First part should be Role
            match &parts[0] {
                Selector::Role { role, name } => {
                    assert_eq!(role, "Document");
                    assert_eq!(*name, None);
                }
                _ => panic!("Expected Role selector, got: {:?}", parts[0]),
            }

            // Second part should be Name
            match &parts[1] {
                Selector::Name(n) => {
                    assert_eq!(n, "Text editor");
                }
                _ => panic!("Expected Name selector, got: {:?}", parts[1]),
            }
        }
        _ => panic!("Expected And selector, got: {:?}", sel),
    }
}

#[test]
fn test_role_with_name_pipe_syntax() {
    // The old pipe syntax creates a single Role selector with name
    let sel = Selector::from("role:Document|name:Text editor");

    match &sel {
        Selector::Role { role, name } => {
            assert_eq!(role, "Document");
            assert_eq!(*name, Some("Text editor".to_string()));
        }
        _ => panic!("Expected Role selector with name, got: {:?}", sel),
    }
}

#[test]
fn test_and_should_be_equivalent_to_pipe_for_role_name() {
    // These two should find the same elements:
    // 1. role:Document && name:Text editor
    // 2. role:Document|name:Text editor

    let and_sel = Selector::from("role:Document && name:Text editor");
    let pipe_sel = Selector::from("role:Document|name:Text editor");

    // They parse differently but should match the same elements
    assert!(matches!(and_sel, Selector::And(_)));
    assert!(matches!(pipe_sel, Selector::Role { .. }));

    // The problem: And selector currently finds intersection of two sets:
    // - All Document elements
    // - All elements named "Text editor"
    // But we want elements that are BOTH Document AND named "Text editor"
}

#[test]
fn test_and_with_multiple_properties() {
    // More complex example
    let sel = Selector::from("role:Button && name:Submit && visible:true");

    match &sel {
        Selector::And(parts) => {
            assert_eq!(parts.len(), 3);

            // Should match only buttons that are named "Submit" AND visible
            // Not the intersection of:
            // - All buttons
            // - All elements named "Submit"
            // - All visible elements
        }
        _ => panic!("Expected And selector"),
    }
}

#[test]
fn test_and_operator_with_chain() {
    // AND within a chain
    let sel = Selector::from("role:Window >> (role:Document && name:Text editor)");

    match &sel {
        Selector::Chain(parts) => {
            assert_eq!(parts.len(), 2);

            // First part: Window
            assert!(matches!(parts[0], Selector::Role { .. }));

            // Second part: Document AND name
            match &parts[1] {
                Selector::And(and_parts) => {
                    assert_eq!(and_parts.len(), 2);
                }
                _ => panic!("Expected And in chain"),
            }
        }
        _ => panic!("Expected Chain selector"),
    }
}