use crate::types::{ComputerUseConfig, ComputerUseMode};
use anyhow::Result;
use computeruse_rs::Desktop;
use elizaos_plugin_mcp::types::StdioServerConfig;
use elizaos_plugin_mcp::{McpClient, StdioTransport, Transport};
use serde_json::{json, Value};
use std::env;
use tracing::info;

pub struct ComputerUsePlugin {
    pub name: String,
    pub description: String,
    pub config: ComputerUseConfig,
    desktop: Option<Desktop>,
    mcp: Option<McpClient>,
    backend: Option<&'static str>,
}

impl ComputerUsePlugin {
    pub fn new(config: ComputerUseConfig) -> Self {
        Self {
            name: "plugin-computeruse".to_string(),
            description: "Computer automation plugin (local or MCP)".to_string(),
            config,
            desktop: None,
            mcp: None,
            backend: None,
        }
    }

    pub async fn init(&mut self) -> Result<()> {
        info!("Initializing computeruse plugin (rust)");

        // Env overrides (mirrors TS behavior)
        if let Ok(v) = env::var("COMPUTERUSE_ENABLED") {
            self.config.enabled = v.trim().eq_ignore_ascii_case("true");
        }
        if let Ok(v) = env::var("COMPUTERUSE_MODE") {
            self.config.mode = match v.as_str() {
                "local" => ComputerUseMode::Local,
                "mcp" => ComputerUseMode::Mcp,
                _ => ComputerUseMode::Auto,
            };
        }
        if let Ok(v) = env::var("COMPUTERUSE_MCP_COMMAND") {
            if !v.trim().is_empty() {
                self.config.mcp_command = v;
            }
        }
        if let Ok(v) = env::var("COMPUTERUSE_MCP_ARGS") {
            // Space-separated list for simplicity.
            let args = v
                .split_whitespace()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            if !args.is_empty() {
                self.config.mcp_args = args;
            }
        }

        if !self.config.enabled {
            info!("computeruse disabled (COMPUTERUSE_ENABLED=false)");
            return Ok(());
        }

        match self.config.mode {
            ComputerUseMode::Local => {
                self.ensure_local()?;
                self.backend = Some("local");
            }
            ComputerUseMode::Mcp => {
                self.ensure_mcp().await?;
                self.backend = Some("mcp");
            }
            ComputerUseMode::Auto => {
                // Try local mode on all platforms, fall back to MCP
                if self.ensure_local().is_ok() {
                    self.backend = Some("local");
                } else {
                    self.ensure_mcp().await?;
                    self.backend = Some("mcp");
                }
            }
        }

        info!(
            "computeruse plugin initialized (backend={})",
            self.backend.unwrap_or("none")
        );
        Ok(())
    }

    pub async fn stop(&mut self) {
        info!("Stopping computeruse plugin (rust)");
        if let Some(mut mcp) = self.mcp.take() {
            let _ = mcp.close().await;
        }
        self.desktop = None;
        self.backend = None;
    }

    pub fn backend(&self) -> Option<&'static str> {
        self.backend
    }

    fn ensure_local(&mut self) -> Result<()> {
        if self.desktop.is_none() {
            self.desktop = Some(Desktop::new_default()?);
        }
        Ok(())
    }

    async fn ensure_mcp(&mut self) -> Result<()> {
        if self.mcp.is_some() {
            return Ok(());
        }

        let transport: Box<dyn Transport> = Box::new(StdioTransport::new(StdioServerConfig {
            command: self.config.mcp_command.clone(),
            args: self.config.mcp_args.clone(),
            env: std::collections::HashMap::new(),
            cwd: None,
            timeout_ms: 60000,
        }));
        let mut client = McpClient::new(transport);
        client.connect().await?;
        self.mcp = Some(client);
        Ok(())
    }

    fn mcp_mut(&mut self) -> Result<&mut McpClient> {
        self.mcp
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("MCP client not initialized"))
    }

    /// Handle an action using a JSON arguments object.
    ///
    /// Expected action names:
    /// - COMPUTERUSE_OPEN_APPLICATION: { "name": "calc" }
    /// - COMPUTERUSE_CLICK: { "process": "notepad", "selector": "role:Button|name:Save", "timeoutMs": 5000 }
    /// - COMPUTERUSE_TYPE: { "process": "notepad", "selector": "role:Edit|name:Search", "text": "...", "timeoutMs": 5000, "clearBeforeTyping": true }
    /// - COMPUTERUSE_GET_WINDOW_TREE: { "process": "notepad", "title": "Untitled", "maxDepth": 6 }
    /// - COMPUTERUSE_GET_APPLICATIONS: {}
    pub async fn handle_action(&mut self, action_name: &str, args: Value) -> Result<Value> {
        if !self.config.enabled {
            return Ok(json!({ "success": false, "error": "ComputerUse disabled" }));
        }

        match (self.backend, action_name) {
            (Some("local"), "COMPUTERUSE_OPEN_APPLICATION") => {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing name"))?;
                let desktop = self
                    .desktop
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("No desktop"))?;
                let _ = desktop.open_application(name)?;
                Ok(json!({ "success": true }))
            }
            (Some("local"), "COMPUTERUSE_CLICK") => {
                let selector = args
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing selector"))?;
                let timeout_ms = args
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(5000);
                let desktop = self
                    .desktop
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("No desktop"))?;
                let el = desktop
                    .locator(selector)
                    .first(Some(std::time::Duration::from_millis(timeout_ms)))
                    .await?;
                let _ = el.click()?;
                Ok(json!({ "success": true }))
            }
            (Some("local"), "COMPUTERUSE_TYPE") => {
                let selector = args
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing selector"))?;
                let text = args
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing text"))?;
                let timeout_ms = args
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(5000);
                let clear = args
                    .get("clearBeforeTyping")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let desktop = self
                    .desktop
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("No desktop"))?;
                let el = desktop
                    .locator(selector)
                    .first(Some(std::time::Duration::from_millis(timeout_ms)))
                    .await?;
                // Local API uses element.type_text(text, use_clipboard, try_focus_before, try_click_before, restore_focus)
                if clear {
                    el.set_value("")?;
                }
                el.type_text(text, false)?;
                Ok(json!({ "success": true }))
            }
            (Some("local"), "COMPUTERUSE_GET_APPLICATIONS") => {
                let desktop = self
                    .desktop
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("No desktop"))?;
                let apps = desktop.applications()?;
                let names = apps
                    .into_iter()
                    .filter_map(|a| a.name())
                    .collect::<Vec<_>>();
                Ok(json!({ "success": true, "apps": names }))
            }
            (Some("local"), "COMPUTERUSE_GET_WINDOW_TREE") => {
                let process = args
                    .get("process")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing process"))?;
                let title = args.get("title").and_then(|v| v.as_str());
                let max_depth = args.get("maxDepth").and_then(|v| v.as_u64());

                let desktop = self
                    .desktop
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("No desktop"))?;
                let pid = computeruse_rs::find_pid_for_process(desktop, process)?;
                let tree_config = max_depth.map(|d| computeruse_rs::TreeBuildConfig {
                    max_depth: Some(d as usize),
                    ..Default::default()
                });
                let tree = desktop.get_window_tree(pid, title, tree_config)?;
                Ok(json!({ "success": true, "process": process, "pid": pid, "tree": tree }))
            }

            (Some("mcp"), "COMPUTERUSE_OPEN_APPLICATION") => {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing name"))?;
                let result = self
                    .mcp_mut()?
                    .call_tool(
                        "open_application",
                        json!({
                            "app_name": name,
                            "verify_element_exists": "",
                            "verify_element_not_exists": "",
                            "include_tree_after_action": false
                        }),
                    )
                    .await?;
                Ok(serde_json::to_value(result)?)
            }
            (Some("mcp"), "COMPUTERUSE_CLICK") => {
                let selector = args
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing selector"))?;
                let process = args.get("process").and_then(|v| v.as_str());
                let timeout_ms = args
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(5000);
                let (proc, sel) = parse_process_scoped_selector(selector, process)?;
                let result = self
                    .mcp_mut()?
                    .call_tool(
                        "click_element",
                        json!({
                            "process": proc,
                            "selector": sel,
                            "timeout_ms": timeout_ms,
                            "verify_element_exists": "",
                            "verify_element_not_exists": "",
                            "highlight_before_action": false,
                            "ui_diff_before_after": false
                        }),
                    )
                    .await?;
                Ok(serde_json::to_value(result)?)
            }
            (Some("mcp"), "COMPUTERUSE_TYPE") => {
                let selector = args
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing selector"))?;
                let process = args.get("process").and_then(|v| v.as_str());
                let text = args
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing text"))?;
                let timeout_ms = args
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(5000);
                let clear = args
                    .get("clearBeforeTyping")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let (proc, sel) = parse_process_scoped_selector(selector, process)?;
                let result = self
                    .mcp_mut()?
                    .call_tool(
                        "type_into_element",
                        json!({
                            "process": proc,
                            "selector": sel,
                            "text_to_type": text,
                            "timeout_ms": timeout_ms,
                            "clear_before_typing": clear,
                            "highlight_before_action": false,
                            "ui_diff_before_after": false
                        }),
                    )
                    .await?;
                Ok(serde_json::to_value(result)?)
            }
            (Some("mcp"), "COMPUTERUSE_GET_APPLICATIONS") => {
                let result = self
                    .mcp_mut()?
                    .call_tool("get_applications_and_windows_list", json!({}))
                    .await?;
                Ok(serde_json::to_value(result)?)
            }
            (Some("mcp"), "COMPUTERUSE_GET_WINDOW_TREE") => {
                let process = args
                    .get("process")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing process"))?;
                let title = args.get("title").and_then(|v| v.as_str());
                let max_depth = args.get("maxDepth").and_then(|v| v.as_u64());

                let result = self
                    .mcp_mut()?
                    .call_tool(
                        "get_window_tree",
                        json!({
                            "process": process,
                            "title": title,
                            "include_tree_after_action": true,
                            "tree_max_depth": max_depth
                        }),
                    )
                    .await?;
                Ok(serde_json::to_value(result)?)
            }

            _ => {
                Ok(json!({ "success": false, "error": format!("Unknown action: {}", action_name) }))
            }
        }
    }
}

pub fn create_computeruse_plugin(config: Option<ComputerUseConfig>) -> ComputerUsePlugin {
    ComputerUsePlugin::new(config.unwrap_or_default())
}

fn parse_process_scoped_selector(
    raw_selector: &str,
    process_hint: Option<&str>,
) -> Result<(String, String)> {
    let selector = raw_selector.trim();
    let re = regex::Regex::new(r"^\s*process:(?P<process>[^\s>]+)\s*(?:>>\s*(?P<sel>.*))?$")?;
    if let Some(caps) = re.captures(selector) {
        let process = caps
            .name("process")
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if process.is_empty() {
            anyhow::bail!(
                "Missing process. Provide args.process or prefix selector with 'process:<name> >> ...'"
            );
        }
        let sel = caps
            .name("sel")
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        return Ok((process, sel));
    }
    let process = process_hint
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Missing process. Provide args.process or prefix selector with 'process:<name> >> ...'"
            )
        })?;
    Ok((process, selector.to_string()))
}

#[cfg(test)]
mod tests {
    use super::parse_process_scoped_selector;

    #[test]
    fn parses_process_prefix() {
        let (proc, sel) =
            parse_process_scoped_selector("process:notepad >> role:Button|name:Save", None)
                .unwrap();
        assert_eq!(proc, "notepad");
        assert_eq!(sel, "role:Button|name:Save");
    }

    #[test]
    fn uses_process_hint_when_no_prefix() {
        let (proc, sel) =
            parse_process_scoped_selector("role:Button|name:Save", Some("notepad")).unwrap();
        assert_eq!(proc, "notepad");
        assert_eq!(sel, "role:Button|name:Save");
    }

    #[test]
    fn errors_when_process_missing() {
        let err = parse_process_scoped_selector("role:Button|name:Save", None).unwrap_err();
        assert!(err.to_string().contains("Missing process"));
    }
}
