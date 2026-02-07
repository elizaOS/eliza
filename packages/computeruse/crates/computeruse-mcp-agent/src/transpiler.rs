//! TypeScript/JavaScript transpilation module.
//!
//! Provides transpilation of TypeScript to JavaScript for browser and Node.js execution.
//! Supports bun (preferred) and esbuild via npx (fallback).
//!
//! ## Context Engineering for AI
//! Error messages are structured following Anthropic's context engineering principles:
//! - Minimal, high-signal information (no verbose stack traces)
//! - Structured with clear sections (error_type, location, fix)
//! - Actionable recovery paths (specific fix suggestions)
//! - Fallback guidance when tools unavailable

use rmcp::ErrorData as McpError;
use serde_json::json;
use tracing::{debug, info, warn};

/// Result of transpiling TypeScript/JavaScript
#[derive(Debug, Clone)]
pub struct TranspileResult {
    /// The transpiled JavaScript code ready for execution
    pub code: String,
    /// Whether the original code was TypeScript (vs plain JavaScript)
    pub was_typescript: bool,
}

/// Error category for structured AI context
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranspileErrorKind {
    /// Syntax error in the code (fixable by AI)
    SyntaxError,
    /// Type error in TypeScript (fixable by AI)
    TypeError,
    /// Missing transpiler tools (requires user action or JS fallback)
    MissingTool,
    /// IO/system error (transient, may retry)
    SystemError,
}

impl TranspileErrorKind {
    /// Returns a short, AI-friendly label
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SyntaxError => "syntax_error",
            Self::TypeError => "type_error",
            Self::MissingTool => "missing_tool",
            Self::SystemError => "system_error",
        }
    }

    /// Returns whether AI can fix this error by rewriting code
    pub fn is_fixable_by_ai(&self) -> bool {
        matches!(self, Self::SyntaxError | Self::TypeError)
    }
}

/// Error returned when transpilation fails.
///
/// Designed for AI consumption following context engineering principles:
/// - Structured with error_kind for routing recovery strategy
/// - Minimal context (just enough to fix, no noise)
/// - Clear actionable fix when possible
#[derive(Debug, Clone)]
pub struct TranspileError {
    /// Error category for AI routing
    pub kind: TranspileErrorKind,
    /// Concise error message (1-2 sentences max)
    pub message: String,
    /// Line number where error occurred (1-indexed)
    pub line: Option<u32>,
    /// Column number where error occurred (1-indexed)
    pub column: Option<u32>,
    /// The problematic code snippet (just the error line, not full context)
    pub error_line: Option<String>,
    /// Specific fix suggestion (actionable, not generic)
    pub fix: Option<String>,
    /// Recovery action if fix not possible
    pub recovery: RecoveryAction,
}

/// Recovery action when error cannot be directly fixed
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    /// AI should fix the code based on error message
    FixCode,
    /// AI should rewrite in plain JavaScript (remove TS syntax)
    UseJavaScript,
    /// User needs to install tools
    InstallTool { tool: String, url: String },
    /// Retry may help (transient error)
    Retry,
}

impl TranspileError {
    /// Create a syntax/type error with location info
    pub fn code_error(
        kind: TranspileErrorKind,
        message: impl Into<String>,
        line: Option<u32>,
        column: Option<u32>,
        error_line: Option<String>,
        fix: Option<String>,
    ) -> Self {
        Self {
            kind,
            message: message.into(),
            line,
            column,
            error_line,
            fix,
            recovery: RecoveryAction::FixCode,
        }
    }

    /// Create a missing tool error
    pub fn missing_tool(tool: &str, _url: &str) -> Self {
        Self {
            kind: TranspileErrorKind::MissingTool,
            message: format!(
                "TypeScript requires {} for transpilation. Not installed.",
                tool
            ),
            line: None,
            column: None,
            error_line: None,
            fix: None,
            recovery: RecoveryAction::UseJavaScript,
        }
    }

    /// Create a system error
    pub fn system_error(message: impl Into<String>) -> Self {
        Self {
            kind: TranspileErrorKind::SystemError,
            message: message.into(),
            line: None,
            column: None,
            error_line: None,
            fix: None,
            recovery: RecoveryAction::Retry,
        }
    }

    /// Convert to McpError with AI-optimized context
    ///
    /// Output structure follows context engineering principles:
    /// ```json
    /// {
    ///   "error_type": "syntax_error",
    ///   "message": "Unexpected token",
    ///   "location": { "line": 5, "column": 10 },
    ///   "error_line": "const x string = 'hello';",
    ///   "fix": "Add ':' between variable name and type: 'const x: string'",
    ///   "recovery": "fix_code"
    /// }
    /// ```
    pub fn into_mcp_error(self) -> McpError {
        let mut error_data = json!({
            "error_type": self.kind.as_str(),
            "can_fix": self.kind.is_fixable_by_ai(),
        });

        // Location (only if available)
        if self.line.is_some() || self.column.is_some() {
            error_data["location"] = json!({
                "line": self.line,
                "column": self.column,
            });
        }

        // Error line (minimal context, just the problematic line)
        if let Some(line) = &self.error_line {
            error_data["error_line"] = json!(line);
        }

        // Actionable fix suggestion
        if let Some(fix) = &self.fix {
            error_data["fix"] = json!(fix);
        }

        // Recovery action
        error_data["recovery"] = match &self.recovery {
            RecoveryAction::FixCode => json!("fix_code"),
            RecoveryAction::UseJavaScript => json!({
                "action": "use_javascript",
                "instruction": "Rewrite without TypeScript syntax. Remove: type annotations (: string), interfaces, generics (<T>), 'as' casts, enum, namespace."
            }),
            RecoveryAction::InstallTool { tool, url } => json!({
                "action": "install_tool",
                "tool": tool,
                "url": url,
            }),
            RecoveryAction::Retry => json!("retry"),
        };

        McpError::invalid_params(self.message, Some(error_data))
    }

    /// Format error for human-readable logging
    pub fn to_log_string(&self) -> String {
        let mut parts = vec![format!("[{}] {}", self.kind.as_str(), self.message)];

        if let (Some(line), Some(col)) = (self.line, self.column) {
            parts.push(format!("  at line {}:{}", line, col));
        } else if let Some(line) = self.line {
            parts.push(format!("  at line {}", line));
        }

        if let Some(error_line) = &self.error_line {
            parts.push(format!("  > {}", error_line));
        }

        if let Some(fix) = &self.fix {
            parts.push(format!("  fix: {}", fix));
        }

        parts.join("\n")
    }
}

/// Target environment for transpilation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranspileTarget {
    /// Browser environment (Chrome DevTools execution)
    Browser,
    /// Node.js/Bun environment
    NodeJs,
}

/// Detects if the script contains TypeScript-specific syntax
pub fn is_typescript_code(script: &str) -> bool {
    // Common TypeScript patterns that are NOT valid JavaScript
    let ts_patterns = [
        // Type annotations
        r":\s*(string|number|boolean|any|void|never|unknown|object)\s*[;,=\)\}]",
        r":\s*(string|number|boolean|any|void|never|unknown|object)\s*\[",
        // Interface declarations
        r"\binterface\s+\w+",
        // Type declarations
        r"\btype\s+\w+\s*=",
        // Generic type parameters
        r"<\s*\w+\s*(extends|,)",
        r"\w+<\w+>",
        // as type assertion
        r"\bas\s+(string|number|boolean|any|object|unknown|\w+)\b",
        // Non-null assertion
        r"\w+!\.",
        // Function parameter types
        r"\(\s*\w+\s*:\s*\w+",
        // Return type annotations
        r"\)\s*:\s*\w+\s*(\{|=>)",
        // readonly modifier
        r"\breadonly\s+\w+",
        // public/private/protected modifiers
        r"\b(public|private|protected)\s+\w+",
        // enum declarations
        r"\benum\s+\w+",
        // namespace declarations
        r"\bnamespace\s+\w+",
        // declare keyword
        r"\bdeclare\s+(const|let|var|function|class)",
        // import type
        r"\bimport\s+type\b",
    ];

    for pattern in &ts_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if re.is_match(script) {
                return true;
            }
        }
    }

    false
}

/// Find executable with cross-platform path resolution
fn find_executable(name: &str) -> Option<String> {
    use std::env;
    use std::path::Path;

    // Special case: for bun, check bundled location first (mediar-app distribution)
    if name == "bun" {
        if let Some(bundled) = find_bundled_bun() {
            return Some(bundled);
        }
    }

    // On Windows, try multiple extensions, prioritizing executable types
    let candidates = if cfg!(windows) {
        vec![
            format!("{}.exe", name),
            format!("{}.cmd", name),
            format!("{}.bat", name),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };

    // Check each candidate in PATH
    if let Ok(path_var) = env::var("PATH") {
        let separator = if cfg!(windows) { ";" } else { ":" };

        for path_dir in path_var.split(separator) {
            let path_dir = Path::new(path_dir);

            for candidate in &candidates {
                let full_path = path_dir.join(candidate);
                if full_path.exists() && full_path.is_file() {
                    return Some(full_path.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

/// Find bundled bun executable next to the current binary
fn find_bundled_bun() -> Option<String> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;

    let bun_path = exe_dir.join("bun.exe");
    if bun_path.exists() && bun_path.is_file() {
        info!("Found bundled bun at: {}", bun_path.display());
        return Some(bun_path.to_string_lossy().to_string());
    }

    None
}

/// Check if a transpiler is available
pub fn is_transpiler_available() -> bool {
    find_executable("bun").is_some() || find_executable("npx").is_some()
}

/// Get which transpiler is available
pub fn get_available_transpiler() -> Option<&'static str> {
    if find_executable("bun").is_some() {
        Some("bun")
    } else if find_executable("npx").is_some() {
        Some("esbuild (via npx)")
    } else {
        None
    }
}

/// Transpile TypeScript to JavaScript.
///
/// This function:
/// 1. Detects if the code is TypeScript or plain JavaScript
/// 2. If TypeScript, transpiles using bun (preferred) or esbuild via npx (fallback)
/// 3. Returns detailed error messages for type errors to help AI fix issues
/// 4. For plain JavaScript, returns the code as-is
///
/// # Arguments
/// * `script` - The TypeScript or JavaScript code to transpile
/// * `target` - The target environment (Browser or NodeJs)
///
/// # Returns
/// * `Ok(TranspileResult)` - The transpiled code and metadata
/// * `Err(TranspileError)` - Detailed error with line/column info for type errors
pub async fn transpile(
    script: &str,
    target: TranspileTarget,
) -> Result<TranspileResult, TranspileError> {
    // Check if it's TypeScript
    let is_ts = is_typescript_code(script);

    if !is_ts {
        debug!("[transpiler] Code appears to be plain JavaScript, skipping transpilation");
        return Ok(TranspileResult {
            code: script.to_string(),
            was_typescript: false,
        });
    }

    info!("[transpiler] Detected TypeScript code, transpiling to JavaScript");

    // Create temp file for the script
    let temp_dir = std::env::temp_dir().join("computeruse_transpile");
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| {
        TranspileError::system_error(format!("Failed to create temp directory: {}", e))
    })?;

    let script_id = std::process::id();
    let ts_file = temp_dir.join(format!("script_{}.ts", script_id));
    let js_file = temp_dir.join(format!("script_{}.js", script_id));

    // Write the TypeScript file
    tokio::fs::write(&ts_file, script)
        .await
        .map_err(|e| TranspileError::system_error(format!("Failed to write temp file: {}", e)))?;

    // Try bun first (fastest, native TS support)
    let transpile_result = if let Some(bun_exe) = find_executable("bun") {
        info!("[transpiler] Using bun for transpilation");
        transpile_with_bun(&bun_exe, &ts_file, &js_file, script, target).await
    } else if find_executable("npx").is_some() {
        info!("[transpiler] Bun not found, trying esbuild via npx");
        transpile_with_esbuild(&ts_file, &js_file, script, target).await
    } else {
        warn!("[transpiler] Neither bun nor npx available for TypeScript transpilation");
        Err(TranspileError::missing_tool(
            "bun or Node.js",
            "https://bun.sh",
        ))
    };

    // Clean up temp files
    let _ = tokio::fs::remove_file(&ts_file).await;
    let _ = tokio::fs::remove_file(&js_file).await;

    transpile_result
}

/// Transpile TypeScript using bun build
async fn transpile_with_bun(
    bun_exe: &str,
    ts_file: &std::path::Path,
    js_file: &std::path::Path,
    original_script: &str,
    target: TranspileTarget,
) -> Result<TranspileResult, TranspileError> {
    use std::process::Stdio;
    use tokio::process::Command;

    let target_arg = match target {
        TranspileTarget::Browser => "browser",
        TranspileTarget::NodeJs => "node",
    };

    // Use bun build to transpile
    let output = Command::new(bun_exe)
        .args([
            "build",
            ts_file.to_string_lossy().as_ref(),
            "--outfile",
            js_file.to_string_lossy().as_ref(),
            "--target",
            target_arg,
            "--no-bundle",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| TranspileError::system_error(format!("Failed to execute bun: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined_output = format!("{}\n{}", stdout, stderr);

        return Err(parse_transpilation_error(
            &combined_output,
            original_script,
            "bun",
        ));
    }

    // Read the transpiled output
    let transpiled = tokio::fs::read_to_string(js_file).await.map_err(|e| {
        TranspileError::system_error(format!("Failed to read transpiled output: {}", e))
    })?;

    info!(
        "[transpiler] Successfully transpiled {} bytes of TypeScript to {} bytes of JavaScript",
        original_script.len(),
        transpiled.len()
    );

    Ok(TranspileResult {
        code: transpiled,
        was_typescript: true,
    })
}

/// Transpile TypeScript using esbuild via npx
async fn transpile_with_esbuild(
    ts_file: &std::path::Path,
    js_file: &std::path::Path,
    original_script: &str,
    target: TranspileTarget,
) -> Result<TranspileResult, TranspileError> {
    use std::process::Stdio;
    use tokio::process::Command;

    let platform_arg = match target {
        TranspileTarget::Browser => "--platform=browser",
        TranspileTarget::NodeJs => "--platform=node",
    };

    let format_arg = match target {
        TranspileTarget::Browser => "--format=iife",
        TranspileTarget::NodeJs => "--format=cjs",
    };

    // Use npx esbuild for transpilation
    let output = Command::new("npx")
        .args([
            "esbuild",
            ts_file.to_string_lossy().as_ref(),
            "--outfile",
            &js_file.to_string_lossy(),
            "--target=es2020",
            format_arg,
            platform_arg,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|_| TranspileError::missing_tool("esbuild (via npx)", "https://nodejs.org"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined_output = format!("{}\n{}", stdout, stderr);

        return Err(parse_transpilation_error(
            &combined_output,
            original_script,
            "esbuild",
        ));
    }

    // Read the transpiled output
    let transpiled = tokio::fs::read_to_string(js_file).await.map_err(|e| {
        TranspileError::system_error(format!("Failed to read transpiled output: {}", e))
    })?;

    info!(
        "[transpiler] Successfully transpiled {} bytes of TypeScript to {} bytes of JavaScript (via esbuild)",
        original_script.len(),
        transpiled.len()
    );

    Ok(TranspileResult {
        code: transpiled,
        was_typescript: true,
    })
}

/// Parse transpilation errors and return a detailed TranspileError
fn parse_transpilation_error(output: &str, original_script: &str, _tool: &str) -> TranspileError {
    let mut line_num: Option<u32> = None;
    let mut col_num: Option<u32> = None;
    let mut error_message = String::new();
    let mut is_type_error = false;

    // Pre-compile regexes outside the loop
    let esbuild_re = regex::Regex::new(r"\.ts:(\d+):(\d+):\s*error:\s*(.+)").ok();
    let bun_location_re = regex::Regex::new(r"at\s+.*\.ts:(\d+):(\d+)").ok();
    let typescript_re = regex::Regex::new(r"TS(\d+):\s*(.+)").ok();

    for line in output.lines() {
        let line_trimmed = line.trim();

        if line_trimmed.is_empty() {
            continue;
        }

        // esbuild format: "file.ts:5:10: error: message"
        if let Some(captures) = esbuild_re.as_ref().and_then(|re| re.captures(line_trimmed)) {
            line_num = captures.get(1).and_then(|m| m.as_str().parse().ok());
            col_num = captures.get(2).and_then(|m| m.as_str().parse().ok());
            if let Some(msg) = captures.get(3) {
                error_message = msg.as_str().to_string();
            }
            break; // First error is most relevant
        }
        // Bun format: "error: message" followed by location
        else if line_trimmed.starts_with("error:") {
            error_message = line_trimmed
                .strip_prefix("error:")
                .unwrap_or("")
                .trim()
                .to_string();
        }
        // Bun location format: "at file.ts:5:10"
        else if let Some(captures) = bun_location_re
            .as_ref()
            .and_then(|re| re.captures(line_trimmed))
        {
            line_num = captures.get(1).and_then(|m| m.as_str().parse().ok());
            col_num = captures.get(2).and_then(|m| m.as_str().parse().ok());
            if !error_message.is_empty() {
                break; // Got both message and location
            }
        }
        // TypeScript-style error: "TS2304: Cannot find name 'foo'"
        else if let Some(captures) = typescript_re
            .as_ref()
            .and_then(|re| re.captures(line_trimmed))
        {
            is_type_error = true;
            if let Some(msg) = captures.get(2) {
                error_message = msg.as_str().to_string();
            }
        }
    }

    // If we couldn't parse specific errors, extract key message
    if error_message.is_empty() && !output.trim().is_empty() {
        error_message = output
            .lines()
            .find(|l| l.contains("error") || l.contains("Error"))
            .unwrap_or("Unknown transpilation error")
            .to_string();
    }

    // Extract just the error line from original script (minimal context)
    let error_line: Option<String> = line_num.and_then(|ln| {
        original_script
            .lines()
            .nth((ln as usize).saturating_sub(1))
            .map(|l| l.trim().to_string())
    });

    // Determine error kind and generate fix suggestion
    let (kind, fix) = categorize_error(&error_message, is_type_error);

    TranspileError::code_error(kind, error_message, line_num, col_num, error_line, fix)
}

/// Categorize error and generate actionable fix suggestion
fn categorize_error(message: &str, is_type_error: bool) -> (TranspileErrorKind, Option<String>) {
    let msg_lower = message.to_lowercase();

    // Type errors
    if is_type_error
        || msg_lower.contains("type")
        || msg_lower.contains("cannot assign")
        || msg_lower.contains("is not assignable")
    {
        let fix = if msg_lower.contains("cannot find name") {
            Some("Check variable spelling or add declaration".to_string())
        } else if msg_lower.contains("is not assignable") {
            Some("Check type compatibility or use type assertion".to_string())
        } else {
            Some("Fix the type error based on the message".to_string())
        };
        return (TranspileErrorKind::TypeError, fix);
    }

    // Syntax errors
    if msg_lower.contains("unexpected")
        || msg_lower.contains("expected")
        || msg_lower.contains("unterminated")
        || msg_lower.contains("invalid")
    {
        let fix = if msg_lower.contains("unexpected token") {
            Some("Check for missing brackets, semicolons, or operators".to_string())
        } else if msg_lower.contains("expected") {
            Some("Add the expected syntax element".to_string())
        } else if msg_lower.contains("unterminated") {
            Some("Close the string or template literal".to_string())
        } else {
            Some("Fix the syntax error at the indicated location".to_string())
        };
        return (TranspileErrorKind::SyntaxError, fix);
    }

    // Default to syntax error with generic fix
    (
        TranspileErrorKind::SyntaxError,
        Some("Review the code at the indicated location".to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_typescript_code_detects_type_annotations() {
        assert!(is_typescript_code("const x: string = 'hello';"));
        assert!(is_typescript_code("let count: number = 42;"));
        assert!(is_typescript_code("var flag: boolean = true;"));
        assert!(is_typescript_code("const data: any = {};"));
    }

    #[test]
    fn test_is_typescript_code_detects_function_types() {
        assert!(is_typescript_code(
            "function greet(name: string) { return name; }"
        ));
        assert!(is_typescript_code(
            "const add = (a: number, b: number) => a + b;"
        ));
        assert!(is_typescript_code(
            "function getData(): string { return ''; }"
        ));
    }

    #[test]
    fn test_is_typescript_code_detects_interface_and_type() {
        assert!(is_typescript_code("interface User { name: string; }"));
        assert!(is_typescript_code("type ID = string | number;"));
    }

    #[test]
    fn test_is_typescript_code_detects_generics() {
        assert!(is_typescript_code("const arr: Array<string> = [];"));
        assert!(is_typescript_code(
            "function identity<T>(arg: T): T { return arg; }"
        ));
    }

    #[test]
    fn test_is_typescript_code_detects_class_modifiers() {
        assert!(is_typescript_code("class Foo { private x = 1; }"));
        assert!(is_typescript_code("class Bar { public name: string; }"));
    }

    #[test]
    fn test_is_typescript_code_rejects_plain_javascript() {
        assert!(!is_typescript_code("const x = 'hello';"));
        assert!(!is_typescript_code("let count = 42;"));
        assert!(!is_typescript_code("function greet(name) { return name; }"));
        assert!(!is_typescript_code("const add = (a, b) => a + b;"));
        assert!(!is_typescript_code("(() => { console.log('hi'); })();"));
    }

    #[test]
    fn test_is_typescript_code_handles_edge_cases() {
        assert!(!is_typescript_code(""));
        assert!(!is_typescript_code(
            "const obj = { name: 'test', value: 123 };"
        ));
        assert!(!is_typescript_code("const x = condition ? 'yes' : 'no';"));
    }

    #[tokio::test]
    async fn test_transpile_passes_through_plain_js() {
        let js_code = "const button = document.querySelector('button'); button.click();";

        let result = transpile(js_code, TranspileTarget::Browser).await;
        assert!(result.is_ok());

        let transpiled = result.unwrap();
        assert!(!transpiled.was_typescript);
        assert_eq!(transpiled.code, js_code);
    }

    #[tokio::test]
    async fn test_transpile_handles_typescript() {
        if !is_transpiler_available() {
            eprintln!("Skipping TypeScript transpilation test - no transpiler available");
            return;
        }

        let ts_code = r#"
            const greet = (name: string): string => {
                return `Hello, ${name}!`;
            };
            greet("World");
        "#;

        let result = transpile(ts_code, TranspileTarget::Browser).await;

        match result {
            Ok(transpiled) => {
                assert!(transpiled.was_typescript);
                assert!(!transpiled.code.contains(": string"));
            }
            Err(e) => {
                // Skip test if transpiler tools are not working (CI environment issue)
                if e.kind == TranspileErrorKind::MissingTool
                    || e.kind == TranspileErrorKind::SystemError
                {
                    eprintln!(
                        "Skipping - transpiler not working in this environment: {}",
                        e.message
                    );
                    return;
                }
                panic!("Unexpected transpilation error: {:?}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_transpile_reports_errors_with_recovery() {
        if !is_transpiler_available() {
            eprintln!("Skipping type error test - no transpiler available");
            return;
        }

        let bad_ts = r#"
            const x: string = "hello"
            const y: number = x +++ 42;
        "#;

        let result = transpile(bad_ts, TranspileTarget::Browser).await;

        assert!(result.is_err());

        // If transpiler is not actually working (esbuild not installed or system error), skip
        if let Err(ref e) = result {
            if e.kind == TranspileErrorKind::MissingTool
                || e.kind == TranspileErrorKind::SystemError
            {
                eprintln!(
                    "Skipping - transpiler not working in this environment: {}",
                    e.message
                );
                return;
            }
        }

        if let Err(e) = result {
            // Should have a recovery action of FixCode for code errors
            assert_eq!(e.recovery, RecoveryAction::FixCode);
            // Should have a fix suggestion
            assert!(e.fix.is_some(), "Expected fix suggestion for code error");
            // Should be a syntax or type error
            assert!(
                e.kind == TranspileErrorKind::SyntaxError
                    || e.kind == TranspileErrorKind::TypeError,
                "Expected code error kind, got: {:?}",
                e.kind
            );
        }
    }

    // ==========================================
    // Context Engineering Tests
    // ==========================================

    #[test]
    fn test_error_output_is_minimal_and_structured() {
        // Test that error output follows context engineering principles:
        // - Minimal (no verbose stack traces)
        // - Structured (JSON with clear sections)
        // - Actionable (specific fix suggestions)

        let error = TranspileError::code_error(
            TranspileErrorKind::SyntaxError,
            "Unexpected token '}'",
            Some(5),
            Some(10),
            Some("const x = { foo };".to_string()),
            Some("Add value for 'foo' property: { foo: value }".to_string()),
        );

        let mcp_error = error.into_mcp_error();
        let data = mcp_error.data.expect("Error should have data");

        // Verify structure
        assert!(data.get("error_type").is_some(), "Must have error_type");
        assert!(data.get("can_fix").is_some(), "Must have can_fix");
        assert!(data.get("recovery").is_some(), "Must have recovery");

        // Verify it's actionable
        assert!(data.get("fix").is_some(), "Code errors must have fix");

        // Verify it's minimal (no raw_output, no verbose stack traces)
        assert!(
            data.get("raw_output").is_none(),
            "Should not include raw output"
        );
        assert!(
            data.get("stack_trace").is_none(),
            "Should not include stack traces"
        );
    }

    #[test]
    fn test_missing_tool_error_provides_fallback_instruction() {
        let error = TranspileError::missing_tool("bun", "https://bun.sh");

        assert_eq!(error.recovery, RecoveryAction::UseJavaScript);
        assert_eq!(error.kind, TranspileErrorKind::MissingTool);

        let mcp_error = error.into_mcp_error();
        let data = mcp_error.data.expect("Error should have data");

        // Recovery should instruct to use JavaScript
        let recovery = data.get("recovery").expect("Must have recovery");
        assert!(
            recovery.get("action").is_some(),
            "Recovery must have action"
        );
        assert!(
            recovery.get("instruction").is_some(),
            "Recovery must have instruction for JS fallback"
        );
    }

    #[test]
    fn test_error_categorization_produces_actionable_fixes() {
        // Test various error messages get proper categorization

        let (kind, fix) = categorize_error("Cannot find name 'foo'", true);
        assert_eq!(kind, TranspileErrorKind::TypeError);
        assert!(
            fix.as_ref().unwrap().contains("spelling")
                || fix.as_ref().unwrap().contains("declaration"),
            "Fix should be actionable: {:?}",
            fix
        );

        let (kind, fix) = categorize_error("Unexpected token '}'", false);
        assert_eq!(kind, TranspileErrorKind::SyntaxError);
        assert!(
            fix.as_ref().unwrap().contains("bracket")
                || fix.as_ref().unwrap().contains("semicolon"),
            "Fix should be actionable: {:?}",
            fix
        );

        let (kind, fix) =
            categorize_error("Type 'string' is not assignable to type 'number'", false);
        assert_eq!(kind, TranspileErrorKind::TypeError);
        assert!(
            fix.as_ref().unwrap().contains("type"),
            "Fix should mention type: {:?}",
            fix
        );
    }

    #[test]
    fn test_log_string_is_concise() {
        let error = TranspileError::code_error(
            TranspileErrorKind::SyntaxError,
            "Unexpected token",
            Some(10),
            Some(5),
            Some("const x = { };".to_string()),
            Some("Check syntax".to_string()),
        );

        let log = error.to_log_string();

        // Should be concise - under 500 chars for a typical error
        assert!(
            log.len() < 500,
            "Log should be concise, got {} chars",
            log.len()
        );

        // Should contain key info
        assert!(log.contains("syntax_error"), "Should contain error type");
        assert!(log.contains("line 10"), "Should contain line number");
        assert!(log.contains("fix:"), "Should contain fix");
    }
}
