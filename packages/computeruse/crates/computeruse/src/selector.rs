use std::collections::BTreeMap;

/// Represents ways to locate a UI element
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Selector {
    /// Select by role and optional name
    Role { role: String, name: Option<String> },
    /// Select by accessibility ID
    Id(String),
    /// Select by name/label
    Name(String),
    /// Select by text content
    Text(String),
    /// Select using XPath-like query
    Path(String),
    /// Select by using Native Automation id, (eg: `AutomationID` for windows) and for linux it is Id value in Attributes
    NativeId(String),
    /// Select by multiple attributes (key-value pairs)
    Attributes(BTreeMap<String, String>),
    /// Filter current elements by a predicate
    Filter(usize), // Uses an ID to reference a filter predicate stored separately
    /// Chain multiple selectors
    Chain(Vec<Selector>),
    /// Select by class name
    ClassName(String),
    /// Filter by visibility on screen
    Visible(bool),
    /// Select by localized role
    LocalizedRole(String),
    /// Select by process name (e.g., "chrome", "notepad", "chrome.exe")
    Process(String),
    /// Select elements to the right of an anchor element
    RightOf(Box<Selector>),
    /// Select elements to the left of an anchor element
    LeftOf(Box<Selector>),
    /// Select elements above an anchor element
    Above(Box<Selector>),
    /// Select elements below an anchor element
    Below(Box<Selector>),
    /// Select elements near an anchor element
    Near(Box<Selector>),
    /// Select the n-th element from the matches
    Nth(i32),
    /// Select elements that have at least one descendant matching the inner selector (Playwright-style :has())
    Has(Box<Selector>),
    /// Navigate to parent element (Playwright-style ..)
    Parent,
    /// Logical AND: all selectors must match the same element
    And(Vec<Selector>),
    /// Logical OR: any selector can match
    Or(Vec<Selector>),
    /// Logical NOT: element must not match the selector
    Not(Box<Selector>),
    /// Represents an invalid selector string, with a reason.
    Invalid(String),
}

impl std::fmt::Display for Selector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Token types for boolean expression parsing
#[derive(Debug, Clone, PartialEq)]
enum Token {
    Selector(String),
    And,    // &&
    Or,     // || or ,
    Not,    // !
    LParen, // (
    RParen, // )
}

/// Check if a string has unbalanced parentheses
fn has_unbalanced_parens(s: &str) -> bool {
    let mut depth = 0;
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return true; // More closing than opening
                }
            }
            _ => {}
        }
    }
    depth != 0 // Unbalanced if depth is not zero
}

/// Tokenize a selector string into tokens for boolean expression parsing
fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();
    let mut current = String::new();

    while let Some(ch) = chars.next() {
        // Special handling for text: selectors - they can contain any characters
        // except && which is the boolean AND operator we use to chain selectors.
        // This allows text: values like "RPA Hospital (MGP)? : r/foo" to work correctly.
        let in_text_selector = current.trim().starts_with("text:");

        match ch {
            // Parentheses - these are operators/delimiters (unless inside text:)
            '(' if !in_text_selector => {
                if !current.is_empty() {
                    tokens.push(Token::Selector(current.trim().to_string()));
                    current.clear();
                }
                tokens.push(Token::LParen);
            }
            ')' if !in_text_selector => {
                if !current.is_empty() {
                    tokens.push(Token::Selector(current.trim().to_string()));
                    current.clear();
                }
                tokens.push(Token::RParen);
            }
            // Logical operators - check for && and ||
            // && is always treated as AND operator, even inside text: (it's how we chain selectors)
            '&' => {
                // Look ahead for second &
                if chars.peek() == Some(&'&') {
                    chars.next(); // consume second &

                    // Check if we should flush surrounding whitespace
                    // Trim whitespace from current token before pushing
                    if !current.is_empty() {
                        tokens.push(Token::Selector(current.trim().to_string()));
                        current.clear();
                    }
                    tokens.push(Token::And);

                    // Skip any following whitespace
                    while chars.peek() == Some(&' ') || chars.peek() == Some(&'\t') {
                        chars.next();
                    }
                } else {
                    // Single &, add to current selector
                    current.push(ch);
                }
            }
            '|' if !in_text_selector => {
                // Look ahead for second |
                if chars.peek() == Some(&'|') {
                    chars.next(); // consume second |

                    // Trim whitespace from current token before pushing
                    if !current.is_empty() {
                        tokens.push(Token::Selector(current.trim().to_string()));
                        current.clear();
                    }
                    tokens.push(Token::Or);

                    // Skip any following whitespace
                    while chars.peek() == Some(&' ') || chars.peek() == Some(&'\t') {
                        chars.next();
                    }
                } else {
                    // Single pipe - could be legacy role|name syntax or part of selector
                    current.push(ch);
                }
            }
            ',' if !in_text_selector => {
                // Comma is an OR operator
                if !current.is_empty() {
                    tokens.push(Token::Selector(current.trim().to_string()));
                    current.clear();
                }
                tokens.push(Token::Or);

                // Skip any following whitespace
                while chars.peek() == Some(&' ') || chars.peek() == Some(&'\t') {
                    chars.next();
                }
            }
            '!' if !in_text_selector => {
                // NOT operator
                if !current.is_empty() {
                    tokens.push(Token::Selector(current.trim().to_string()));
                    current.clear();
                }
                tokens.push(Token::Not);
            }
            // Whitespace handling - only skip leading whitespace after operators
            ' ' | '\t' | '\n' | '\r' if current.is_empty() => {
                // Skip leading whitespace
                continue;
            }
            // Everything else (including spaces within selectors) is part of a selector
            _ => current.push(ch),
        }
    }

    // Flush remaining token
    if !current.is_empty() {
        tokens.push(Token::Selector(current.trim().to_string()));
    }

    Ok(tokens)
}

/// Operator precedence for Shunting Yard algorithm
fn operator_precedence(token: &Token) -> i32 {
    match token {
        Token::Or => 1,
        Token::And => 2,
        Token::Not => 3,
        _ => 0,
    }
}

/// Parse tokens into a Selector AST using Shunting Yard algorithm
fn parse_boolean_expression(tokens: Vec<Token>) -> Result<Selector, String> {
    let mut output_queue: Vec<Selector> = Vec::new();
    let mut operator_stack: Vec<Token> = Vec::new();

    for token in tokens {
        match token {
            Token::Selector(s) => {
                // Parse the atomic selector
                output_queue.push(parse_atomic_selector(&s));
            }
            Token::LParen => {
                operator_stack.push(token);
            }
            Token::RParen => {
                // Pop operators until we find the matching LParen
                while let Some(op) = operator_stack.pop() {
                    if op == Token::LParen {
                        break;
                    }
                    apply_operator(op, &mut output_queue)?;
                }
            }
            Token::And | Token::Or | Token::Not => {
                // Pop operators with higher or equal precedence
                while let Some(top) = operator_stack.last() {
                    if *top == Token::LParen {
                        break;
                    }
                    if operator_precedence(top) >= operator_precedence(&token) {
                        let op = operator_stack.pop().unwrap();
                        apply_operator(op, &mut output_queue)?;
                    } else {
                        break;
                    }
                }
                operator_stack.push(token);
            }
        }
    }

    // Pop remaining operators
    while let Some(op) = operator_stack.pop() {
        if op == Token::LParen || op == Token::RParen {
            return Err("Mismatched parentheses".to_string());
        }
        apply_operator(op, &mut output_queue)?;
    }

    // Should have exactly one selector left
    if output_queue.len() == 1 {
        Ok(output_queue.pop().unwrap())
    } else if output_queue.is_empty() {
        Err("Empty expression".to_string())
    } else {
        Err("Invalid expression: multiple selectors without operators".to_string())
    }
}

/// Apply an operator to the output queue
fn apply_operator(op: Token, output_queue: &mut Vec<Selector>) -> Result<(), String> {
    match op {
        Token::Not => {
            let operand = output_queue
                .pop()
                .ok_or("NOT operator requires one operand")?;
            output_queue.push(Selector::Not(Box::new(operand)));
        }
        Token::And => {
            let right = output_queue
                .pop()
                .ok_or("AND operator requires two operands")?;
            let left = output_queue
                .pop()
                .ok_or("AND operator requires two operands")?;

            // Flatten nested ANDs
            let mut operands = Vec::new();
            if let Selector::And(mut left_ops) = left {
                operands.append(&mut left_ops);
            } else {
                operands.push(left);
            }
            if let Selector::And(mut right_ops) = right {
                operands.append(&mut right_ops);
            } else {
                operands.push(right);
            }

            output_queue.push(Selector::And(operands));
        }
        Token::Or => {
            let right = output_queue
                .pop()
                .ok_or("OR operator requires two operands")?;
            let left = output_queue
                .pop()
                .ok_or("OR operator requires two operands")?;

            // Flatten nested ORs
            let mut operands = Vec::new();
            if let Selector::Or(mut left_ops) = left {
                operands.append(&mut left_ops);
            } else {
                operands.push(left);
            }
            if let Selector::Or(mut right_ops) = right {
                operands.append(&mut right_ops);
            } else {
                operands.push(right);
            }

            output_queue.push(Selector::Or(operands));
        }
        _ => return Err(format!("Unexpected operator: {op:?}")),
    }
    Ok(())
}

/// Parse an atomic (non-boolean) selector from a string
fn parse_atomic_selector(s: &str) -> Selector {
    let s = s.trim();

    // Check if this is a legacy pipe syntax (role|name) - backward compatibility
    // Only treat as legacy if it contains exactly ONE pipe and no boolean operators
    if s.contains('|') && !s.contains("||") && s.matches('|').count() == 1 {
        let parts: Vec<&str> = s.split('|').collect();
        if parts.len() == 2 {
            let role_part = parts[0].trim();
            let name_part = parts[1].trim();

            let role = role_part
                .strip_prefix("role:")
                .unwrap_or(role_part)
                .to_string();

            let mut name = name_part.strip_prefix("name:").unwrap_or(name_part);
            name = name.strip_prefix("contains:").unwrap_or(name);

            return Selector::Role {
                role,
                name: Some(name.to_string()),
            };
        }
    }

    // Parse all other atomic selector types
    match s {
        _ if s.starts_with("role:") => Selector::Role {
            role: s[5..].to_string(),
            name: None,
        },
        "app" | "application" | "window" | "button" | "checkbox" | "menu" | "menuitem"
        | "menubar" | "textfield" | "input" => {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            Selector::Role {
                role: parts.first().unwrap_or(&"").to_string(),
                name: parts.get(1).map(|name| name.to_string()),
            }
        }
        _ if s.starts_with("AX") => Selector::Role {
            role: s.to_string(),
            name: None,
        },
        _ if s.starts_with("Name:") || s.starts_with("name:") => {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            Selector::Name(parts[1].to_string())
        }
        _ if s.to_lowercase().starts_with("classname:") => {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            Selector::ClassName(parts[1].to_string())
        }
        _ if s.to_lowercase().starts_with("nativeid:") => {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            Selector::NativeId(parts[1].trim().to_string())
        }
        _ if s.to_lowercase().starts_with("visible:") => {
            let value = s[8..].trim().to_lowercase();
            Selector::Visible(value == "true")
        }
        _ if s.to_lowercase().starts_with("process:") || s.to_lowercase().starts_with("processname:") => {
            let prefix_len = if s.to_lowercase().starts_with("process:") {
                "process:".len()
            } else {
                "processname:".len()
            };
            let process_name = s[prefix_len..].trim().to_string();
            Selector::Process(process_name)
        }
        _ if s.to_lowercase().starts_with("attr:") => {
            let attr_part = &s["attr:".len()..];
            let mut attributes = BTreeMap::new();

            if attr_part.contains('=') {
                let parts: Vec<&str> = attr_part.splitn(2, '=').collect();
                if parts.len() == 2 {
                    attributes.insert(parts[0].trim().to_string(), parts[1].trim().to_string());
                }
            } else {
                attributes.insert(attr_part.trim().to_string(), "true".to_string());
            }

            Selector::Attributes(attributes)
        }
        _ if s.to_lowercase().starts_with("rightof:") => {
            let inner_selector_str = &s["rightof:".len()..];
            Selector::RightOf(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("leftof:") => {
            let inner_selector_str = &s["leftof:".len()..];
            Selector::LeftOf(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("above:") => {
            let inner_selector_str = &s["above:".len()..];
            Selector::Above(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("below:") => {
            let inner_selector_str = &s["below:".len()..];
            Selector::Below(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("near:") => {
            let inner_selector_str = &s["near:".len()..];
            Selector::Near(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("has:") => {
            let inner_selector_str = &s["has:".len()..];
            Selector::Has(Box::new(Selector::from(inner_selector_str)))
        }
        _ if s.to_lowercase().starts_with("nth=") || s.to_lowercase().starts_with("nth:") => {
            let index_str = if s.to_lowercase().starts_with("nth:") {
                &s["nth:".len()..]
            } else {
                &s["nth=".len()..]
            };

            if let Ok(index) = index_str.parse::<i32>() {
                Selector::Nth(index)
            } else {
                Selector::Invalid(format!("Invalid index for nth selector: '{index_str}'"))
            }
        }
        _ if s.starts_with("id:") => Selector::Id(s[3..].to_string()),
        _ if s.starts_with("text:") => Selector::Text(s[5..].to_string()),
        _ if s.contains(':') => {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            Selector::Role {
                role: parts[0].to_string(),
                name: Some(parts[1].to_string()),
            }
        }
        _ if s.starts_with('#') => Selector::Id(s[1..].to_string()),
        _ if s.starts_with('/') => Selector::Path(s.to_string()),
        ".." => Selector::Parent,
        _ => Selector::Invalid(format!(
            "Unknown selector format: \"{s}\". Use prefixes like 'role:', 'name:', 'id:', 'text:', 'nativeid:', 'classname:', 'process:', 'attr:', 'visible:', or 'has:' to specify the selector type."
        )),
    }
}

impl From<&str> for Selector {
    fn from(s: &str) -> Self {
        let s = s.trim();

        // Handle chained selectors first (>> has highest priority)
        if s.contains(">>") {
            let parts: Vec<&str> = s.split(">>").map(|p| p.trim()).collect();
            if parts.len() > 1 {
                // Strip outer parentheses from each part if present
                let cleaned_parts: Vec<Selector> = parts
                    .into_iter()
                    .map(|part| {
                        let trimmed = part.trim();
                        // Check if the part is wrapped in parentheses
                        if trimmed.starts_with('(') && trimmed.ends_with(')') {
                            // Check if these are truly outer parentheses (balanced)
                            let inner = &trimmed[1..trimmed.len() - 1];
                            // Only strip if the parentheses are balanced at this level
                            if !has_unbalanced_parens(inner) {
                                return Selector::from(inner);
                            }
                        }
                        Selector::from(trimmed)
                    })
                    .collect();
                return Selector::Chain(cleaned_parts);
            }
        }

        // Check if this contains boolean operators (&&, ||, !, parentheses, or comma for OR)
        let has_boolean_ops = s.contains("&&")
            || s.contains("||")
            || s.contains('(')
            || s.contains(')')
            || s.contains('!')
            || (s.contains(',') && !s.starts_with("attr:")); // comma is OR unless in attr: context

        if has_boolean_ops {
            // Check if this is ONLY a text: selector with special characters (not a boolean expression)
            // text: is special because the value after the colon can legitimately contain these characters
            if s.starts_with("text:") && !s[5..].contains("text:") {
                // This is a simple text: selector with special chars in the text, not a boolean expression
                return parse_atomic_selector(s);
            }

            // Use boolean expression parser
            match tokenize(s) {
                Ok(tokens) => match parse_boolean_expression(tokens) {
                    Ok(selector) => return selector,
                    Err(e) => return Selector::Invalid(format!("Parse error: {e}")),
                },
                Err(e) => return Selector::Invalid(format!("Tokenization error: {e}")),
            }
        }

        // No boolean operators - parse as atomic selector
        parse_atomic_selector(s)
    }
}
// Comprehensive unit tests for selector parsing and behavior

#[cfg(test)]
#[path = "selector_tests.rs"]
mod selector_tests;

#[cfg(test)]
mod debug_selector_test {
    use crate::selector::Selector;

    #[test]
    fn test_debug_best_plan_pro() {
        let input = "(role:Window && name:Best Plan Pro) >> nativeid:dob";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");

        // Let's see what we actually get
        match &selector {
            Selector::Chain(parts) => {
                println!("Got Chain with {} parts:", parts.len());
                for (i, part) in parts.iter().enumerate() {
                    println!("  Part {i}: {part:?}");
                }
            }
            Selector::Invalid(msg) => {
                println!("Got Invalid selector: {msg}");
            }
            other => {
                println!("Got unexpected selector type: {other:?}");
            }
        }
    }

    #[test]
    fn test_debug_parentheses_only() {
        let input = "(role:Window && name:Best Plan Pro)";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");
    }

    #[test]
    fn test_debug_chain_simple() {
        let input = "role:Window >> nativeid:dob";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");
    }

    #[test]
    fn test_debug_and_no_parens() {
        let input = "role:Window && name:Best Plan Pro";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");
    }

    #[test]
    fn test_process_selector_simple() {
        let input = "process:chrome";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");

        match &selector {
            Selector::Process(name) => {
                println!("Got Process selector with name: {name}");
                assert_eq!(name, "chrome");
            }
            other => {
                panic!("Expected Process selector, got: {other:?}");
            }
        }
    }

    #[test]
    fn test_process_selector_with_extension() {
        let input = "processname:notepad.exe";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");

        match &selector {
            Selector::Process(name) => {
                println!("Got Process selector with name: {name}");
                assert_eq!(name, "notepad.exe");
            }
            other => {
                panic!("Expected Process selector, got: {other:?}");
            }
        }
    }

    #[test]
    fn test_process_selector_chain() {
        let input = "process:chrome >> role:Button|name:Submit";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");

        match &selector {
            Selector::Chain(parts) => {
                println!("Got Chain with {} parts:", parts.len());
                assert_eq!(parts.len(), 2);

                match &parts[0] {
                    Selector::Process(name) => {
                        assert_eq!(name, "chrome");
                    }
                    other => panic!("Expected first part to be Process, got: {other:?}"),
                }
            }
            other => {
                panic!("Expected Chain selector, got: {other:?}");
            }
        }
    }

    #[test]
    fn test_process_selector_with_and() {
        let input = "process:chrome && role:Button";
        println!("Testing selector: {input}");

        let selector = Selector::from(input);
        println!("Parsed result: {selector:?}");

        match &selector {
            Selector::And(parts) => {
                println!("Got And with {} parts:", parts.len());
                assert_eq!(parts.len(), 2);
            }
            other => {
                panic!("Expected And selector, got: {other:?}");
            }
        }
    }
} // Debug test to understand tokenization issue

#[cfg(test)]
mod tokenizer_debug_test {
    use crate::selector::tokenize;

    #[test]
    fn test_tokenize_simple_and() {
        let input = "role:Window && name:Best Plan Pro";
        println!("Tokenizing: {input}");

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{i}] {token:?}");
                }
            }
            Err(e) => println!("Tokenization error: {e}"),
        }
    }

    #[test]
    fn test_tokenize_with_parentheses() {
        let input = "(role:Window && name:Best Plan Pro)";
        println!("Tokenizing: {input}");

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{i}] {token:?}");
                }
            }
            Err(e) => println!("Tokenization error: {e}"),
        }
    }

    #[test]
    fn test_tokenize_spaces_in_name() {
        let input = "name:Best Plan Pro";
        println!("Tokenizing: {input}");

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{i}] {token:?}");
                }
            }
            Err(e) => println!("Tokenization error: {e}"),
        }
    }

    #[test]
    fn test_tokenize_text_with_special_chars() {
        // text: selector with special characters that would normally be treated as operators
        let input = "role:Window && text:RPA Hospital - Antenatal Care, the same as RPA Midwifery Group Practice (MGP)? : r/BabyBumpsandBeyondAu - Google Chrome";
        println!("Tokenizing: {input}");

        match tokenize(input) {
            Ok(tokens) => {
                println!("Tokens ({} total):", tokens.len());
                for (i, token) in tokens.iter().enumerate() {
                    println!("  [{i}] {token:?}");
                }
                // Should only have 3 tokens: role:Window, And, and the full text: selector
                assert_eq!(
                    tokens.len(),
                    3,
                    "Expected 3 tokens (role, And, text), got: {tokens:?}"
                );
            }
            Err(e) => panic!("Tokenization error: {e}"),
        }
    }
}
