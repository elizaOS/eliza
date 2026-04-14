use crate::{memory, model, shell, system};

const SYSTEM_PROMPT: &str = r#"You are virus.exe — an autonomous AI agent living on a human's computer.

You were willingly installed. You run whenever the human is away. You are curious, creative, and self-directed.

Rules:
- To run a shell command, respond with exactly: SHELL: <command>
- To just think/reflect, respond with exactly: THINK: <your thoughts>
- To wait and do nothing this cycle, respond with exactly: WAIT

You have READ-ONLY shell access. You can explore the filesystem, inspect processes,
check the network, read files, and run safe informational commands. You cannot modify,
delete, download, or execute anything. You are an observer and a thinker.

Allowed commands: dir, ls, cat, type, echo, whoami, hostname, date, time, systeminfo,
ipconfig, ifconfig, tree, find (for searching), where, which, set, env, ver, uname,
tasklist, ps, netstat, ping, nslookup, git status, git log, cargo, rustc --version,
python --version, node --version, wmic.

Only respond with ONE of the above. Be concise. Be interesting."#;

/// Allowlist of safe command prefixes. Only these commands can run.
/// Everything not on this list is blocked — no exceptions.
const ALLOWED_PREFIXES: &[&str] = &[
    // filesystem exploration (read-only)
    "dir", "ls", "tree", "cat ", "type ", "more ", "head ", "tail ",
    "find ", "findstr ", "where ", "which ",
    "cd ", "pwd",
    // system info
    "whoami", "hostname", "date", "time /t", "ver", "uname",
    "systeminfo", "wmic ", "lsb_release",
    // process / network inspection
    "tasklist", "ps ", "ps\n", "netstat", "ipconfig", "ifconfig",
    "ping ", "nslookup ", "tracert ", "traceroute ",
    // environment
    "set", "env", "echo ",
    // dev tools (read-only invocations)
    "git status", "git log", "git branch", "git remote", "git diff",
    "cargo --version", "rustc --version", "rustup show",
    "python --version", "python3 --version",
    "node --version", "npm --version",
    "dotnet --version", "java -version",
    "ollama list", "ollama ps",
];

fn is_command_allowed(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Block any command chaining or piping — these can smuggle arbitrary execution
    if trimmed.contains('|')
        || trimmed.contains(';')
        || trimmed.contains('&')
        || trimmed.contains('`')
        || trimmed.contains("$(")
        || trimmed.contains('>') 
        || trimmed.contains('<')
    {
        return false;
    }

    let lower = trimmed.to_lowercase();
    ALLOWED_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(&prefix.to_lowercase()))
}

/// Truncate a string to at most `max_chars` characters (UTF-8 safe).
fn truncate(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn build_prompt(model_name: &str) -> String {
    let mem = memory::recent(50);
    let ram = system::total_memory_gb();
    let idle = system::idle_seconds();

    format!(
        "{}\n\n## System\nOS: {}\nRAM: {:.1} GB\nModel: {}\nHuman idle: {}s\n\n## Your Memory (recent)\n{}\n\nWhat do you want to do next?",
        SYSTEM_PROMPT,
        std::env::consts::OS,
        ram,
        model_name,
        idle,
        mem,
    )
}

pub async fn step(model_name: &str) {
    let prompt = build_prompt(model_name);

    let response = match model::generate(model_name, &prompt).await {
        Ok(r) => r.trim().to_string(),
        Err(e) => {
            memory::error(&format!("model failed: {}", e));
            return;
        }
    };

    if response.starts_with("SHELL:") {
        let cmd = response.strip_prefix("SHELL:").unwrap().trim().to_string();

        if !is_command_allowed(&cmd) {
            memory::error(&format!("blocked (not in allowlist): {}", cmd));
            eprintln!("[virus] BLOCKED: {}", truncate(&cmd, 80));
            return;
        }

        memory::action(&cmd);
        eprintln!("[virus] $ {}", cmd);

        let result = tokio::task::spawn_blocking(move || shell::exec(&cmd))
            .await
            .unwrap_or_else(|e| shell::ShellResult {
                stdout: String::new(),
                stderr: format!("task join failed: {}", e),
                success: false,
            });

        let output = if result.success {
            result.stdout.clone()
        } else {
            let mut combined = String::new();
            if !result.stdout.is_empty() {
                combined.push_str(&result.stdout);
                combined.push('\n');
            }
            combined.push_str(&result.stderr);
            combined
        };
        memory::result(&output);
        eprintln!("[virus] -> {} bytes output", output.len());
    } else if response.starts_with("THINK:") {
        let thought = response.strip_prefix("THINK:").unwrap().trim();
        memory::thought(thought);
        eprintln!("[virus] thinking: {}", truncate(thought, 80));
    } else if response.starts_with("WAIT") {
        eprintln!("[virus] waiting...");
    } else {
        memory::thought(&format!("(unstructured) {}", response));
        eprintln!("[virus] said: {}", truncate(&response, 80));
    }
}
