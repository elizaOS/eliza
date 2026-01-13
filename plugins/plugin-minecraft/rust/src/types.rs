use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MinecraftConfig {
    pub server_port: u16,
}

impl Default for MinecraftConfig {
    fn default() -> Self {
        Self { server_port: 3457 }
    }
}

