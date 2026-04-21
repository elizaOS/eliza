use anyhow::{Context, Result};
use elizaos_plugin_inmemorydb::{IStorage, MemoryStorage};
use elizaos_plugin_local_ai::{LocalAIPlugin, TextGenerationParams};
use elizaos_plugin_shell::{ShellConfig, ShellService};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;
use uuid::Uuid;

#[derive(Debug, Clone)]
enum Decision {
    Run { command: String, note: String },
    Sleep { sleep_ms: u64, note: String },
    Stop { note: String },
}

#[derive(Debug, Serialize)]
struct StepRecord {
    step: u64,
    decided_at_ms: u64,
    goal: String,
    decision: serde_json::Value,
    shell: serde_json::Value,
}

fn env_string(name: &str, fallback: &str) -> String {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    match std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok()) {
        Some(n) => n,
        None => fallback,
    }
}

fn clamp_u64(n: u64, min_v: u64, max_v: u64) -> u64 {
    n.max(min_v).min(max_v)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_millis(0))
        .as_millis() as u64
}

fn truncate(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let head = &text[..max_len];
    format!(
        "{}\n...<truncated {} chars>...",
        head,
        text.len().saturating_sub(max_len)
    )
}

fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let start = format!("<{}>", tag);
    let end = format!("</{}>", tag);
    let start_idx = text.find(&start)?;
    let end_idx = text[start_idx + start.len()..].find(&end)?;
    let content = &text[start_idx + start.len()..start_idx + start.len() + end_idx];
    Some(content.trim().to_string())
}

fn extract_response_block(text: &str) -> Option<String> {
    let start = text.find("<response>")?;
    let end = text.find("</response>")?;
    Some(text[start..end + "</response>".len()].to_string())
}

fn parse_decision(raw: &str) -> Option<Decision> {
    let xml = extract_response_block(raw).unwrap_or_else(|| raw.to_string());

    let action_raw = extract_tag(&xml, "action")?;
    let action = action_raw.trim().to_uppercase();
    let note = extract_tag(&xml, "note").unwrap_or_default();

    match action.as_str() {
        "STOP" => Some(Decision::Stop { note }),
        "SLEEP" => {
            let sleep_raw = extract_tag(&xml, "sleepMs")?;
            let sleep_ms = sleep_raw.parse::<u64>().ok()?;
            Some(Decision::Sleep {
                sleep_ms: clamp_u64(sleep_ms, 100, 60_000),
                note,
            })
        }
        "RUN" => {
            let command = extract_tag(&xml, "command")?;
            if command.trim().is_empty() {
                return None;
            }
            Some(Decision::Run { command, note })
        }
        _ => None,
    }
}

fn base_command(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

fn is_command_allowed(command: &str, allowed_base: &[String]) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Avoid shell meta characters; plugin-shell switches to `sh -c` when seeing these.
    let meta = ["|", ">", "<", ";", "&&", "||"];
    if meta.iter().any(|m| trimmed.contains(m)) {
        return false;
    }

    let cmd = base_command(trimmed);
    allowed_base.iter().any(|a| a == cmd)
}

fn build_prompt(goal: &str, allowed_dir: &Path, allowed_commands: &[String], recent_steps: &str) -> String {
    let allowed_list = allowed_commands.join(", ");
    format!(
        "You are an autonomous agent running inside a sandbox directory on the local machine.\n\n\
GOAL:\n{goal}\n\n\
SANDBOX:\n- You may ONLY run shell commands inside: {allowed}\n- You may ONLY use these base commands: {allowed_list}\n- Never use networking, package managers, or process control.\n- If you cannot make progress safely, choose SLEEP.\n\n\
RECENT HISTORY (most recent last):\n{recent}\n\n\
Choose exactly ONE next step and output ONLY this XML (no extra text):\n\
<response>\n  <action>RUN|SLEEP|STOP</action>\n  <command>...</command>\n  <sleepMs>...</sleepMs>\n  <note>short reason</note>\n</response>\n\n\
Rules:\n- If action is RUN, include <command> and omit <sleepMs>.\n- If action is SLEEP, include <sleepMs> (100-60000) and omit <command>.\n- If action is STOP, omit both <command> and <sleepMs>.\n- Keep output short.\n",
        goal = goal,
        allowed = allowed_dir.display(),
        allowed_list = allowed_list,
        recent = recent_steps
    )
}

fn find_repo_root(mut start: PathBuf) -> PathBuf {
    loop {
        let looks_like_repo = start.join("package.json").exists() && start.join("packages").exists();
        if looks_like_repo {
            return start;
        }
        if !start.pop() {
            return PathBuf::from(".");
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    if !LocalAIPlugin::is_llm_enabled() {
        anyhow::bail!(
            "Rust local-ai inference requires `elizaos-plugin-local-ai` with feature `llm` enabled."
        );
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let repo_root = find_repo_root(cwd);

    let default_sandbox = repo_root.join("examples").join("autonomous").join("sandbox");
    let allowed_directory = PathBuf::from(env_string(
        "SHELL_ALLOWED_DIRECTORY",
        default_sandbox.to_string_lossy().as_ref(),
    ));
    tokio::fs::create_dir_all(&allowed_directory)
        .await
        .with_context(|| format!("Failed to create sandbox dir: {}", allowed_directory.display()))?;

    // Ensure plugin-shell reads the same constrained directory
    std::env::set_var("SHELL_ALLOWED_DIRECTORY", &allowed_directory);

    let goal_file = PathBuf::from(env_string(
        "AUTONOMY_GOAL_FILE",
        allowed_directory.join("GOAL.txt").to_string_lossy().as_ref(),
    ));
    let stop_file = PathBuf::from(env_string(
        "AUTONOMY_STOP_FILE",
        allowed_directory.join("STOP").to_string_lossy().as_ref(),
    ));

    let interval_ms = clamp_u64(env_u64("AUTONOMY_INTERVAL_MS", 2000), 100, 60_000);
    let max_steps = clamp_u64(env_u64("AUTONOMY_MAX_STEPS", 200), 1, 1_000_000);

    let allowed_commands: Vec<String> = env_string("AUTONOMY_ALLOWED_COMMANDS", "ls,pwd,cat,echo,touch,mkdir")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if !goal_file.exists() {
        let default_goal = [
            "Explore the sandbox directory safely.",
            "Create a short STATUS.txt describing what you found.",
            "Keep commands small and only use allowed commands.",
        ]
        .join("\n");
        tokio::fs::write(&goal_file, format!("{}\n", default_goal))
            .await
            .with_context(|| format!("Failed to write goal file: {}", goal_file.display()))?;
    }

    let local_ai = LocalAIPlugin::from_env().context("Failed to initialize local-ai")?;

    let storage = MemoryStorage::new();
    storage.init().await?;
    let steps_collection = "autonomous_steps";

    let shell_config = ShellConfig::from_env()?;
    let mut shell_service = ShellService::new(shell_config.clone());

    println!(
        "Starting sandboxed autonomous loop (Rust).\n- sandbox: {}\n- goal file: {}\n- stop file: {}\n- intervalMs: {}\n- maxSteps: {}\n- allowedCommands: {}\n",
        allowed_directory.display(),
        goal_file.display(),
        stop_file.display(),
        interval_ms,
        max_steps,
        allowed_commands.join(", ")
    );

    let mut recent_summaries: Vec<String> = Vec::new();

    for step in 1..=max_steps {
        if stop_file.exists() {
            println!("STOP file found at {}; exiting.", stop_file.display());
            break;
        }

        let goal = tokio::fs::read_to_string(&goal_file)
            .await
            .unwrap_or_default()
            .trim()
            .to_string();

        let recent_steps_text = if recent_summaries.is_empty() {
            "(none yet)".to_string()
        } else {
            recent_summaries
                .iter()
                .rev()
                .take(10)
                .cloned()
                .collect::<Vec<String>>()
                .into_iter()
                .rev()
                .collect::<Vec<String>>()
                .join("\n\n---\n\n")
        };

        let prompt = build_prompt(&goal, &allowed_directory, &allowed_commands, &recent_steps_text);

        let decided_at_ms = now_ms();

        let raw_text = match local_ai
            .generate_text_with_params(
                &TextGenerationParams::new(prompt)
                    .max_tokens(512)
                    .temperature(0.7)
                    .top_p(0.9),
            )
            .await
        {
            Ok(res) => res.text,
            Err(e) => format!(
                "<response><action>SLEEP</action><sleepMs>2000</sleepMs><note>model-error:{}</note></response>",
                e
            ),
        };

        let decision = parse_decision(&raw_text).unwrap_or(Decision::Sleep {
            sleep_ms: 2000,
            note: "parse-failed".to_string(),
        });

        let mut shell_json = json!({ "executed": false });
        let mut summary_lines: Vec<String> = Vec::new();

        match &decision {
            Decision::Run { command, note } => {
                summary_lines.push(format!("[step {}] RUN", step));
                if !note.is_empty() {
                    summary_lines.push(format!("note: {}", note));
                }
                summary_lines.push(format!("command: {}", command));

                if !is_command_allowed(command, &allowed_commands) {
                    summary_lines.push(format!("shell: not executed (command-not-allowed): {}", command));
                    shell_json = json!({ "executed": false, "error": "command-not-allowed", "command": command });
                } else if !shell_config.enabled {
                    summary_lines.push("shell: not executed (shell disabled)".to_string());
                    shell_json = json!({ "executed": false, "error": "shell-disabled", "command": command });
                } else {
                    let result = shell_service
                        .execute_command(command, Some("autonomous"))
                        .await?;
                    summary_lines.push(format!(
                        "result: success={} exitCode={:?} cwd={}",
                        result.success, result.exit_code, result.executed_in
                    ));
                    if !result.stdout.is_empty() {
                        summary_lines.push(format!("stdout:\n{}", truncate(&result.stdout, 2000)));
                    }
                    if !result.stderr.is_empty() {
                        summary_lines.push(format!("stderr:\n{}", truncate(&result.stderr, 2000)));
                    }
                    if let Some(err) = &result.error {
                        summary_lines.push(format!("error: {}", err));
                    }
                    shell_json = json!({
                        "executed": true,
                        "command": command,
                        "success": result.success,
                        "exitCode": result.exit_code,
                        "stdout": truncate(&result.stdout, 2000),
                        "stderr": truncate(&result.stderr, 2000),
                        "executedIn": result.executed_in,
                        "error": result.error,
                    });
                }
            }
            Decision::Sleep { sleep_ms, note } => {
                summary_lines.push(format!("[step {}] SLEEP", step));
                if !note.is_empty() {
                    summary_lines.push(format!("note: {}", note));
                }
                summary_lines.push(format!("sleepMs: {}", sleep_ms));
            }
            Decision::Stop { note } => {
                summary_lines.push(format!("[step {}] STOP", step));
                if !note.is_empty() {
                    summary_lines.push(format!("note: {}", note));
                }
            }
        }

        let summary = summary_lines.join("\n");
        println!("\n{}\n", summary);

        let decision_json = match &decision {
            Decision::Run { command, note } => json!({ "action": "RUN", "command": command, "note": note }),
            Decision::Sleep { sleep_ms, note } => json!({ "action": "SLEEP", "sleepMs": sleep_ms, "note": note }),
            Decision::Stop { note } => json!({ "action": "STOP", "note": note }),
        };

        let record = StepRecord {
            step,
            decided_at_ms,
            goal: goal.clone(),
            decision: decision_json,
            shell: shell_json,
        };

        storage
            .set(
                steps_collection,
                &Uuid::new_v4().to_string(),
                serde_json::to_value(record).unwrap_or_else(|_| json!({ "error": "serialize-failed" })),
            )
            .await?;

        recent_summaries.push(truncate(&summary, 1200));

        if matches!(decision, Decision::Stop { .. }) {
            break;
        }

        let sleep_for = match decision {
            Decision::Sleep { sleep_ms, .. } => sleep_ms,
            _ => interval_ms,
        };
        sleep(Duration::from_millis(sleep_for)).await;
    }

    storage.close().await?;
    Ok(())
}

