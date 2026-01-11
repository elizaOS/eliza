#![allow(missing_docs)]
//! Path and command validation utilities for the shell plugin.

use regex::Regex;
use std::path::{Path, PathBuf};
use tracing::warn;

/// Default forbidden commands for safety
pub const DEFAULT_FORBIDDEN_COMMANDS: &[&str] = &[
    "rm -rf /",
    "rmdir",
    "chmod 777",
    "chown",
    "chgrp",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "kill -9",
    "killall",
    "pkill",
    "sudo rm -rf",
    "su",
    "passwd",
    "useradd",
    "userdel",
    "groupadd",
    "groupdel",
    "format",
    "fdisk",
    "mkfs",
    "dd if=/dev/zero",
    "shred",
    ":(){:|:&};:", // Fork bomb
];

/// Normalize a path and ensure it's within the allowed directory.
///
/// # Arguments
/// * `command_path` - The path from the command
/// * `allowed_dir` - The allowed directory
/// * `current_dir` - The current working directory
///
/// # Returns
/// The normalized absolute path or None if invalid
pub fn validate_path(
    command_path: &str,
    allowed_dir: &Path,
    current_dir: &Path,
) -> Option<PathBuf> {
    let resolved_path = if Path::new(command_path).is_absolute() {
        PathBuf::from(command_path)
    } else {
        current_dir.join(command_path)
    };

    // Normalize the path
    let normalized = match resolved_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // If can't canonicalize, try to normalize manually
            normalize_path(&resolved_path)
        }
    };

    let normalized_allowed = match allowed_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => normalize_path(allowed_dir),
    };

    // Check if the resolved path is within the allowed directory
    if normalized.starts_with(&normalized_allowed) {
        Some(normalized)
    } else {
        warn!(
            "Path validation failed: {} is outside allowed directory {}",
            normalized.display(),
            normalized_allowed.display()
        );
        None
    }
}

/// Manually normalize a path (resolve . and ..)
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::CurDir => {}
            c => components.push(c),
        }
    }

    components.iter().collect()
}

/// Check if a command contains path traversal attempts or dangerous patterns.
///
/// # Arguments
/// * `command` - The command to check
///
/// # Returns
/// true if the command appears safe, false if it contains dangerous patterns
pub fn is_safe_command(command: &str) -> bool {
    // Check for path traversal patterns
    let path_traversal_patterns = [
        r"\.\./",   // ../
        r"\.\.\\",  // ..\
        r"/\.\.",   // /..
        r"\\\.\.",  // \..
    ];

    // Check for dangerous command patterns
    let dangerous_patterns = [
        r"\$\(",        // Command substitution $(
        r"`[^']*`",     // Command substitution ` (but allow in quotes)
        r"\|\s*sudo",   // Pipe to sudo
        r";\s*sudo",    // Chain with sudo
        r"&\s*&",       // && chaining
        r"\|\s*\|",     // || chaining
    ];

    // Check for path traversal
    for pattern in &path_traversal_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(command) {
                warn!("Path traversal detected in command: {}", command);
                return false;
            }
        }
    }

    // Check for dangerous patterns
    for pattern in &dangerous_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(command) {
                warn!("Dangerous pattern detected in command: {}", command);
                return false;
            }
        }
    }

    // Allow single pipes but block multiple pipes
    let pipe_count = command.matches('|').count();
    if pipe_count > 1 {
        warn!("Multiple pipes detected in command: {}", command);
        return false;
    }

    true
}

/// Extract the base command from a full command string.
///
/// # Arguments
/// * `full_command` - The full command string
///
/// # Returns
/// The base command
pub fn extract_base_command(full_command: &str) -> &str {
    full_command
        .split_whitespace()
        .next()
        .unwrap_or("")
}

/// Check if a command is in the forbidden list.
///
/// # Arguments
/// * `command` - The command to check
/// * `forbidden_commands` - List of forbidden commands/patterns
///
/// # Returns
/// true if the command is forbidden
pub fn is_forbidden_command(command: &str, forbidden_commands: &[String]) -> bool {
    let normalized_command = command.trim().to_lowercase();

    for forbidden in forbidden_commands {
        let forbidden_lower = forbidden.to_lowercase();

        // Check if the command starts with the forbidden pattern
        if normalized_command.starts_with(&forbidden_lower) {
            return true;
        }

        // Check if it's the exact base command for single-word forbidden commands
        if !forbidden.contains(' ') {
            let base_command = extract_base_command(command).to_lowercase();
            if base_command == forbidden_lower {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_is_safe_command_allows_safe() {
        assert!(is_safe_command("ls -la"));
        assert!(is_safe_command("echo hello"));
        assert!(is_safe_command("pwd"));
        assert!(is_safe_command("touch newfile.txt"));
        assert!(is_safe_command("mkdir newdir"));
    }

    #[test]
    fn test_is_safe_command_rejects_traversal() {
        assert!(!is_safe_command("cd ../.."));
        assert!(!is_safe_command("ls ../../../etc"));
    }

    #[test]
    fn test_is_safe_command_rejects_dangerous() {
        assert!(!is_safe_command("echo $(malicious)"));
        assert!(!is_safe_command("ls | grep test | wc -l"));
        assert!(!is_safe_command("cmd1 && cmd2"));
        assert!(!is_safe_command("cmd1 || cmd2"));
    }

    #[test]
    fn test_extract_base_command() {
        assert_eq!(extract_base_command("ls -la"), "ls");
        assert_eq!(extract_base_command("git status"), "git");
        assert_eq!(extract_base_command("  npm   test  "), "npm");
        assert_eq!(extract_base_command(""), "");
    }

    #[test]
    fn test_is_forbidden_command() {
        let forbidden = vec![
            "rm -rf /".to_string(),
            "shutdown".to_string(),
            "chmod 777".to_string(),
        ];

        assert!(is_forbidden_command("rm -rf /", &forbidden));
        assert!(is_forbidden_command("shutdown now", &forbidden));
        assert!(is_forbidden_command("chmod 777 /etc", &forbidden));

        assert!(!is_forbidden_command("rm file.txt", &forbidden));
        assert!(!is_forbidden_command("ls -la", &forbidden));
        assert!(!is_forbidden_command("chmod 644 file", &forbidden));
    }

    #[test]
    fn test_is_forbidden_case_insensitive() {
        let forbidden = vec!["shutdown".to_string()];
        assert!(is_forbidden_command("SHUTDOWN", &forbidden));
        assert!(is_forbidden_command("Shutdown", &forbidden));
    }
}







