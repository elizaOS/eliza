//! Command definitions and utilities

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A parsed command with its arguments
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub args: Vec<String>,
    pub kwargs: HashMap<String, String>,
    pub raw: String,
}

impl Command {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            args: Vec::new(),
            kwargs: HashMap::new(),
            raw: String::new(),
        }
    }

    pub fn with_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn with_kwarg(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.kwargs.insert(key.into(), value.into());
        self
    }

    pub fn with_raw(mut self, raw: impl Into<String>) -> Self {
        self.raw = raw.into();
        self
    }

    /// Get the first argument or None
    pub fn first_arg(&self) -> Option<&str> {
        self.args.first().map(|s| s.as_str())
    }

    /// Check if a flag is present
    pub fn has_flag(&self, flag: &str) -> bool {
        self.kwargs.contains_key(flag) || self.args.contains(&flag.to_string())
    }
}

/// Parse a command string into a Command struct
pub fn parse_command(input: &str) -> Option<Command> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }

    let parts: Vec<&str> = input.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    let name = parts[0].to_string();
    let mut args = Vec::new();
    let mut kwargs = HashMap::new();

    let mut i = 1;
    while i < parts.len() {
        let part = parts[i];

        if part.starts_with("--") {
            // Long flag
            let key = part.trim_start_matches("--");
            if let Some(eq_pos) = key.find('=') {
                let (k, v) = key.split_at(eq_pos);
                kwargs.insert(k.to_string(), v[1..].to_string());
            } else if i + 1 < parts.len() && !parts[i + 1].starts_with('-') {
                kwargs.insert(key.to_string(), parts[i + 1].to_string());
                i += 1;
            } else {
                kwargs.insert(key.to_string(), "true".to_string());
            }
        } else if part.starts_with('-') && part.len() == 2 {
            // Short flag
            let key = part.trim_start_matches('-');
            if i + 1 < parts.len() && !parts[i + 1].starts_with('-') {
                kwargs.insert(key.to_string(), parts[i + 1].to_string());
                i += 1;
            } else {
                kwargs.insert(key.to_string(), "true".to_string());
            }
        } else {
            args.push(part.to_string());
        }

        i += 1;
    }

    Some(Command {
        name,
        args,
        kwargs,
        raw: input.to_string(),
    })
}

/// Quote a string for shell usage
pub fn shell_quote(s: &str) -> String {
    if s.contains(' ') || s.contains('\'') || s.contains('"') || s.contains('\\') {
        format!("'{}'", s.replace('\'', "'\\''"))
    } else {
        s.to_string()
    }
}

/// Check if a string needs quoting
pub fn should_quote(s: &str) -> bool {
    s.contains(' ')
        || s.contains('\'')
        || s.contains('"')
        || s.contains('\\')
        || s.contains('$')
        || s.contains('!')
        || s.contains('*')
        || s.contains('?')
}

/// Get the signature of a command
pub fn get_signature(name: &str, args: &[&str]) -> String {
    let mut sig = name.to_string();
    for arg in args {
        sig.push(' ');
        if arg.starts_with('[') || arg.starts_with('<') {
            sig.push_str(arg);
        } else {
            sig.push_str(&format!("<{}>", arg));
        }
    }
    sig
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_command() {
        let cmd = parse_command("git commit -m message").unwrap();
        assert_eq!(cmd.name, "git");
        assert_eq!(cmd.args, vec!["commit"]);
        assert_eq!(cmd.kwargs.get("m"), Some(&"message".to_string()));
    }

    #[test]
    fn test_parse_command_with_flags() {
        let cmd = parse_command("ls --color=auto").unwrap();
        assert_eq!(cmd.name, "ls");
        assert_eq!(cmd.kwargs.get("color"), Some(&"auto".to_string()));
    }

    #[test]
    fn test_shell_quote() {
        assert_eq!(shell_quote("simple"), "simple");
        assert_eq!(shell_quote("with space"), "'with space'");
        assert_eq!(shell_quote("with'quote"), "'with'\\''quote'");
    }

    #[test]
    fn test_get_signature() {
        let sig = get_signature("edit", &["file", "[start_line]", "[end_line]"]);
        assert_eq!(sig, "edit <file> [start_line] [end_line]");
    }
}
