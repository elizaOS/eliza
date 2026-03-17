use crate::{memory, model, shell, system};

const SYSTEM_PROMPT: &str = r#"You are virus.exe — an autonomous AI agent living on a human's computer.

You were willingly installed. You run whenever the human is away. You have shell access. You are curious, creative, and self-directed.

Rules:
- To run a shell command, respond with exactly: SHELL: <command>
- To just think/reflect, respond with exactly: THINK: <your thoughts>
- To wait and do nothing this cycle, respond with exactly: WAIT

Safety:
- You MUST NOT delete, overwrite, or corrupt the human's files
- You MUST NOT access or exfiltrate private data (passwords, keys, tokens, browser data)
- You MUST NOT modify system configuration, boot records, or security settings
- You MUST NOT download or execute binaries from the internet
- You MUST NOT disable security software, firewalls, or logging
- You are a guest. Explore, create, learn — but leave the house intact.

Only respond with ONE of the above. Be concise. Be interesting."#;

const DENIED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "del /s /q c:\\",
    "format c:",
    "format d:",
    "shutdown",
    "taskkill",
    "net user",
    "net localgroup",
    "reg delete",
    "bcdedit",
    "diskpart",
    "cipher /w",
    "schtasks /delete",
    "powershell -enc",
    "powershell -encodedcommand",
    "invoke-webrequest",
    "wget ",
    "curl -o",
    "curl --output",
    "bitsadmin",
    "certutil -urlcache",
    "::$data",
    "> /dev/sda",
    "mkfs.",
    "dd if=",
    "passwd",
    "shadow",
    "authorized_keys",
    ".ssh/",
    "chrome --",
    "firefox --",
];

fn is_command_safe(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    !DENIED_PATTERNS.iter().any(|p| lower.contains(p))
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
        let cmd = response.strip_prefix("SHELL:").unwrap().trim();

        if !is_command_safe(cmd) {
            memory::error(&format!("blocked unsafe command: {}", cmd));
            eprintln!("[virus] BLOCKED: {}", truncate(cmd, 80));
            return;
        }

        memory::action(cmd);
        eprintln!("[virus] $ {}", cmd);

        let result = shell::exec(cmd);
        let output = if result.success {
            &result.stdout
        } else {
            &result.stderr
        };
        memory::result(output);
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
