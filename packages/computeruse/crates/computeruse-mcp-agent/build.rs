use std::process::Command;

fn main() {
    // Get git commit hash
    if let Ok(output) = Command::new("git").args(["rev-parse", "HEAD"]).output() {
        let git_hash = String::from_utf8_lossy(&output.stdout);
        println!("cargo:rustc-env=GIT_HASH={}", git_hash.trim());
    }

    // Get git branch
    if let Ok(output) = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
    {
        let git_branch = String::from_utf8_lossy(&output.stdout);
        println!("cargo:rustc-env=GIT_BRANCH={}", git_branch.trim());
    }

    // Set build timestamp
    println!(
        "cargo:rustc-env=BUILD_TIMESTAMP={}",
        chrono::Utc::now().to_rfc3339()
    );

    // Extract MCP tool names from server.rs dispatch_tool match
    println!("cargo:rerun-if-changed=src/server.rs");
    let mcp_tools = extract_mcp_tools();
    println!("cargo:rustc-env=MCP_TOOLS={}", mcp_tools);
}

fn extract_mcp_tools() -> String {
    use std::fs;

    let server_rs = match fs::read_to_string("src/server.rs") {
        Ok(content) => content,
        Err(_) => return String::new(),
    };

    // Find dispatch_tool match block and extract tool names
    // Pattern: lines starting with `"tool_name" =>` at match arm level
    let mut tools = Vec::new();
    let mut in_dispatch_tool = false;

    for line in server_rs.lines() {
        // Detect start of dispatch_tool match
        if line.contains("let result = match tool_name") {
            in_dispatch_tool = true;
            continue;
        }

        if in_dispatch_tool {
            let trimmed = line.trim();

            // Match arm pattern: starts with `"tool_name" =>`
            if trimmed.starts_with('"') && trimmed.contains("\" =>") {
                if let Some(end) = trimmed[1..].find('"') {
                    let tool_name = &trimmed[1..1 + end];
                    // Only include valid tool names (lowercase with underscores)
                    if tool_name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '_')
                        && !tools.contains(&tool_name.to_string())
                    {
                        tools.push(tool_name.to_string());
                    }
                }
            }

            // Exit at the unknown tool fallback (end of match)
            if trimmed.starts_with("unknown =>") || trimmed.starts_with("_ =>") {
                break;
            }
        }
    }

    tools.join(",")
}
