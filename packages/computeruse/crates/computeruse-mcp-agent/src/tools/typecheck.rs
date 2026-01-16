//! TypeScript workflow type-checking module.
//!
//! Provides functionality to type-check TypeScript workflows using .

use rmcp::{schemars, schemars::JsonSchema};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;
use tracing::{info, warn};

/// Arguments for the typecheck_workflow tool.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TypecheckWorkflowArgs {
    /// Path to the workflow directory containing tsconfig.json
    pub workflow_path: String,
}

/// A single type error from tsc output.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TypeError {
    /// File path where the error occurred
    pub file: String,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (1-indexed)
    pub column: u32,
    /// Error code (e.g., "TS2345")
    pub code: String,
    /// Error message
    pub message: String,
    /// Code context: ~5 lines around the error with line numbers
    pub context: Option<String>,
}

/// Result of type-checking a workflow.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TypecheckResult {
    /// Whether type-checking passed (no errors)
    pub success: bool,
    /// List of type errors found
    pub errors: Vec<TypeError>,
    /// Total error count
    pub error_count: usize,
    /// Raw stderr output from tsc (for debugging)
    pub raw_output: Option<String>,
}
/// Parse tsc output into structured errors.
///
/// TSC output format:
pub fn parse_tsc_output(output: &str) -> Vec<TypeError> {
    let mut errors = Vec::new();
    let re = regex::Regex::new(r"^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$")
        .expect("Invalid regex");

    for line in output.lines() {
        let line = line.trim();
        if let Some(caps) = re.captures(line) {
            errors.push(TypeError {
                file: caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default(),
                line: caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0),
                column: caps
                    .get(3)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0),
                code: caps
                    .get(4)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default(),
                message: caps
                    .get(5)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default(),
                context: None,
            });
        }
    }
    errors
}

/// Extract code context around an error (3 lines before, 3 after).
/// Returns formatted string with line numbers and arrow pointing to error line.
fn get_error_context(workflow_path: &Path, error: &TypeError) -> Option<String> {
    let file_path = workflow_path.join(&error.file);
    let content = fs::read_to_string(&file_path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    if error.line == 0 || error.line as usize > lines.len() {
        return None;
    }

    let error_idx = error.line as usize - 1;
    let start = error_idx.saturating_sub(3);
    let end = (error_idx + 4).min(lines.len());

    let mut context_lines = Vec::new();
    for (i, line) in lines.iter().enumerate().take(end).skip(start) {
        let line_num = i + 1;
        let marker = if line_num == error.line as usize {
            " -> "
        } else {
            "    "
        };
        context_lines.push(format!("{}{:>4}: {}", marker, line_num, line));
    }

    Some(context_lines.join("\n"))
}

/// Enrich parsed errors with code context from source files.
fn enrich_errors_with_context(workflow_path: &Path, errors: &mut [TypeError]) {
    for error in errors.iter_mut() {
        error.context = get_error_context(workflow_path, error);
    }
}

/// Check if a command exists in PATH.
async fn command_exists(cmd: &str) -> bool {
    #[cfg(windows)]
    let check_cmd = "where";
    #[cfg(not(windows))]
    let check_cmd = "which";

    Command::new(check_cmd)
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run type-checking on a TypeScript workflow.
pub async fn typecheck_workflow(workflow_path: &str) -> Result<TypecheckResult, String> {
    let path = Path::new(workflow_path);

    if !path.exists() {
        return Err(format!("Workflow path does not exist: {}", workflow_path));
    }

    let tsconfig = path.join("tsconfig.json");
    if !tsconfig.exists() {
        return Err(format!("No tsconfig.json found in: {}", workflow_path));
    }

    info!("[typecheck] Running tsc --noEmit in {}", workflow_path);

    let (program, args) = if command_exists("bun").await {
        ("bun", vec!["tsc", "--noEmit"])
    } else if command_exists("npx").await {
        ("npx", vec!["tsc", "--noEmit"])
    } else {
        return Err("Neither bun nor npx found. Install bun or Node.js.".to_string());
    };

    let output = Command::new(program)
        .args(&args)
        .current_dir(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run tsc: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined_output = format!("{}\n{}", stdout, stderr);
    let mut errors = parse_tsc_output(&combined_output);
    let error_count = errors.len();
    let success = output.status.success() && error_count == 0;

    // Enrich errors with code context
    if !success {
        enrich_errors_with_context(path, &mut errors);
    }

    if success {
        info!("[typecheck] Type-check passed for {}", workflow_path);
    } else {
        warn!(
            "[typecheck] Found {} type errors in {}",
            error_count, workflow_path
        );
    }

    Ok(TypecheckResult {
        success,
        errors,
        error_count,
        raw_output: if success {
            None
        } else {
            Some(combined_output.to_string())
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tsc_output_single_error() {
        let output = "src/computeruse.ts(10,5): error TS2345: Argument of type string.";
        let errors = parse_tsc_output(output);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file, "src/computeruse.ts");
        assert_eq!(errors[0].line, 10);
        assert_eq!(errors[0].column, 5);
        assert_eq!(errors[0].code, "TS2345");
    }

    #[test]
    fn test_parse_tsc_output_multiple_errors() {
        let output = "src/a.ts(10,5): error TS2345: Err1.\nsrc/b.ts(25,10): error TS2304: Err2.";
        let errors = parse_tsc_output(output);
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].code, "TS2345");
        assert_eq!(errors[1].code, "TS2304");
    }

    #[test]
    fn test_parse_tsc_output_no_errors() {
        let errors = parse_tsc_output("");
        assert!(errors.is_empty());
    }

    #[test]
    fn test_parse_tsc_output_with_noise() {
        let output = "Random noise\nsrc/a.ts(10,5): error TS2345: Real error.\nMore noise";
        let errors = parse_tsc_output(output);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "TS2345");
    }

    #[test]
    fn test_get_error_context() {
        use std::io::Write;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let src_dir = temp_dir.path().join("src");
        fs::create_dir_all(&src_dir).unwrap();

        let test_file = src_dir.join("test.ts");
        let mut file = fs::File::create(&test_file).unwrap();
        writeln!(file, "import {{ foo }} from 'bar';").unwrap();
        writeln!(file).unwrap();
        writeln!(file, "export function test() {{").unwrap();
        writeln!(file, "  const x: string = 123;").unwrap();
        writeln!(file, "  return x;").unwrap();
        writeln!(file, "}}").unwrap();

        let error = TypeError {
            file: "src/test.ts".to_string(),
            line: 4,
            column: 3,
            code: "TS2322".to_string(),
            message: "Type number is not assignable to type string.".to_string(),
            context: None,
        };

        let context = get_error_context(temp_dir.path(), &error).unwrap();
        assert!(context.contains(" -> "), "should have arrow marker");
        assert!(
            context.contains("const x: string = 123"),
            "should include error line"
        );
    }
}
