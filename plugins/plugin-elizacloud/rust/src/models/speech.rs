#![allow(missing_docs)]

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextToSpeechParams};

pub async fn handle_text_to_speech(
    config: ElizaCloudConfig,
    params: TextToSpeechParams,
) -> Result<Vec<u8>> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_speech(params).await
}
