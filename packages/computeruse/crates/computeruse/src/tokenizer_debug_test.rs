// Debug test to understand tokenization issue

#[cfg(test)]
mod tokenizer_debug_test {
    use crate::selector::{Token, tokenize};

    #[test]
    fn test_tokenize_simple_and() {
        let input = "role:Window && name:Best Plan Pro";
        println!("Tokenizing: {}", input);

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{}] {:?}", i, token);
                }
            }
            Err(e) => println!("Tokenization error: {}", e),
        }
    }

    #[test]
    fn test_tokenize_with_parentheses() {
        let input = "(role:Window && name:Best Plan Pro)";
        println!("Tokenizing: {}", input);

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{}] {:?}", i, token);
                }
            }
            Err(e) => println!("Tokenization error: {}", e),
        }
    }

    #[test]
    fn test_tokenize_spaces_in_name() {
        let input = "name:Best Plan Pro";
        println!("Tokenizing: {}", input);

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{}] {:?}", i, token);
                }
            }
            Err(e) => println!("Tokenization error: {}", e),
        }
    }
}