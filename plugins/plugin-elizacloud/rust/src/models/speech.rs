#![allow(missing_docs)]
//! Text-to-speech model handler.

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextToSpeechParams};

/// Handle TEXT_TO_SPEECH model generation.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Text-to-speech parameters
///
/// # Returns
///
/// Audio data as bytes.
pub async fn handle_text_to_speech(
    config: ElizaCloudConfig,
    params: TextToSpeechParams,
) -> Result<Vec<u8>> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_speech(params).await
}







