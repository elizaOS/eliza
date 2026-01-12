#![allow(missing_docs)]

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TranscriptionParams};

pub async fn handle_transcription(
    config: ElizaCloudConfig,
    params: TranscriptionParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.transcribe_audio(params).await
}
