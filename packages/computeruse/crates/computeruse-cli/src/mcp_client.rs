use anyhow::Result;
use rmcp::{
    model::{CallToolRequestParam, ClientCapabilities, ClientInfo, Implementation},
    object,
    transport::{StreamableHttpClientTransport, TokioChildProcess},
    ServiceExt,
};
use std::io::{self, Write};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::sleep;
use tracing::info;

use anthropic_sdk::{Client as AnthropicClient, ToolChoice};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub enum Transport {
    Http {
        url: String,
        auth_token: Option<String>,
    },
    Stdio(Vec<String>),
}

/// Check if the path is a Windows batch file
fn is_batch_file(path: &str) -> bool {
    path.ends_with(".bat") || path.ends_with(".cmd")
}

/// Create command with proper handling for batch files on Windows
fn create_command(executable: &str, args: &[String]) -> Command {
    let mut cmd = if cfg!(windows) && is_batch_file(executable) {
        // For batch files on Windows, use cmd.exe /c
        let mut cmd = Command::new("cmd");
        cmd.arg("/c");
        cmd.arg(executable);
        cmd
    } else {
        Command::new(executable)
    };

    if !args.is_empty() {
        cmd.args(args);
    }

    cmd
}

/// Create HTTP transport with optional authentication
fn create_http_transport(
    url: &str,
    auth_token: Option<&String>,
) -> StreamableHttpClientTransport<reqwest::Client> {
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;

    if let Some(token) = auth_token {
        // Create config with authentication
        let config = StreamableHttpClientTransportConfig::with_uri(url).auth_header(token);
        StreamableHttpClientTransport::with_client(reqwest::Client::new(), config)
    } else {
        // No authentication
        StreamableHttpClientTransport::from_uri(url)
    }
}

/// Find executable with cross-platform path resolution
fn find_executable(name: &str) -> Option<String> {
    use std::env;
    use std::path::Path;

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

    // Fallback: try the name as-is (might work on some systems)
    Some(name.to_string())
}

pub async fn interactive_chat(transport: Transport) -> Result<()> {
    println!("🤖 ComputerUse MCP Chat Client");
    println!("=============================");

    match transport {
        Transport::Http { url, auth_token } => {
            println!("Connecting to: {url}");
            let transport = create_http_transport(&url, auth_token.as_ref());
            let client_info = ClientInfo {
                protocol_version: Default::default(),
                capabilities: ClientCapabilities::default(),
                client_info: Implementation {
                    name: "computeruse-cli".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    ..Default::default()
                },
            };
            let service = client_info.serve(transport).await?;

            // Get server info
            let server_info = service.peer_info();
            if let Some(info) = server_info {
                println!("✅ Connected to server: {}", info.server_info.name);
                println!("   Version: {}", info.server_info.version);
            }

            // List available tools
            let tools = service.list_all_tools().await?;
            println!("\n📋 Available tools ({}):", tools.len());
            for (i, tool) in tools.iter().enumerate() {
                if i < 10 {
                    println!(
                        "   🔧 {} - {}",
                        tool.name,
                        tool.description.as_deref().unwrap_or("No description")
                    );
                } else if i == 10 {
                    println!("   ... and {} more tools", tools.len() - 10);
                    break;
                }
            }

            println!("\n💡 Examples:");
            println!("  - get_desktop_info");
            println!("  - list_applications");
            println!("  - open_application notepad");
            println!("  - type_text 'Hello from ComputerUse!'");
            println!("  - take_screenshot");
            println!("\nType 'help' to see all tools, 'exit' to quit");
            println!("=====================================\n");

            let stdin = io::stdin();
            let mut stdout = io::stdout();

            loop {
                print!("🔧 Tool (or command): ");
                stdout.flush()?;

                let mut input = String::new();
                stdin.read_line(&mut input)?;
                let input = input.trim();

                if input.is_empty() {
                    continue;
                }

                if input == "exit" || input == "quit" {
                    println!("👋 Goodbye!");
                    break;
                }

                if input == "help" {
                    println!("\n📚 All available tools:");
                    for tool in &tools {
                        println!(
                            "   {} - {}",
                            tool.name,
                            tool.description.as_deref().unwrap_or("No description")
                        );
                        if let Some(props) = tool.input_schema.get("properties") {
                            println!("      Parameters: {}", serde_json::to_string(props)?);
                        }
                    }
                    println!();
                    continue;
                }

                // Parse tool call
                let parts: Vec<&str> = input.splitn(2, ' ').collect();
                let tool_name = parts[0].to_string();

                // Build arguments
                let arguments = if parts.len() > 1 {
                    let args_part = parts[1];
                    // Try to parse as JSON first
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(args_part) {
                        json.as_object().cloned()
                    } else {
                        // Otherwise, try to build simple arguments
                        match tool_name.as_str() {
                            "open_application" => Some(object!({ "name": args_part.to_string() })),
                            "type_text" => Some(object!({ "text": args_part.to_string() })),
                            _ => None,
                        }
                    }
                } else {
                    None
                };

                let args_str = arguments
                    .as_ref()
                    .map(|a| {
                        let json_str = serde_json::to_string(a).unwrap_or_default();
                        // Truncate very long arguments to avoid verbose output
                        if json_str.len() > 500 {
                            format!(
                                "{}... (truncated, {} total chars)",
                                &json_str[..500],
                                json_str.len()
                            )
                        } else {
                            json_str
                        }
                    })
                    .unwrap_or_else(|| "{}".to_string());

                println!("\n⚡ Calling {tool_name} with args: {args_str}");

                match service
                    .call_tool(CallToolRequestParam {
                        name: tool_name.into(),
                        arguments,
                    })
                    .await
                {
                    Ok(result) => {
                        println!("✅ Result:");
                        if !result.content.is_empty() {
                            for content in &result.content {
                                match &content.raw {
                                    rmcp::model::RawContent::Text(text) => {
                                        println!("{}", text.text);
                                    }
                                    rmcp::model::RawContent::Image(image) => {
                                        println!("[Image: {}]", image.mime_type);
                                    }
                                    rmcp::model::RawContent::Resource(resource) => {
                                        println!("[Resource: {:?}]", resource.resource);
                                    }
                                    rmcp::model::RawContent::Audio(audio) => {
                                        println!("[Audio: {}]", audio.mime_type);
                                    }
                                    rmcp::model::RawContent::ResourceLink(resource) => {
                                        println!("[ResourceLink: {resource:?}]");
                                    }
                                }
                            }
                        }
                        println!();
                    }
                    Err(e) => {
                        println!("❌ Error: {e}\n");
                    }
                }
            }

            // Cancel the service connection
            service.cancel().await?;
        }
        Transport::Stdio(command) => {
            println!("Starting: {}", command.join(" "));
            let executable = find_executable(&command[0]).unwrap_or_else(|| command[0].clone());
            let command_args: Vec<String> = if command.len() > 1 {
                command[1..].to_vec()
            } else {
                vec![]
            };
            let mut cmd = create_command(&executable, &command_args);
            // Ensure server prints useful logs if not set by user
            if std::env::var("LOG_LEVEL").is_err() && std::env::var("RUST_LOG").is_err() {
                cmd.env("LOG_LEVEL", "info");
            }
            let transport = TokioChildProcess::new(cmd)?;
            let service = ().serve(transport).await?;
            // Get server info
            let server_info = service.peer_info();
            if let Some(info) = server_info {
                println!("✅ Connected to server: {}", info.server_info.name);
                println!("   Version: {}", info.server_info.version);
            }

            // List available tools
            let tools = service.list_all_tools().await?;
            println!("\n📋 Available tools ({}):", tools.len());
            for (i, tool) in tools.iter().enumerate() {
                if i < 10 {
                    println!(
                        "   🔧 {} - {}",
                        tool.name,
                        tool.description.as_deref().unwrap_or("No description")
                    );
                } else if i == 10 {
                    println!("   ... and {} more tools", tools.len() - 10);
                    break;
                }
            }

            println!("\n💡 Examples:");
            println!("  - get_desktop_info");
            println!("  - list_applications");
            println!("  - open_application notepad");
            println!("  - type_text 'Hello from ComputerUse!'");
            println!("  - take_screenshot");
            println!("\nType 'help' to see all tools, 'exit' to quit");
            println!("=====================================\n");

            let stdin = io::stdin();
            let mut stdout = io::stdout();

            loop {
                print!("🔧 Tool (or command): ");
                stdout.flush()?;

                let mut input = String::new();
                stdin.read_line(&mut input)?;
                let input = input.trim();

                if input.is_empty() {
                    continue;
                }

                if input == "exit" || input == "quit" {
                    println!("👋 Goodbye!");
                    break;
                }

                if input == "help" {
                    println!("\n📚 All available tools:");
                    for tool in &tools {
                        println!(
                            "   {} - {}",
                            tool.name,
                            tool.description.as_deref().unwrap_or("No description")
                        );
                        if let Some(props) = tool.input_schema.get("properties") {
                            println!("      Parameters: {}", serde_json::to_string(props)?);
                        }
                    }
                    println!();
                    continue;
                }

                // Parse tool call
                let parts: Vec<&str> = input.splitn(2, ' ').collect();
                let tool_name = parts[0].to_string();

                // Build arguments
                let arguments = if parts.len() > 1 {
                    let args_part = parts[1];
                    // Try to parse as JSON first
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(args_part) {
                        json.as_object().cloned()
                    } else {
                        // Otherwise, try to build simple arguments
                        match tool_name.as_str() {
                            "open_application" => Some(object!({ "name": args_part.to_string() })),
                            "type_text" => Some(object!({ "text": args_part.to_string() })),
                            _ => None,
                        }
                    }
                } else {
                    None
                };

                let args_str = arguments
                    .as_ref()
                    .map(|a| {
                        let json_str = serde_json::to_string(a).unwrap_or_default();
                        // Truncate very long arguments to avoid verbose output
                        if json_str.len() > 500 {
                            format!(
                                "{}... (truncated, {} total chars)",
                                &json_str[..500],
                                json_str.len()
                            )
                        } else {
                            json_str
                        }
                    })
                    .unwrap_or_else(|| "{}".to_string());

                println!("\n⚡ Calling {tool_name} with args: {args_str}");

                match service
                    .call_tool(CallToolRequestParam {
                        name: tool_name.into(),
                        arguments,
                    })
                    .await
                {
                    Ok(result) => {
                        println!("✅ Result:");
                        if !result.content.is_empty() {
                            for content in &result.content {
                                match &content.raw {
                                    rmcp::model::RawContent::Text(text) => {
                                        println!("{}", text.text);
                                    }
                                    rmcp::model::RawContent::Image(image) => {
                                        println!("[Image: {}]", image.mime_type);
                                    }
                                    rmcp::model::RawContent::Resource(resource) => {
                                        println!("[Resource: {:?}]", resource.resource);
                                    }
                                    rmcp::model::RawContent::Audio(audio) => {
                                        println!("[Audio: {}]", audio.mime_type);
                                    }
                                    rmcp::model::RawContent::ResourceLink(resource) => {
                                        println!("[ResourceLink: {resource:?}]");
                                    }
                                }
                            }
                        }
                        println!();
                    }
                    Err(e) => {
                        println!("❌ Error: {e}\n");
                    }
                }
            }

            // Cancel the service connection
            service.cancel().await?;
        }
    }
    Ok(())
}

pub async fn execute_command(
    transport: Transport,
    tool: String,
    args: Option<String>,
) -> Result<()> {
    // Initialize logging for non-interactive mode
    init_logging();

    match transport {
        Transport::Http { url, auth_token } => {
            info!("Connecting to server: {}", url);
            let transport = create_http_transport(&url, auth_token.as_ref());
            let client_info = ClientInfo {
                protocol_version: Default::default(),
                capabilities: ClientCapabilities::default(),
                client_info: Implementation {
                    name: "computeruse-cli".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    ..Default::default()
                },
            };
            let service = client_info.serve(transport).await?;

            let arguments = if let Some(args_str) = args {
                serde_json::from_str::<serde_json::Value>(&args_str)
                    .ok()
                    .and_then(|v| v.as_object().cloned())
            } else {
                None
            };

            let args_str = arguments
                .as_ref()
                .map(|a| {
                    let json_str = serde_json::to_string(a).unwrap_or_default();
                    // Truncate very long arguments to avoid verbose output
                    if json_str.len() > 500 {
                        format!(
                            "{}... (truncated, {} total chars)",
                            &json_str[..500],
                            json_str.len()
                        )
                    } else {
                        json_str
                    }
                })
                .unwrap_or_else(|| "{}".to_string());

            println!("⚡ Calling {tool} with args: {args_str}");

            let result = service
                .call_tool(CallToolRequestParam {
                    name: tool.into(),
                    arguments,
                })
                .await?;

            println!("✅ Result:");
            if !result.content.is_empty() {
                for content in &result.content {
                    match &content.raw {
                        rmcp::model::RawContent::Text(text) => {
                            println!("{}", text.text);
                        }
                        rmcp::model::RawContent::Image(image) => {
                            println!("[Image: {}]", image.mime_type);
                        }
                        rmcp::model::RawContent::Resource(resource) => {
                            println!("[Resource: {:?}]", resource.resource);
                        }
                        rmcp::model::RawContent::Audio(audio) => {
                            println!("[Audio: {}]", audio.mime_type);
                        }
                        rmcp::model::RawContent::ResourceLink(resource) => {
                            println!("[ResourceLink: {resource:?}]");
                        }
                    }
                }
            }

            // Cancel the service connection
            service.cancel().await?;
        }
        Transport::Stdio(command) => {
            info!("Starting MCP server: {}", command.join(" "));
            let executable = find_executable(&command[0]).unwrap_or_else(|| command[0].clone());
            let command_args: Vec<String> = if command.len() > 1 {
                command[1..].to_vec()
            } else {
                vec![]
            };
            let mut cmd = create_command(&executable, &command_args);
            // Default server log level to info if not provided by the user
            if std::env::var("LOG_LEVEL").is_err() && std::env::var("RUST_LOG").is_err() {
                cmd.env("LOG_LEVEL", "info");
            }
            let transport = TokioChildProcess::new(cmd)?;
            let service = ().serve(transport).await?;

            let arguments = if let Some(args_str) = args {
                serde_json::from_str::<serde_json::Value>(&args_str)
                    .ok()
                    .and_then(|v| v.as_object().cloned())
            } else {
                None
            };

            let args_str = arguments
                .as_ref()
                .map(|a| {
                    let json_str = serde_json::to_string(a).unwrap_or_default();
                    // Truncate very long arguments to avoid verbose output
                    if json_str.len() > 500 {
                        format!(
                            "{}... (truncated, {} total chars)",
                            &json_str[..500],
                            json_str.len()
                        )
                    } else {
                        json_str
                    }
                })
                .unwrap_or_else(|| "{}".to_string());

            println!("⚡ Calling {tool} with args: {args_str}");

            let result = service
                .call_tool(CallToolRequestParam {
                    name: tool.into(),
                    arguments,
                })
                .await?;

            println!("✅ Result:");
            if !result.content.is_empty() {
                for content in &result.content {
                    match &content.raw {
                        rmcp::model::RawContent::Text(text) => {
                            println!("{}", text.text);
                        }
                        rmcp::model::RawContent::Image(image) => {
                            println!("[Image: {}]", image.mime_type);
                        }
                        rmcp::model::RawContent::Resource(resource) => {
                            println!("[Resource: {:?}]", resource.resource);
                        }
                        rmcp::model::RawContent::Audio(audio) => {
                            println!("[Audio: {}]", audio.mime_type);
                        }
                        rmcp::model::RawContent::ResourceLink(resource) => {
                            println!("[ResourceLink: {resource:?}]");
                        }
                    }
                }
            }

            // Cancel the service connection
            service.cancel().await?;
        }
    }
    Ok(())
}

fn init_logging() {
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
    let file_appender = rolling::daily(&log_dir, "computeruse-mcp-client.log");

    let _ = tracing_subscriber::registry()
        .with(
            // Respect RUST_LOG if provided, else default to info
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(
            // Console layer
            tracing_subscriber::fmt::layer().with_writer(std::io::stderr),
        )
        .with(
            // File layer
            tracing_subscriber::fmt::layer()
                .with_writer(file_appender)
                .with_ansi(false)
                .with_target(true)
                .with_file(true)
                .with_line_number(true),
        )
        .try_init();
}

// Helper function to parse step start logs
#[allow(dead_code)]
fn parse_step_log(line: &str) -> Option<(String, String, String)> {
    // Parse lines like: "Step 0 BEGIN tool='open_application' id='open_notepad' ..."
    if let Some(step_idx) = line.find("Step ") {
        let after_step = &line[step_idx + 5..];
        if let Some(space_idx) = after_step.find(' ') {
            let step_num = &after_step[..space_idx];
            if let Some(tool_idx) = line.find("tool='") {
                let after_tool = &line[tool_idx + 6..];
                if let Some(quote_idx) = after_tool.find('\'') {
                    let tool_name = &after_tool[..quote_idx];
                    return Some((
                        step_num.to_string(),
                        "?".to_string(), // We don't have total from logs
                        tool_name.to_string(),
                    ));
                }
            } else if let Some(group_idx) = line.find("group='") {
                let after_group = &line[group_idx + 7..];
                if let Some(quote_idx) = after_group.find('\'') {
                    let group_name = &after_group[..quote_idx];
                    return Some((
                        step_num.to_string(),
                        "?".to_string(),
                        format!("[{group_name}]"),
                    ));
                }
            }
        }
    }
    None
}

// Helper function to parse step end logs
#[allow(dead_code)]
fn parse_step_end_log(line: &str) -> Option<(String, String)> {
    // Parse lines like: "Step 0 END tool='open_application' id='open_notepad' status=success"
    if let Some(step_idx) = line.find("Step ") {
        let after_step = &line[step_idx + 5..];
        if let Some(space_idx) = after_step.find(' ') {
            let step_num = &after_step[..space_idx];
            if let Some(status_idx) = line.find("status=") {
                let after_status = &line[status_idx + 7..];
                let status = after_status.split_whitespace().next().unwrap_or("unknown");
                return Some((step_num.to_string(), status.to_string()));
            }
        }
    }
    None
}

pub async fn natural_language_chat(transport: Transport) -> Result<()> {
    println!("🤖 ComputerUse Natural Language Chat Client");
    println!("==========================================");

    // Load Anthropic API Key
    dotenvy::dotenv().ok();
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("❌ ANTHROPIC_API_KEY environment variable not set.");
            println!("Please set it in a .env file or export it:");
            println!("  export ANTHROPIC_API_KEY='your-api-key-here'");
            return Ok(());
        }
    };

    // Connect to MCP Server
    let service = match transport {
        Transport::Http { url, auth_token } => {
            println!("Connecting to MCP server: {url}");
            let transport = create_http_transport(&url, auth_token.as_ref());
            let client_info = ClientInfo {
                protocol_version: Default::default(),
                capabilities: ClientCapabilities::default(),
                client_info: Implementation {
                    name: "computeruse-cli-ai".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    ..Default::default()
                },
            };
            client_info.serve(transport).await?
        }
        Transport::Stdio(command) => {
            println!("Starting MCP server: {}", command.join(" "));
            let executable = find_executable(&command[0]).unwrap_or_else(|| command[0].clone());
            let command_args: Vec<String> = if command.len() > 1 {
                command[1..].to_vec()
            } else {
                vec![]
            };
            let mut cmd = create_command(&executable, &command_args);
            // Default server log level to info if not provided by the user
            if std::env::var("LOG_LEVEL").is_err() && std::env::var("RUST_LOG").is_err() {
                cmd.env("LOG_LEVEL", "info");
            }
            let transport = TokioChildProcess::new(cmd)?;
            let client_info = ClientInfo {
                protocol_version: Default::default(),
                capabilities: ClientCapabilities::default(),
                client_info: Implementation {
                    name: "computeruse-cli-ai".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    ..Default::default()
                },
            };
            client_info.serve(transport).await?
        }
    };

    if let Some(info) = service.peer_info() {
        println!("✅ Connected to MCP server: {}", info.server_info.name);
    }

    // Get MCP tools and convert to Anthropic format
    let mcp_tools = service.list_all_tools().await?;
    let anthropic_tools: Vec<serde_json::Value> = mcp_tools
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description.unwrap_or_default(),
                "input_schema": t.input_schema
            })
        })
        .collect();

    println!("✅ Found {} tools.", anthropic_tools.len());
    println!("\n💡 Type your command in natural language. Examples:");
    println!("  - 'Open notepad and type hello world'");
    println!("  - 'Take a screenshot of the desktop'");
    println!("  - 'Show me all running applications'");
    println!("\nType 'exit' or 'quit' to end the session.");
    println!("========================================================================================\n");

    let mut messages = Vec::new();

    loop {
        print!("💬 You: ");
        std::io::stdout().flush()?;

        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        let input = input.trim();

        if input.eq_ignore_ascii_case("exit") || input.eq_ignore_ascii_case("quit") {
            println!("👋 Goodbye!");
            break;
        }

        if input.is_empty() {
            continue;
        }

        // Add user message
        messages.push(json!({
            "role": "user",
            "content": input
        }));

        println!("🤔 Thinking...");

        // Process with Claude and handle tool calls in a loop
        loop {
            // Create request
            let mut request_builder = AnthropicClient::new()
                .auth(api_key.as_str())
                .version("2023-06-01")
                .model("claude-3-opus-20240229")
                .messages(&json!(messages))
                .max_tokens(1000)
                .stream(false); // Disable streaming for simplicity

            // Add tools if available
            if !anthropic_tools.is_empty() {
                request_builder = request_builder.tools(&json!(anthropic_tools));
                request_builder = request_builder.tool_choice(ToolChoice::Auto);
            }

            let request = request_builder.build()?;

            // Execute request and collect the response
            let response_text = Arc::new(Mutex::new(String::new()));
            let response_text_clone = response_text.clone();

            let execute_result = request
                .execute(move |response| {
                    let response_text = response_text_clone.clone();
                    async move {
                        // Collect the full response
                        if let Ok(mut text) = response_text.lock() {
                            text.push_str(&response);
                        }
                    }
                })
                .await;

            if let Err(error) = execute_result {
                eprintln!("❌ Error: {error}");
                break; // Break inner loop on error
            }

            // Get the collected response
            let full_response = response_text.lock().unwrap().clone();

            // Try to parse as JSON (the SDK should return JSON when not in streaming mode)
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&full_response) {
                // Extract content from the response
                let mut assistant_content = Vec::new();
                let mut tool_calls = Vec::new();
                let mut text_parts = Vec::new();

                if let Some(content_array) = json.get("content").and_then(|v| v.as_array()) {
                    for content in content_array {
                        if let Some(content_type) = content.get("type").and_then(|v| v.as_str()) {
                            match content_type {
                                "text" => {
                                    if let Some(text) = content.get("text").and_then(|v| v.as_str())
                                    {
                                        text_parts.push(text.to_string());
                                        assistant_content.push(json!({
                                            "type": "text",
                                            "text": text
                                        }));
                                    }
                                }
                                "tool_use" => {
                                    let tool_call = content.clone();
                                    tool_calls.push(tool_call.clone());
                                    assistant_content.push(tool_call);
                                }
                                _ => {}
                            }
                        }
                    }
                }

                // Print the text response
                if !text_parts.is_empty() {
                    println!("{}", text_parts.join("\n"));
                }

                // Add assistant's response to messages
                if !assistant_content.is_empty() {
                    messages.push(json!({
                        "role": "assistant",
                        "content": assistant_content
                    }));
                }

                // If no tool calls, we're done with this query
                if tool_calls.is_empty() {
                    break;
                }

                // Execute tool calls
                println!("\n🔧 Executing {} tool(s)...", tool_calls.len());
                let mut tool_results = Vec::new();

                // Consume `tool_calls` to avoid holding an iterator borrow across the `await` boundary
                for tool_call in tool_calls {
                    let tool_name = tool_call
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_id = tool_call
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_input = tool_call.get("input").cloned().unwrap_or(json!({}));

                    println!("   - Calling `{tool_name}` with args: {tool_input}");

                    let result = service
                        .call_tool(CallToolRequestParam {
                            name: tool_name.into(),
                            arguments: tool_input.as_object().cloned(),
                        })
                        .await;

                    let result_content = match result {
                        Ok(res) => {
                            let text_results: Vec<String> = res
                                .content
                                .iter()
                                .filter_map(|c| match &c.raw {
                                    rmcp::model::RawContent::Text(text) => Some(text.text.clone()),
                                    _ => None,
                                })
                                .collect();
                            if text_results.is_empty() {
                                "Tool executed successfully.".to_string()
                            } else {
                                text_results.join("\n")
                            }
                        }
                        Err(e) => format!("Error: {e}"),
                    };

                    let display_result = if result_content.len() > 100 {
                        format!("{}...", &result_content[..100])
                    } else {
                        result_content.clone()
                    };
                    println!("   ✅ Result: {display_result}");

                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result_content
                    }));
                }

                // Add tool results to messages
                messages.push(json!({
                    "role": "user",
                    "content": tool_results
                }));

                println!("\n🤔 Processing results...");
                // Continue the loop to get Claude's response about the tool results
            } else {
                // If not JSON, just print the response
                println!("{full_response}");
                break;
            }
        }
    }

    service.cancel().await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn execute_command_with_result(
    transport: Transport,
    tool: String,
    args: Option<String>,
) -> Result<serde_json::Value> {
    execute_command_with_progress(transport, tool, args, false).await
}

pub async fn execute_command_with_progress(
    transport: Transport,
    tool: String,
    args: Option<String>,
    show_progress: bool,
) -> Result<serde_json::Value> {
    execute_command_with_progress_and_retry(transport, tool, args, show_progress, false).await
}

pub async fn execute_command_with_progress_and_retry(
    transport: Transport,
    tool: String,
    args: Option<String>,
    show_progress: bool,
    no_retry: bool,
) -> Result<serde_json::Value> {
    use colored::Colorize;
    use tracing::debug;

    // Special handling for execute_sequence to capture full result
    if tool == "execute_sequence" {
        match transport {
            Transport::Http { url, auth_token } => {
                debug!("Connecting to server: {}", url);
                let transport = create_http_transport(&url, auth_token.as_ref());
                let client_info = ClientInfo {
                    protocol_version: Default::default(),
                    capabilities: ClientCapabilities::default(),
                    client_info: Implementation {
                        name: "computeruse-cli".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                        ..Default::default()
                    },
                };

                // Connection setup - no retry here as StreamableHttpClientTransport doesn't support cloning
                // Retries will be handled at the tool call level
                let service = client_info.serve(transport).await?;

                let arguments = if let Some(args_str) = args {
                    serde_json::from_str::<serde_json::Value>(&args_str)
                        .ok()
                        .and_then(|v| v.as_object().cloned())
                } else {
                    None
                };

                // Parse workflow to get step count if showing progress
                if show_progress {
                    if let Some(args_obj) = &arguments {
                        if let Some(steps) = args_obj.get("steps").and_then(|v| v.as_array()) {
                            let total_steps = steps.len();
                            println!(
                                "\n{} {} {}",
                                "🎯".cyan(),
                                "WORKFLOW START:".bold().cyan(),
                                format!("{total_steps} steps").dimmed()
                            );

                            // List the steps that will be executed
                            for (i, step) in steps.iter().enumerate() {
                                let tool_name = step
                                    .get("tool_name")
                                    .and_then(|v| v.as_str())
                                    .or_else(|| step.get("group_name").and_then(|v| v.as_str()))
                                    .unwrap_or("unknown");
                                let step_id = step.get("id").and_then(|v| v.as_str()).unwrap_or("");

                                println!(
                                    "  {} Step {}/{}: {} {}",
                                    "📋".dimmed(),
                                    i + 1,
                                    total_steps,
                                    tool_name.yellow(),
                                    if !step_id.is_empty() {
                                        format!("[{step_id}]").dimmed().to_string()
                                    } else {
                                        String::new()
                                    }
                                );
                            }
                            println!("\n{} Executing workflow...\n", "⚡".cyan());
                        }
                    }
                }

                // Retry logic for tool execution
                let mut retry_count = 0;
                let max_retries = if no_retry { 0 } else { 3 };
                let mut _last_error = None;

                // Check if this is a TypeScript workflow (URL ends with .ts or .js)
                let is_typescript_workflow = if tool == "execute_sequence" {
                    arguments
                        .as_ref()
                        .and_then(|args| args.get("url"))
                        .and_then(|url| url.as_str())
                        .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
                        .unwrap_or(false)
                } else {
                    false
                };

                let result = loop {
                    match service
                        .call_tool(CallToolRequestParam {
                            name: tool.clone().into(),
                            arguments: arguments.clone(),
                        })
                        .await
                    {
                        Ok(res) => break res,
                        Err(e) => {
                            let error_str = e.to_string();
                            // TypeScript workflows: don't retry on timeout (should handle retries internally)
                            // YAML workflows: retry on timeout
                            // Other tools: retry on timeout
                            let is_retryable = if is_typescript_workflow {
                                // TypeScript workflows should handle retries internally
                                error_str.contains("401")
                                    || error_str.contains("Unauthorized")
                                    || error_str.contains("500")
                                    || error_str.contains("502")
                                    || error_str.contains("503")
                                    || error_str.contains("504")
                            } else {
                                // YAML workflows and other tools can retry on timeout
                                error_str.contains("401")
                                    || error_str.contains("Unauthorized")
                                    || error_str.contains("500")
                                    || error_str.contains("502")
                                    || error_str.contains("503")
                                    || error_str.contains("504")
                                    || error_str.contains("timeout")
                            };

                            if is_retryable && retry_count < max_retries {
                                retry_count += 1;
                                let delay = Duration::from_secs(2u64.pow(retry_count));
                                eprintln!("⚠️  Tool execution failed: {}. Retrying in {} seconds... (attempt {}/{})",
                                         error_str, delay.as_secs(), retry_count, max_retries);
                                sleep(delay).await;
                                _last_error = Some(e);
                            } else {
                                return Err(e.into());
                            }
                        }
                    }
                };

                // Parse the result content as JSON
                if !result.content.is_empty() {
                    for content in &result.content {
                        if let rmcp::model::RawContent::Text(text) = &content.raw {
                            // Try to parse as JSON
                            if let Ok(json_result) =
                                serde_json::from_str::<serde_json::Value>(&text.text)
                            {
                                service.cancel().await?;

                                return Ok(json_result);
                            }
                        }
                    }
                }

                service.cancel().await?;

                Ok(json!({"status": "unknown", "message": "No parseable result from workflow"}))
            }
            Transport::Stdio(command) => {
                debug!("Starting MCP server: {}", command.join(" "));
                let executable = find_executable(&command[0]).unwrap_or_else(|| command[0].clone());
                let command_args: Vec<String> = if command.len() > 1 {
                    command[1..].to_vec()
                } else {
                    vec![]
                };
                let mut cmd = create_command(&executable, &command_args);

                // Set up logging for the server to capture step progress
                if std::env::var("LOG_LEVEL").is_err() && std::env::var("RUST_LOG").is_err() {
                    if show_progress {
                        // Enable info level logging to see step progress
                        cmd.env("RUST_LOG", "computeruse_mcp_agent=info");
                    } else {
                        cmd.env("LOG_LEVEL", "info");
                    }
                }

                // Enable telemetry if showing progress
                if show_progress {
                    cmd.env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
                    cmd.env("OTEL_SERVICE_NAME", "computeruse-mcp");
                    cmd.env("ENABLE_TELEMETRY", "true");
                }

                // For now, just use the standard transport without stderr parsing
                // TODO: Add proper step streaming once MCP protocol supports it
                let transport = TokioChildProcess::new(cmd)?;
                let service = ().serve(transport).await?;

                let arguments = if let Some(args_str) = args {
                    // Parse workflow to show initial progress
                    if show_progress {
                        if let Ok(workflow) = serde_json::from_str::<serde_json::Value>(&args_str) {
                            if let Some(steps) = workflow.get("steps").and_then(|v| v.as_array()) {
                                let total_steps = steps.len();
                                println!(
                                    "\n{} {} {}",
                                    "🎯".cyan(),
                                    "WORKFLOW START:".bold().cyan(),
                                    format!("{total_steps} steps").dimmed()
                                );

                                // List the steps that will be executed
                                for (i, step) in steps.iter().enumerate() {
                                    let tool_name = step
                                        .get("tool_name")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| step.get("group_name").and_then(|v| v.as_str()))
                                        .unwrap_or("unknown");
                                    let step_id =
                                        step.get("id").and_then(|v| v.as_str()).unwrap_or("");

                                    println!(
                                        "  {} Step {}/{}: {} {}",
                                        "📋".dimmed(),
                                        i + 1,
                                        total_steps,
                                        tool_name.yellow(),
                                        if !step_id.is_empty() {
                                            format!("[{step_id}]").dimmed().to_string()
                                        } else {
                                            String::new()
                                        }
                                    );
                                }
                                println!("\n{} Executing workflow...\n", "⚡".cyan());
                            }
                        }
                    }

                    serde_json::from_str::<serde_json::Value>(&args_str)
                        .ok()
                        .and_then(|v| v.as_object().cloned())
                } else {
                    None
                };

                // Retry logic for tool execution (stdio)
                let mut retry_count = 0;
                let max_retries = if no_retry { 0 } else { 3 };
                let mut _last_error = None;

                // Check if this is a TypeScript workflow (URL ends with .ts or .js)
                let is_typescript_workflow = if tool == "execute_sequence" {
                    arguments
                        .as_ref()
                        .and_then(|args| args.get("url"))
                        .and_then(|url| url.as_str())
                        .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
                        .unwrap_or(false)
                } else {
                    false
                };

                let result = loop {
                    match service
                        .call_tool(CallToolRequestParam {
                            name: tool.clone().into(),
                            arguments: arguments.clone(),
                        })
                        .await
                    {
                        Ok(res) => break res,
                        Err(e) => {
                            let error_str = e.to_string();
                            // TypeScript workflows: don't retry on timeout (should handle retries internally)
                            // YAML workflows: retry on timeout
                            // Other tools: retry on timeout
                            let is_retryable = if is_typescript_workflow {
                                // TypeScript workflows should handle retries internally
                                error_str.contains("401")
                                    || error_str.contains("Unauthorized")
                                    || error_str.contains("500")
                                    || error_str.contains("502")
                                    || error_str.contains("503")
                                    || error_str.contains("504")
                            } else {
                                // YAML workflows and other tools can retry on timeout
                                error_str.contains("401")
                                    || error_str.contains("Unauthorized")
                                    || error_str.contains("500")
                                    || error_str.contains("502")
                                    || error_str.contains("503")
                                    || error_str.contains("504")
                                    || error_str.contains("timeout")
                            };

                            if is_retryable && retry_count < max_retries {
                                retry_count += 1;
                                let delay = Duration::from_secs(2u64.pow(retry_count));
                                eprintln!("⚠️  Tool execution failed: {}. Retrying in {} seconds... (attempt {}/{})",
                                         error_str, delay.as_secs(), retry_count, max_retries);
                                sleep(delay).await;
                                _last_error = Some(e);
                            } else {
                                return Err(e.into());
                            }
                        }
                    }
                };

                // Parse the result content as JSON
                if !result.content.is_empty() {
                    for content in &result.content {
                        if let rmcp::model::RawContent::Text(text) = &content.raw {
                            // Try to parse as JSON
                            if let Ok(json_result) =
                                serde_json::from_str::<serde_json::Value>(&text.text)
                            {
                                service.cancel().await?;

                                return Ok(json_result);
                            }
                        }
                    }
                }

                service.cancel().await?;

                Ok(json!({"status": "unknown", "message": "No parseable result from workflow"}))
            }
        }
    } else {
        // For other tools, just execute normally
        execute_command(transport, tool.clone(), args).await?;
        Ok(json!({"status": "success", "message": format!("Tool {} executed", tool)}))
    }
}

#[cfg(test)]
mod tests {
    // Tests for TypeScript workflow detection and retry logic

    #[test]
    fn test_typescript_workflow_detection() {
        // Test TypeScript workflow detection (URL ends with .ts)
        let args_ts = serde_json::json!({
            "url": "file:///path/to/workflow.ts"
        });
        let args_map_ts = args_ts.as_object().cloned();

        let is_ts = args_map_ts
            .as_ref()
            .and_then(|args| args.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
            .unwrap_or(false);

        assert!(is_ts, "Should detect .ts file as TypeScript workflow");

        // Test JavaScript workflow detection (URL ends with .js)
        let args_js = serde_json::json!({
            "url": "file:///path/to/workflow.js"
        });
        let args_map_js = args_js.as_object().cloned();

        let is_js = args_map_js
            .as_ref()
            .and_then(|args| args.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
            .unwrap_or(false);

        assert!(is_js, "Should detect .js file as JavaScript workflow");

        // Test YAML workflow detection (URL ends with .yml or .yaml)
        let args_yaml = serde_json::json!({
            "url": "file:///path/to/workflow.yml"
        });
        let args_map_yaml = args_yaml.as_object().cloned();

        let is_yaml = args_map_yaml
            .as_ref()
            .and_then(|args| args.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
            .unwrap_or(false);

        assert!(
            !is_yaml,
            "Should NOT detect .yml file as TypeScript workflow"
        );

        // Test no URL provided
        let args_no_url = serde_json::json!({
            "steps": []
        });
        let args_map_no_url = args_no_url.as_object().cloned();

        let is_no_url = args_map_no_url
            .as_ref()
            .and_then(|args| args.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.ends_with(".ts") || url.ends_with(".js"))
            .unwrap_or(false);

        assert!(!is_no_url, "Should return false when no URL provided");
    }

    #[test]
    fn test_retry_logic_for_typescript_workflows() {
        // Test that timeout errors should NOT be retryable for TypeScript workflows
        let error_str = "timeout waiting for element"; // lowercase to match contains() check
        let is_typescript_workflow = true;

        let is_retryable = if is_typescript_workflow {
            // TypeScript workflows should handle retries internally
            error_str.contains("401")
                || error_str.contains("Unauthorized")
                || error_str.contains("500")
                || error_str.contains("502")
                || error_str.contains("503")
                || error_str.contains("504")
        } else {
            // YAML workflows and other tools can retry on timeout
            error_str.contains("401")
                || error_str.contains("Unauthorized")
                || error_str.contains("500")
                || error_str.contains("502")
                || error_str.contains("503")
                || error_str.contains("504")
                || error_str.contains("timeout")
        };

        assert!(
            !is_retryable,
            "TypeScript workflows should NOT retry on timeout errors"
        );

        // Test that HTTP errors ARE retryable for TypeScript workflows
        let error_str_500 = "500 Internal Server Error";

        let is_retryable_500 = if is_typescript_workflow {
            error_str_500.contains("401")
                || error_str_500.contains("Unauthorized")
                || error_str_500.contains("500")
                || error_str_500.contains("502")
                || error_str_500.contains("503")
                || error_str_500.contains("504")
        } else {
            error_str_500.contains("401")
                || error_str_500.contains("Unauthorized")
                || error_str_500.contains("500")
                || error_str_500.contains("502")
                || error_str_500.contains("503")
                || error_str_500.contains("504")
                || error_str_500.contains("timeout")
        };

        assert!(
            is_retryable_500,
            "TypeScript workflows SHOULD retry on HTTP 500 errors"
        );
    }

    #[test]
    fn test_retry_logic_for_yaml_workflows() {
        // Test that timeout errors ARE retryable for YAML workflows
        let error_str = "timeout waiting for element"; // lowercase to match contains() check
        let is_typescript_workflow = false;

        let is_retryable = if is_typescript_workflow {
            error_str.contains("401")
                || error_str.contains("Unauthorized")
                || error_str.contains("500")
                || error_str.contains("502")
                || error_str.contains("503")
                || error_str.contains("504")
        } else {
            error_str.contains("401")
                || error_str.contains("Unauthorized")
                || error_str.contains("500")
                || error_str.contains("502")
                || error_str.contains("503")
                || error_str.contains("504")
                || error_str.contains("timeout")
        };

        assert!(
            is_retryable,
            "YAML workflows SHOULD retry on timeout errors"
        );

        // Test that HTTP errors ARE retryable for YAML workflows
        let error_str_502 = "502 Bad Gateway";

        let is_retryable_502 = if is_typescript_workflow {
            error_str_502.contains("401")
                || error_str_502.contains("Unauthorized")
                || error_str_502.contains("500")
                || error_str_502.contains("502")
                || error_str_502.contains("503")
                || error_str_502.contains("504")
        } else {
            error_str_502.contains("401")
                || error_str_502.contains("Unauthorized")
                || error_str_502.contains("500")
                || error_str_502.contains("502")
                || error_str_502.contains("503")
                || error_str_502.contains("504")
                || error_str_502.contains("timeout")
        };

        assert!(
            is_retryable_502,
            "YAML workflows SHOULD retry on HTTP 502 errors"
        );
    }
}
