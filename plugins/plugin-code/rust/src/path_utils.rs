use std::path::{Path, PathBuf};

pub const DEFAULT_FORBIDDEN_COMMANDS: [&str; 5] =
    ["rm -rf /", "rm -rf ~", "sudo rm", "mkfs", "dd if=/dev"];

pub fn extract_base_command(command: &str) -> String {
    command.split_whitespace().next().unwrap_or("").to_string()
}

pub fn is_safe_command(command: &str) -> bool {
    let c = command.trim();
    if c.is_empty() {
        return false;
    }
    // Block path traversal via cd
    if c.starts_with("cd ") && c.contains("..") {
        return false;
    }
    if c.contains("&&") || c.contains("||") || c.contains(';') {
        return false;
    }
    if c.contains("$(") || c.contains('`') {
        return false;
    }
    true
}

pub fn is_forbidden_command(command: &str, additional_forbidden: &[String]) -> bool {
    let lower = command.to_lowercase();
    for f in DEFAULT_FORBIDDEN_COMMANDS {
        if lower.contains(&f.to_lowercase()) {
            return true;
        }
    }
    for f in additional_forbidden {
        let ft = f.trim();
        if ft.is_empty() {
            continue;
        }
        if lower.contains(&ft.to_lowercase()) {
            return true;
        }
    }
    false
}

pub fn validate_path(
    target_path: &str,
    allowed_directory: &Path,
    current_directory: &Path,
) -> Option<PathBuf> {
    let base = if current_directory.as_os_str().is_empty() {
        allowed_directory
    } else {
        current_directory
    };
    let resolved = base.join(target_path);

    // Canonicalize the allowed directory first (best-effort).
    let allowed = allowed_directory
        .canonicalize()
        .ok()
        .unwrap_or_else(|| allowed_directory.to_path_buf());

    // Canonicalize target if it exists; otherwise canonicalize the parent and re-join.
    let canonical = match resolved.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = resolved.parent()?.canonicalize().ok()?;
            let name = resolved.file_name()?;
            parent.join(name)
        }
    };

    // Enforce containment.
    if canonical == allowed {
        return Some(canonical);
    }
    canonical.strip_prefix(&allowed).ok()?;
    Some(canonical)
}
