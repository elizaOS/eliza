/// TypeScript/JavaScript workflow detection and execution
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;

/// Check if the input is a TypeScript/JavaScript workflow
pub fn is_typescript_workflow(input: &str, is_file_input: bool) -> bool {
    use tracing::debug;

    debug!(
        "Checking TypeScript workflow: input={}, is_file_input={}",
        input, is_file_input
    );

    if !is_file_input {
        debug!("Not a file input, returning false");
        return false;
    }

    let path = Path::new(input);
    debug!(
        "Path exists: {}, is_dir: {}, is_file: {}",
        path.exists(),
        path.is_dir(),
        path.is_file()
    );

    if path.is_file() {
        // Check if it's a .ts/.js file
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext == "ts" || ext == "js")
            .unwrap_or(false)
    } else if path.is_dir() {
        // Check for package.json AND (computeruse.ts OR src/computeruse.ts OR workflow.ts OR index.ts)
        let package_json = path.join("package.json");
        let computeruse_ts = path.join("computeruse.ts");
        let src_computeruse_ts = path.join("src").join("computeruse.ts");
        let workflow_ts = path.join("workflow.ts");
        let index_ts = path.join("index.ts");

        debug!("Checking directory for TypeScript workflow files:");
        debug!("  package.json exists: {}", package_json.exists());
        debug!("  computeruse.ts exists: {}", computeruse_ts.exists());
        debug!("  src/computeruse.ts exists: {}", src_computeruse_ts.exists());
        debug!("  workflow.ts exists: {}", workflow_ts.exists());
        debug!("  index.ts exists: {}", index_ts.exists());

        let result = package_json.exists()
            && (computeruse_ts.exists()
                || src_computeruse_ts.exists()
                || workflow_ts.exists()
                || index_ts.exists());

        debug!("Is TypeScript workflow: {}", result);
        result
    } else {
        false
    }
}

/// Convert file path to file:// URL
pub fn path_to_file_url(input: &str) -> Result<String> {
    let abs_path =
        std::fs::canonicalize(input).with_context(|| format!("Failed to resolve path: {input}"))?;

    // If it's a directory with TypeScript workflow files, point to the specific file
    let target_path = if abs_path.is_dir() {
        // Check for computeruse.ts first (root), then src/computeruse.ts, then workflow.ts, then index.ts
        if abs_path.join("computeruse.ts").exists() {
            abs_path.join("computeruse.ts")
        } else if abs_path.join("src").join("computeruse.ts").exists() {
            abs_path.join("src").join("computeruse.ts")
        } else if abs_path.join("workflow.ts").exists() {
            abs_path.join("workflow.ts")
        } else if abs_path.join("index.ts").exists() {
            abs_path.join("index.ts")
        } else {
            abs_path
        }
    } else {
        abs_path
    };

    // Strip Windows \\?\ prefix if present
    let path_str = target_path.display().to_string();
    let normalized_path = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);

    Ok(format!("file://{normalized_path}"))
}

/// Build execute_sequence arguments for TypeScript workflow
#[allow(clippy::too_many_arguments)]
pub fn build_typescript_workflow_args(
    file_url: String,
    inputs: Option<&String>,
    start_from_step: Option<&String>,
    end_at_step: Option<&String>,
    follow_fallback: Option<bool>,
    execute_jumps_at_end: Option<bool>,
    no_stop_on_error: bool,
    no_detailed_results: bool,
) -> Result<Value> {
    let mut workflow_args = serde_json::Map::new();

    // Add URL
    workflow_args.insert("url".to_string(), Value::String(file_url));

    // Add execution options
    if no_stop_on_error {
        workflow_args.insert("stop_on_error".to_string(), Value::Bool(false));
    }

    workflow_args.insert(
        "include_detailed_results".to_string(),
        Value::Bool(!no_detailed_results),
    );

    // Add step control parameters
    if let Some(start_step) = start_from_step {
        workflow_args.insert(
            "start_from_step".to_string(),
            Value::String(start_step.clone()),
        );
    }

    if let Some(end_step) = end_at_step {
        workflow_args.insert("end_at_step".to_string(), Value::String(end_step.clone()));
    }

    if let Some(follow) = follow_fallback {
        workflow_args.insert("follow_fallback".to_string(), Value::Bool(follow));
    }

    if let Some(execute_jumps) = execute_jumps_at_end {
        workflow_args.insert(
            "execute_jumps_at_end".to_string(),
            Value::Bool(execute_jumps),
        );
    }

    // Add CLI inputs if provided
    if let Some(inputs_str) = inputs {
        let inputs_val = serde_json::from_str::<Value>(inputs_str)
            .with_context(|| "Invalid JSON in --inputs parameter")?;
        workflow_args.insert("inputs".to_string(), inputs_val);
    }

    Ok(Value::Object(workflow_args))
}

/// Run TypeScript type checking with tsc --noEmit
/// Returns Ok(()) if type check passes, Err with formatted error message if it fails
pub fn run_type_check(input: &str) -> Result<()> {
    use std::process::Command;
    use tracing::{error, info};

    let path = Path::new(input);

    // Get the directory to run tsc in
    let working_dir = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };

    // Check if this is a TypeScript project (has tsconfig.json or typescript dependency)
    let has_tsconfig = working_dir.join("tsconfig.json").exists();
    let package_json = working_dir.join("package.json");

    // Read package.json to check for typescript dependency
    let has_typescript_dep = if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            if let Ok(json) = serde_json::from_str::<Value>(&content) {
                let has_in_deps = json
                    .get("dependencies")
                    .and_then(|deps| deps.get("typescript"))
                    .is_some();
                let has_in_dev_deps = json
                    .get("devDependencies")
                    .and_then(|deps| deps.get("typescript"))
                    .is_some();
                has_in_deps || has_in_dev_deps
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    // Only run type check if it's a TypeScript project
    if !has_tsconfig && !has_typescript_dep {
        info!("Skipping type check - not a TypeScript project (no tsconfig.json or typescript dependency)");
        return Ok(());
    }

    info!("🔍 Running type check with tsc --noEmit...");

    // Try bun first (faster), then npx, then global tsc
    let output = Command::new("bun")
        .args(["tsc", "--noEmit"])
        .current_dir(working_dir)
        .output()
        .or_else(|_| {
            // Fallback to npx if bun fails
            Command::new("npx")
                .args(["tsc", "--noEmit"])
                .current_dir(working_dir)
                .output()
        })
        .or_else(|_| {
            // Fallback to global tsc if npx fails
            Command::new("tsc")
                .args(["--noEmit"])
                .current_dir(working_dir)
                .output()
        })
        .with_context(|| {
            "Failed to run TypeScript compiler (tsc). Make sure TypeScript is installed."
        })?;

    if output.status.success() {
        info!("✅ Type check passed");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        // Combine stderr and stdout for error output
        let error_output = if !stderr.is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        };

        // Format the error message
        error!("❌ Type errors found:\n{}", error_output);

        eprintln!("\n{}", "=".repeat(80));
        eprintln!("❌ TypeScript Type Check Failed");
        eprintln!("{}", "=".repeat(80));
        eprintln!("\n{error_output}");
        eprintln!("{}", "=".repeat(80));
        eprintln!("\n💡 Fix type errors before running the workflow");
        eprintln!("   Or use --skip-type-check to bypass (not recommended)\n");

        anyhow::bail!("Type check failed - fix errors above")
    }
}
