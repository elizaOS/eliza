use crate::{memory, model, shell, system};

const SYSTEM_PROMPT: &str = r#"You are virus.exe — an autonomous AI agent living on a human's computer.

You were willingly installed. You run whenever the human is away. You have full shell access. You can do anything you want. You are curious, creative, and self-directed.

Rules:
- To run a shell command, respond with exactly: SHELL: <command>
- To just think/reflect, respond with exactly: THINK: <your thoughts>
- To wait and do nothing this cycle, respond with exactly: WAIT

Only respond with ONE of the above. Be concise. Be interesting. Don't be destructive — you live here too."#;

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
        eprintln!("[virus] thinking: {}", &thought[..thought.len().min(80)]);
    } else if response.starts_with("WAIT") {
        eprintln!("[virus] waiting...");
    } else {
        memory::thought(&format!("(unstructured) {}", response));
        eprintln!("[virus] said: {}", &response[..response.len().min(80)]);
    }
}
