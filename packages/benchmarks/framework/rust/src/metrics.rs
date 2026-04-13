//! Performance Metrics Collection Utilities — Rust Runtime
//!
//! High-resolution timing, memory monitoring, and statistical aggregation.

use serde::Serialize;
use std::time::Instant;
use sysinfo::System;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct LatencyStats {
    pub min_ms: f64,
    pub max_ms: f64,
    pub avg_ms: f64,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub stddev_ms: f64,
    pub raw_ms: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ThroughputStats {
    pub messages_per_second: f64,
    pub total_messages: u64,
    pub total_time_ms: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PipelineBreakdown {
    pub compose_state_avg_ms: f64,
    pub provider_execution_avg_ms: f64,
    pub should_respond_avg_ms: f64,
    pub model_call_avg_ms: f64,
    pub action_dispatch_avg_ms: f64,
    pub evaluator_avg_ms: f64,
    pub memory_create_avg_ms: f64,
    pub memory_get_avg_ms: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ResourceStats {
    pub memory_rss_start_mb: f64,
    pub memory_rss_peak_mb: f64,
    pub memory_rss_end_mb: f64,
    pub memory_delta_mb: f64,
    pub heap_used_start_mb: f64,
    pub heap_used_peak_mb: f64,
    pub heap_used_end_mb: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ScenarioResult {
    pub iterations: u32,
    pub warmup: u32,
    pub latency: LatencyStats,
    pub throughput: ThroughputStats,
    pub pipeline: PipelineBreakdown,
    pub resources: ResourceStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub cpus: usize,
    pub memory_gb: f64,
    pub runtime_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    pub runtime: String,
    pub timestamp: String,
    pub system: SystemInfo,
    pub scenarios: std::collections::HashMap<String, ScenarioResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_size_bytes: Option<u64>,
    /// When true, results are from stub runners that don't exercise the real runtime.
    /// Only the TypeScript benchmark currently produces non-stub results.
    #[serde(default)]
    pub is_stub: bool,
}

// ─── High-resolution timer ──────────────────────────────────────────────────

pub struct Timer {
    start: Instant,
    elapsed_ms: f64,
}

impl Timer {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            elapsed_ms: 0.0,
        }
    }

    pub fn start(&mut self) {
        self.start = Instant::now();
    }

    pub fn stop(&mut self) -> f64 {
        self.elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
        self.elapsed_ms
    }

    pub fn elapsed(&self) -> f64 {
        self.elapsed_ms
    }
}

// ─── Memory monitor ─────────────────────────────────────────────────────────

pub struct MemoryMonitor {
    sys: System,
    pid: sysinfo::Pid,
    start_rss: u64,
    peak_rss: u64,
}

impl MemoryMonitor {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let pid = sysinfo::Pid::from(std::process::id() as usize);
        Self {
            sys,
            pid,
            start_rss: 0,
            peak_rss: 0,
        }
    }

    fn refresh_and_get_rss(&mut self) -> u64 {
        self.sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[self.pid]),
            true,
        );
        self.sys
            .process(self.pid)
            .map(|p| p.memory())
            .unwrap_or(0)
    }

    pub fn start(&mut self) {
        let rss = self.refresh_and_get_rss();
        self.start_rss = rss;
        self.peak_rss = rss;
    }

    pub fn poll(&mut self) {
        let rss = self.refresh_and_get_rss();
        if rss > self.peak_rss {
            self.peak_rss = rss;
        }
    }

    pub fn stop(&mut self) -> ResourceStats {
        let end_rss = self.refresh_and_get_rss();
        if end_rss > self.peak_rss {
            self.peak_rss = end_rss;
        }

        let mb = 1024.0 * 1024.0;
        ResourceStats {
            memory_rss_start_mb: self.start_rss as f64 / mb,
            memory_rss_peak_mb: self.peak_rss as f64 / mb,
            memory_rss_end_mb: end_rss as f64 / mb,
            memory_delta_mb: (end_rss as f64 - self.start_rss as f64) / mb,
            heap_used_start_mb: 0.0, // Rust doesn't have a managed heap
            heap_used_peak_mb: 0.0,
            heap_used_end_mb: 0.0,
        }
    }
}

// ─── Pipeline instrumentation ───────────────────────────────────────────────

pub struct PipelineTimer {
    timings: std::collections::HashMap<String, Vec<f64>>,
}

impl PipelineTimer {
    pub fn new() -> Self {
        let mut timings = std::collections::HashMap::new();
        for cat in &[
            "compose_state",
            "provider_execution",
            "should_respond",
            "model_call",
            "action_dispatch",
            "evaluator",
            "memory_create",
            "memory_get",
        ] {
            timings.insert(cat.to_string(), Vec::new());
        }
        Self { timings }
    }

    pub fn record(&mut self, category: &str, duration_ms: f64) {
        self.timings
            .entry(category.to_string())
            .or_default()
            .push(duration_ms);
    }

    pub fn get_breakdown(&self) -> PipelineBreakdown {
        let avg = |arr: &[f64]| -> f64 {
            if arr.is_empty() {
                0.0
            } else {
                arr.iter().sum::<f64>() / arr.len() as f64
            }
        };

        PipelineBreakdown {
            compose_state_avg_ms: avg(self.timings.get("compose_state").unwrap_or(&vec![])),
            provider_execution_avg_ms: avg(self.timings.get("provider_execution").unwrap_or(&vec![])),
            should_respond_avg_ms: avg(self.timings.get("should_respond").unwrap_or(&vec![])),
            model_call_avg_ms: avg(self.timings.get("model_call").unwrap_or(&vec![])),
            action_dispatch_avg_ms: avg(self.timings.get("action_dispatch").unwrap_or(&vec![])),
            evaluator_avg_ms: avg(self.timings.get("evaluator").unwrap_or(&vec![])),
            memory_create_avg_ms: avg(self.timings.get("memory_create").unwrap_or(&vec![])),
            memory_get_avg_ms: avg(self.timings.get("memory_get").unwrap_or(&vec![])),
        }
    }

    #[allow(dead_code)]
    pub fn reset(&mut self) {
        for vals in self.timings.values_mut() {
            vals.clear();
        }
    }
}

// ─── Statistics ─────────────────────────────────────────────────────────────

fn percentile_val(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (pct / 100.0) * (sorted.len() - 1) as f64;
    let lower = idx.floor() as usize;
    let upper = idx.ceil() as usize;
    if lower == upper {
        return sorted[lower];
    }
    let weight = idx - lower as f64;
    sorted[lower] * (1.0 - weight) + sorted[upper] * weight
}

pub fn compute_latency_stats(raw_ms: &[f64]) -> LatencyStats {
    if raw_ms.is_empty() {
        return LatencyStats::default();
    }

    let mut sorted: Vec<f64> = raw_ms.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let sum: f64 = sorted.iter().sum();
    let avg = sum / sorted.len() as f64;
    let variance: f64 = sorted.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / sorted.len() as f64;
    let stddev = variance.sqrt();

    LatencyStats {
        min_ms: sorted[0],
        max_ms: sorted[sorted.len() - 1],
        avg_ms: avg,
        median_ms: percentile_val(&sorted, 50.0),
        p95_ms: percentile_val(&sorted, 95.0),
        p99_ms: percentile_val(&sorted, 99.0),
        stddev_ms: stddev,
        raw_ms: raw_ms.to_vec(),
    }
}

pub fn compute_throughput_stats(total_messages: u64, total_time_ms: f64) -> ThroughputStats {
    ThroughputStats {
        messages_per_second: if total_time_ms > 0.0 {
            (total_messages as f64 / total_time_ms) * 1000.0
        } else {
            0.0
        },
        total_messages,
        total_time_ms,
    }
}

// ─── System info ────────────────────────────────────────────────────────────

pub fn get_system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    SystemInfo {
        os: format!("{} {}", System::name().unwrap_or_default(), System::os_version().unwrap_or_default()),
        arch: std::env::consts::ARCH.to_string(),
        cpus: sys.cpus().len(),
        memory_gb: (sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0,
        runtime_version: format!(
            "Rust {} ({})",
            option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("unknown"),
            env!("CARGO_PKG_VERSION")
        ),
        platform: "rust".to_string(),
    }
}

// ─── Pretty print ───────────────────────────────────────────────────────────

pub fn format_duration(ms: f64) -> String {
    if ms < 1.0 {
        format!("{:.0}us", ms * 1000.0)
    } else if ms < 1000.0 {
        format!("{:.2}ms", ms)
    } else {
        format!("{:.2}s", ms / 1000.0)
    }
}

pub fn print_scenario_result(scenario_id: &str, result: &ScenarioResult) {
    let lat = &result.latency;
    let tp = &result.throughput;
    let res = &result.resources;
    let pl = &result.pipeline;
    println!("\n  {scenario_id}");
    println!("    Iterations: {} (warmup: {})", result.iterations, result.warmup);
    println!(
        "    Latency:  avg={}  median={}  p95={}  p99={}",
        format_duration(lat.avg_ms),
        format_duration(lat.median_ms),
        format_duration(lat.p95_ms),
        format_duration(lat.p99_ms)
    );
    println!(
        "    Range:    min={}  max={}  stddev={}",
        format_duration(lat.min_ms),
        format_duration(lat.max_ms),
        format_duration(lat.stddev_ms)
    );
    println!(
        "    Throughput: {:.1} msg/s ({} messages in {})",
        tp.messages_per_second,
        tp.total_messages,
        format_duration(tp.total_time_ms)
    );
    println!(
        "    Memory:   start={:.1}MB  peak={:.1}MB  delta={:.1}MB",
        res.memory_rss_start_mb, res.memory_rss_peak_mb, res.memory_delta_mb
    );
    println!(
        "    Pipeline: state={}  model={}  actions={}  memory={}",
        format_duration(pl.compose_state_avg_ms),
        format_duration(pl.model_call_avg_ms),
        format_duration(pl.action_dispatch_avg_ms),
        format_duration(pl.memory_create_avg_ms)
    );
}
