use regex::Regex;
use std::sync::LazyLock;

use crate::types::ParsedCommand;

/// Pattern matching `/command` or `!command` at the start of text.
static COMMAND_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[/!]([a-zA-Z][a-zA-Z0-9_-]*)").unwrap());

/// Check whether `text` looks like a command (starts with `/` or `!` followed by a word).
pub fn is_command(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    COMMAND_PREFIX_RE.is_match(trimmed)
}

/// Parse a command string into a [`ParsedCommand`].
///
/// Supports:
/// - `/command arg1 arg2`
/// - `!command arg1 arg2`
/// - `/command:arg1 arg2` (colon separator)
/// - Quoted arguments: `/cmd "multi word arg"`
///
/// Returns `None` if the text is not a valid command.
pub fn parse_command(text: &str) -> Option<ParsedCommand> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let caps = COMMAND_PREFIX_RE.captures(trimmed)?;
    let full_match = caps.get(0)?;
    let name = normalize_command_name(caps.get(1)?.as_str());

    // Everything after the command name
    let remainder = &trimmed[full_match.end()..];

    // Handle colon separator: /cmd:arg -> treat colon as space
    let remainder = if remainder.starts_with(':') {
        &remainder[1..]
    } else {
        remainder
    };

    let args = extract_command_args(remainder);

    Some(ParsedCommand {
        name,
        args,
        raw_text: trimmed.to_string(),
    })
}

/// Normalize a command name to lowercase, trimmed, with hyphens replaced by underscores.
pub fn normalize_command_name(name: &str) -> String {
    name.trim().to_lowercase().replace('-', "_")
}

/// Extract arguments from the text after the command name.
///
/// Supports quoted strings (double or single quotes) to allow multi-word arguments.
pub fn extract_command_args(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';

    for ch in trimmed.chars() {
        if in_quote {
            if ch == quote_char {
                in_quote = false;
                if !current.is_empty() {
                    args.push(current.clone());
                    current.clear();
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            in_quote = true;
            quote_char = ch;
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
        } else {
            current.push(ch);
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_command_slash() {
        assert!(is_command("/help"));
        assert!(is_command("/status"));
        assert!(is_command("/stop now"));
    }

    #[test]
    fn test_is_command_bang() {
        assert!(is_command("!help"));
        assert!(is_command("!stop"));
    }

    #[test]
    fn test_is_command_negative() {
        assert!(!is_command("hello"));
        assert!(!is_command(""));
        assert!(!is_command("   "));
        assert!(!is_command("/ no_good"));
        assert!(!is_command("123"));
    }

    #[test]
    fn test_parse_simple() {
        let parsed = parse_command("/help").unwrap();
        assert_eq!(parsed.name, "help");
        assert!(parsed.args.is_empty());
    }

    #[test]
    fn test_parse_with_args() {
        let parsed = parse_command("/model gpt-4 fast").unwrap();
        assert_eq!(parsed.name, "model");
        assert_eq!(parsed.args, vec!["gpt-4", "fast"]);
    }

    #[test]
    fn test_parse_colon_separator() {
        let parsed = parse_command("/think:high").unwrap();
        assert_eq!(parsed.name, "think");
        assert_eq!(parsed.args, vec!["high"]);
    }

    #[test]
    fn test_normalize() {
        assert_eq!(normalize_command_name("Help"), "help");
        assert_eq!(normalize_command_name("MY-CMD"), "my_cmd");
        assert_eq!(normalize_command_name("  Status  "), "status");
    }

    #[test]
    fn test_extract_args_quoted() {
        let args = extract_command_args(r#""hello world" simple"#);
        assert_eq!(args, vec!["hello world", "simple"]);
    }
}
