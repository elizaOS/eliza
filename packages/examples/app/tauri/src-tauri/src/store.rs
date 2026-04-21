use crate::types::ChatMessage;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatStore {
    pub messages: Vec<ChatMessage>,
}

impl ChatStore {
    pub async fn load(path: &PathBuf) -> ChatStore {
        match fs::read_to_string(path).await {
            Ok(text) => serde_json::from_str::<ChatStore>(&text).unwrap_or_default(),
            Err(_) => ChatStore::default(),
        }
    }

    pub async fn save(&self, path: &PathBuf) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let text = serde_json::to_string_pretty(self)?;
        fs::write(path, text).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("eliza-tauri-{}-{}.json", name, unique));
        p
    }

    #[tokio::test]
    async fn save_and_load_roundtrip() {
        let path = tmp_path("chatstore");
        let store = ChatStore {
            messages: vec![ChatMessage {
                id: "1".to_string(),
                role: "user".to_string(),
                text: "hi".to_string(),
                timestamp: 123,
            }],
        };

        store.save(&path).await.unwrap();
        let loaded = ChatStore::load(&path).await;
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].text, "hi");

        let _ = tokio::fs::remove_file(&path).await;
    }
}

