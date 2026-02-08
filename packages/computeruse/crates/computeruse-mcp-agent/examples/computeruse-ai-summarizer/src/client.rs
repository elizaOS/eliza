use crate::utils::get_agent_binary_path;
use anyhow::{anyhow, Result};
use rmcp::model::CallToolResult;
use rmcp::transport::ConfigureCommandExt;
use rmcp::transport::TokioChildProcess;
use rmcp::{model::CallToolRequestParam, ServiceExt};
use serde_json::json;
use serde_json::Value;
use tokio::process::Command;
use tracing::debug;

pub async fn get_mcp_tool_result(
    tool_name: String,
    args: Option<serde_json::Map<String, Value>>,
) -> Result<Value> {
    let agent_path = get_agent_binary_path();

    if !agent_path.exists() {
        eprintln!("HELP: Run 'cargo build --bin computeruse-mcp-agent --release' first");
        return Err(anyhow!(format!("ComputerUse MCP agent binary not found at: {:?}. 
                            add 'COMPUTERUSE_AGENT_PATH' env var with the path of computeruse-mcp-agent binary ", agent_path)));
    }

    let transport = ()
        .serve(TokioChildProcess::new(Command::new(agent_path).configure(
            |cmd| {
                cmd.arg("-t").arg("stdio");
            },
        ))?)
        .await?;

    let request = CallToolRequestParam {
        name: std::borrow::Cow::Owned(tool_name.clone()),
        arguments: args,
    };

    let result: CallToolResult = transport.call_tool(request).await?;
    debug!(
        "ComputerUse MCP Tool '{:?}' Result: {:#?}",
        tool_name, &result
    );

    if !result.content.is_empty() {
        if let Some(first_content) = result.content.first() {
            match &first_content.raw {
                rmcp::model::RawContent::Text(raw_text_content) => {
                    let parsed_json: serde_json::Value =
                        serde_json::from_str(&raw_text_content.text)?;

                    let ui_tree = parsed_json
                        .get("ui_tree")
                        .cloned()
                        .ok_or_else(|| anyhow!("missing ui_tree"))?;
                    let focused_window = parsed_json
                        .get("focused_window")
                        .cloned()
                        .ok_or_else(|| anyhow!("missing focused_window"))?;

                    let filtered_result = json!({
                        "ui_tree": ui_tree,
                        "focused_window": focused_window
                    });

                    Ok(filtered_result)
                }
                _ => Err(anyhow!("expected text content in CallToolResult")),
            }
        } else {
            Err(anyhow!("no content in callToolResult"))
        }
    } else {
        Err(anyhow!("no content in callToolResult"))
    }
}
