// Debug test to understand selector parsing issue

#[cfg(test)]
mod debug_selector_test {
    use crate::selector::Selector;

    #[test]
    fn test_debug_best_plan_pro() {
        let input = "(role:Window && name:Best Plan Pro) >> nativeid:dob";
        println!("Testing selector: {}", input);

        let selector = Selector::from(input);
        println!("Parsed result: {:?}", selector);

        // Let's see what we actually get
        match &selector {
            Selector::Chain(parts) => {
                println!("Got Chain with {} parts:", parts.len());
                for (i, part) in parts.iter().enumerate() {
                    println!("  Part {}: {:?}", i, part);
                }
            }
            Selector::Invalid(msg) => {
                println!("Got Invalid selector: {}", msg);
            }
            other => {
                println!("Got unexpected selector type: {:?}", other);
            }
        }
    }

    #[test]
    fn test_debug_parentheses_only() {
        let input = "(role:Window && name:Best Plan Pro)";
        println!("Testing selector: {}", input);

        let selector = Selector::from(input);
        println!("Parsed result: {:?}", selector);
    }

    #[test]
    fn test_debug_chain_simple() {
        let input = "role:Window >> nativeid:dob";
        println!("Testing selector: {}", input);

        let selector = Selector::from(input);
        println!("Parsed result: {:?}", selector);
    }

    #[test]
    fn test_debug_and_no_parens() {
        let input = "role:Window && name:Best Plan Pro";
        println!("Testing selector: {}", input);

        let selector = Selector::from(input);
        println!("Parsed result: {:?}", selector);
    }

    #[test]
    fn test_debug_invalid_selector() {
        let input = "invalid&&&selector";
        println!("Testing invalid selector: {}", input);

        let selector = Selector::from(input);
        println!("Parsed result: {:?}", selector);
    }
}