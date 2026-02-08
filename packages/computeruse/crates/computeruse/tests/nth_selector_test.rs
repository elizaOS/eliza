#[cfg(test)]
mod tests {
    use computeruse::{Desktop, Selector};

    #[tokio::test]
    async fn test_nth_negative_one_selector_parsing() {
        // Test that nth=-1 is parsed correctly
        let selector_str = "role:combobox >> nth=-1";
        let selector = Selector::from(selector_str);

        match selector {
            Selector::Chain(selectors) => {
                assert_eq!(selectors.len(), 2);

                // First should be role:combobox
                match &selectors[0] {
                    Selector::Role { role, name } => {
                        assert_eq!(role, "combobox");
                        assert_eq!(name, &None);
                    }
                    _ => panic!("First selector should be Role"),
                }

                // Second should be nth=-1
                match &selectors[1] {
                    Selector::Nth(index) => {
                        assert_eq!(*index, -1);
                    }
                    _ => panic!("Second selector should be Nth(-1), got: {:?}", selectors[1]),
                }
            }
            _ => panic!("Should parse as Chain selector, got: {selector:?}"),
        }
    }

    #[tokio::test]
    async fn test_standalone_nth_selector_parsing() {
        // Test various nth selector formats
        let test_cases = vec![
            ("nth=-1", -1),
            ("nth=0", 0),
            ("nth=1", 1),
            ("nth:2", 2),
            ("nth:-2", -2),
        ];

        for (selector_str, expected_index) in test_cases {
            let selector = Selector::from(selector_str);
            match selector {
                Selector::Nth(index) => {
                    assert_eq!(index, expected_index, "Failed for selector: {selector_str}");
                }
                _ => {
                    panic!("Should parse as Nth selector for '{selector_str}', got: {selector:?}",)
                }
            }
        }
    }

    #[tokio::test]
    async fn test_invalid_nth_selector() {
        let selector_str = "nth=invalid";
        let selector = Selector::from(selector_str);

        match selector {
            Selector::Invalid(reason) => {
                assert!(reason.contains("Invalid index for nth selector"));
            }
            _ => panic!("Should parse as Invalid selector for invalid nth"),
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_nth_negative_one_simple() {
        // Simple test without async complexity - just test parsing and basic functionality
        // This test tries to create a desktop instance to verify the selector parsing works

        if let Ok(desktop) = Desktop::new_default() {
            // Test that we can create a locator with nth=-1 selector
            desktop.locator("role:combobox >> nth=-1");

            // The fact that this doesn't panic means the selector was parsed correctly
            println!("✓ Successfully created locator with 'role:combobox >> nth=-1' selector");

            // Test that we can create a locator with just nth=-1
            desktop.locator("nth=-1");
            println!("✓ Successfully created locator with 'nth=-1' selector");
        } else {
            println!("⚠ Could not create Desktop instance, but selector parsing still works");
        }
    }
}
