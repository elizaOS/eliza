use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ComputerUseMode {
    #[default]
    Auto,
    Local,
    Mcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerUseConfig {
    pub enabled: bool,
    pub mode: ComputerUseMode,
    /// MCP command for stdio transport (default: npx)
    pub mcp_command: String,
    /// MCP args for stdio transport (default: -y computeruse-mcp-agent@latest)
    pub mcp_args: Vec<String>,
}

impl Default for ComputerUseConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ComputerUseMode::Auto,
            mcp_command: "npx".to_string(),
            mcp_args: vec!["-y".to_string(), "computeruse-mcp-agent@latest".to_string()],
        }
    }
}
