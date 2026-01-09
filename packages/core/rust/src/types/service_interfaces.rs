//! Service interface definitions for elizaOS
//!
//! This module provides standardized service interface trait definitions that plugins implement.
//! Each trait extends the base Service trait and defines the contract for a specific
//! capability (e.g., transcription, wallet, browser automation).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::{service::Service, service_type, Metadata, Uuid};

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
#[async_trait]
pub trait TokenDataService: Service {
    /// Fetch detailed information for a single token
    async fn get_token_details(&self, address: &str, chain: &str) -> Result<Option<TokenData>, anyhow::Error>;
    
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
#[async_trait]
pub trait WalletService: Service {
    /// Get wallet portfolio
    async fn get_portfolio(&self, owner: Option<&str>) -> Result<WalletPortfolio, anyhow::Error>;
    
    /// Get balance of specific asset
    async fn get_balance(&self, asset_address: &str, owner: Option<&str>) -> Result<f64, anyhow::Error>;
    
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
    pub mint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserve: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
}

/// A standardized representation of a liquidity pool
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub dex: String,
    pub token_a: PoolTokenInfo,
    pub token_b: PoolTokenInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lp_token_mint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tvl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

/// User's position in a liquidity pool
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LpPositionDetails {
    pub pool_id: String,
    pub dex: String,
    pub lp_token_balance: TokenBalance,
    pub underlying_tokens: Vec<TokenBalance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accrued_fees: Option<Vec<TokenBalance>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<Vec<TokenBalance>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

/// Result of a blockchain transaction
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Add liquidity parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLiquidityParams {
    pub pool_id: String,
    pub token_a_amount_lamports: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_b_amount_lamports: Option<String>,
    pub slippage_bps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lower_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_upper_index: Option<i32>,
}

/// Remove liquidity parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLiquidityParams {
    pub pool_id: String,
    pub lp_token_amount_lamports: String,
    pub slippage_bps: u32,
}

/// Liquidity pool service trait
#[async_trait]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_granularities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_timestamps: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_timestamps: Option<bool>,
}

/// A segment of transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub id: u32,
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_logprob: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_speech_prob: Option<f64>,
}

/// A word in transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Result of audio transcription
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<TranscriptionSegment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscriptionWord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Speech-to-text options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechToTextOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interim_results: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_alternatives: Option<u32>,
}

/// Text-to-speech options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextToSpeechOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,
}

/// Voice information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
}

/// Transcription service trait
#[async_trait]
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
    pub format_id: String,
    pub url: String,
    pub extension: String,
    pub quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
}

/// Video information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formats: Option<Vec<VideoFormat>>,
}

/// Video download options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitles: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_subs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_info_json: Option<bool>,
}

/// Video processing options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProcessingOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framerate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
}

/// Video service trait
#[async_trait]
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
    pub width: u32,
    pub height: u32,
}

/// Browser navigation options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<BrowserViewport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
}

/// Screenshot clip region
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotClip {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Screenshot options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_page: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<ScreenshotClip>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omit_background: Option<bool>,
}

/// Element selector
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSelector {
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
}

/// Extracted link
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedLink {
    pub url: String,
    pub text: String,
}

/// Extracted image
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    pub src: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// Extracted content from page
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedContent {
    pub text: String,
    pub html: String,
    pub links: Vec<ExtractedLink>,
    pub images: Vec<ExtractedImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

/// Click options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_for_navigation: Option<bool>,
}

/// Type options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear: Option<bool>,
}

/// Browser service trait
#[async_trait]
pub trait BrowserService: Service {
    /// Navigate to URL
    async fn navigate(
        &self,
        url: &str,
        options: Option<BrowserNavigationOptions>,
    ) -> Result<(), anyhow::Error>;
    
    /// Take screenshot
    async fn screenshot(&self, options: Option<ScreenshotOptions>) -> Result<Vec<u8>, anyhow::Error>;
    
    /// Extract content
    async fn extract_content(&self, selector: Option<&str>) -> Result<ExtractedContent, anyhow::Error>;
    
    /// Click element
    async fn click(&self, selector: &str, options: Option<ClickOptions>) -> Result<(), anyhow::Error>;
    
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
}

/// PDF extraction result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtractionResult {
    pub text: String,
    pub page_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PdfMetadata>,
}

/// PDF margins
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMargins {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<f32>,
}

/// PDF generation options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfGenerationOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margins: Option<PdfMargins>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// PDF conversion options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfConversionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression: Option<bool>,
}

/// PDF service trait
#[async_trait]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
}

/// Search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_range: Option<SearchDateRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_search: Option<String>,
}

/// Search result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relevance_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// Search response
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_results: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_searches: Option<Vec<String>>,
}

/// Page info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub title: String,
    pub description: String,
    pub content: String,
    pub metadata: HashMap<String, String>,
    pub images: Vec<String>,
    pub links: Vec<String>,
}

/// Web search service trait
#[async_trait]
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
    async fn get_trending_searches(&self, region: Option<&str>) -> Result<Vec<String>, anyhow::Error>;
    
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
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Email attachment
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAttachment {
    pub filename: String,
    pub content: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_disposition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

/// Email message
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMessage {
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cc: Option<Vec<EmailAddress>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bcc: Option<Vec<EmailAddress>>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<EmailAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<EmailAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// Email send options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_opens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_clicks: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Email search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSearchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flagged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_attachments: Option<bool>,
}

/// Email folder
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFolder {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub folder_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<EmailFolder>>,
}

/// Email account
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAccount {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<EmailFolder>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_limit: Option<u64>,
}

/// Email service trait
#[async_trait]
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
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Message attachment
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub id: Uuid,
    pub filename: String,
    pub url: String,
    pub mime_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// Message reaction
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReaction {
    pub emoji: String,
    pub count: u32,
    pub users: Vec<Uuid>,
    pub has_reacted: bool,
}

/// Message reference
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    pub message_id: Uuid,
    pub channel_id: Uuid,
    #[serde(rename = "type")]
    pub ref_type: String,
}

/// Message embed field
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedField {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

/// Message embed
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEmbed {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<EmbedField>>,
}

/// Message content
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<MessageReaction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<MessageReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<MessageEmbed>>,
}

/// Message thread info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageThread {
    pub id: Uuid,
    pub message_count: u32,
    pub participants: Vec<Uuid>,
    pub last_message_at: String,
}

/// Message info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInfo {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub sender_id: Uuid,
    pub content: MessageContent,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<MessageThread>,
}

/// Message send options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// Message search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_attachments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Uuid>,
}

/// Channel permissions
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPermissions {
    pub can_send: bool,
    pub can_read: bool,
    pub can_delete: bool,
    pub can_pin: bool,
    pub can_manage: bool,
}

/// Message channel
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannel {
    pub id: Uuid,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<MessageParticipant>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<ChannelPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u32>,
}

/// Messaging service trait
#[async_trait]
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
    pub id: Uuid,
    pub url: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub mime_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
}

/// Post location
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLocation {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_id: Option<String>,
}

/// Post author
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAuthor {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub following_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

/// Post engagement
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostEngagement {
    pub likes: u64,
    pub shares: u64,
    pub comments: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub views: Option<u64>,
    pub has_liked: bool,
    pub has_shared: bool,
    pub has_commented: bool,
    pub has_saved: bool,
}

/// Link preview
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLinkPreview {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// Poll option
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollOption {
    pub text: String,
    pub votes: u64,
}

/// Post poll
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPoll {
    pub question: String,
    pub options: Vec<PollOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiple_choice: Option<bool>,
}

/// Post content
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<PostMedia>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<PostLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<PostLinkPreview>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll: Option<PostPoll>,
}

/// Post thread
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostThread {
    pub id: Uuid,
    pub position: u32,
    pub total: u32,
}

/// Cross-posted info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossPostedInfo {
    pub platform: String,
    pub platform_id: String,
    pub url: String,
}

/// Post info
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostInfo {
    pub id: Uuid,
    pub author: PostAuthor,
    pub content: PostContent,
    pub platform: String,
    pub platform_id: String,
    pub url: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    pub engagement: PostEngagement,
    pub visibility: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<PostThread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_posted: Option<Vec<CrossPostedInfo>>,
}

/// Post create options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreateOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<PostLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_comments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_sharing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

/// Post search options
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSearchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Uuid>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_media: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_location: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
}

/// Demographics data
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemographicsData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<HashMap<String, u64>>,
}

/// Performing hour
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformingHour {
    pub hour: u32,
    pub engagement: u64,
}

/// Post analytics
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAnalytics {
    pub post_id: Uuid,
    pub platform: String,
    pub impressions: u64,
    pub reach: u64,
    pub engagement: PostEngagement,
    pub clicks: u64,
    pub shares: u64,
    pub saves: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demographics: Option<DemographicsData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_performing_hours: Option<Vec<PerformingHour>>,
}

/// Post service trait
#[async_trait]
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

