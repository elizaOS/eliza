#![allow(missing_docs)]

use regex::Regex;
use std::path::{Path, PathBuf};
use tracing::warn;

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
    ":(){:|:&};:",
];

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

    let normalized = match resolved_path.canonicalize() {
        Ok(p) => p,
        Err(_) => normalize_path(&resolved_path),
    };

    let normalized_allowed = match allowed_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => normalize_path(allowed_dir),
    };

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

pub fn is_safe_command(command: &str) -> bool {
    let path_traversal_patterns = [r"\.\./", r"\.\.\\", r"/\.\.", r"\\\.\."];

    let dangerous_patterns = [
        r"\$\(",
        r"`[^']*`",
        r"\|\s*sudo",
        r";\s*sudo",
        r"&\s*&",
        r"\|\s*\|",
    ];

    for pattern in &path_traversal_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(command) {
                warn!("Path traversal detected in command: {}", command);
                return false;
            }
        }
    }

    for pattern in &dangerous_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(command) {
                warn!("Dangerous pattern detected in command: {}", command);
                return false;
            }
        }
    }

    let pipe_count = command.matches('|').count();
    if pipe_count > 1 {
        warn!("Multiple pipes detected in command: {}", command);
        return false;
    }

    true
}

pub fn extract_base_command(full_command: &str) -> &str {
    full_command.split_whitespace().next().unwrap_or("")
}

pub fn is_forbidden_command(command: &str, forbidden_commands: &[String]) -> bool {
    let normalized_command = command.trim().to_lowercase();

    for forbidden in forbidden_commands {
        let forbidden_lower = forbidden.to_lowercase();

        if normalized_command.starts_with(&forbidden_lower) {
            return true;
        }

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
