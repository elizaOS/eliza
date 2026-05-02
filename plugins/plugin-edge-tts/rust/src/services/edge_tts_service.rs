//! Edge TTS service – synthesizes speech via the Microsoft Edge WebSocket endpoint.

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::types::{escape_xml, resolve_voice, speed_to_rate};
use crate::types::{
    AudioOptions, EdgeTTSError, EdgeTTSParams, EdgeTTSSettings, MetadataOptions, SpeechConfig,
    SpeechConfigContext, SynthesisOptions, MAX_TEXT_LENGTH,
};

/// Speech synthesis via the Edge TTS WebSocket service. No API key required.
pub struct EdgeTTSService {
    settings: EdgeTTSSettings,
}

impl Default for EdgeTTSService {
    fn default() -> Self {
        Self::new()
    }
}

impl EdgeTTSService {
    const WS_URL: &'static str =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

    const TRUSTED_CLIENT_TOKEN: &'static str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

    const USER_AGENT: &'static str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
        AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

    /// Create with settings loaded from `EDGE_TTS_*` environment variables.
    pub fn new() -> Self {
        Self {
            settings: EdgeTTSSettings::from_env(),
        }
    }

    /// Create with explicit settings.
    pub fn with_settings(settings: EdgeTTSSettings) -> Self {
        Self { settings }
    }

    /// Returns a reference to the current TTS settings.
    pub fn settings(&self) -> &EdgeTTSSettings {
        &self.settings
    }

    /// Synthesize speech from text using the service's default settings.
    pub async fn text_to_speech(&self, text: &str) -> Result<Bytes, EdgeTTSError> {
        self.text_to_speech_with_params(&EdgeTTSParams {
            text: text.to_string(),
            ..Default::default()
        })
        .await
    }

    /// Synthesize speech with explicit per-call parameters.
    pub async fn text_to_speech_with_params(
        &self,
        params: &EdgeTTSParams,
    ) -> Result<Bytes, EdgeTTSError> {
        if params.text.is_empty() || params.text.trim().is_empty() {
            return Err(EdgeTTSError::InvalidInput(
                "Text must not be empty".to_string(),
            ));
        }
        if params.text.len() > MAX_TEXT_LENGTH {
            return Err(EdgeTTSError::InvalidInput(format!(
                "Text exceeds {} character limit",
                MAX_TEXT_LENGTH
            )));
        }

        let voice = resolve_voice(params.voice.as_deref(), &self.settings.voice);
        let lang = params.lang.as_deref().unwrap_or(&self.settings.lang);
        let output_format = params
            .output_format
            .as_deref()
            .unwrap_or(&self.settings.output_format);

        let speed_rate_str = speed_to_rate(params.speed);
        let rate = params
            .rate
            .as_deref()
            .or(speed_rate_str.as_deref())
            .or(self.settings.rate.as_deref())
            .unwrap_or("+0%");
        let pitch = params
            .pitch
            .as_deref()
            .or(self.settings.pitch.as_deref())
            .unwrap_or("+0Hz");
        let volume = params
            .volume
            .as_deref()
            .or(self.settings.volume.as_deref())
            .unwrap_or("+0%");

        let conn_id = Uuid::new_v4().to_string().replace('-', "");
        let url = format!(
            "{}?TrustedClientToken={}&ConnectionId={}",
            Self::WS_URL,
            Self::TRUSTED_CLIENT_TOKEN,
            conn_id
        );

        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| EdgeTTSError::Connection(e.to_string()))?;

        request.headers_mut().insert(
            HeaderName::from_static("origin"),
            HeaderValue::from_static("https://speech.platform.bing.com"),
        );
        request.headers_mut().insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_str(Self::USER_AGENT)
                .map_err(|e| EdgeTTSError::Connection(e.to_string()))?,
        );

        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| EdgeTTSError::Connection(e.to_string()))?;

        let (mut write, mut read) = ws_stream.split();

        let config = SpeechConfig {
            context: SpeechConfigContext {
                synthesis: SynthesisOptions {
                    audio: AudioOptions {
                        metadata_options: MetadataOptions {
                            sentence_boundary_enabled: "false".to_string(),
                            word_boundary_enabled: "false".to_string(),
                        },
                        output_format: output_format.to_string(),
                    },
                },
            },
        };
        let config_json = serde_json::to_string(&config)?;
        let config_msg = format!(
            "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{}",
            config_json
        );

        write
            .send(Message::Text(config_msg))
            .await
            .map_err(|e| EdgeTTSError::WebSocket(e.to_string()))?;

        let escaped_text = escape_xml(&params.text);
        let request_id = Uuid::new_v4().to_string().replace('-', "");
        let ssml_msg = format!(
            "X-RequestId:{request_id}\r\n\
             Content-Type:application/ssml+xml\r\n\
             Path:ssml\r\n\r\n\
             <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>\
             <voice name='{voice}'>\
             <prosody rate='{rate}' pitch='{pitch}' volume='{volume}'>\
             {escaped_text}\
             </prosody></voice></speak>"
        );

        write
            .send(Message::Text(ssml_msg))
            .await
            .map_err(|e| EdgeTTSError::WebSocket(e.to_string()))?;

        let mut audio_data: Vec<u8> = Vec::new();

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if text.contains("Path:turn.end") {
                        break;
                    }
                }
                Ok(Message::Binary(data)) => {
                    if data.len() >= 2 {
                        let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                        let header_end = 2 + header_len;
                        if header_end <= data.len() {
                            let header = String::from_utf8_lossy(&data[2..header_end]);
                            if header.contains("Path:audio") {
                                audio_data.extend_from_slice(&data[header_end..]);
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    return Err(EdgeTTSError::WebSocket(e.to_string()));
                }
                _ => {}
            }
        }

        if audio_data.is_empty() {
            return Err(EdgeTTSError::EmptyResponse);
        }

        Ok(Bytes::from(audio_data))
    }
}
