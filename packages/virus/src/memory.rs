use chrono::Utc;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::system;

fn journal_path() -> PathBuf {
    system::virus_dir().join("journal.txt")
}

pub fn init() {
    let dir = system::virus_dir();
    fs::create_dir_all(&dir).ok();
}

pub fn append(kind: &str, content: &str) {
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
pub fn recent(n: usize) -> String {
    let path = journal_path();
    match fs::read_to_string(&path) {
        Ok(contents) => {
            let lines: Vec<&str> = contents.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        Err(_) => String::from("(no memory yet — this is your first time waking up)"),
    }
}
