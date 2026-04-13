use chrono::Utc;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::system;

const MAX_JOURNAL_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

fn journal_path() -> PathBuf {
    system::virus_dir().join("journal.txt")
}

fn archive_path() -> PathBuf {
    system::virus_dir().join("journal.old.txt")
}

pub fn init() {
    let dir = system::virus_dir();
    fs::create_dir_all(&dir).ok();
}

fn maybe_rotate() {
    let path = journal_path();
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_JOURNAL_BYTES {
            let _ = fs::rename(&path, archive_path());
        }
    }
}

pub fn append(kind: &str, content: &str) {
    maybe_rotate();
    let path = journal_path();
    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] {}: {}\n", timestamp, kind, content);

    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn thought(content: &str) {
    append("THOUGHT", content);
}

pub fn action(command: &str) {
    append("ACTION", command);
}

pub fn result(output: &str) {
    let truncated = if output.chars().count() > 2000 {
        let s: String = output.chars().take(2000).collect();
        format!("{}...[truncated]", s)
    } else {
        output.to_string()
    };
    append("RESULT", &truncated);
}

pub fn error(msg: &str) {
    append("ERROR", msg);
}

/// Return the most recent N lines from the journal for context.
/// Reads from the end of the file without loading the entire file when possible.
pub fn recent(n: usize) -> String {
    let path = journal_path();
    let contents = match fs::read_to_string(&path) {
        Ok(c) if !c.is_empty() => c,
        _ => return String::from("(no memory yet — this is your first time waking up)"),
    };

    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}
