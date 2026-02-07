//! Service interface definitions for elizaOS
//!
//! This module provides standardized service interface trait definitions that plugins implement.
//! Each trait extends the base Service trait and defines the contract for a specific
//! capability (e.g., transcription, wallet, browser automation).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::primitives::{Metadata, UUID};
use super::service::Service;

// Local alias to keep field names aligned with upstream docs/types while using elizaOS's UUID wrapper.
type Uuid = UUID;

// ============================================================================
// Token & Wallet Types
// ============================================================================

/// A standardized representation of a token holding.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalance {
    /// Token mint address or native identifier
    pub address: String,
    /// Raw balance as string for precision
    pub balance: String,
    /// Number of decimal places
    pub decimals: u8,
    /// User-friendly balance
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_amount: Option<f64>,
    /// Token name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Token symbol
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Token logo URI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_uri: Option<String>,
}

/// Generic representation of token data from various services.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenData {
    /// Unique identifier
    pub id: String,
    /// Token symbol
    pub symbol: String,
    /// Token name
    pub name: String,
    /// Contract address
    pub address: String,
    /// Chain identifier (e.g., 'solana', 'ethereum')
    pub chain: String,
    /// Data source provider
    pub source_provider: String,
    /// Current price in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    /// 24h price change percentage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_change_24h_percent: Option<f64>,
    /// 24h price change USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_change_24h_usd: Option<f64>,
    /// 24h trading volume
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_24h_usd: Option<f64>,
    /// Market capitalization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_cap_usd: Option<f64>,
    /// Liquidity in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liquidity: Option<f64>,
    /// Number of holders
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holders: Option<u64>,
    /// Token logo URI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_uri: Option<String>,
    /// Token decimals
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
    /// Last update time (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_at: Option<String>,
    /// Raw provider data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

/// A wallet asset with value information.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletAsset {
    /// Token balance information (flattened into the asset)
    #[serde(flatten)]
    pub token: TokenBalance,
    /// Current price in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<f64>,
    /// Total value in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<f64>,
}

/// Wallet portfolio containing all assets.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPortfolio {
    /// Total portfolio value
    pub total_value_usd: f64,
    /// Portfolio assets
    pub assets: Vec<WalletAsset>,
}

/// Token data service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait TokenDataService: Service {
    /// Fetch detailed information for a single token
    async fn get_token_details(
        &self,
        address: &str,
        chain: &str,
    ) -> Result<Option<TokenData>, anyhow::Error>;

    /// Fetch trending tokens
    async fn get_trending_tokens(
        &self,
        chain: Option<&str>,
        limit: Option<usize>,
        time_period: Option<&str>,
    ) -> Result<Vec<TokenData>, anyhow::Error>;

    /// Search for tokens
    async fn search_tokens(
        &self,
        query: &str,
        chain: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<TokenData>, anyhow::Error>;

    /// Fetch tokens by addresses
    async fn get_tokens_by_addresses(
        &self,
        addresses: &[String],
        chain: &str,
    ) -> Result<Vec<TokenData>, anyhow::Error>;
}

/// Wallet service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait WalletService: Service {
    /// Get wallet portfolio
    async fn get_portfolio(&self, owner: Option<&str>) -> Result<WalletPortfolio, anyhow::Error>;

    /// Get balance of specific asset
    async fn get_balance(
        &self,
        asset_address: &str,
        owner: Option<&str>,
    ) -> Result<f64, anyhow::Error>;

    /// Transfer native tokens
    async fn transfer_sol(
        &self,
        from: &[u8],
        to: &[u8],
        lamports: u64,
    ) -> Result<String, anyhow::Error>;
}

// ============================================================================
// Liquidity Pool Types
// ============================================================================

/// Token information in a pool
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolTokenInfo {
    /// Token mint address
    pub mint: String,
    /// Token symbol
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Token reserve amount in the pool
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserve: Option<String>,
    /// Token decimal places
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
}

/// A standardized representation of a liquidity pool
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolInfo {
    /// Unique identifier for the pool
    pub id: String,
    /// Human-readable display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// DEX/exchange name
    pub dex: String,
    /// First token in the pool pair
    pub token_a: PoolTokenInfo,
    /// Second token in the pool pair
    pub token_b: PoolTokenInfo,
    /// LP token mint address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lp_token_mint: Option<String>,
    /// Annual percentage rate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apr: Option<f64>,
    /// Annual percentage yield
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apy: Option<f64>,
    /// Total value locked in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tvl: Option<f64>,
    /// Trading fee percentage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<f64>,
    /// Additional metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

/// User's position in a liquidity pool
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LpPositionDetails {
    /// Pool identifier
    pub pool_id: String,
    /// DEX/exchange name
    pub dex: String,
    /// LP token balance held
    pub lp_token_balance: TokenBalance,
    /// Underlying tokens in the position
    pub underlying_tokens: Vec<TokenBalance>,
    /// Total value in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<f64>,
    /// Fees earned from the position
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accrued_fees: Option<Vec<TokenBalance>>,
    /// Reward tokens earned
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<Vec<TokenBalance>>,
    /// Additional metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

/// Result of a blockchain transaction
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResult {
    /// Whether the transaction was successful
    pub success: bool,
    /// Transaction ID/hash on the blockchain
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    /// Error message if the transaction failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Additional transaction data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Add liquidity parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLiquidityParams {
    /// Pool identifier
    pub pool_id: String,
    /// Amount of token A in lamports
    pub token_a_amount_lamports: String,
    /// Amount of token B in lamports
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_b_amount_lamports: Option<String>,
    /// Slippage tolerance in basis points
    pub slippage_bps: u32,
    /// Lower tick index for concentrated liquidity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lower_index: Option<i32>,
    /// Upper tick index for concentrated liquidity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_upper_index: Option<i32>,
}

/// Remove liquidity parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLiquidityParams {
    /// Pool identifier
    pub pool_id: String,
    /// Amount of LP tokens to burn in lamports
    pub lp_token_amount_lamports: String,
    /// Slippage tolerance in basis points
    pub slippage_bps: u32,
}

/// Liquidity pool service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait LpService: Service {
    /// Get DEX name
    fn get_dex_name(&self) -> &str;

    /// Get available pools
    async fn get_pools(
        &self,
        token_a_mint: Option<&str>,
        token_b_mint: Option<&str>,
    ) -> Result<Vec<PoolInfo>, anyhow::Error>;

    /// Add liquidity
    async fn add_liquidity(
        &self,
        user_vault: &[u8],
        params: AddLiquidityParams,
    ) -> Result<(TransactionResult, Option<TokenBalance>), anyhow::Error>;

    /// Remove liquidity
    async fn remove_liquidity(
        &self,
        user_vault: &[u8],
        params: RemoveLiquidityParams,
    ) -> Result<(TransactionResult, Option<Vec<TokenBalance>>), anyhow::Error>;

    /// Get LP position details
    async fn get_lp_position_details(
        &self,
        user_account_public_key: &str,
        pool_or_position_identifier: &str,
    ) -> Result<Option<LpPositionDetails>, anyhow::Error>;

    /// Get market data for pools
    async fn get_market_data_for_pools(
        &self,
        pool_ids: &[String],
    ) -> Result<HashMap<String, PoolInfo>, anyhow::Error>;
}

// ============================================================================
// Transcription & Audio Types
// ============================================================================

/// Transcription options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {
    /// Language of the audio
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Model to use for transcription
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Sampling temperature for the model
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Prompt to guide the transcription
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Output format (e.g., "json", "text", "srt")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,
    /// Timestamp granularities to include
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_granularities: Option<Vec<String>>,
    /// Whether to include word-level timestamps
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_timestamps: Option<bool>,
    /// Whether to include segment-level timestamps
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_timestamps: Option<bool>,
}

/// A segment of transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    /// Segment identifier
    pub id: u32,
    /// Transcribed text for this segment
    pub text: String,
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Confidence score for this segment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Token IDs for this segment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<u32>>,
    /// Temperature used for this segment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Average log probability
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_logprob: Option<f64>,
    /// Compression ratio
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression_ratio: Option<f64>,
    /// Probability of no speech in this segment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_speech_prob: Option<f64>,
}

/// A word in transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionWord {
    /// The transcribed word
    pub word: String,
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Confidence score for this word
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Result of audio transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    /// Full transcribed text
    pub text: String,
    /// Detected language
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Audio duration in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Transcription segments with timestamps
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<TranscriptionSegment>>,
    /// Word-level transcription with timestamps
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscriptionWord>>,
    /// Overall confidence score
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Speech-to-text options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechToTextOptions {
    /// Language of the speech
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Model to use for recognition
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Whether to continuously recognize speech
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuous: Option<bool>,
    /// Whether to return interim results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interim_results: Option<bool>,
    /// Maximum number of alternative transcriptions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_alternatives: Option<u32>,
}

/// Text-to-speech options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextToSpeechOptions {
    /// Voice identifier to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// Model to use for synthesis
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Speech speed multiplier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f32>,
    /// Audio format (e.g., "mp3", "wav")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Response format for the API
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,
}

/// Voice information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    /// Voice identifier
    pub id: String,
    /// Display name of the voice
    pub name: String,
    /// Language code of the voice
    pub language: String,
    /// Gender of the voice
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
}

/// Transcription service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait TranscriptionService: Service {
    /// Transcribe audio to text
    async fn transcribe_audio(
        &self,
        audio: &[u8],
        options: Option<TranscriptionOptions>,
    ) -> Result<TranscriptionResult, anyhow::Error>;

    /// Transcribe video to text
    async fn transcribe_video(
        &self,
        video: &[u8],
        options: Option<TranscriptionOptions>,
    ) -> Result<TranscriptionResult, anyhow::Error>;

    /// Speech to text
    async fn speech_to_text(
        &self,
        audio_stream: &[u8],
        options: Option<SpeechToTextOptions>,
    ) -> Result<TranscriptionResult, anyhow::Error>;

    /// Text to speech
    async fn text_to_speech(
        &self,
        text: &str,
        options: Option<TextToSpeechOptions>,
    ) -> Result<Vec<u8>, anyhow::Error>;

    /// Get supported languages
    async fn get_supported_languages(&self) -> Result<Vec<String>, anyhow::Error>;

    /// Get available voices
    async fn get_available_voices(&self) -> Result<Vec<VoiceInfo>, anyhow::Error>;

    /// Detect language
    async fn detect_language(&self, audio: &[u8]) -> Result<String, anyhow::Error>;
}

// ============================================================================
// Video Types
// ============================================================================

/// Video format information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormat {
    /// Format identifier
    pub format_id: String,
    /// Download URL for this format
    pub url: String,
    /// File extension
    pub extension: String,
    /// Quality label (e.g., "1080p", "720p")
    pub quality: String,
    /// File size in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    /// Video codec name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    /// Audio codec name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    /// Resolution (e.g., "1920x1080")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// Frames per second
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<u32>,
    /// Bitrate in bits per second
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
}

/// Video information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// Video URL
    pub url: String,
    /// Video title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Duration in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Thumbnail image URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Video description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Name of the uploader/channel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader: Option<String>,
    /// Number of views
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<u64>,
    /// Upload date (ISO 8601 format)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_date: Option<String>,
    /// Available formats for download
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formats: Option<Vec<VideoFormat>>,
}

/// Video download options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadOptions {
    /// Preferred format ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Preferred quality (e.g., "best", "1080p")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    /// Output file path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    /// Download audio only
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_only: Option<bool>,
    /// Download video only (no audio)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_only: Option<bool>,
    /// Download subtitles
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitles: Option<bool>,
    /// Embed subtitles in the video
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_subs: Option<bool>,
    /// Write video metadata to JSON file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_info_json: Option<bool>,
}

/// Video processing options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProcessingOptions {
    /// Start time for trimming in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    /// End time for trimming in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<f64>,
    /// Output container format
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    /// Target resolution (e.g., "1920x1080")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// Target bitrate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<String>,
    /// Target framerate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framerate: Option<u32>,
    /// Audio codec to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    /// Video codec to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
}

/// Video service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait VideoService: Service {
    /// Get video info
    async fn get_video_info(&self, url: &str) -> Result<VideoInfo, anyhow::Error>;

    /// Download video
    async fn download_video(
        &self,
        url: &str,
        options: Option<VideoDownloadOptions>,
    ) -> Result<String, anyhow::Error>;

    /// Extract audio
    async fn extract_audio(
        &self,
        video_path: &str,
        output_path: Option<&str>,
    ) -> Result<String, anyhow::Error>;

    /// Get thumbnail
    async fn get_thumbnail(
        &self,
        video_path: &str,
        timestamp: Option<f64>,
    ) -> Result<String, anyhow::Error>;

    /// Convert video
    async fn convert_video(
        &self,
        video_path: &str,
        output_path: &str,
        options: Option<VideoProcessingOptions>,
    ) -> Result<String, anyhow::Error>;

    /// Get available formats
    async fn get_available_formats(&self, url: &str) -> Result<Vec<VideoFormat>, anyhow::Error>;
}

// ============================================================================
// Browser Types
// ============================================================================

/// Browser viewport
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    /// Viewport width in pixels
    pub width: u32,
    /// Viewport height in pixels
    pub height: u32,
}

/// Browser navigation options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationOptions {
    /// Navigation timeout in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    /// Wait condition (e.g., "load", "domcontentloaded", "networkidle")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<String>,
    /// Browser viewport size
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<BrowserViewport>,
    /// Custom user agent string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// Custom HTTP headers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
}

/// Screenshot clip region
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotClip {
    /// X coordinate of the clip region
    pub x: u32,
    /// Y coordinate of the clip region
    pub y: u32,
    /// Width of the clip region
    pub width: u32,
    /// Height of the clip region
    pub height: u32,
}

/// Screenshot options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOptions {
    /// Capture full scrollable page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_page: Option<bool>,
    /// Clip region to capture
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<ScreenshotClip>,
    /// Image format (e.g., "png", "jpeg")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Image quality (0-100, for JPEG)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    /// Make background transparent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omit_background: Option<bool>,
}

/// Element selector
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSelector {
    /// CSS selector string
    pub selector: String,
    /// Text content to match
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Timeout for finding the element in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
}

/// Extracted link
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedLink {
    /// URL of the link
    pub url: String,
    /// Link text content
    pub text: String,
}

/// Extracted image
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    /// Image source URL
    pub src: String,
    /// Alternative text for the image
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// Extracted content from page
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedContent {
    /// Plain text content of the page
    pub text: String,
    /// HTML content of the page
    pub html: String,
    /// Links found on the page
    pub links: Vec<ExtractedLink>,
    /// Images found on the page
    pub images: Vec<ExtractedImage>,
    /// Page title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Page metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

/// Click options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickOptions {
    /// Click timeout in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    /// Force click even if element is not visible
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    /// Wait for navigation after clicking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_for_navigation: Option<bool>,
}

/// Type options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeOptions {
    /// Delay between keystrokes in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay: Option<u32>,
    /// Timeout for finding the element in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    /// Clear existing text before typing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear: Option<bool>,
}

/// Browser service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait BrowserService: Service {
    /// Navigate to URL
    async fn navigate(
        &self,
        url: &str,
        options: Option<BrowserNavigationOptions>,
    ) -> Result<(), anyhow::Error>;

    /// Take screenshot
    async fn screenshot(
        &self,
        options: Option<ScreenshotOptions>,
    ) -> Result<Vec<u8>, anyhow::Error>;

    /// Extract content
    async fn extract_content(
        &self,
        selector: Option<&str>,
    ) -> Result<ExtractedContent, anyhow::Error>;

    /// Click element
    async fn click(
        &self,
        selector: &str,
        options: Option<ClickOptions>,
    ) -> Result<(), anyhow::Error>;

    /// Type text
    async fn type_text(
        &self,
        selector: &str,
        text: &str,
        options: Option<TypeOptions>,
    ) -> Result<(), anyhow::Error>;

    /// Wait for element
    async fn wait_for_element(&self, selector: &str) -> Result<(), anyhow::Error>;

    /// Evaluate JavaScript
    async fn evaluate(&self, script: &str) -> Result<serde_json::Value, anyhow::Error>;

    /// Get current URL
    async fn get_current_url(&self) -> Result<String, anyhow::Error>;

    /// Go back
    async fn go_back(&self) -> Result<(), anyhow::Error>;

    /// Go forward
    async fn go_forward(&self) -> Result<(), anyhow::Error>;

    /// Refresh
    async fn refresh(&self) -> Result<(), anyhow::Error>;
}

// ============================================================================
// PDF Types
// ============================================================================

/// PDF metadata
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMetadata {
    /// Document title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Document author
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Creation timestamp (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Last modification timestamp (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
}

/// PDF extraction result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtractionResult {
    /// Extracted text content
    pub text: String,
    /// Total number of pages
    pub page_count: u32,
    /// Document metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PdfMetadata>,
}

/// PDF margins
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMargins {
    /// Top margin in points
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<f32>,
    /// Bottom margin in points
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f32>,
    /// Left margin in points
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<f32>,
    /// Right margin in points
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<f32>,
}

/// PDF generation options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfGenerationOptions {
    /// Page format (e.g., "A4", "Letter")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Page orientation ("portrait" or "landscape")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// Page margins
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margins: Option<PdfMargins>,
    /// Header HTML content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// Footer HTML content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// PDF conversion options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfConversionOptions {
    /// Output quality level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    /// Output format for images
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    /// Whether to compress the output
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression: Option<bool>,
}

/// PDF service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait PdfService: Service {
    /// Extract text from PDF
    async fn extract_text(&self, pdf: &[u8]) -> Result<PdfExtractionResult, anyhow::Error>;

    /// Generate PDF from HTML
    async fn generate_pdf(
        &self,
        html_content: &str,
        options: Option<PdfGenerationOptions>,
    ) -> Result<Vec<u8>, anyhow::Error>;

    /// Convert file to PDF
    async fn convert_to_pdf(
        &self,
        file_path: &str,
        options: Option<PdfConversionOptions>,
    ) -> Result<Vec<u8>, anyhow::Error>;

    /// Merge PDFs
    async fn merge_pdfs(&self, pdfs: &[&[u8]]) -> Result<Vec<u8>, anyhow::Error>;

    /// Split PDF
    async fn split_pdf(&self, pdf: &[u8]) -> Result<Vec<Vec<u8>>, anyhow::Error>;
}

// ============================================================================
// Web Search Types
// ============================================================================

/// Search date range
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDateRange {
    /// Start date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// End date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
}

/// Search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Maximum number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Result offset for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// Language filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Region filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Date range filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_range: Option<SearchDateRange>,
    /// File type filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    /// Site filter (search within a site)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    /// Sort order
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    /// Safe search setting
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_search: Option<String>,
}

/// Search result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Result title
    pub title: String,
    /// Result URL
    pub url: String,
    /// Result description
    pub description: String,
    /// Display-friendly URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
    /// Thumbnail image URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Publication date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    /// Source name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Relevance score
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relevance_score: Option<f64>,
    /// Highlighted snippet from the result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// Search response
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    /// Original search query
    pub query: String,
    /// Search results
    pub results: Vec<SearchResult>,
    /// Total number of results available
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_results: Option<u64>,
    /// Time taken for the search in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_time: Option<f64>,
    /// Query suggestions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<String>>,
    /// Token for fetching the next page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
    /// Related search queries
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_searches: Option<Vec<String>>,
}

/// Page info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// Page title
    pub title: String,
    /// Page description
    pub description: String,
    /// Main content of the page
    pub content: String,
    /// Page metadata
    pub metadata: HashMap<String, String>,
    /// Image URLs found on the page
    pub images: Vec<String>,
    /// Links found on the page
    pub links: Vec<String>,
}

/// Web search service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait WebSearchService: Service {
    /// Perform web search
    async fn search(
        &self,
        query: &str,
        options: Option<SearchOptions>,
    ) -> Result<SearchResponse, anyhow::Error>;

    /// Search news
    async fn search_news(
        &self,
        query: &str,
        options: Option<SearchOptions>,
    ) -> Result<SearchResponse, anyhow::Error>;

    /// Search images
    async fn search_images(
        &self,
        query: &str,
        options: Option<SearchOptions>,
    ) -> Result<SearchResponse, anyhow::Error>;

    /// Search videos
    async fn search_videos(
        &self,
        query: &str,
        options: Option<SearchOptions>,
    ) -> Result<SearchResponse, anyhow::Error>;

    /// Get suggestions
    async fn get_suggestions(&self, query: &str) -> Result<Vec<String>, anyhow::Error>;

    /// Get trending searches
    async fn get_trending_searches(
        &self,
        region: Option<&str>,
    ) -> Result<Vec<String>, anyhow::Error>;

    /// Get page info
    async fn get_page_info(&self, url: &str) -> Result<PageInfo, anyhow::Error>;
}

// ============================================================================
// Email Types
// ============================================================================

/// Email address
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAddress {
    /// Email address
    pub email: String,
    /// Display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Email attachment
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAttachment {
    /// Attachment filename
    pub filename: String,
    /// Attachment content as bytes
    pub content: Vec<u8>,
    /// MIME type of the attachment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Content disposition (inline or attachment)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_disposition: Option<String>,
    /// Content ID for inline attachments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

/// Email message
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMessage {
    /// Sender address
    pub from: EmailAddress,
    /// Recipient addresses
    pub to: Vec<EmailAddress>,
    /// CC recipient addresses
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cc: Option<Vec<EmailAddress>>,
    /// BCC recipient addresses
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bcc: Option<Vec<EmailAddress>>,
    /// Email subject line
    pub subject: String,
    /// Plain text body
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// HTML body
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// File attachments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<EmailAttachment>>,
    /// Reply-to address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<EmailAddress>,
    /// Send date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Message ID header
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Referenced message IDs for threading
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    /// Message ID this is replying to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    /// Email priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// Email send options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSendOptions {
    /// Number of retry attempts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<u32>,
    /// Send timeout in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    /// Track email opens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_opens: Option<bool>,
    /// Track link clicks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_clicks: Option<bool>,
    /// Tags for categorization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Email search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSearchOptions {
    /// Search query string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Filter by sender
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Filter by recipient
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Filter by subject
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// Filter by folder
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Filter by emails since date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// Filter by emails before date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    /// Maximum number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Result offset for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// Filter by unread status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    /// Filter by flagged status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flagged: Option<bool>,
    /// Filter by attachment presence
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_attachments: Option<bool>,
}

/// Email folder
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFolder {
    /// Folder display name
    pub name: String,
    /// Full folder path
    pub path: String,
    /// Folder type (e.g., "inbox", "sent", "drafts")
    #[serde(rename = "type")]
    pub folder_type: String,
    /// Total messages in folder
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    /// Unread message count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u32>,
    /// Child folders
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<EmailFolder>>,
}

/// Email account
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAccount {
    /// Account email address
    pub email: String,
    /// Account display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Email provider name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Account folders
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<EmailFolder>>,
    /// Storage quota used in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_used: Option<u64>,
    /// Storage quota limit in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_limit: Option<u64>,
}

/// Email service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait EmailService: Service {
    /// Send email
    async fn send_email(
        &self,
        message: EmailMessage,
        options: Option<EmailSendOptions>,
    ) -> Result<String, anyhow::Error>;

    /// Get emails
    async fn get_emails(
        &self,
        options: Option<EmailSearchOptions>,
    ) -> Result<Vec<EmailMessage>, anyhow::Error>;

    /// Get email by ID
    async fn get_email(&self, message_id: &str) -> Result<EmailMessage, anyhow::Error>;

    /// Delete email
    async fn delete_email(&self, message_id: &str) -> Result<(), anyhow::Error>;

    /// Mark email as read
    async fn mark_email_as_read(&self, message_id: &str, read: bool) -> Result<(), anyhow::Error>;

    /// Flag email
    async fn flag_email(&self, message_id: &str, flagged: bool) -> Result<(), anyhow::Error>;

    /// Move email
    async fn move_email(&self, message_id: &str, folder_path: &str) -> Result<(), anyhow::Error>;

    /// Get folders
    async fn get_folders(&self) -> Result<Vec<EmailFolder>, anyhow::Error>;

    /// Create folder
    async fn create_folder(
        &self,
        folder_name: &str,
        parent_path: Option<&str>,
    ) -> Result<(), anyhow::Error>;

    /// Get account info
    async fn get_account_info(&self) -> Result<EmailAccount, anyhow::Error>;

    /// Search emails
    async fn search_emails(
        &self,
        query: &str,
        options: Option<EmailSearchOptions>,
    ) -> Result<Vec<EmailMessage>, anyhow::Error>;
}

// ============================================================================
// Messaging Types
// ============================================================================

/// Message participant
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageParticipant {
    /// Unique identifier for the participant
    pub id: Uuid,
    /// Display name
    pub name: String,
    /// Username/handle
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Avatar URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Online status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Message attachment
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    /// Unique identifier for the attachment
    pub id: Uuid,
    /// Original filename
    pub filename: String,
    /// Download URL
    pub url: String,
    /// MIME type of the file
    pub mime_type: String,
    /// File size in bytes
    pub size: u64,
    /// Width in pixels for images/videos
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Height in pixels for images/videos
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Duration in seconds for audio/video
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Thumbnail URL for previews
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// Message reaction
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReaction {
    /// Emoji used for the reaction
    pub emoji: String,
    /// Total number of reactions with this emoji
    pub count: u32,
    /// User IDs who reacted
    pub users: Vec<Uuid>,
    /// Whether the current user has reacted
    pub has_reacted: bool,
}

/// Message reference
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    /// ID of the referenced message
    pub message_id: Uuid,
    /// ID of the channel containing the referenced message
    pub channel_id: Uuid,
    /// Type of reference (e.g., "reply", "forward")
    #[serde(rename = "type")]
    pub ref_type: String,
}

/// Message embed field
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedField {
    /// Field name/title
    pub name: String,
    /// Field value/content
    pub value: String,
    /// Whether to display inline with other fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

/// Message embed
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEmbed {
    /// Title of the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Description text of the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// URL associated with the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Image URL for the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Custom fields within the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<EmbedField>>,
}

/// Message content
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContent {
    /// Plain text content of the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// HTML formatted content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// Markdown formatted content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    /// File attachments included with the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    /// Emoji reactions on the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<MessageReaction>>,
    /// Reference to another message (e.g., reply)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<MessageReference>,
    /// User IDs mentioned in the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    /// Rich embeds included in the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<MessageEmbed>>,
}

/// Message thread info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageThread {
    /// Unique identifier for the thread
    pub id: Uuid,
    /// Total number of messages in the thread
    pub message_count: u32,
    /// User IDs of thread participants
    pub participants: Vec<Uuid>,
    /// ISO 8601 timestamp of the last message in the thread
    pub last_message_at: String,
}

/// Message info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInfo {
    /// Unique identifier for the message
    pub id: Uuid,
    /// ID of the channel containing this message
    pub channel_id: Uuid,
    /// ID of the user who sent the message
    pub sender_id: Uuid,
    /// Content of the message
    pub content: MessageContent,
    /// ISO 8601 timestamp when the message was sent
    pub timestamp: String,
    /// ISO 8601 timestamp when the message was last edited
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<String>,
    /// ISO 8601 timestamp when the message was deleted
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<String>,
    /// Whether the message is pinned
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// Thread information if this message started a thread
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<MessageThread>,
}

/// Message send options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendOptions {
    /// ID of message to reply to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    /// Whether the message is ephemeral (only visible to sender)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    /// Whether to suppress notifications for this message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
    /// ISO 8601 timestamp for scheduled delivery
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,
    /// Thread ID to send the message to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<Uuid>,
    /// Client-generated nonce for deduplication
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// Message search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchOptions {
    /// Text query to search for in messages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Filter by channel ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,
    /// Filter by sender ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<Uuid>,
    /// Return messages before this ISO 8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    /// Return messages after this ISO 8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// Maximum number of messages to return
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Number of messages to skip for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// Filter for messages with attachments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_attachments: Option<bool>,
    /// Filter for pinned messages only
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// Filter for messages mentioning this user ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Uuid>,
}

/// Channel permissions
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPermissions {
    /// Permission to send messages in the channel
    pub can_send: bool,
    /// Permission to read messages in the channel
    pub can_read: bool,
    /// Permission to delete messages in the channel
    pub can_delete: bool,
    /// Permission to pin messages in the channel
    pub can_pin: bool,
    /// Permission to manage channel settings
    pub can_manage: bool,
}

/// Message channel
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannel {
    /// Unique identifier for the channel
    pub id: Uuid,
    /// Display name of the channel
    pub name: String,
    /// Type of channel (e.g., "dm", "group", "public")
    #[serde(rename = "type")]
    pub channel_type: String,
    /// Description of the channel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// List of participants in the channel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<MessageParticipant>>,
    /// User's permissions in this channel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<ChannelPermissions>,
    /// ISO 8601 timestamp of the last message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    /// Total number of messages in the channel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    /// Number of unread messages for the current user
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u32>,
}

/// Messaging service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait MessagingService: Service {
    /// Send message
    async fn send_message(
        &self,
        channel_id: &Uuid,
        content: MessageContent,
        options: Option<MessageSendOptions>,
    ) -> Result<Uuid, anyhow::Error>;

    /// Get messages
    async fn get_messages(
        &self,
        channel_id: &Uuid,
        options: Option<MessageSearchOptions>,
    ) -> Result<Vec<MessageInfo>, anyhow::Error>;

    /// Get message by ID
    async fn get_message(&self, message_id: &Uuid) -> Result<MessageInfo, anyhow::Error>;

    /// Edit message
    async fn edit_message(
        &self,
        message_id: &Uuid,
        content: MessageContent,
    ) -> Result<(), anyhow::Error>;

    /// Delete message
    async fn delete_message(&self, message_id: &Uuid) -> Result<(), anyhow::Error>;

    /// Add reaction
    async fn add_reaction(&self, message_id: &Uuid, emoji: &str) -> Result<(), anyhow::Error>;

    /// Remove reaction
    async fn remove_reaction(&self, message_id: &Uuid, emoji: &str) -> Result<(), anyhow::Error>;

    /// Pin message
    async fn pin_message(&self, message_id: &Uuid) -> Result<(), anyhow::Error>;

    /// Unpin message
    async fn unpin_message(&self, message_id: &Uuid) -> Result<(), anyhow::Error>;

    /// Get channels
    async fn get_channels(&self) -> Result<Vec<MessageChannel>, anyhow::Error>;

    /// Get channel by ID
    async fn get_channel(&self, channel_id: &Uuid) -> Result<MessageChannel, anyhow::Error>;

    /// Create channel
    async fn create_channel(
        &self,
        name: &str,
        channel_type: &str,
        description: Option<&str>,
        participants: Option<&[Uuid]>,
        private: Option<bool>,
    ) -> Result<Uuid, anyhow::Error>;

    /// Search messages
    async fn search_messages(
        &self,
        query: &str,
        options: Option<MessageSearchOptions>,
    ) -> Result<Vec<MessageInfo>, anyhow::Error>;
}

// ============================================================================
// Post/Social Media Types
// ============================================================================

/// Post media
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMedia {
    /// Unique identifier for the media
    pub id: Uuid,
    /// URL where the media is hosted
    pub url: String,
    /// Type of media (e.g., "image", "video", "audio")
    #[serde(rename = "type")]
    pub media_type: String,
    /// MIME type of the media file
    pub mime_type: String,
    /// File size in bytes
    pub size: u64,
    /// Width in pixels for images/videos
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Height in pixels for images/videos
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Duration in seconds for audio/video
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// URL of a thumbnail image
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Description of the media content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Alternative text for accessibility
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
}

/// Post location
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLocation {
    /// Display name of the location
    pub name: String,
    /// Street address of the location
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// Latitude coordinate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    /// Longitude coordinate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    /// Platform-specific place identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_id: Option<String>,
}

/// Post author
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAuthor {
    /// Unique identifier for the author
    pub id: Uuid,
    /// Username/handle of the author
    pub username: String,
    /// Display name of the author
    pub display_name: String,
    /// URL to the author's avatar image
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Whether the author is verified
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    /// Number of followers the author has
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower_count: Option<u64>,
    /// Number of accounts the author follows
    #[serde(skip_serializing_if = "Option::is_none")]
    pub following_count: Option<u64>,
    /// Biography/description of the author
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Author's website URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

/// Post engagement
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostEngagement {
    /// Total number of likes on the post
    pub likes: u64,
    /// Total number of shares/reposts
    pub shares: u64,
    /// Total number of comments
    pub comments: u64,
    /// Total number of views
    #[serde(skip_serializing_if = "Option::is_none")]
    pub views: Option<u64>,
    /// Whether the current user has liked this post
    pub has_liked: bool,
    /// Whether the current user has shared this post
    pub has_shared: bool,
    /// Whether the current user has commented on this post
    pub has_commented: bool,
    /// Whether the current user has saved this post
    pub has_saved: bool,
}

/// Link preview
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLinkPreview {
    /// URL of the linked page
    pub url: String,
    /// Title from the linked page's metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Description from the linked page's metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Preview image URL from the linked page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// Poll option
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollOption {
    /// Display text for the poll option
    pub text: String,
    /// Number of votes for this option
    pub votes: u64,
}

/// Post poll
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPoll {
    /// Question being asked in the poll
    pub question: String,
    /// Available options for the poll
    pub options: Vec<PollOption>,
    /// ISO 8601 timestamp when the poll expires
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Whether users can select multiple options
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiple_choice: Option<bool>,
}

/// Post content
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostContent {
    /// Plain text content of the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// HTML formatted content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// Media attachments (images, videos, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<PostMedia>>,
    /// Location associated with the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<PostLocation>,
    /// Hashtags/tags on the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// User IDs mentioned in the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    /// Link previews for URLs in the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<PostLinkPreview>>,
    /// Poll attached to the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll: Option<PostPoll>,
}

/// Post thread
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostThread {
    /// Unique identifier for the thread
    pub id: Uuid,
    /// Position of this post within the thread (1-indexed)
    pub position: u32,
    /// Total number of posts in the thread
    pub total: u32,
}

/// Cross-posted info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossPostedInfo {
    /// Platform where the post was cross-posted
    pub platform: String,
    /// Platform-specific identifier for the cross-posted version
    pub platform_id: String,
    /// URL to the cross-posted version
    pub url: String,
}

/// Post info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostInfo {
    /// Unique identifier for the post
    pub id: Uuid,
    /// Author of the post
    pub author: PostAuthor,
    /// Content of the post
    pub content: PostContent,
    /// Platform where the post was created
    pub platform: String,
    /// Platform-specific identifier
    pub platform_id: String,
    /// URL to the post
    pub url: String,
    /// ISO 8601 timestamp when the post was created
    pub created_at: String,
    /// ISO 8601 timestamp when the post was last edited
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    /// ISO 8601 timestamp for scheduled posts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    /// Engagement metrics for the post
    pub engagement: PostEngagement,
    /// Visibility setting (e.g., "public", "private", "followers")
    pub visibility: String,
    /// ID of the post this is replying to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    /// Thread information if part of a thread
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<PostThread>,
    /// Information about cross-posted versions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_posted: Option<Vec<CrossPostedInfo>>,
}

/// Post create options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreateOptions {
    /// Platforms to post to (for cross-posting)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    /// ISO 8601 timestamp for scheduled posting
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    /// Visibility setting (e.g., "public", "private", "followers")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    /// ID of post to reply to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    /// Whether to create as part of a thread
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<bool>,
    /// Location to tag on the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<PostLocation>,
    /// Hashtags/tags for the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// User IDs to mention
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    /// Whether to allow comments on the post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_comments: Option<bool>,
    /// Whether to allow sharing/reposting
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_sharing: Option<bool>,
    /// Content warning text
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_warning: Option<String>,
    /// Whether the content is marked as sensitive
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

/// Post search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSearchOptions {
    /// Text query to search for
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Filter by author ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<Uuid>,
    /// Filter by platform
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// Filter by tags/hashtags
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Filter by mentioned user IDs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    /// Return posts since this ISO 8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// Return posts before this ISO 8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    /// Maximum number of posts to return
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Number of posts to skip for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// Filter for posts with media attachments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_media: Option<bool>,
    /// Filter for posts with location data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_location: Option<bool>,
    /// Filter by visibility setting
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    /// Sort order (e.g., "recent", "popular", "engagement")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
}

/// Demographics data
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemographicsData {
    /// Age distribution (age range -> count)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age: Option<HashMap<String, u64>>,
    /// Gender distribution (gender -> count)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<HashMap<String, u64>>,
    /// Geographic distribution (location -> count)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<HashMap<String, u64>>,
}

/// Performing hour
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformingHour {
    /// Hour of day (0-23)
    pub hour: u32,
    /// Total engagement during this hour
    pub engagement: u64,
}

/// Post analytics
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAnalytics {
    /// ID of the post these analytics are for
    pub post_id: Uuid,
    /// Platform the analytics are from
    pub platform: String,
    /// Total number of times the post was shown
    pub impressions: u64,
    /// Number of unique users who saw the post
    pub reach: u64,
    /// Engagement metrics for the post
    pub engagement: PostEngagement,
    /// Number of link clicks
    pub clicks: u64,
    /// Number of shares/reposts
    pub shares: u64,
    /// Number of times the post was saved
    pub saves: u64,
    /// Demographic breakdown of engaged users
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demographics: Option<DemographicsData>,
    /// Hours with highest engagement
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_performing_hours: Option<Vec<PerformingHour>>,
}

/// Post service trait
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait PostService: Service {
    /// Create post
    async fn create_post(
        &self,
        content: PostContent,
        options: Option<PostCreateOptions>,
    ) -> Result<Uuid, anyhow::Error>;

    /// Get posts
    async fn get_posts(
        &self,
        options: Option<PostSearchOptions>,
    ) -> Result<Vec<PostInfo>, anyhow::Error>;

    /// Get post by ID
    async fn get_post(&self, post_id: &Uuid) -> Result<PostInfo, anyhow::Error>;

    /// Edit post
    async fn edit_post(&self, post_id: &Uuid, content: PostContent) -> Result<(), anyhow::Error>;

    /// Delete post
    async fn delete_post(&self, post_id: &Uuid) -> Result<(), anyhow::Error>;

    /// Like/unlike post
    async fn like_post(&self, post_id: &Uuid, like: bool) -> Result<(), anyhow::Error>;

    /// Share post
    async fn share_post(
        &self,
        post_id: &Uuid,
        comment: Option<&str>,
    ) -> Result<Uuid, anyhow::Error>;

    /// Save/unsave post
    async fn save_post(&self, post_id: &Uuid, save: bool) -> Result<(), anyhow::Error>;

    /// Comment on post
    async fn comment_on_post(
        &self,
        post_id: &Uuid,
        content: PostContent,
    ) -> Result<Uuid, anyhow::Error>;

    /// Get comments
    async fn get_comments(
        &self,
        post_id: &Uuid,
        options: Option<PostSearchOptions>,
    ) -> Result<Vec<PostInfo>, anyhow::Error>;

    /// Schedule post
    async fn schedule_post(
        &self,
        content: PostContent,
        scheduled_at: &str,
        options: Option<PostCreateOptions>,
    ) -> Result<Uuid, anyhow::Error>;

    /// Get post analytics
    async fn get_post_analytics(&self, post_id: &Uuid) -> Result<PostAnalytics, anyhow::Error>;

    /// Get trending posts
    async fn get_trending_posts(
        &self,
        options: Option<PostSearchOptions>,
    ) -> Result<Vec<PostInfo>, anyhow::Error>;

    /// Search posts
    async fn search_posts(
        &self,
        query: &str,
        options: Option<PostSearchOptions>,
    ) -> Result<Vec<PostInfo>, anyhow::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_balance_serialization() {
        let balance = TokenBalance {
            address: "So11111111111111111111111111111111111111112".to_string(),
            balance: "1000000000".to_string(),
            decimals: 9,
            ui_amount: Some(1.0),
            name: Some("Wrapped SOL".to_string()),
            symbol: Some("SOL".to_string()),
            logo_uri: None,
        };

        let json = serde_json::to_string(&balance).unwrap();
        assert!(json.contains("\"address\":\"So11111111111111111111111111111111111111112\""));
        assert!(json.contains("\"uiAmount\":1.0"));
    }

    #[test]
    fn test_wallet_portfolio_serialization() {
        let portfolio = WalletPortfolio {
            total_value_usd: 1000.0,
            assets: vec![],
        };

        let json = serde_json::to_string(&portfolio).unwrap();
        assert!(json.contains("\"totalValueUsd\":1000.0"));
    }
}
