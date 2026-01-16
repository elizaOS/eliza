use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderMode {
    ElizaClassic,
    OpenAI,
    XAI,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub openai_api_key: String,
    pub openai_base_url: String,
    pub openai_small_model: String,
    pub openai_large_model: String,

    pub xai_api_key: String,
    pub xai_base_url: String,
    pub xai_small_model: String,
    pub xai_large_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub mode: ProviderMode,
    pub provider: ProviderSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            mode: ProviderMode::ElizaClassic,
            provider: ProviderSettings {
                openai_api_key: String::new(),
                openai_base_url: "https://api.openai.com/v1".to_string(),
                openai_small_model: "gpt-5-mini".to_string(),
                openai_large_model: "gpt-5".to_string(),

                xai_api_key: String::new(),
                xai_base_url: "https://api.x.ai/v1".to_string(),
                xai_small_model: "grok-3-mini".to_string(),
                xai_large_model: "grok-3".to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: i64,
}

pub fn effective_mode(cfg: &AppConfig) -> ProviderMode {
    match cfg.mode {
        ProviderMode::ElizaClassic => ProviderMode::ElizaClassic,
        ProviderMode::OpenAI => {
            if cfg.provider.openai_api_key.trim().is_empty() {
                ProviderMode::ElizaClassic
            } else {
                ProviderMode::OpenAI
            }
        }
        ProviderMode::XAI => {
            if cfg.provider.xai_api_key.trim().is_empty() {
                ProviderMode::ElizaClassic
            } else {
                ProviderMode::XAI
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_mode_falls_back_without_credentials() {
        let mut cfg = AppConfig::default();

        cfg.mode = ProviderMode::OpenAI;
        cfg.provider.openai_api_key = "".to_string();
        assert_eq!(effective_mode(&cfg), ProviderMode::ElizaClassic);

        cfg.mode = ProviderMode::XAI;
        cfg.provider.xai_api_key = "".to_string();
        assert_eq!(effective_mode(&cfg), ProviderMode::ElizaClassic);
    }

    #[test]
    fn effective_mode_respects_credentials() {
        let mut cfg = AppConfig::default();

        cfg.mode = ProviderMode::OpenAI;
        cfg.provider.openai_api_key = "k".to_string();
        assert_eq!(effective_mode(&cfg), ProviderMode::OpenAI);

        cfg.mode = ProviderMode::XAI;
        cfg.provider.xai_api_key = "k".to_string();
        assert_eq!(effective_mode(&cfg), ProviderMode::XAI);
    }
}

