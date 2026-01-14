//! SWE-agent CLI
//!
//! Main command-line interface for the SWE-agent software engineering agent.

use clap::{Parser, Subcommand};
use elizaos_sweagent::run::{
    run_batch_from_config, run_from_config, RunBatchConfig, RunSingleConfig,
};
use elizaos_sweagent::types::Trajectory;
use elizaos_sweagent::VERSION;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "sweagent")]
#[command(author = "elizaOS")]
#[command(version = VERSION)]
#[command(about = "SWE-agent: AI software engineering agent", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run swe-agent on a single problem statement instance
    #[command(alias = "r")]
    Run {
        /// Path to configuration file
        #[arg(long)]
        config: Option<PathBuf>,

        /// Model name to use
        #[arg(long = "agent.model.name")]
        model_name: Option<String>,

        /// GitHub repository URL
        #[arg(long = "env.repo.github_url")]
        github_url: Option<String>,

        /// Local repository path
        #[arg(long = "env.repo.path")]
        repo_path: Option<String>,

        /// GitHub issue URL for problem statement
        #[arg(long = "problem_statement.github_url")]
        issue_url: Option<String>,

        /// Path to problem statement file
        #[arg(long = "problem_statement.path")]
        problem_path: Option<String>,

        /// Output directory
        #[arg(long, default_value = "trajectories")]
        output_dir: String,

        /// Open a PR with the patch
        #[arg(long = "actions.open_pr")]
        open_pr: bool,

        /// Apply patch to local repository
        #[arg(long = "actions.apply_patch_locally")]
        apply_patch: bool,

        /// Enable verbose output
        #[arg(long, short)]
        verbose: bool,
    },

    /// Run swe-agent on a batch of problem statements
    #[command(alias = "b")]
    RunBatch {
        /// Path to configuration file
        #[arg(long)]
        config: Option<PathBuf>,

        /// Instance source type (swe_bench, file)
        #[arg(long = "instances.type")]
        instances_type: Option<String>,

        /// SWE-bench subset
        #[arg(long = "instances.subset")]
        subset: Option<String>,

        /// Dataset split
        #[arg(long = "instances.split")]
        split: Option<String>,

        /// Slice specification
        #[arg(long = "instances.slice")]
        slice: Option<String>,

        /// Shuffle instances
        #[arg(long = "instances.shuffle")]
        shuffle: bool,

        /// Filter instances by regex
        #[arg(long = "instances.filter")]
        filter: Option<String>,

        /// Path to instances file
        #[arg(long = "instances.path")]
        instances_path: Option<String>,

        /// Model name
        #[arg(long = "agent.model.name")]
        model_name: Option<String>,

        /// Cost limit per instance
        #[arg(long = "agent.model.per_instance_cost_limit")]
        cost_limit: Option<f64>,

        /// Output directory
        #[arg(long, default_value = "trajectories")]
        output_dir: String,

        /// Number of parallel workers
        #[arg(long, default_value = "1")]
        num_workers: usize,

        /// Redo existing trajectories
        #[arg(long)]
        redo_existing: bool,
    },

    /// Open a trajectory file and display info
    #[command(alias = "i")]
    Inspect {
        /// Path to trajectory file or directory
        #[arg(default_value = ".")]
        trajectory_path: PathBuf,

        /// Path to data file for gold patches
        #[arg(long, short)]
        data_path: Option<PathBuf>,

        /// Show full messages (not truncated)
        #[arg(long)]
        full: bool,
    },

    /// Calculate quick statistics from trajectories
    #[command(alias = "qs")]
    QuickStats {
        /// Directory to search for .traj files
        #[arg(default_value = ".")]
        directory: PathBuf,
    },

    /// Merge multiple prediction files
    MergePreds {
        /// Directories containing predictions
        directories: Vec<PathBuf>,

        /// Output file
        #[arg(long, short)]
        output: Option<PathBuf>,
    },

    /// Remove unfinished trajectories
    #[command(alias = "ru")]
    RemoveUnfinished {
        /// Base directory
        #[arg(long, default_value = ".")]
        base_dir: PathBuf,

        /// Actually remove (dry run by default)
        #[arg(long)]
        remove: bool,
    },

    /// Compare multiple run results
    #[command(alias = "cr")]
    CompareRuns {
        /// Paths to results files or directories
        paths: Vec<PathBuf>,

        /// Show instances with same results
        #[arg(long)]
        show_same: bool,
    },

    /// Replay a trajectory file
    RunReplay {
        /// Path to trajectory file
        #[arg(long)]
        traj_path: PathBuf,

        /// Override deployment type
        #[arg(long)]
        deployment: Option<String>,

        /// Output directory
        #[arg(long, default_value = "trajectories")]
        output_dir: String,

        /// Only execute forward passes
        #[arg(long)]
        forward_only: bool,

        /// Number of forward passes
        #[arg(long, default_value = "0")]
        n_forward: usize,
    },
}

/// Trajectory file format
#[derive(Debug, Serialize, Deserialize)]
struct TrajectoryFile {
    #[serde(default)]
    trajectory: Trajectory,
    #[serde(default)]
    info: TrajectoryInfo,
    #[serde(default)]
    history: Vec<serde_json::Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrajectoryInfo {
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    exit_status: String,
    #[serde(default)]
    submission: Option<String>,
    #[serde(default)]
    model_stats: Option<ModelStatsInfo>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ModelStatsInfo {
    #[serde(default)]
    instance_cost: f64,
    #[serde(default)]
    tokens_sent: u64,
    #[serde(default)]
    tokens_received: u64,
    #[serde(default)]
    api_calls: u64,
}

/// Statistics for a collection of trajectories
#[derive(Debug, Default)]
struct TrajectoryStats {
    total: usize,
    submitted: usize,
    empty_submission: usize,
    errored: usize,
    total_cost: f64,
    total_tokens_sent: u64,
    total_tokens_received: u64,
    total_api_calls: u64,
    exit_statuses: HashMap<String, usize>,
}

fn find_trajectory_files(dir: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();

    if dir.is_file() && dir.extension().is_some_and(|e| e == "traj") {
        files.push(dir.clone());
        return files;
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|e| e == "traj") {
                files.push(path);
            } else if path.is_dir() {
                files.extend(find_trajectory_files(&path));
            }
        }
    }

    files
}

fn load_trajectory(path: &PathBuf) -> anyhow::Result<TrajectoryFile> {
    let content = std::fs::read_to_string(path)?;
    let traj: TrajectoryFile = serde_json::from_str(&content)?;
    Ok(traj)
}

fn inspect_trajectory(path: &PathBuf, full: bool) -> anyhow::Result<()> {
    let traj = load_trajectory(path)?;

    println!("=== Trajectory: {} ===", path.display());
    println!("Instance ID: {}", traj.info.instance_id);
    println!("Exit Status: {}", traj.info.exit_status);

    if let Some(ref stats) = traj.info.model_stats {
        println!("\n--- Model Statistics ---");
        println!("Cost: ${:.4}", stats.instance_cost);
        println!("Tokens sent: {}", stats.tokens_sent);
        println!("Tokens received: {}", stats.tokens_received);
        println!("API calls: {}", stats.api_calls);
    }

    println!("\n--- Trajectory ({} steps) ---", traj.trajectory.len());
    for (idx, step) in traj.trajectory.iter().enumerate() {
        println!("\n[Step {}]", idx + 1);

        // Display thought if present
        if !step.thought.is_empty() {
            let thought = if full || step.thought.len() <= 200 {
                step.thought.clone()
            } else {
                format!("{}... (truncated)", &step.thought[..200])
            };
            println!("Thought: {}", thought);
        }

        // Display action
        if !step.action.is_empty() {
            let action = if full || step.action.len() <= 200 {
                step.action.clone()
            } else {
                format!("{}... (truncated)", &step.action[..200])
            };
            println!("Action: {}", action);
        }

        // Display observation (truncated by default)
        if !step.observation.is_empty() {
            let obs = if full || step.observation.len() <= 500 {
                step.observation.clone()
            } else {
                format!("{}... (truncated)", &step.observation[..500])
            };
            println!("Observation: {}", obs);
        }

        // Display execution time
        println!("Execution time: {:.2}s", step.execution_time);
    }

    if let Some(ref submission) = traj.info.submission {
        println!("\n--- Submission ---");
        let sub_display = if full || submission.len() <= 1000 {
            submission.clone()
        } else {
            format!(
                "{}... (truncated, {} bytes total)",
                &submission[..1000],
                submission.len()
            )
        };
        println!("{}", sub_display);
    }

    Ok(())
}

fn calculate_stats(files: &[PathBuf]) -> TrajectoryStats {
    let mut stats = TrajectoryStats::default();

    for path in files {
        stats.total += 1;

        match load_trajectory(path) {
            Ok(traj) => {
                // Track exit status
                let status = if traj.info.exit_status.is_empty() {
                    "unknown".to_string()
                } else {
                    traj.info.exit_status.clone()
                };
                *stats.exit_statuses.entry(status.clone()).or_insert(0) += 1;

                if status.contains("error") || status.contains("Error") {
                    stats.errored += 1;
                }

                // Track submission
                if let Some(ref sub) = traj.info.submission {
                    if sub.trim().is_empty() {
                        stats.empty_submission += 1;
                    } else {
                        stats.submitted += 1;
                    }
                } else {
                    stats.empty_submission += 1;
                }

                // Track model stats
                if let Some(ref model_stats) = traj.info.model_stats {
                    stats.total_cost += model_stats.instance_cost;
                    stats.total_tokens_sent += model_stats.tokens_sent;
                    stats.total_tokens_received += model_stats.tokens_received;
                    stats.total_api_calls += model_stats.api_calls;
                }
            }
            Err(e) => {
                tracing::warn!(path = ?path, error = %e, "Failed to load trajectory");
                stats.errored += 1;
            }
        }
    }

    stats
}

fn find_unfinished(dir: &PathBuf) -> Vec<PathBuf> {
    let files = find_trajectory_files(dir);
    let mut unfinished = Vec::new();

    for path in files {
        if let Ok(traj) = load_trajectory(&path) {
            // A trajectory is unfinished if it has no submission and no definitive exit status
            let is_finished = traj.info.submission.is_some()
                || traj.info.exit_status.contains("submitted")
                || traj.info.exit_status.contains("cost_limit")
                || traj.info.exit_status.contains("error");

            if !is_finished {
                unfinished.push(path);
            }
        }
    }

    unfinished
}

fn merge_predictions(dirs: &[PathBuf], output: Option<&PathBuf>) -> anyhow::Result<()> {
    let mut all_predictions: HashMap<String, serde_json::Value> = HashMap::new();

    for dir in dirs {
        let files = find_trajectory_files(dir);
        for path in files {
            if let Ok(traj) = load_trajectory(&path) {
                if let Some(ref submission) = traj.info.submission {
                    all_predictions.insert(
                        traj.info.instance_id.clone(),
                        serde_json::json!({
                            "instance_id": traj.info.instance_id,
                            "model_patch": submission,
                            "model_name_or_path": path.display().to_string(),
                        }),
                    );
                }
            }
        }
    }

    let predictions: Vec<_> = all_predictions.values().collect();
    let json = serde_json::to_string_pretty(&predictions)?;

    if let Some(output_path) = output {
        std::fs::write(output_path, &json)?;
        println!(
            "Wrote {} predictions to {}",
            predictions.len(),
            output_path.display()
        );
    } else {
        println!("{}", json);
    }

    Ok(())
}

fn compare_runs(paths: &[PathBuf], show_same: bool) -> anyhow::Result<()> {
    // Load predictions from each run
    let mut runs: Vec<(PathBuf, HashMap<String, String>)> = Vec::new();

    for path in paths {
        let mut predictions = HashMap::new();
        let files = find_trajectory_files(path);

        for file in files {
            if let Ok(traj) = load_trajectory(&file) {
                let status = if traj.info.submission.is_some() {
                    "submitted"
                } else {
                    "no_submission"
                };
                predictions.insert(traj.info.instance_id, status.to_string());
            }
        }

        runs.push((path.clone(), predictions));
    }

    // Find all instance IDs
    let mut all_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (_, preds) in &runs {
        all_ids.extend(preds.keys().cloned());
    }

    println!(
        "Comparing {} runs across {} instances\n",
        runs.len(),
        all_ids.len()
    );

    // Print header
    print!("{:<40}", "Instance ID");
    for (path, _) in &runs {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());
        print!("{:<20}", &name[..name.len().min(18)]);
    }
    println!();
    println!("{}", "-".repeat(40 + runs.len() * 20));

    // Print comparison
    let mut same_count = 0;
    let mut diff_count = 0;

    for id in all_ids {
        let statuses: Vec<&str> = runs
            .iter()
            .map(|(_, preds)| preds.get(&id).map(|s| s.as_str()).unwrap_or("-"))
            .collect();

        let all_same = statuses.iter().all(|s| *s == statuses[0]);

        if all_same {
            same_count += 1;
            if !show_same {
                continue;
            }
        } else {
            diff_count += 1;
        }

        print!("{:<40}", &id[..id.len().min(38)]);
        for status in &statuses {
            print!("{:<20}", status);
        }
        println!();
    }

    println!("\nSummary: {} same, {} different", same_count, diff_count);

    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            config,
            model_name: _,
            github_url: _,
            repo_path: _,
            issue_url: _,
            problem_path: _,
            output_dir,
            open_pr,
            apply_patch,
            verbose,
        } => {
            if verbose {
                tracing::info!("Running in verbose mode");
            }

            // Build configuration
            let mut run_config = if let Some(config_path) = config {
                let content = std::fs::read_to_string(&config_path)?;
                serde_yaml::from_str(&content)?
            } else {
                RunSingleConfig::default()
            };

            run_config.output_dir = output_dir;
            run_config.actions.open_pr = open_pr;
            run_config.actions.apply_patch_locally = apply_patch;

            let result = run_from_config(run_config).await?;

            if let Some(submission) = result.info.submission {
                println!("Submission:\n{}", submission);
            }

            println!("Exit status: {:?}", result.info.exit_status);
        }

        Commands::RunBatch {
            config,
            instances_type: _,
            subset: _,
            split: _,
            slice: _,
            shuffle: _,
            filter: _,
            instances_path: _,
            model_name: _,
            cost_limit: _,
            output_dir,
            num_workers,
            redo_existing,
        } => {
            let mut batch_config = if let Some(config_path) = config {
                let content = std::fs::read_to_string(&config_path)?;
                serde_yaml::from_str(&content)?
            } else {
                RunBatchConfig::default()
            };

            batch_config.output_dir = output_dir;
            batch_config.num_workers = num_workers;
            batch_config.redo_existing = redo_existing;

            let result = run_batch_from_config(batch_config).await?;

            println!(
                "Batch complete: {} completed, {} skipped, {} failed",
                result.completed, result.skipped, result.failed
            );
        }

        Commands::Inspect {
            trajectory_path,
            data_path: _,
            full,
        } => {
            let files = find_trajectory_files(&trajectory_path);

            if files.is_empty() {
                println!("No trajectory files found in {:?}", trajectory_path);
                return Ok(());
            }

            for file in files {
                if let Err(e) = inspect_trajectory(&file, full) {
                    eprintln!("Error inspecting {}: {}", file.display(), e);
                }
                println!();
            }
        }

        Commands::QuickStats { directory } => {
            let files = find_trajectory_files(&directory);

            if files.is_empty() {
                println!("No trajectory files found in {:?}", directory);
                return Ok(());
            }

            let stats = calculate_stats(&files);

            println!("=== Trajectory Statistics ===");
            println!("Directory: {:?}", directory);
            println!("Total trajectories: {}", stats.total);
            println!(
                "Submitted: {} ({:.1}%)",
                stats.submitted,
                100.0 * stats.submitted as f64 / stats.total as f64
            );
            println!(
                "Empty submission: {} ({:.1}%)",
                stats.empty_submission,
                100.0 * stats.empty_submission as f64 / stats.total as f64
            );
            println!(
                "Errored: {} ({:.1}%)",
                stats.errored,
                100.0 * stats.errored as f64 / stats.total as f64
            );
            println!();
            println!("=== Model Usage ===");
            println!("Total cost: ${:.4}", stats.total_cost);
            println!(
                "Average cost: ${:.4}",
                stats.total_cost / stats.total as f64
            );
            println!("Total tokens sent: {}", stats.total_tokens_sent);
            println!("Total tokens received: {}", stats.total_tokens_received);
            println!("Total API calls: {}", stats.total_api_calls);
            println!();
            println!("=== Exit Statuses ===");
            let mut sorted_statuses: Vec<_> = stats.exit_statuses.into_iter().collect();
            sorted_statuses.sort_by(|a, b| b.1.cmp(&a.1));
            for (status, count) in sorted_statuses {
                println!(
                    "  {}: {} ({:.1}%)",
                    status,
                    count,
                    100.0 * count as f64 / stats.total as f64
                );
            }
        }

        Commands::MergePreds {
            directories,
            output,
        } => {
            merge_predictions(&directories, output.as_ref())?;
        }

        Commands::RemoveUnfinished { base_dir, remove } => {
            let unfinished = find_unfinished(&base_dir);

            if unfinished.is_empty() {
                println!("No unfinished trajectories found in {:?}", base_dir);
                return Ok(());
            }

            println!("Found {} unfinished trajectories:", unfinished.len());
            for path in &unfinished {
                println!("  {}", path.display());
            }

            if remove {
                println!("\nRemoving...");
                for path in &unfinished {
                    if let Err(e) = std::fs::remove_file(path) {
                        eprintln!("Failed to remove {}: {}", path.display(), e);
                    } else {
                        println!("Removed: {}", path.display());
                    }
                }
                println!("Done. Removed {} files.", unfinished.len());
            } else {
                println!("\nDry run. Use --remove to actually delete these files.");
            }
        }

        Commands::CompareRuns { paths, show_same } => {
            compare_runs(&paths, show_same)?;
        }

        Commands::RunReplay {
            traj_path,
            deployment: _,
            output_dir: _,
            forward_only: _,
            n_forward: _,
        } => {
            // Load the trajectory
            let traj = load_trajectory(&traj_path)?;

            println!("=== Trajectory Replay ===");
            println!("File: {}", traj_path.display());
            println!("Instance: {}", traj.info.instance_id);
            println!("Steps: {}", traj.trajectory.len());

            // Extract actions from trajectory
            let actions: Vec<String> = traj
                .trajectory
                .iter()
                .filter(|step| !step.action.is_empty())
                .map(|step| step.action.clone())
                .collect();

            println!("\n--- Extracted Actions ({}) ---", actions.len());
            for (idx, action) in actions.iter().enumerate() {
                let preview: String = if action.len() > 100 {
                    format!("{}...", &action[..100])
                } else {
                    action.clone()
                };
                println!("[{}] {}", idx + 1, preview.replace('\n', "\\n"));
            }

            println!("\nReplay file generated. Use 'sweagent run' with --replay to execute.");

            // Save replay file
            let replay_path = traj_path.with_extension("replay.json");
            let replay_data = serde_json::json!({
                "instance_id": traj.info.instance_id,
                "actions": actions,
            });
            std::fs::write(&replay_path, serde_json::to_string_pretty(&replay_data)?)?;
            println!("Replay data saved to: {}", replay_path.display());
        }
    }

    Ok(())
}
