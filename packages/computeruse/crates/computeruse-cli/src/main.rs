#!/usr/bin/env cargo

//! ComputerUse CLI
//!
//! A cross-platform Rust tool to manage the ComputerUse project, including version management,
//! releases, and development workflows.
//!
//! Usage from workspace root:
//!   cargo run --bin computeruse -- patch      # Bump patch version
//!   cargo run --bin computeruse -- minor      # Bump minor version
//!   cargo run --bin computeruse -- major      # Bump major version
//!   cargo run --bin computeruse -- sync       # Sync all versions
//!   cargo run --bin computeruse -- status     # Show current status
//!   cargo run --bin computeruse -- tag        # Tag and push current version
//!   cargo run --bin computeruse -- release    # Full release: bump patch + tag + push
//!   cargo run --bin computeruse -- release minor # Full release: bump minor + tag + push

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use serde_json::Value;
use std::env;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use tokio::sync::Mutex;

mod commands;
mod mcp_client;
mod typescript_workflow;
mod workflow_result;
mod workflow_validator;

use workflow_result::WorkflowResult;
use workflow_validator::WorkflowOutputValidator;

#[derive(Parser)]
#[command(name = "computeruse")]
#[command(about = "🤖 ComputerUse CLI - AI-native GUI automation")]
#[command(
    long_about = "ComputerUse CLI provides tools for managing the ComputerUse project, including version management, releases, and development workflows."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(ValueEnum, Clone, Copy, Debug, Default)]
#[clap(rename_all = "lower")]
enum BumpLevel {
    #[default]
    Patch,
    Minor,
    Major,
}

impl std::fmt::Display for BumpLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", format!("{self:?}").to_lowercase())
    }
}

#[derive(Parser, Debug)]
struct ReleaseArgs {
    /// The part of the version to bump: patch, minor, or major.
    #[clap(value_enum, default_value_t = BumpLevel::Patch)]
    level: BumpLevel,
}

#[derive(Parser, Debug)]
struct McpChatArgs {
    /// MCP server URL (e.g., http://localhost:3000)
    #[clap(long, short = 'u', conflicts_with = "command")]
    url: Option<String>,

    /// Command to start MCP server via stdio (e.g., "npx -y computeruse-mcp-agent")
    #[clap(long, short = 'c', conflicts_with = "url")]
    command: Option<String>,
}

#[derive(Parser, Debug)]
struct McpExecArgs {
    /// MCP server URL
    #[clap(long, short = 'u', conflicts_with = "command")]
    url: Option<String>,

    /// Command to start MCP server via stdio
    #[clap(long, short = 'c', conflicts_with = "url")]
    command: Option<String>,

    /// Tool name to execute
    tool: String,

    /// Arguments for the tool (as JSON or simple string)
    args: Option<String>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
#[clap(rename_all = "lower")]
enum InputType {
    Auto,
    Gist,
    Raw,
    File,
}

#[derive(Parser, Debug, Clone)]
struct McpRunArgs {
    /// MCP server URL (e.g., http://localhost:3000)
    #[clap(long, short = 'u', conflicts_with = "command")]
    url: Option<String>,

    /// Command to start MCP server via stdio (e.g., "npx -y computeruse-mcp-agent")
    #[clap(long, short = 'c', conflicts_with = "url")]
    command: Option<String>,

    /// Input source - can be a GitHub gist URL, raw gist URL, or local file path (JSON/YAML)
    input: String,

    /// Input type (auto-detected by default)
    #[clap(long, value_enum, default_value = "auto")]
    input_type: InputType,

    /// Dry run - parse and validate the workflow without executing
    #[clap(long)]
    dry_run: bool,

    /// Verbose output
    #[clap(long, short)]
    verbose: bool,

    /// Stop on first error (default: true)
    #[clap(long)]
    no_stop_on_error: bool,

    /// Include detailed results (default: true)
    #[clap(long)]
    no_detailed_results: bool,

    /// Skip retry logic on errors (default: false, will retry on errors)
    #[clap(long)]
    no_retry: bool,

    /// Skip TypeScript type checking before execution (not recommended)
    #[clap(long)]
    skip_type_check: bool,

    /// Start execution from a specific step ID
    #[clap(long)]
    start_from_step: Option<String>,

    /// End execution at a specific step ID (inclusive)
    #[clap(long)]
    end_at_step: Option<String>,

    /// Follow fallback_id even beyond end_at_step boundary (default: false when end_at_step is specified)
    #[clap(long)]
    follow_fallback: Option<bool>,

    /// Execute jumps when reaching the end_at_step boundary (default: false)
    #[clap(long)]
    execute_jumps_at_end: Option<bool>,

    /// Disable output logging to file (logging is enabled by default)
    #[clap(long)]
    no_log: bool,

    /// JSON object with input values for workflow variables
    /// Example: --inputs '{"user":"john","count":5}'
    #[clap(long)]
    inputs: Option<String>,
}

#[derive(Subcommand)]
enum McpCommands {
    /// Interactive chat with MCP server
    Chat(McpChatArgs),
    /// Interactive AI-powered chat with MCP server
    AiChat(McpChatArgs),
    /// Execute a single MCP tool
    Exec(McpExecArgs),
    /// Execute a workflow sequence from a local file or GitHub gist
    Run(McpRunArgs),
    /// Validate workflow output structure
    Validate(McpValidateArgs),
    /// Generate TypeScript SDK snippet from MCP tool call
    Snippet(McpSnippetArgs),
}

#[derive(Parser, Debug, Clone)]
struct McpSnippetArgs {
    /// Tool name (e.g., click_element, type_into_element)
    tool: String,

    /// Arguments as JSON string
    args: String,
}

#[derive(Parser, Debug, Clone)]
struct McpValidateArgs {
    /// Input file containing workflow output (JSON format). Use '-' or omit to read from stdin
    input: Option<String>,

    /// Show quality score (0-100)
    #[clap(long)]
    score: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Bump patch version (x.y.Z+1)
    Patch,
    /// Bump minor version (x.Y+1.0)
    Minor,
    /// Bump major version (X+1.0.0)
    Major,
    /// Sync all package versions without bumping
    Sync,
    /// Show current version status
    Status,
    /// Tag current version and push (triggers CI)
    Tag,
    /// Full release: bump version + tag + push
    Release(ReleaseArgs),
    /// MCP client commands
    #[command(subcommand)]
    Mcp(McpCommands),
    /// Setup ComputerUse environment (Chrome extension, SDKs, dependencies)
    Setup(commands::setup::SetupCommand),
    /// Create a new TypeScript workflow project
    Init(commands::init::InitCommand),
}

fn main() {
    let cli = Cli::parse();

    // Only ensure we're in the project root for development commands
    match cli.command {
        Commands::Patch => {
            ensure_project_root();
            bump_version("patch");
        }
        Commands::Minor => {
            ensure_project_root();
            bump_version("minor");
        }
        Commands::Major => {
            ensure_project_root();
            bump_version("major");
        }
        Commands::Sync => {
            ensure_project_root();
            sync_all_versions();
        }
        Commands::Status => {
            ensure_project_root();
            show_status();
        }
        Commands::Tag => {
            ensure_project_root();
            tag_and_push();
        }
        Commands::Release(args) => {
            ensure_project_root();
            full_release(&args.level.to_string());
        }
        Commands::Mcp(mcp_cmd) => handle_mcp_command(mcp_cmd),
        Commands::Setup(setup_cmd) => {
            // Setup command doesn't require project root
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    if let Err(e) = setup_cmd.execute().await {
                        eprintln!("❌ Setup failed: {e}");
                        std::process::exit(1);
                    }
                });
        }
        Commands::Init(init_cmd) => {
            // Init command doesn't require project root
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    if let Err(e) = init_cmd.execute().await {
                        eprintln!("❌ Init failed: {e}");
                        std::process::exit(1);
                    }
                });
        }
    }
}

fn ensure_project_root() {
    // Check if we're already in the project root
    if Path::new("Cargo.toml").exists() && Path::new("crates/computeruse").exists() {
        return;
    }

    // If we're in computeruse-cli, go up two levels (crates/computeruse-cli -> crates -> root)
    if env::current_dir()
        .map(|p| {
            p.file_name()
                .map(|n| n == "computeruse-cli")
                .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        // Go up one level to crates/
        if env::set_current_dir("..").is_ok() {
            // Go up one more level to project root
            if env::set_current_dir("..").is_err() {
                eprintln!("❌ Failed to change to project root directory");
                std::process::exit(1);
            }
        } else {
            eprintln!("❌ Failed to change to crates directory");
            std::process::exit(1);
        }
        return;
    }

    // If we're in crates/, go up one level
    if env::current_dir()
        .map(|p| p.file_name().map(|n| n == "crates").unwrap_or(false))
        .unwrap_or(false)
        && env::set_current_dir("..").is_err()
    {
        eprintln!("❌ Failed to change to project root directory");
        std::process::exit(1);
    }

    // Final check
    if !Path::new("Cargo.toml").exists() || !Path::new("crates/computeruse").exists() {
        eprintln!("❌ Not in ComputerUse project root. Please run from workspace root.");
        eprintln!("💡 Usage: computeruse <command>");
        std::process::exit(1);
    }
}

fn get_workspace_version() -> Result<String, Box<dyn std::error::Error>> {
    let cargo_toml = fs::read_to_string("Cargo.toml")?;
    let mut in_workspace_package = false;

    for line in cargo_toml.lines() {
        let trimmed_line = line.trim();
        if trimmed_line == "[workspace.package]" {
            in_workspace_package = true;
            continue;
        }

        if in_workspace_package {
            if trimmed_line.starts_with('[') {
                // We've left the workspace.package section
                break;
            }
            if trimmed_line.starts_with("version") {
                if let Some(version_part) = trimmed_line.split('=').nth(1) {
                    if let Some(version) = version_part.trim().split('"').nth(1) {
                        return Ok(version.to_string());
                    }
                }
            }
        }
    }

    Err("Version not found in [workspace.package] in Cargo.toml".into())
}

fn sync_cargo_versions() -> Result<(), Box<dyn std::error::Error>> {
    println!("📦 Syncing Cargo.toml dependency versions...");
    let workspace_version = get_workspace_version()?;

    let cargo_toml = fs::read_to_string("Cargo.toml")?;
    let mut lines: Vec<String> = cargo_toml.lines().map(|s| s.to_string()).collect();
    let mut in_workspace_deps = false;
    let mut updated_count = 0;

    // Workspace crates that need version sync
    let workspace_crates = [
        "computeruse =",
        "computeruse-computer-use =",
        "computeruse-rs =",
    ];

    for line in &mut lines {
        let trimmed_line = line.trim();

        if trimmed_line.starts_with('[') {
            in_workspace_deps = trimmed_line == "[workspace.dependencies]";
            continue;
        }

        if in_workspace_deps {
            for crate_prefix in &workspace_crates {
                if trimmed_line.starts_with(crate_prefix) {
                    let line_clone = line.clone();
                    if let Some(start) = line_clone.find("version = \"") {
                        let version_start = start + "version = \"".len();
                        if let Some(end_quote_offset) = line_clone[version_start..].find('"') {
                            let range = version_start..(version_start + end_quote_offset);
                            if &line_clone[range.clone()] != workspace_version.as_str() {
                                line.replace_range(range, &workspace_version);
                                let crate_name = crate_prefix.trim_end_matches(" =");
                                println!("✅ Updated '{crate_name}' to {workspace_version}");
                                updated_count += 1;
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    if updated_count > 0 {
        fs::write("Cargo.toml", lines.join("\n") + "\n")?;
        println!("📦 Updated {updated_count} workspace dependencies");
    } else {
        println!("✅ All workspace dependency versions are up to date");
    }
    Ok(())
}

fn set_workspace_version(new_version: &str) -> Result<(), Box<dyn std::error::Error>> {
    let cargo_toml = fs::read_to_string("Cargo.toml")?;
    let mut lines: Vec<String> = cargo_toml.lines().map(|s| s.to_string()).collect();
    let mut in_workspace_package = false;
    let mut package_version_updated = false;

    let tmp = 0..lines.len();
    for i in tmp {
        let line = &lines[i];
        let trimmed_line = line.trim();

        if trimmed_line.starts_with('[') {
            in_workspace_package = trimmed_line == "[workspace.package]";
            continue;
        }

        if in_workspace_package && trimmed_line.starts_with("version =") {
            let indentation = line.len() - line.trim_start().len();
            lines[i] = format!("{}version = \"{}\"", " ".repeat(indentation), new_version);
            package_version_updated = true;
            break; // Exit after finding and updating the version
        }
    }

    if !package_version_updated {
        return Err("version key not found in [workspace.package] in Cargo.toml".into());
    }

    fs::write("Cargo.toml", lines.join("\n") + "\n")?;
    Ok(())
}

fn parse_version(version: &str) -> Result<(u32, u32, u32), Box<dyn std::error::Error>> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid version format".into());
    }

    let major = parts[0].parse::<u32>()?;
    let minor = parts[1].parse::<u32>()?;
    let patch = parts[2].parse::<u32>()?;

    Ok((major, minor, patch))
}

fn bump_version(bump_type: &str) {
    println!("🔄 Bumping {bump_type} version...");

    let current_version = match get_workspace_version() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("❌ Failed to get current version: {e}");
            return;
        }
    };

    let (major, minor, patch) = match parse_version(&current_version) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("❌ Failed to parse version {current_version}: {e}");
            return;
        }
    };

    let new_version = match bump_type {
        "patch" => format!("{}.{}.{}", major, minor, patch + 1),
        "minor" => format!("{}.{}.0", major, minor + 1),
        "major" => format!("{}.0.0", major + 1),
        _ => {
            eprintln!("❌ Invalid bump type: {bump_type}");
            return;
        }
    };

    println!("📝 {current_version} → {new_version}");

    if let Err(e) = set_workspace_version(&new_version) {
        eprintln!("❌ Failed to update workspace version: {e}");
        return;
    }

    println!("✅ Updated workspace version to {new_version}");
    sync_all_versions();
}

fn sync_all_versions() {
    println!("🔄 Syncing all package versions...");

    // First, sync versions within Cargo.toml
    if let Err(e) = sync_cargo_versions() {
        eprintln!("❌ Failed to sync versions in Cargo.toml: {e}");
        return;
    }

    let workspace_version = match get_workspace_version() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("❌ Failed to get workspace version: {e}");
            return;
        }
    };

    println!("📦 Workspace version: {workspace_version}");

    // Sync Node.js bindings
    sync_nodejs_bindings(&workspace_version);

    // Sync MCP agent
    sync_mcp_agent(&workspace_version);

    // Sync CLI package
    sync_cli(&workspace_version);

    // Sync Browser Extension
    sync_browser_extension(&workspace_version);

    // Sync Workflow Package
    sync_workflow_package(&workspace_version);

    // Sync KV Package
    sync_kv_package(&workspace_version);

    // Update Cargo.lock
    println!("🔒 Updating Cargo.lock...");
    if let Err(e) = run_command("cargo", &["check", "--quiet"]) {
        eprintln!("⚠️  Warning: Failed to update Cargo.lock: {e}");
    }

    println!("✅ All versions synchronized!");
}

fn sync_nodejs_bindings(version: &str) {
    println!("📦 Syncing Node.js bindings to version {version}...");

    let nodejs_dir = Path::new("packages/computeruse-nodejs");
    if !nodejs_dir.exists() {
        println!("⚠️  Node.js bindings directory not found, skipping");
        return;
    }

    // Update main package.json directly
    if let Err(e) = update_package_json("packages/computeruse-nodejs/package.json", version) {
        eprintln!("⚠️  Warning: Failed to update Node.js package.json directly: {e}");
    } else {
        println!("✅ Updated Node.js package.json to {version}");
    }

    // ALSO update CPU/platform-specific packages under packages/computeruse-nodejs/npm
    let npm_dir = nodejs_dir.join("npm");
    if npm_dir.exists() {
        if let Ok(entries) = fs::read_dir(&npm_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let package_json = entry.path().join("package.json");
                    if package_json.exists() {
                        if let Err(e) =
                            update_package_json(&package_json.to_string_lossy(), version)
                        {
                            eprintln!(
                                "⚠️  Warning: Failed to update {}: {}",
                                package_json.display(),
                                e
                            );
                        } else {
                            println!("📦 Updated {}", entry.file_name().to_string_lossy());
                        }
                    }
                }
            }
        }
    }

    // Run sync script if it exists (still useful for additional tasks like N-API metadata)
    let original_dir = match env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("❌ Could not get current directory: {e}");
            return;
        }
    };

    if env::set_current_dir(nodejs_dir).is_ok() {
        println!("🔄 Running npm run sync-version...");
        if run_command("npm", &["run", "sync-version"]).is_ok() {
            println!("✅ Node.js sync script completed");
        } else {
            // This is not really a failure - the versions are already synced
            println!(
                "ℹ️  Note: npm sync-version script exited (versions may already be up-to-date)"
            );
        }
        // Always change back to the original directory
        if let Err(e) = env::set_current_dir(&original_dir) {
            eprintln!("❌ Failed to restore original directory: {e}");
            std::process::exit(1); // Exit if we can't get back, to avoid further errors
        }
    } else {
        eprintln!("⚠️  Warning: Could not switch to Node.js directory");
    }
}

fn sync_mcp_agent(version: &str) {
    println!("📦 Syncing MCP agent to version {version}...");

    let mcp_dir = Path::new("crates/computeruse-mcp-agent");
    if !mcp_dir.exists() {
        println!("⚠️  MCP agent directory not found, skipping");
        return;
    }

    // Update main package.json
    if let Err(e) = update_package_json("crates/computeruse-mcp-agent/package.json", version) {
        eprintln!("⚠️  Warning: Failed to update MCP agent package.json: {e}");
        return;
    }
    println!("✅ Updated MCP agent package.json to {version}");

    // Update platform packages
    let npm_dir = mcp_dir.join("npm");
    if npm_dir.exists() {
        if let Ok(entries) = fs::read_dir(npm_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let package_json = entry.path().join("package.json");
                    if package_json.exists() {
                        if let Err(e) =
                            update_package_json(&package_json.to_string_lossy(), version)
                        {
                            eprintln!(
                                "⚠️  Warning: Failed to update {}: {}",
                                entry.path().display(),
                                e
                            );
                        } else {
                            println!("📦 Updated {}", entry.file_name().to_string_lossy());
                        }
                    }
                }
            }
        }
    }

    // Update package-lock.json
    let original_dir = match env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("❌ Could not get current directory: {e}");
            return;
        }
    };

    if env::set_current_dir(mcp_dir).is_ok() {
        if run_command("npm", &["install", "--package-lock-only", "--silent"]).is_ok() {
            println!("✅ MCP package-lock.json updated");
        } else {
            println!("ℹ️  Note: package-lock.json update skipped (run 'npm install' in crates/computeruse-mcp-agent if needed)");
        }
        // Always change back to the original directory
        if let Err(e) = env::set_current_dir(&original_dir) {
            eprintln!("❌ Failed to restore original directory: {e}");
            std::process::exit(1);
        }
    }

    println!("✅ MCP agent synced");
}

fn sync_cli(version: &str) {
    println!("📦 Syncing CLI package...");

    let cli_dir = Path::new("crates/computeruse-cli");
    if !cli_dir.exists() {
        return;
    }

    // Update main package.json
    if let Err(e) = update_package_json("crates/computeruse-cli/package.json", version) {
        eprintln!("⚠️  Warning: Failed to update CLI package.json: {e}");
        return;
    }

    // Update platform packages
    let npm_dir = cli_dir.join("npm");
    if npm_dir.exists() {
        if let Ok(entries) = fs::read_dir(npm_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let package_json = entry.path().join("package.json");
                    if package_json.exists() {
                        if let Err(e) =
                            update_package_json(&package_json.to_string_lossy(), version)
                        {
                            eprintln!(
                                "⚠️  Warning: Failed to update {}: {}",
                                entry.path().display(),
                                e
                            );
                        } else {
                            println!("📦 Updated {}", entry.file_name().to_string_lossy());
                        }
                    }
                }
            }
        }
    }

    println!("✅ CLI package synced");
}

fn sync_browser_extension(version: &str) {
    println!("📦 Syncing browser extension to version {version}...");

    let ext_dir = Path::new("crates/computeruse/browser-extension");
    if !ext_dir.exists() {
        println!("⚠️  Browser extension directory not found, skipping");
        return;
    }

    let manifest_path = ext_dir.join("manifest.json");
    if manifest_path.exists() {
        if let Err(e) = update_json_version(&manifest_path.to_string_lossy(), version) {
            eprintln!(
                "⚠️  Warning: Failed to update {}: {}",
                manifest_path.display(),
                e
            );
        } else {
            println!("✅ Updated manifest.json to {version}");
        }
    }

    let build_check_path = ext_dir.join("build_check.json");
    if build_check_path.exists() {
        if let Err(e) = update_json_version(&build_check_path.to_string_lossy(), version) {
            eprintln!(
                "⚠️  Warning: Failed to update {}: {}",
                build_check_path.display(),
                e
            );
        } else {
            println!("✅ Updated build_check.json to {version}");
        }
    }
}

fn sync_workflow_package(version: &str) {
    println!("📦 Syncing workflow package to version {version}...");

    let workflow_dir = Path::new("packages/workflow");
    if !workflow_dir.exists() {
        println!("⚠️  Workflow package directory not found, skipping");
        return;
    }

    let package_json = workflow_dir.join("package.json");
    if package_json.exists() {
        if let Err(e) = update_package_json(&package_json.to_string_lossy(), version) {
            eprintln!("⚠️  Warning: Failed to update workflow package.json: {e}");
        } else {
            println!("✅ Workflow package synced to {version}");
        }
    }
}

fn sync_kv_package(version: &str) {
    println!("📦 Syncing KV package to version {version}...");

    let kv_dir = Path::new("packages/kv");
    if !kv_dir.exists() {
        println!("⚠️  KV package directory not found, skipping");
        return;
    }

    let package_json = kv_dir.join("package.json");
    if package_json.exists() {
        if let Err(e) = update_package_json(&package_json.to_string_lossy(), version) {
            eprintln!("⚠️  Warning: Failed to update KV package.json: {e}");
        } else {
            println!("✅ KV package synced to {version}");
        }
    }
}

fn update_package_json(path: &str, version: &str) -> Result<(), Box<dyn std::error::Error>> {
    let content = fs::read_to_string(path)?;
    let mut pkg: serde_json::Value = serde_json::from_str(&content)?;

    // Update main version
    pkg["version"] = serde_json::Value::String(version.to_string());

    // Update optional dependencies for platform packages
    if let Some(deps) = pkg
        .get_mut("optionalDependencies")
        .and_then(|v| v.as_object_mut())
    {
        for (key, value) in deps.iter_mut() {
            // Update @elizaos/computeruse-* platform packages
            if key.starts_with("@elizaos/computeruse-")
                || key.starts_with("@mediar-ai/cli-")
                || key.starts_with("computeruse-mcp-")
                || key.starts_with("computeruse.js-")
            {
                *value = serde_json::Value::String(version.to_string());
            }
        }
    }

    // Update peerDependencies for @elizaos/computeruse
    if let Some(peer_deps) = pkg
        .get_mut("peerDependencies")
        .and_then(|v| v.as_object_mut())
    {
        for (key, value) in peer_deps.iter_mut() {
            if key == "@elizaos/computeruse" {
                // Use caret range for peer dependencies (allows compatible versions)
                *value = serde_json::Value::String(format!("^{version}"));
            }
        }
    }

    // Write back with pretty formatting
    let formatted = serde_json::to_string_pretty(&pkg)?;
    fs::write(path, formatted + "\n")?;

    Ok(())
}

fn update_json_version(path: &str, version: &str) -> Result<(), Box<dyn std::error::Error>> {
    let content = fs::read_to_string(path)?;
    let mut json_value: serde_json::Value = serde_json::from_str(&content)?;

    json_value["version"] = serde_json::Value::String(version.to_string());

    let formatted = serde_json::to_string_pretty(&json_value)?;
    fs::write(path, formatted + "\n")?;

    Ok(())
}

fn show_status() {
    println!("📊 ComputerUse Project Status");
    println!("============================");

    let workspace_version = get_workspace_version().unwrap_or_else(|_| "ERROR".to_string());
    println!("📦 Workspace version: {workspace_version}");

    // Show package versions
    let nodejs_version = get_package_version("packages/computeruse-nodejs/package.json");
    let mcp_version = get_package_version("crates/computeruse-mcp-agent/package.json");
    let browser_extension_version =
        get_package_version("crates/computeruse/browser-extension/manifest.json");
    let workflow_version = get_package_version("packages/workflow/package.json");

    println!();
    println!("Package versions:");
    println!("  Node.js bindings:  {nodejs_version}");
    println!("  MCP agent:         {mcp_version}");
    println!("  Browser extension: {browser_extension_version}");
    println!("  Workflow package:  {workflow_version}");

    // Git status
    println!();
    println!("Git status:");
    if let Ok(output) = Command::new("git").args(["status", "--porcelain"]).output() {
        let status = String::from_utf8_lossy(&output.stdout);
        if status.trim().is_empty() {
            println!("  ✅ Working directory clean");
        } else {
            println!("  ⚠️  Uncommitted changes:");
            for line in status.lines().take(5) {
                println!("     {line}");
            }
        }
    }
}

fn get_package_version(path: &str) -> String {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(pkg) => pkg
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "No version field".to_string()),
            Err(_) => "Parse error".to_string(),
        },
        Err(_) => "Not found".to_string(),
    }
}

fn tag_and_push() {
    let version = match get_workspace_version() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("❌ Failed to get current version: {e}");
            return;
        }
    };

    println!("🏷️  Tagging and pushing version {version}...");

    // Check for uncommitted changes
    if let Ok(output) = Command::new("git").args(["diff", "--name-only"]).output() {
        let diff = String::from_utf8_lossy(&output.stdout);
        if !diff.trim().is_empty() {
            println!("⚠️  Uncommitted changes detected. Committing...");
            if let Err(e) = run_command("git", &["add", "."]) {
                eprintln!("❌ Failed to git add: {e}");
                return;
            }
            if let Err(e) = run_command(
                "git",
                &["commit", "-m", &format!("Bump version to {version}")],
            ) {
                eprintln!("❌ Failed to git commit: {e}");
                return;
            }
        }
    }

    // Create tag
    let tag = format!("v{version}");
    if let Err(e) = run_command(
        "git",
        &[
            "tag",
            "-a",
            &tag,
            "-m",
            &format!("Release version {version}"),
        ],
    ) {
        eprintln!("❌ Failed to create tag: {e}");
        return;
    }

    // Push changes and tag
    if let Err(e) = run_command("git", &["push", "origin", "main"]) {
        eprintln!("❌ Failed to push changes: {e}");
        return;
    }

    if let Err(e) = run_command("git", &["push", "origin", &tag]) {
        eprintln!("❌ Failed to push tag: {e}");
        return;
    }

    println!("✅ Successfully released version {version}!");
    println!("🔗 Check CI: https://github.com/mediar-ai/computeruse/actions");
}

fn full_release(bump_type: &str) {
    println!("🚀 Starting full release process with {bump_type} bump...");
    bump_version(bump_type);
    tag_and_push();
}

fn run_command(program: &str, args: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Command failed: {} {}\nError: {}",
            program,
            args.join(" "),
            stderr
        )
        .into());
    }

    Ok(())
}

fn handle_mcp_command(cmd: McpCommands) {
    // Handle validate separately as it doesn't need MCP connection
    if let McpCommands::Validate(args) = cmd {
        if let Err(e) = validate_workflow_output(args) {
            eprintln!("❌ Validation error: {e}");
            std::process::exit(1);
        }
        return;
    }

    // Handle snippet generation - doesn't need MCP connection
    if let McpCommands::Snippet(args) = cmd {
        if let Err(e) = generate_snippet(args) {
            eprintln!("❌ Snippet generation error: {e}");
            std::process::exit(1);
        }
        return;
    }

    let transport = match cmd {
        McpCommands::Chat(ref args) => parse_transport(args.url.clone(), args.command.clone()),
        McpCommands::AiChat(ref args) => parse_transport(args.url.clone(), args.command.clone()),
        McpCommands::Exec(ref args) => parse_transport(args.url.clone(), args.command.clone()),
        McpCommands::Run(ref args) => parse_transport(args.url.clone(), args.command.clone()),
        McpCommands::Validate(_) => unreachable!(), // Handled above
        McpCommands::Snippet(_) => unreachable!(),  // Handled above
    };

    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

    let result = rt.block_on(async {
        match cmd {
            McpCommands::Chat(_) => mcp_client::interactive_chat(transport).await,
            McpCommands::AiChat(_) => mcp_client::natural_language_chat(transport).await,
            McpCommands::Exec(args) => {
                mcp_client::execute_command(transport, args.tool, args.args).await
            }
            McpCommands::Run(args) => run_workflow(transport, args).await,
            McpCommands::Validate(_) => unreachable!(), // Handled above
            McpCommands::Snippet(_) => unreachable!(),  // Handled above
        }
    });

    if let Err(e) = result {
        eprintln!("❌ MCP command error: {e}");
        std::process::exit(1);
    }
}

fn validate_workflow_output(args: McpValidateArgs) -> Result<()> {
    // Read the input - from file or stdin
    let content = match args.input.as_deref() {
        None | Some("-") => {
            // Read from stdin
            use std::io::Read;
            let mut buffer = String::new();
            std::io::stdin()
                .read_to_string(&mut buffer)
                .context("Failed to read from stdin")?;
            buffer
        }
        Some(path) => {
            // Read from file
            fs::read_to_string(path).with_context(|| format!("Failed to read file: {path}"))?
        }
    };

    // Parse as JSON
    let output: Value = serde_json::from_str(&content).context("Failed to parse JSON input")?;

    // Validate the structure
    let validation_result = WorkflowOutputValidator::validate(&output);

    // Display results
    WorkflowOutputValidator::display_results(&validation_result);

    // Show quality score if requested
    if args.score {
        let score = validation_result.quality_score();
        println!("Quality Score: {score}/100");

        let rating = match score {
            90..=100 => "Excellent",
            75..=89 => "Good",
            60..=74 => "Fair",
            _ => "Needs Improvement",
        };
        println!("Rating: {rating}");
    }

    // Exit with error if validation failed
    if !validation_result.is_valid() {
        std::process::exit(1);
    }

    Ok(())
}

/// Generate TypeScript SDK snippet from tool name and args
fn generate_snippet(args: McpSnippetArgs) -> Result<()> {
    // Parse args JSON
    let args_value: Value = serde_json::from_str(&args.args)
        .with_context(|| format!("Failed to parse args JSON: {}", args.args))?;

    // Generate snippet using computeruse-mcp-agent's function
    let snippet = computeruse_mcp_agent::execution_logger::generate_typescript_snippet(
        &args.tool,
        &args_value,
        Ok(&serde_json::json!({"status": "success"})), // Assume success for snippet generation
    );

    // Output just the snippet (without status comment for cleaner output)
    // The function returns "// Status: SUCCESS\n<snippet>\n" - extract just the snippet
    let lines: Vec<&str> = snippet.lines().collect();
    let snippet_only = if lines.len() > 1 && lines[0].starts_with("// Status:") {
        lines[1..].join("\n")
    } else {
        snippet
    };

    println!("{}", snippet_only);
    Ok(())
}

fn parse_transport(url: Option<String>, command: Option<String>) -> mcp_client::Transport {
    if let Some(url) = url {
        // Check for MCP_AUTH_TOKEN environment variable
        let auth_token = std::env::var("MCP_AUTH_TOKEN").ok();
        if auth_token.is_some() {
            println!("🔒 Using authentication token from MCP_AUTH_TOKEN environment variable");
        }
        mcp_client::Transport::Http { url, auth_token }
    } else if let Some(command) = command {
        let parts = parse_command(&command);
        mcp_client::Transport::Stdio(parts)
    } else {
        // Default to spawning local MCP agent via npx for convenience
        let default_cmd = "npx -y computeruse-mcp-agent@latest";
        println!("ℹ️  No --url or --command specified. Falling back to '{default_cmd}'");
        let parts = parse_command(default_cmd);
        mcp_client::Transport::Stdio(parts)
    }
}

fn parse_command(command: &str) -> Vec<String> {
    // Simple command parsing - splits by spaces but respects quotes
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for c in command.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            ' ' if !in_quotes => {
                if !current.is_empty() {
                    parts.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(c),
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

/// Run workflow with output logging to file
async fn run_logged_workflow(args: McpRunArgs) -> anyhow::Result<()> {
    use chrono::Local;
    use colored::Colorize;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // Determine base log directory
    // Use data_local_dir (same as state) for consistency: %LOCALAPPDATA%\mediar\workflows\
    let base_log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| dirs::cache_dir().unwrap_or_else(std::env::temp_dir))
        .join("mediar")
        .join("workflows");

    // Create a workflow-specific subdirectory based on input path (like state persistence)
    let workflow_hash = {
        let mut hasher = DefaultHasher::new();
        args.input.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    };

    // Log directory: %LOCALAPPDATA%\mediar\workflows\<hash>\logs\
    let log_dir = base_log_dir.join(&workflow_hash).join("logs");

    // Create directory if it doesn't exist
    fs::create_dir_all(&log_dir)?;

    // Create latest.txt and timestamped file paths in the workflow-specific directory
    let latest_path = log_dir.join("latest.txt");
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    // CLIPPY: Use implicit capture for format!
    let timestamped_path = log_dir.join(format!("run_{timestamp}.txt"));

    // Open both files for writing
    let latest_file = Arc::new(Mutex::new(
        fs::File::create(&latest_path)
            .with_context(|| format!("Failed to create {}", latest_path.display()))?,
    ));
    let timestamped_file = Arc::new(Mutex::new(
        fs::File::create(&timestamped_path)
            .with_context(|| format!("Failed to create {}", timestamped_path.display()))?,
    ));

    println!("{}", "📝 Workflow logs:".cyan());
    println!("   Latest: {}", latest_path.display());
    println!("   Run:    {}", timestamped_path.display());

    // Show state file location if it exists (in same parent directory)
    let state_file = log_dir.parent().unwrap().join("state.json");
    if state_file.exists() {
        println!("   State:  {}", state_file.display());
    }
    println!();

    // Build command to re-execute ourselves with --no-log to prevent recursion
    let current_exe = env::current_exe()?;
    let mut cmd = tokio::process::Command::new(&current_exe);

    // Reconstruct arguments with --no-log added to prevent recursion
    let args_vec: Vec<String> = env::args().collect();
    let mut skip_next = false;
    let mut reconstructed_args = Vec::new();

    for (i, arg) in args_vec.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }

        // Skip the executable name (first arg)
        if i == 0 {
            continue;
        }

        // Check if this arg takes a value
        if arg.starts_with("--") && i + 1 < args_vec.len() {
            let next_arg = &args_vec[i + 1];
            if !next_arg.starts_with("-") {
                // This is a flag with a value, include both
                reconstructed_args.push(arg.clone());
                reconstructed_args.push(next_arg.clone());
                skip_next = true;
                continue;
            }
        }

        reconstructed_args.push(arg.clone());
    }

    // Add --no-log to prevent infinite recursion
    reconstructed_args.push("--no-log".to_string());

    cmd.args(&reconstructed_args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn the child process
    let mut child = cmd
        .spawn()
        .with_context(|| "Failed to spawn computeruse subprocess")?;

    // Get handles to stdout and stderr
    let stdout = child.stdout.take().expect("Failed to get stdout");
    let stderr = child.stderr.take().expect("Failed to get stderr");

    // Function to strip ANSI codes
    fn strip_ansi_codes(text: &str) -> String {
        let ansi_regex = regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap();
        ansi_regex.replace_all(text, "").to_string()
    }

    // Spawn tasks to handle stdout and stderr
    let latest_file_stdout = Arc::clone(&latest_file);
    let timestamped_file_stdout = Arc::clone(&timestamped_file);
    let stdout_task = tokio::spawn(async move {
        let mut reader = AsyncBufReader::new(stdout);
        let mut line = String::new();

        while reader.read_line(&mut line).await? > 0 {
            // Write to console (with colors)
            // CLIPPY: Use implicit capture for print!
            print!("{line}"); // CLIPPY FIXED

            // Write to files (without colors)
            let clean_line = strip_ansi_codes(&line);
            latest_file_stdout
                .lock()
                .await
                .write_all(clean_line.as_bytes())?;
            timestamped_file_stdout
                .lock()
                .await
                .write_all(clean_line.as_bytes())?;

            line.clear();
        }
        Ok::<(), anyhow::Error>(())
    });

    let latest_file_stderr = Arc::clone(&latest_file);
    let timestamped_file_stderr = Arc::clone(&timestamped_file);
    let stderr_task = tokio::spawn(async move {
        let mut reader = AsyncBufReader::new(stderr);
        let mut line = String::new();

        while reader.read_line(&mut line).await? > 0 {
            // Write to console (with colors)
            // CLIPPY: Use implicit capture for eprint!
            eprint!("{line}"); // CLIPPY FIXED

            // Write to files (without colors)
            let clean_line = strip_ansi_codes(&line);
            latest_file_stderr
                .lock()
                .await
                .write_all(clean_line.as_bytes())?;
            timestamped_file_stderr
                .lock()
                .await
                .write_all(clean_line.as_bytes())?;

            line.clear();
        }
        Ok::<(), anyhow::Error>(())
    });

    // Wait for child process to complete
    let status = child.wait().await?;

    // Wait for output tasks to complete
    let _ = tokio::join!(stdout_task, stderr_task);

    // Flush files
    latest_file.lock().await.flush()?;
    timestamped_file.lock().await.flush()?;

    println!();
    println!("{}", "📄 Output saved to:".green()); // CLIPPY FIXED
    println!("   {}", latest_path.display());

    // Exit with same code as child
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }

    Ok(())
}

async fn run_workflow(transport: mcp_client::Transport, args: McpRunArgs) -> anyhow::Result<()> {
    use tracing::info;

    // By default, log output to file unless --no-log is specified
    if !args.no_log {
        return run_logged_workflow(args).await;
    }

    if args.verbose {
        // Keep rmcp quieter even in verbose mode unless user explicitly overrides
        std::env::set_var("RUST_LOG", "debug,rmcp=warn");
    }

    // Initialize logging with file output (only if not already initialized)
    {
        use std::env;
        use tracing_appender::rolling;
        use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

        // Determine log directory - check for override first
        let log_dir = if let Ok(custom_dir) = env::var("COMPUTERUSE_LOG_DIR") {
            // User-specified log directory via environment variable
            std::path::PathBuf::from(custom_dir)
        } else {
            // Use standard directories: data_local_dir on all platforms with temp fallback
            dirs::data_local_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("computeruse")
                .join("logs")
        };

        // Create log directory if it doesn't exist
        let _ = std::fs::create_dir_all(&log_dir);

        // Create a daily rolling file appender
        let file_appender = rolling::daily(&log_dir, "computeruse-cli.log");

        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            // Suppress noisy rmcp info logs by default while keeping our own at info
            .unwrap_or_else(|_| "info,rmcp=warn".into());

        let init_result = tracing_subscriber::registry()
            .with(filter)
            .with(
                // Console layer
                tracing_subscriber::fmt::layer().with_writer(std::io::stderr),
            )
            .with(
                // File layer with more details
                tracing_subscriber::fmt::layer()
                    .with_writer(file_appender)
                    .with_ansi(false)
                    .with_target(true)
                    .with_file(true)
                    .with_line_number(true),
            )
            .try_init();

        if init_result.is_ok() {
            info!("Log files will be written to: {}", log_dir.display());
        }
    }

    info!("Starting workflow execution via computeruse CLI");
    info!(input = %args.input, ?args.input_type);

    // Resolve actual input type (auto-detect if needed)
    let resolved_type = determine_input_type(&args.input, args.input_type);

    // Check if this is a TypeScript/JavaScript workflow
    let is_ts_workflow =
        typescript_workflow::is_typescript_workflow(&args.input, resolved_type == InputType::File);

    // For TypeScript workflows, skip content fetching and parsing - just pass the path to MCP
    if is_ts_workflow {
        info!("Detected TypeScript/JavaScript workflow - delegating to MCP server");

        // Run type check unless explicitly skipped
        if !args.skip_type_check {
            typescript_workflow::run_type_check(&args.input)?;
        } else {
            info!("⚠️  Skipping type check (--skip-type-check flag set)");
        }

        // Convert to absolute path and create file:// URL
        let file_url = typescript_workflow::path_to_file_url(&args.input)?;
        info!("TypeScript workflow URL: {}", file_url);

        // Build execute_sequence args
        let workflow_args = typescript_workflow::build_typescript_workflow_args(
            file_url,
            args.inputs.as_ref(),
            args.start_from_step.as_ref(),
            args.end_at_step.as_ref(),
            args.follow_fallback,
            args.execute_jumps_at_end,
            args.no_stop_on_error,
            args.no_detailed_results,
        )?;

        let workflow_str = serde_json::to_string(&workflow_args)?;
        info!("Sending TypeScript workflow args to MCP: {}", workflow_str);

        // Execute via MCP
        let result_json = mcp_client::execute_command_with_progress_and_retry(
            transport,
            "execute_sequence".to_string(),
            Some(workflow_str),
            true, // Show progress for workflow steps
            args.no_retry,
        )
        .await?;

        // Parse and display the workflow result
        let workflow_result = WorkflowResult::from_mcp_response(&result_json)?;
        workflow_result.display();

        // Always show parsed_output if it exists
        if let Some(parsed_output) = result_json.get("parsed_output") {
            println!("{}", "─".repeat(60));
            println!("📋 Complete Output Parser Result:");
            println!("{}", serde_json::to_string_pretty(parsed_output)?);
        }

        // If verbose mode, also show FULL raw MCP response
        if args.verbose {
            println!("{}", "─".repeat(60));
            println!("📝 Full Raw MCP Response:");
            println!("{}", serde_json::to_string_pretty(&result_json)?);
        }

        return Ok(());
    }

    // Fetch workflow content (for YAML workflows)
    let content = match resolved_type {
        InputType::File => {
            info!("Reading local file");
            read_local_file(&args.input).await?
        }
        InputType::Gist => {
            info!("Fetching GitHub gist");
            let raw_url = convert_gist_to_raw_url(&args.input)?;
            fetch_remote_content(&raw_url).await?
        }
        InputType::Raw => {
            info!("Fetching raw URL");
            fetch_remote_content(&args.input).await?
        }
        InputType::Auto => unreachable!(),
    };

    // Parse workflow using the same robust logic as gist_executor
    let mut workflow_val = parse_workflow_content(&content)
        .with_context(|| format!("Failed to parse workflow from {}", args.input))?;

    // Handle cron scheduling if specified in workflow
    if let Some(cron_expr) = extract_cron_from_workflow(&workflow_val) {
        info!(
            "🕐 Starting cron scheduler with workflow expression: {}",
            cron_expr
        );
        return run_workflow_with_cron(transport, args, &cron_expr).await;
    }

    // Validate workflow structure early to catch issues
    validate_workflow(&workflow_val).with_context(|| "Workflow validation failed")?;

    // Get steps count for logging
    let steps_count = workflow_val
        .get("steps")
        .and_then(|v| v.as_array())
        .map(|arr| arr.len())
        .unwrap_or(0);

    info!(
        "Successfully parsed and validated workflow with {} steps",
        steps_count
    );

    // Apply overrides
    if let Some(obj) = workflow_val.as_object_mut() {
        if args.no_stop_on_error {
            obj.insert("stop_on_error".into(), serde_json::Value::Bool(false));
        }
        if args.no_detailed_results {
            obj.insert(
                "include_detailed_results".into(),
                serde_json::Value::Bool(false),
            );
        }
    }

    if args.dry_run {
        println!("✅ Workflow validation successful!");
        println!("📊 Workflow Summary:");
        println!("   • Steps: {steps_count}");

        if let Some(variables) = workflow_val.get("variables").and_then(|v| v.as_object()) {
            println!("   • Variables: {}", variables.len());
        } else {
            println!("   • Variables: 0");
        }

        if let Some(selectors) = workflow_val.get("selectors").and_then(|v| v.as_object()) {
            println!("   • Selectors: {}", selectors.len());
        } else {
            println!("   • Selectors: 0");
        }

        let stop_on_error = workflow_val
            .get("stop_on_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        println!("   • Stop on error: {stop_on_error}");

        return Ok(());
    }

    info!("Executing workflow with {steps_count} steps via MCP");

    // Check if we're using a remote HTTP transport
    let is_remote_http = matches!(transport, mcp_client::Transport::Http { .. });

    // For local files with stdio transport, use file:// URL to avoid verbose logging
    // For remote HTTP transport, send the workflow content directly
    let workflow_str = if resolved_type == InputType::File && !is_remote_http {
        info!("Using file:// URL for local file with stdio transport");

        // Convert to absolute path and create file:// URL
        let abs_path = std::fs::canonicalize(&args.input)
            .with_context(|| format!("Failed to resolve path: {}", args.input))?;
        let file_url = format!("file://{}", abs_path.display());

        info!("File URL: {}", file_url);

        // Build minimal execute_sequence args with just the URL
        let mut workflow_args = serde_json::Map::new();
        workflow_args.insert("url".to_string(), serde_json::Value::String(file_url));

        // Apply overrides
        if args.no_stop_on_error {
            workflow_args.insert("stop_on_error".to_string(), serde_json::Value::Bool(false));
        }
        if args.no_detailed_results {
            workflow_args.insert(
                "include_detailed_results".to_string(),
                serde_json::Value::Bool(false),
            );
        } else {
            // Default to true for detailed results
            workflow_args.insert(
                "include_detailed_results".to_string(),
                serde_json::Value::Bool(true),
            );
        }

        // Add step control parameters if provided
        if let Some(start_step) = &args.start_from_step {
            workflow_args.insert(
                "start_from_step".to_string(),
                serde_json::Value::String(start_step.clone()),
            );
        }
        if let Some(end_step) = &args.end_at_step {
            workflow_args.insert(
                "end_at_step".to_string(),
                serde_json::Value::String(end_step.clone()),
            );
        }
        if let Some(follow) = args.follow_fallback {
            workflow_args.insert(
                "follow_fallback".to_string(),
                serde_json::Value::Bool(follow),
            );
        }
        if let Some(execute_jumps) = args.execute_jumps_at_end {
            workflow_args.insert(
                "execute_jumps_at_end".to_string(),
                serde_json::Value::Bool(execute_jumps),
            );
        }

        // Add CLI inputs if provided
        if let Some(inputs_str) = &args.inputs {
            match serde_json::from_str::<serde_json::Value>(inputs_str) {
                Ok(inputs_val) => {
                    workflow_args.insert("inputs".to_string(), inputs_val);
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("Invalid JSON in --inputs parameter: {}", e));
                }
            }
        }

        let workflow_str = serde_json::to_string(&workflow_args)?;
        info!("Sending workflow_args to MCP: {}", workflow_str);
        workflow_str
    } else {
        // For remote sources, merge inputs into the workflow content
        if let Some(inputs_str) = &args.inputs {
            match serde_json::from_str::<serde_json::Value>(inputs_str) {
                Ok(inputs_val) => {
                    if let Some(obj) = workflow_val.as_object_mut() {
                        obj.insert("inputs".to_string(), inputs_val);
                    }
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("Invalid JSON in --inputs parameter: {}", e));
                }
            }
        }

        // For remote sources, send the entire parsed content
        serde_json::to_string(&workflow_val)?
    };

    let result_json = mcp_client::execute_command_with_progress_and_retry(
        transport,
        "execute_sequence".to_string(),
        Some(workflow_str),
        true, // Show progress for workflow steps
        args.no_retry,
    )
    .await?;

    // Parse and display the workflow result
    let workflow_result = WorkflowResult::from_mcp_response(&result_json)?;

    // Display result in user-friendly format
    workflow_result.display();

    // Always show parsed_output if it exists
    if let Some(parsed_output) = result_json.get("parsed_output") {
        println!("{}", "─".repeat(60));
        println!("📋 Complete Output Parser Result:");
        println!("{}", serde_json::to_string_pretty(parsed_output)?);
    }

    // If verbose mode, also show FULL raw MCP response
    if args.verbose {
        println!("{}", "─".repeat(60));
        println!("📝 Full Raw MCP Response:");
        println!("{}", serde_json::to_string_pretty(&result_json)?);
    }

    // Exit with appropriate code based on success
    if !workflow_result.success {
        std::process::exit(1);
    }

    Ok(())
}

/// Extract cron expression from workflow YAML
fn extract_cron_from_workflow(workflow: &Value) -> Option<String> {
    // Primary format: cron field at root level (simpler format)
    if let Some(cron) = workflow.get("cron") {
        if let Some(cron_str) = cron.as_str() {
            return Some(cron_str.to_string());
        }
    }

    // Alternative: GitHub Actions style: on.schedule.cron
    if let Some(on) = workflow.get("on") {
        if let Some(schedule) = on.get("schedule") {
            // Handle both single cron and array of crons
            if let Some(cron_array) = schedule.as_array() {
                // If it's an array, take the first cron expression
                if let Some(first_schedule) = cron_array.first() {
                    if let Some(cron) = first_schedule.get("cron") {
                        if let Some(cron_str) = cron.as_str() {
                            return Some(cron_str.to_string());
                        }
                    }
                }
            } else if let Some(cron) = schedule.get("cron") {
                // Handle single cron expression
                if let Some(cron_str) = cron.as_str() {
                    return Some(cron_str.to_string());
                }
            }
        }
    }

    None
}

/// Execute workflow with cron scheduling
async fn run_workflow_with_cron(
    transport: mcp_client::Transport,
    args: McpRunArgs,
    cron_expr: &str,
) -> anyhow::Result<()> {
    use tokio_cron_scheduler::{Job, JobScheduler};
    use tracing::error;

    println!("🕐 Setting up cron scheduler...");
    println!("📅 Cron expression: {cron_expr}");
    println!("🔄 Workflow will run continuously at scheduled intervals");
    println!("💡 Press Ctrl+C to stop the scheduler");

    // Try to parse the cron expression to validate it (tokio-cron-scheduler will handle this)
    // We'll let tokio-cron-scheduler validate it when we create the job

    // For preview, we'll just show a generic message since calculating next times
    // with tokio-cron-scheduler is more complex
    println!("📋 Workflow will run according to cron schedule: {cron_expr}");
    println!("💡 Note: Exact execution times depend on system clock and scheduler timing");

    // Create scheduler
    let mut sched = JobScheduler::new().await?;

    // Clone transport for the job closure
    let transport_clone = transport.clone();
    let args_clone = args.clone();

    // Create the scheduled job
    let job = Job::new_async(cron_expr, move |_uuid, _lock| {
        let transport = transport_clone.clone();
        let args = args_clone.clone();

        Box::pin(async move {
            let start_time = std::time::Instant::now();
            println!(
                "\n🚀 Starting scheduled workflow execution at {}",
                chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
            );

            match run_workflow_once(transport, args).await {
                Ok(_) => {
                    let duration = start_time.elapsed();
                    println!(
                        "✅ Scheduled workflow completed successfully in {:.2}s",
                        duration.as_secs_f64()
                    );
                }
                Err(e) => {
                    let duration = start_time.elapsed();
                    println!(
                        "❌ Scheduled workflow failed after {:.2}s: {}",
                        duration.as_secs_f64(),
                        e
                    );
                }
            }
        })
    })?;

    // Add job to scheduler
    sched.add(job).await?;
    println!("✅ Cron job scheduled successfully");

    // Start the scheduler
    sched.start().await?;
    println!("▶️  Scheduler started - workflow will run at scheduled intervals");

    // Set up graceful shutdown
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel(1);

    // Spawn a task to handle Ctrl+C
    tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                println!("\n🛑 Received shutdown signal");
                let _ = shutdown_tx.send(()).await;
            }
            Err(e) => {
                error!("Failed to listen for shutdown signal: {}", e);
            }
        }
    });

    // Wait for shutdown signal
    let _ = shutdown_rx.recv().await;

    println!("🛑 Shutting down scheduler...");
    sched.shutdown().await?;
    println!("✅ Scheduler stopped successfully");

    Ok(())
}

/// Execute a single workflow run (used by cron scheduler)
async fn run_workflow_once(
    transport: mcp_client::Transport,
    args: McpRunArgs,
) -> anyhow::Result<()> {
    use tracing::info;
    // Resolve actual input type (auto-detect if needed)
    let resolved_type = determine_input_type(&args.input, args.input_type);

    // Check if this is a TypeScript/JavaScript workflow
    let is_ts_workflow =
        typescript_workflow::is_typescript_workflow(&args.input, resolved_type == InputType::File);

    // For TypeScript workflows, delegate to MCP server
    if is_ts_workflow {
        info!("Detected TypeScript/JavaScript workflow - delegating to MCP server");

        // Run type check unless explicitly skipped
        if !args.skip_type_check {
            typescript_workflow::run_type_check(&args.input)?;
        } else {
            info!("⚠️  Skipping type check (--skip-type-check flag set)");
        }

        // Convert to absolute path and create file:// URL
        let file_url = typescript_workflow::path_to_file_url(&args.input)?;
        info!("TypeScript workflow URL: {}", file_url);

        // Build workflow args for TypeScript
        let workflow_args = typescript_workflow::build_typescript_workflow_args(
            file_url,
            args.inputs.as_ref(),
            args.start_from_step.as_ref(),
            args.end_at_step.as_ref(),
            args.follow_fallback,
            args.execute_jumps_at_end,
            args.no_stop_on_error,
            args.no_detailed_results,
        )?;

        let workflow_str = serde_json::to_string(&workflow_args)?;
        info!("Sending TypeScript workflow args to MCP: {}", workflow_str);

        // Execute via MCP
        let result_json = mcp_client::execute_command_with_progress_and_retry(
            transport,
            "execute_sequence".to_string(),
            Some(workflow_str),
            true, // Show progress for workflow steps
            args.no_retry,
        )
        .await?;

        // Parse and display the workflow result
        let workflow_result = WorkflowResult::from_mcp_response(&result_json)?;
        workflow_result.display();

        // Always show parsed_output if it exists
        if let Some(parsed_output) = result_json.get("parsed_output") {
            println!("{}", "─".repeat(60));
            println!("📋 Complete Output Parser Result:");
            println!("{}", serde_json::to_string_pretty(parsed_output)?);
        }

        // If verbose mode, also show FULL raw MCP response
        if args.verbose {
            println!("{}", "─".repeat(60));
            println!("📝 Full Raw MCP Response:");
            println!("{}", serde_json::to_string_pretty(&result_json)?);
        }

        return Ok(());
    }

    // Fetch workflow content (for YAML workflows)
    let content = match resolved_type {
        InputType::File => read_local_file(&args.input).await?,
        InputType::Gist => {
            let raw_url = convert_gist_to_raw_url(&args.input)?;
            fetch_remote_content(&raw_url).await?
        }
        InputType::Raw => fetch_remote_content(&args.input).await?,
        InputType::Auto => unreachable!(),
    };

    // Parse workflow using the same robust logic as gist_executor
    let mut workflow_val = parse_workflow_content(&content)
        .with_context(|| format!("Failed to parse workflow from {}", args.input))?;

    // Validate workflow structure early to catch issues
    validate_workflow(&workflow_val).with_context(|| "Workflow validation failed")?;

    // Apply overrides
    if let Some(obj) = workflow_val.as_object_mut() {
        if args.no_stop_on_error {
            obj.insert("stop_on_error".into(), serde_json::Value::Bool(false));
        }
        if args.no_detailed_results {
            obj.insert(
                "include_detailed_results".into(),
                serde_json::Value::Bool(false),
            );
        }
    }

    // Check if we're using a remote HTTP transport
    let is_remote_http = matches!(transport, mcp_client::Transport::Http { .. });

    // For cron jobs, use simple execution to avoid connection spam
    // For local files with stdio transport, use file:// URL to avoid verbose logging
    // For remote HTTP transport, send the workflow content directly
    let workflow_str = if resolved_type == InputType::File && !is_remote_http {
        // Convert to absolute path and create file:// URL
        let abs_path = std::fs::canonicalize(&args.input)
            .with_context(|| format!("Failed to resolve path: {}", args.input))?;
        let file_url = format!("file://{}", abs_path.display());

        // Build minimal execute_sequence args with just the URL
        let mut workflow_args = serde_json::Map::new();
        workflow_args.insert("url".to_string(), serde_json::Value::String(file_url));

        // Apply overrides
        if args.no_stop_on_error {
            workflow_args.insert("stop_on_error".to_string(), serde_json::Value::Bool(false));
        }
        if args.no_detailed_results {
            workflow_args.insert(
                "include_detailed_results".to_string(),
                serde_json::Value::Bool(false),
            );
        } else {
            workflow_args.insert(
                "include_detailed_results".to_string(),
                serde_json::Value::Bool(true),
            );
        }

        // Add step control parameters if provided
        if let Some(start_step) = &args.start_from_step {
            workflow_args.insert(
                "start_from_step".to_string(),
                serde_json::Value::String(start_step.clone()),
            );
        }
        if let Some(end_step) = &args.end_at_step {
            workflow_args.insert(
                "end_at_step".to_string(),
                serde_json::Value::String(end_step.clone()),
            );
        }
        if let Some(follow) = args.follow_fallback {
            workflow_args.insert(
                "follow_fallback".to_string(),
                serde_json::Value::Bool(follow),
            );
        }
        if let Some(execute_jumps) = args.execute_jumps_at_end {
            workflow_args.insert(
                "execute_jumps_at_end".to_string(),
                serde_json::Value::Bool(execute_jumps),
            );
        }

        // Add CLI inputs if provided
        if let Some(inputs_str) = &args.inputs {
            match serde_json::from_str::<serde_json::Value>(inputs_str) {
                Ok(inputs_val) => {
                    workflow_args.insert("inputs".to_string(), inputs_val);
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("Invalid JSON in --inputs parameter: {}", e));
                }
            }
        }

        let workflow_str = serde_json::to_string(&workflow_args)?;
        info!("Sending workflow_args to MCP: {}", workflow_str);
        workflow_str
    } else {
        // For remote sources, merge inputs into the workflow content
        if let Some(inputs_str) = &args.inputs {
            match serde_json::from_str::<serde_json::Value>(inputs_str) {
                Ok(inputs_val) => {
                    if let Some(obj) = workflow_val.as_object_mut() {
                        obj.insert("inputs".to_string(), inputs_val);
                    }
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("Invalid JSON in --inputs parameter: {}", e));
                }
            }
        }

        // For remote sources, send the entire parsed content
        serde_json::to_string(&workflow_val)?
    };
    let result_json = mcp_client::execute_command_with_progress_and_retry(
        transport,
        "execute_sequence".to_string(),
        Some(workflow_str),
        true, // Show progress for workflow steps
        args.no_retry,
    )
    .await?;

    // Parse the workflow result
    let workflow_result = WorkflowResult::from_mcp_response(&result_json)?;

    // For cron jobs, log success/failure/exception/skipped
    use workflow_result::WorkflowState;
    match workflow_result.state {
        WorkflowState::Success => {
            println!("   ✅ {}", workflow_result.message);
            if let Some(Value::Array(arr)) = &workflow_result.data {
                println!("   📊 Extracted {} items", arr.len());
            }
        }
        WorkflowState::Skipped => {
            println!("   ⏭️  {}", workflow_result.message);
            if let Some(Value::Object(data)) = &workflow_result.data {
                if let Some(reason) = data.get("reason").and_then(|r| r.as_str()) {
                    println!("   📝 Reason: {reason}");
                }
            }
        }
        WorkflowState::Exception => {
            println!("   🚨 {}", workflow_result.message);
            if let Some(error) = &workflow_result.error {
                println!("   ⚠️  {error}");
            }
        }
        WorkflowState::Failure => {
            println!("   ❌ {}", workflow_result.message);
            if let Some(error) = &workflow_result.error {
                println!("   ⚠️  {error}");
            }
        }
    }

    Ok(())
}

fn determine_input_type(input: &str, specified_type: InputType) -> InputType {
    match specified_type {
        InputType::Auto => {
            if input.starts_with("https://gist.github.com/") {
                InputType::Gist
            } else if input.starts_with("https://gist.githubusercontent.com/")
                || input.starts_with("http://")
                || input.starts_with("https://")
            {
                InputType::Raw
            } else {
                InputType::File
            }
        }
        other => other,
    }
}

fn convert_gist_to_raw_url(gist_url: &str) -> anyhow::Result<String> {
    if !gist_url.starts_with("https://gist.github.com/") {
        return Err(anyhow::anyhow!("Invalid GitHub gist URL format"));
    }

    let raw_url = gist_url.replace(
        "https://gist.github.com/",
        "https://gist.githubusercontent.com/",
    );

    Ok(if raw_url.ends_with("/raw") {
        raw_url
    } else {
        format!("{raw_url}/raw")
    })
}

async fn read_local_file(path: &str) -> anyhow::Result<String> {
    use std::path::Path;
    use tokio::fs;

    let p = Path::new(path);
    if !p.exists() {
        return Err(anyhow::anyhow!("File not found: {}", p.display()));
    }
    if !p.is_file() {
        return Err(anyhow::anyhow!("Not a file: {}", p.display()));
    }

    fs::read_to_string(p).await.map_err(|e| e.into())
}

async fn fetch_remote_content(url: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let res = client
        .get(url)
        .header("User-Agent", "computeruse-cli-workflow/1.0")
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow::anyhow!(
            "HTTP request failed: {} for {}",
            res.status(),
            url
        ));
    }
    Ok(res.text().await?)
}

/// Parse workflow content (JSON only - YAML support removed)
fn parse_workflow_content(content: &str) -> anyhow::Result<serde_json::Value> {
    // Try direct JSON workflow
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        // Check if it's a valid workflow (has steps field)
        if val.get("steps").is_some() {
            return Ok(val);
        }

        // Check if it's a wrapper object
        if let Some(extracted) = extract_workflow_from_wrapper(&val)? {
            return Ok(extracted);
        }
    }

    Err(anyhow::anyhow!(
        "Unable to parse content as JSON workflow. Content must either be:\n\
        1. A workflow with 'steps' field\n\
        2. A wrapper object with tool_name='execute_sequence' and 'arguments' field\n\
        3. Valid JSON format\n\
        Note: YAML workflows are no longer supported. Use TypeScript workflows instead."
    ))
}

/// Extract workflow from wrapper object if it has tool_name: execute_sequence
fn extract_workflow_from_wrapper(
    value: &serde_json::Value,
) -> anyhow::Result<Option<serde_json::Value>> {
    if let Some(tool_name) = value.get("tool_name") {
        if tool_name == "execute_sequence" {
            if let Some(arguments) = value.get("arguments") {
                return Ok(Some(arguments.clone()));
            } else {
                return Err(anyhow::anyhow!("Tool call missing 'arguments' field"));
            }
        }
    }
    Ok(None)
}

/// Validate workflow structure to provide early error detection
fn validate_workflow(workflow: &serde_json::Value) -> anyhow::Result<()> {
    // Check that it's an object
    let obj = workflow
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Workflow must be a JSON object"))?;

    // Check that steps exists and is an array
    let steps = obj
        .get("steps")
        .ok_or_else(|| anyhow::anyhow!("Workflow must contain a 'steps' field"))?;

    let steps_array = steps
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("'steps' field must be an array"))?;

    if steps_array.is_empty() {
        return Err(anyhow::anyhow!("Workflow must contain at least one step"));
    }

    // Validate each step
    for (i, step) in steps_array.iter().enumerate() {
        let step_obj = step
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Step {} must be an object", i))?;

        let has_tool_name = step_obj.contains_key("tool_name");
        let has_group_name = step_obj.contains_key("group_name");

        if !has_tool_name && !has_group_name {
            return Err(anyhow::anyhow!(
                "Step {} must have either 'tool_name' or 'group_name'",
                i
            ));
        }

        if has_tool_name && has_group_name {
            return Err(anyhow::anyhow!(
                "Step {} cannot have both 'tool_name' and 'group_name'",
                i
            ));
        }
    }

    // Validate variables if present
    if let Some(variables) = obj.get("variables") {
        if let Some(vars_obj) = variables.as_object() {
            for (name, def) in vars_obj {
                if name.is_empty() {
                    return Err(anyhow::anyhow!("Variable name cannot be empty"));
                }

                if let Some(def_obj) = def.as_object() {
                    // Ensure label exists and is non-empty
                    if let Some(label) = def_obj.get("label") {
                        if let Some(label_str) = label.as_str() {
                            if label_str.is_empty() {
                                return Err(anyhow::anyhow!(
                                    "Variable '{}' must have a non-empty label",
                                    name
                                ));
                            }
                        }
                    } else {
                        return Err(anyhow::anyhow!(
                            "Variable '{}' must have a 'label' field",
                            name
                        ));
                    }

                    // --------------------- NEW VALIDATION ---------------------
                    // Enforce `required` property logic
                    let is_required = def_obj
                        .get("required")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);

                    if is_required {
                        // Check for default value in definition
                        let has_default = def_obj.contains_key("default");

                        // Check if inputs provide a value for this variable
                        let input_has_value = obj
                            .get("inputs")
                            .and_then(|v| v.as_object())
                            .map(|inputs_obj| inputs_obj.contains_key(name))
                            .unwrap_or(false);

                        if !has_default && !input_has_value {
                            return Err(anyhow::anyhow!(
                                "Required variable '{}' is missing and has no default value",
                                name
                            ));
                        }
                    }
                    // ----------------------------------------------------------------
                }
            }
        }
    }

    Ok(())
}
