//! Audio transcription model handler.

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TranscriptionParams};

/// Handle TRANSCRIPTION model.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Transcription parameters
///
/// # Returns
///
/// Transcribed text.
pub async fn handle_transcription(
    config: ElizaCloudConfig,
    params: TranscriptionParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.transcribe_audio(params).await
}

