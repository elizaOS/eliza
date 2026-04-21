//! Eliza Framework Benchmark — Rust Runtime
//!
//! Measures core agent framework performance with mock LLM handlers
//! and in-memory database. No real LLM calls, no disk I/O, no network.

mod metrics;
mod mock_llm_plugin;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use serde::Deserialize;

use metrics::*;
use mock_llm_plugin::create_mock_llm_plugin;

// ─── Scenario types ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
struct ScenarioMessage {
    content: String,
    role: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScenarioConfig {
    #[serde(default)]
    check_should_respond: bool,
    #[serde(default)]
    multi_step: bool,
    #[serde(default = "default_warmup")]
    warmup: u32,
    #[serde(default = "default_iterations")]
    iterations: u32,
    #[serde(default)]
    dummy_providers: Option<u32>,
    #[serde(default)]
    pre_populate_history: Option<u32>,
    #[serde(default)]
    concurrent: bool,
    #[serde(default)]
    db_only: bool,
    #[serde(default)]
    db_operation: Option<String>,
    #[serde(default)]
    db_count: Option<u32>,
    #[serde(default)]
    startup_only: bool,
    #[serde(default)]
    minimal_bootstrap: bool,
}

fn default_warmup() -> u32 { 3 }
fn default_iterations() -> u32 { 10 }

#[derive(Debug, Deserialize, Clone)]
struct Scenario {
    id: String,
    name: String,
    description: String,
    messages: serde_json::Value, // Can be array or string like "_generate:100"
    config: ScenarioConfig,
}

#[derive(Debug, Deserialize)]
struct ScenariosFile {
    scenarios: Vec<Scenario>,
}

// ─── Path helpers ───────────────────────────────────────────────────────────

fn shared_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("..").join("shared")
}

fn results_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("..").join("results")
}

// ─── Load shared configuration ──────────────────────────────────────────────

fn load_scenarios() -> Result<Vec<Scenario>> {
    let path = shared_dir().join("scenarios.json");
    let raw = fs::read_to_string(&path)?;
    let file: ScenariosFile = serde_json::from_str(&raw)?;
    Ok(file.scenarios)
}

fn load_character() -> Result<serde_json::Value> {
    let path = shared_dir().join("character.json");
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn resolve_messages(messages: &serde_json::Value) -> Vec<ScenarioMessage> {
    if let Some(s) = messages.as_str() {
        if s.starts_with("_generate:") {
            let count: usize = s.split(':').nth(1).unwrap_or("10").parse().unwrap_or(10);
            return (0..count)
                .map(|i| ScenarioMessage {
                    content: format!("BenchmarkAgent, benchmark message number {}.", i + 1),
                    role: "user".to_string(),
                })
                .collect();
        }
        return vec![];
    }
    if let Some(arr) = messages.as_array() {
        return arr
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
    }
    vec![]
}

// ─── Benchmark runners ──────────────────────────────────────────────────────
//
// STATUS: STUB — The Rust elizaos AgentRuntime public API is not yet stable
// enough for direct integration. These runners produce results tagged with
// is_stub: true so consumers know the data is NOT from the real runtime.
//
// What IS measured (baseline only):
// - startup: mock plugin creation + HashMap allocation overhead
// - db: raw HashMap insert/get (NOT the elizaos InMemoryDatabaseAdapter)
// - message: mock handler lookup overhead (NOT handleMessage pipeline)
//
// To make this real, replace the body of each runner with:
// 1. elizaos::AgentRuntime::new(opts).initialize().await
// 2. runtime.message_service.handle_message(runtime, message, callback).await
// 3. Collect per-stage timings from the runtime

async fn run_startup_benchmark(
    _character: &serde_json::Value,
    config: &ScenarioConfig,
) -> ScenarioResult {
    eprintln!("    [STUB] Rust startup benchmark measures plugin creation only, not AgentRuntime");
    let mut timings: Vec<f64> = Vec::new();
    let mut mem_monitor = MemoryMonitor::new();
    mem_monitor.start();

    for _ in 0..config.iterations {
        let mut timer = Timer::new();
        timer.start();
        let _mock_plugin = create_mock_llm_plugin();
        timings.push(timer.stop());
    }

    let resources = mem_monitor.stop();
    let total_time: f64 = timings.iter().sum();

    ScenarioResult {
        iterations: config.iterations,
        warmup: 0,
        latency: compute_latency_stats(&timings),
        throughput: compute_throughput_stats(config.iterations as u64, total_time),
        pipeline: PipelineBreakdown::default(),
        resources,
    }
}

async fn run_db_benchmark(
    _character: &serde_json::Value,
    config: &ScenarioConfig,
) -> ScenarioResult {
    eprintln!("    [STUB] Rust DB benchmark measures raw HashMap ops, not InMemoryDatabaseAdapter");
    let count = config.db_count.unwrap_or(10000) as usize;
    let mut timings: Vec<f64> = Vec::new();
    let mut mem_monitor = MemoryMonitor::new();
    mem_monitor.start();

    let operation = config.db_operation.as_deref().unwrap_or("write");

    for _ in 0..config.iterations {
        let mut timer = Timer::new();
        timer.start();

        if operation == "write" {
            let mut store: HashMap<String, serde_json::Value> = HashMap::with_capacity(count);
            for j in 0..count {
                let key = format!("00000000-0000-0000-3000-{:012}", j);
                store.insert(key, serde_json::json!({
                    "text": format!("Write benchmark message {j}"),
                    "source": "benchmark",
                }));
            }
            std::hint::black_box(&store);
        } else {
            let mut store: HashMap<String, serde_json::Value> = HashMap::with_capacity(count);
            for j in 0..count {
                let key = format!("00000000-0000-0000-1000-{:012}", j);
                store.insert(key, serde_json::json!({"text": format!("Historical message {j}")}));
            }
            for j in 0..count {
                let key = format!("00000000-0000-0000-1000-{:012}", j);
                std::hint::black_box(store.get(&key));
            }
        }

        timings.push(timer.stop());
    }

    let resources = mem_monitor.stop();
    let total_time: f64 = timings.iter().sum();

    ScenarioResult {
        iterations: config.iterations,
        warmup: config.warmup,
        latency: compute_latency_stats(&timings),
        throughput: compute_throughput_stats((count * config.iterations as usize) as u64, total_time),
        pipeline: PipelineBreakdown {
            memory_create_avg_ms: if operation == "write" { total_time / (count * config.iterations as usize) as f64 } else { 0.0 },
            memory_get_avg_ms: if operation == "read" { total_time / (count * config.iterations as usize) as f64 } else { 0.0 },
            ..Default::default()
        },
        resources,
    }
}

async fn run_message_benchmark(
    _character: &serde_json::Value,
    messages: &[ScenarioMessage],
    config: &ScenarioConfig,
) -> ScenarioResult {
    eprintln!("    [STUB] Rust message benchmark measures handler lookup, not full pipeline");
    let mut all_timings: Vec<f64> = Vec::new();
    let mut pipeline_timer = PipelineTimer::new();
    let mut mem_monitor = MemoryMonitor::new();

    for _ in 0..config.warmup {
        let _mock_plugin = create_mock_llm_plugin();
        for msg in messages { std::hint::black_box(&msg.content); }
    }

    mem_monitor.start();

    for _i in 0..config.iterations {
        let mock_plugin = create_mock_llm_plugin();
        let mut iter_timer = Timer::new();
        iter_timer.start();

        for msg in messages {
            let msg_start = Instant::now();
            // Only measure handler lookup — NOT the full agent pipeline
            let _handler = mock_plugin.model_handlers.get("TEXT_LARGE");
            let msg_elapsed = msg_start.elapsed().as_secs_f64() * 1000.0;
            pipeline_timer.record("model_call", msg_elapsed);
            std::hint::black_box(&msg.content);
        }

        all_timings.push(iter_timer.stop());
        mem_monitor.poll();
    }

    let resources = mem_monitor.stop();
    let total_time: f64 = all_timings.iter().sum();
    let total_messages = messages.len() as u64 * config.iterations as u64;

    ScenarioResult {
        iterations: config.iterations,
        warmup: config.warmup,
        latency: compute_latency_stats(&all_timings),
        throughput: compute_throughput_stats(total_messages, total_time),
        pipeline: pipeline_timer.get_breakdown(),
        resources,
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let scenario_filter: Option<Vec<&str>> = args
        .iter()
        .find(|a| a.starts_with("--scenarios="))
        .map(|a| a.split('=').nth(1).unwrap_or("").split(',').collect());
    let run_all = args.iter().any(|a| a == "--all");
    let output_path: Option<&str> = args
        .iter()
        .find(|a| a.starts_with("--output="))
        .map(|a| a.split('=').nth(1).unwrap_or(""));

    let all_scenarios = load_scenarios()?;
    let character = load_character()?;

    let selected: Vec<&Scenario> = if let Some(ref ids) = scenario_filter {
        all_scenarios.iter().filter(|s| ids.contains(&s.id.as_str())).collect()
    } else if run_all {
        all_scenarios.iter().collect()
    } else {
        let default_ids = vec![
            "single-message", "conversation-10", "burst-100",
            "with-should-respond", "provider-scaling-10", "provider-scaling-50",
            "history-scaling-100", "history-scaling-1000",
            "concurrent-10", "db-write-throughput", "db-read-throughput",
            "startup-cold",
        ];
        all_scenarios
            .iter()
            .filter(|s| default_ids.contains(&s.id.as_str()))
            .collect()
    };

    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║           Eliza Framework Benchmark — Rust              ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();

    let sys_info = get_system_info();
    println!(
        "System: {} {} | {} CPUs | {:.1}GB RAM",
        sys_info.os, sys_info.arch, sys_info.cpus, sys_info.memory_gb
    );
    println!("Runtime: {}", sys_info.runtime_version);
    println!("Scenarios: {} selected", selected.len());
    println!();

    let mut results = BenchmarkResult {
        runtime: "rust".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        system: sys_info,
        scenarios: HashMap::new(),
        binary_size_bytes: None,
        is_stub: true,
    };

    for scenario in &selected {
        print!("Running: {}...", scenario.name);

        let start = Instant::now();

        let result = if scenario.config.startup_only {
            run_startup_benchmark(&character, &scenario.config).await
        } else if scenario.config.db_only {
            run_db_benchmark(&character, &scenario.config).await
        } else {
            let messages = resolve_messages(&scenario.messages);
            run_message_benchmark(&character, &messages, &scenario.config).await
        };

        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        println!(" done ({})", format_duration(elapsed_ms));
        print_scenario_result(&scenario.id, &result);

        results.scenarios.insert(scenario.id.clone(), result);
    }

    // Try to get binary size
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(meta) = fs::metadata(&exe) {
            results.binary_size_bytes = Some(meta.len());
            println!("\nBinary size: {:.1}KB", meta.len() as f64 / 1024.0);
        }
    }

    // Write results
    let out_path = output_path
        .map(|p| PathBuf::from(p))
        .unwrap_or_else(|| {
            results_dir().join(format!(
                "rust-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ))
        });

    let json = serde_json::to_string_pretty(&results)?;
    fs::write(&out_path, &json)?;
    println!("\nResults written to: {}", out_path.display());

    Ok(())
}
