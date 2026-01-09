"""
Service interface definitions for elizaOS.

This module provides standardized service interface definitions that plugins implement.
Each interface extends the base Service class and defines the contract for a specific
capability (e.g., transcription, wallet, browser automation).
"""

from __future__ import annotations

from abc import abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from pydantic import BaseModel, Field

from elizaos.types.service import Service, ServiceType

if TYPE_CHECKING:
    from io import BufferedReader

# ============================================================================
# Token & Wallet Interfaces
# ============================================================================


class TokenBalance(BaseModel):
    """A standardized representation of a token holding."""

    address: str = Field(..., description="Token mint address or native identifier")
    balance: str = Field(..., description="Raw balance as string for precision")
    decimals: int = Field(..., description="Number of decimal places")
    ui_amount: float | None = Field(None, description="User-friendly balance")
    name: str | None = Field(None, description="Token name")
    symbol: str | None = Field(None, description="Token symbol")
    logo_uri: str | None = Field(None, description="Token logo URI")


class TokenData(BaseModel):
    """Generic representation of token data from various services."""

    id: str = Field(..., description="Unique identifier")
    symbol: str = Field(..., description="Token symbol")
    name: str = Field(..., description="Token name")
    address: str = Field(..., description="Contract address")
    chain: str = Field(..., description="Chain identifier")
    source_provider: str = Field(..., description="Data source provider")

    price: float | None = Field(None, description="Current price in USD")
    price_change_24h_percent: float | None = Field(None, description="24h price change %")
    price_change_24h_usd: float | None = Field(None, description="24h price change USD")

    volume_24h_usd: float | None = Field(None, description="24h trading volume")
    market_cap_usd: float | None = Field(None, description="Market capitalization")

    liquidity: float | None = Field(None, description="Liquidity in USD")
    holders: int | None = Field(None, description="Number of holders")

    logo_uri: str | None = Field(None, description="Token logo URI")
    token_decimals: int | None = Field(None, description="Token decimals")

    last_updated_at: datetime | None = Field(None, description="Last update time")
    raw: dict[str, Any] | None = Field(None, description="Raw provider data")


class WalletAsset(TokenBalance):
    """A wallet asset with value information."""

    price_usd: float | None = Field(None, description="Current price in USD")
    value_usd: float | None = Field(None, description="Total value in USD")


class WalletPortfolio(BaseModel):
    """Wallet portfolio containing all assets."""

    total_value_usd: float = Field(..., description="Total portfolio value")
    assets: list[WalletAsset] = Field(default_factory=list, description="Portfolio assets")


class ITokenDataService(Service):
    """Interface for token data services."""

    service_type: ClassVar[str] = ServiceType.TOKEN_DATA

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to token market data."

    @abstractmethod
    async def get_token_details(self, address: str, chain: str) -> TokenData | None:
        """Fetch detailed information for a single token."""
        ...

    @abstractmethod
    async def get_trending_tokens(
        self, chain: str | None = None, limit: int | None = None, time_period: str | None = None
    ) -> list[TokenData]:
        """Fetch a list of trending tokens."""
        ...

    @abstractmethod
    async def search_tokens(
        self, query: str, chain: str | None = None, limit: int | None = None
    ) -> list[TokenData]:
        """Search for tokens based on a query string."""
        ...

    @abstractmethod
    async def get_tokens_by_addresses(self, addresses: list[str], chain: str) -> list[TokenData]:
        """Fetch data for multiple tokens by their addresses."""
        ...


class IWalletService(Service):
    """Interface for wallet services."""

    service_type: ClassVar[str] = ServiceType.WALLET

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to wallet balances and portfolios."

    @abstractmethod
    async def get_portfolio(self, owner: str | None = None) -> WalletPortfolio:
        """Retrieve the entire portfolio of assets held by the wallet."""
        ...

    @abstractmethod
    async def get_balance(self, asset_address: str, owner: str | None = None) -> float:
        """Retrieve the balance of a specific asset in the wallet."""
        ...

    @abstractmethod
    async def transfer_sol(self, from_keypair: object, to_pubkey: object, lamports: int) -> str:
        """Transfer native tokens from a keypair to a recipient."""
        ...


# ============================================================================
# Liquidity Pool Interfaces
# ============================================================================


class PoolTokenInfo(BaseModel):
    """Token information in a pool."""

    mint: str = Field(..., description="Token mint address")
    symbol: str | None = Field(None, description="Token symbol")
    reserve: str | None = Field(None, description="Token reserve")
    decimals: int | None = Field(None, description="Token decimals")


class PoolInfo(BaseModel):
    """A standardized representation of a liquidity pool."""

    id: str = Field(..., description="Pool unique identifier")
    display_name: str | None = Field(None, description="User-friendly name")
    dex: str = Field(..., description="DEX identifier")
    token_a: PoolTokenInfo = Field(..., description="First token")
    token_b: PoolTokenInfo = Field(..., description="Second token")
    lp_token_mint: str | None = Field(None, description="LP token mint")
    apr: float | None = Field(None, description="Annual Percentage Rate")
    apy: float | None = Field(None, description="Annual Percentage Yield")
    tvl: float | None = Field(None, description="Total Value Locked")
    fee: float | None = Field(None, description="Trading fee percentage")
    metadata: dict[str, Any] | None = Field(None, description="DEX-specific data")


class LpPositionDetails(BaseModel):
    """User's position in a liquidity pool."""

    pool_id: str = Field(..., description="Pool ID")
    dex: str = Field(..., description="DEX identifier")
    lp_token_balance: TokenBalance = Field(..., description="LP token balance")
    underlying_tokens: list[TokenBalance] = Field(
        default_factory=list, description="Underlying tokens"
    )
    value_usd: float | None = Field(None, description="Position value in USD")
    accrued_fees: list[TokenBalance] | None = Field(None, description="Accrued fees")
    rewards: list[TokenBalance] | None = Field(None, description="Farming rewards")
    metadata: dict[str, Any] | None = Field(None, description="Additional data")


class TransactionResult(BaseModel):
    """Result of a blockchain transaction."""

    success: bool = Field(..., description="Whether transaction succeeded")
    transaction_id: str | None = Field(None, description="Transaction ID")
    error: str | None = Field(None, description="Error message if failed")
    data: dict[str, Any] | None = Field(None, description="Additional data")


class ILpService(Service):
    """Interface for liquidity pool services."""

    service_type: ClassVar[str] = ServiceType.LP_POOL

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to DEX liquidity pools."

    @abstractmethod
    def get_dex_name(self) -> str:
        """Returns the name of the DEX this service interacts with."""
        ...

    @abstractmethod
    async def get_pools(
        self, token_a_mint: str | None = None, token_b_mint: str | None = None
    ) -> list[PoolInfo]:
        """Fetch available liquidity pools from the DEX."""
        ...

    @abstractmethod
    async def add_liquidity(
        self,
        user_vault: object,
        pool_id: str,
        token_a_amount_lamports: str,
        token_b_amount_lamports: str | None,
        slippage_bps: int,
        tick_lower_index: int | None = None,
        tick_upper_index: int | None = None,
    ) -> tuple[TransactionResult, TokenBalance | None]:
        """Add liquidity to a pool."""
        ...

    @abstractmethod
    async def remove_liquidity(
        self,
        user_vault: object,
        pool_id: str,
        lp_token_amount_lamports: str,
        slippage_bps: int,
    ) -> tuple[TransactionResult, list[TokenBalance] | None]:
        """Remove liquidity from a pool."""
        ...

    @abstractmethod
    async def get_lp_position_details(
        self, user_account_public_key: str, pool_or_position_identifier: str
    ) -> LpPositionDetails | None:
        """Fetch details of a specific LP position."""
        ...

    @abstractmethod
    async def get_market_data_for_pools(self, pool_ids: list[str]) -> dict[str, PoolInfo]:
        """Fetch latest market data for pools."""
        ...


# ============================================================================
# Transcription & Audio Interfaces
# ============================================================================


class TranscriptionOptions(BaseModel):
    """Options for audio transcription."""

    language: str | None = None
    model: str | None = None
    temperature: float | None = None
    prompt: str | None = None
    response_format: Literal["json", "text", "srt", "vtt", "verbose_json"] | None = None
    timestamp_granularities: list[Literal["word", "segment"]] | None = None
    word_timestamps: bool | None = None
    segment_timestamps: bool | None = None


class TranscriptionSegment(BaseModel):
    """A segment of transcription."""

    id: int = Field(..., description="Segment ID")
    text: str = Field(..., description="Segment text")
    start: float = Field(..., description="Start time in seconds")
    end: float = Field(..., description="End time in seconds")
    confidence: float | None = None
    tokens: list[int] | None = None
    temperature: float | None = None
    avg_logprob: float | None = None
    compression_ratio: float | None = None
    no_speech_prob: float | None = None


class TranscriptionWord(BaseModel):
    """A word in transcription."""

    word: str = Field(..., description="The word")
    start: float = Field(..., description="Start time in seconds")
    end: float = Field(..., description="End time in seconds")
    confidence: float | None = None


class TranscriptionResult(BaseModel):
    """Result of audio transcription."""

    text: str = Field(..., description="Transcribed text")
    language: str | None = None
    duration: float | None = None
    segments: list[TranscriptionSegment] | None = None
    words: list[TranscriptionWord] | None = None
    confidence: float | None = None


class SpeechToTextOptions(BaseModel):
    """Options for speech-to-text."""

    language: str | None = None
    model: str | None = None
    continuous: bool | None = None
    interim_results: bool | None = None
    max_alternatives: int | None = None


class TextToSpeechOptions(BaseModel):
    """Options for text-to-speech."""

    voice: str | None = None
    model: str | None = None
    speed: float | None = None
    format: Literal["mp3", "wav", "flac", "aac"] | None = None
    response_format: Literal["mp3", "opus", "aac", "flac"] | None = None


class VoiceInfo(BaseModel):
    """Voice information for TTS."""

    id: str = Field(..., description="Voice ID")
    name: str = Field(..., description="Voice name")
    language: str = Field(..., description="Voice language")
    gender: Literal["male", "female", "neutral"] | None = None


class ITranscriptionService(Service):
    """Interface for transcription and speech services."""

    service_type: ClassVar[str] = ServiceType.TRANSCRIPTION

    @property
    def capability_description(self) -> str:
        return "Audio transcription and speech processing capabilities"

    @abstractmethod
    async def transcribe_audio(
        self, audio_path: str | bytes, options: TranscriptionOptions | None = None
    ) -> TranscriptionResult:
        """Transcribe audio file to text."""
        ...

    @abstractmethod
    async def transcribe_video(
        self, video_path: str | bytes, options: TranscriptionOptions | None = None
    ) -> TranscriptionResult:
        """Transcribe video file to text."""
        ...

    @abstractmethod
    async def speech_to_text(
        self, audio_stream: BufferedReader | bytes, options: SpeechToTextOptions | None = None
    ) -> TranscriptionResult:
        """Real-time speech to text."""
        ...

    @abstractmethod
    async def text_to_speech(self, text: str, options: TextToSpeechOptions | None = None) -> bytes:
        """Convert text to speech."""
        ...

    @abstractmethod
    async def get_supported_languages(self) -> list[str]:
        """Get supported languages for transcription."""
        ...

    @abstractmethod
    async def get_available_voices(self) -> list[VoiceInfo]:
        """Get available voices for TTS."""
        ...

    @abstractmethod
    async def detect_language(self, audio_path: str | bytes) -> str:
        """Detect language of audio file."""
        ...


# ============================================================================
# Video Interfaces
# ============================================================================


class VideoFormat(BaseModel):
    """Video format information."""

    format_id: str = Field(..., description="Format ID")
    url: str = Field(..., description="Download URL")
    extension: str = Field(..., description="File extension")
    quality: str = Field(..., description="Quality label")
    file_size: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    resolution: str | None = None
    fps: int | None = None
    bitrate: int | None = None


class VideoInfo(BaseModel):
    """Video information."""

    url: str = Field(..., description="Video URL")
    title: str | None = None
    duration: float | None = None
    thumbnail: str | None = None
    description: str | None = None
    uploader: str | None = None
    view_count: int | None = None
    upload_date: datetime | None = None
    formats: list[VideoFormat] | None = None


class VideoDownloadOptions(BaseModel):
    """Video download options."""

    format: str | None = None
    quality: str | None = None
    output_path: str | None = None
    audio_only: bool | None = None
    video_only: bool | None = None
    subtitles: bool | None = None
    embed_subs: bool | None = None
    write_info_json: bool | None = None


class VideoProcessingOptions(BaseModel):
    """Video processing options."""

    start_time: float | None = None
    end_time: float | None = None
    output_format: str | None = None
    resolution: str | None = None
    bitrate: str | None = None
    framerate: int | None = None
    audio_codec: str | None = None
    video_codec: str | None = None


class IVideoService(Service):
    """Interface for video processing services."""

    service_type: ClassVar[str] = ServiceType.VIDEO

    @property
    def capability_description(self) -> str:
        return "Video download, processing, and conversion capabilities"

    @abstractmethod
    async def get_video_info(self, url: str) -> VideoInfo:
        """Get video information without downloading."""
        ...

    @abstractmethod
    async def download_video(self, url: str, options: VideoDownloadOptions | None = None) -> str:
        """Download a video from URL."""
        ...

    @abstractmethod
    async def extract_audio(self, video_path: str, output_path: str | None = None) -> str:
        """Extract audio from video."""
        ...

    @abstractmethod
    async def get_thumbnail(self, video_path: str, timestamp: float | None = None) -> str:
        """Generate thumbnail from video."""
        ...

    @abstractmethod
    async def convert_video(
        self, video_path: str, output_path: str, options: VideoProcessingOptions | None = None
    ) -> str:
        """Convert video to different format."""
        ...

    @abstractmethod
    async def get_available_formats(self, url: str) -> list[VideoFormat]:
        """Get available formats for a video URL."""
        ...


# ============================================================================
# Browser Interfaces
# ============================================================================


class BrowserViewport(BaseModel):
    """Browser viewport size."""

    width: int = Field(..., description="Width in pixels")
    height: int = Field(..., description="Height in pixels")


class BrowserNavigationOptions(BaseModel):
    """Browser navigation options."""

    timeout: int | None = None
    wait_until: Literal["load", "domcontentloaded", "networkidle0", "networkidle2"] | None = None
    viewport: BrowserViewport | None = None
    user_agent: str | None = None
    headers: dict[str, str] | None = None


class ScreenshotClip(BaseModel):
    """Screenshot clip region."""

    x: int = Field(..., description="X position")
    y: int = Field(..., description="Y position")
    width: int = Field(..., description="Width")
    height: int = Field(..., description="Height")


class ScreenshotOptions(BaseModel):
    """Screenshot options."""

    full_page: bool | None = None
    clip: ScreenshotClip | None = None
    format: Literal["png", "jpeg", "webp"] | None = None
    quality: int | None = None
    omit_background: bool | None = None


class ElementSelector(BaseModel):
    """Element selector options."""

    selector: str = Field(..., description="CSS selector")
    text: str | None = None
    timeout: int | None = None


class ExtractedLink(BaseModel):
    """Extracted link from page."""

    url: str = Field(..., description="Link URL")
    text: str = Field(..., description="Link text")


class ExtractedImage(BaseModel):
    """Extracted image from page."""

    src: str = Field(..., description="Image source")
    alt: str | None = None


class ExtractedContent(BaseModel):
    """Extracted content from a page."""

    text: str = Field(..., description="Text content")
    html: str = Field(..., description="HTML content")
    links: list[ExtractedLink] = Field(default_factory=list, description="Links found")
    images: list[ExtractedImage] = Field(default_factory=list, description="Images found")
    title: str | None = None
    metadata: dict[str, str] | None = None


class ClickOptions(BaseModel):
    """Click options."""

    timeout: int | None = None
    force: bool | None = None
    wait_for_navigation: bool | None = None


class TypeOptions(BaseModel):
    """Type/input options."""

    delay: int | None = None
    timeout: int | None = None
    clear: bool | None = None


class IBrowserService(Service):
    """Interface for browser automation services."""

    service_type: ClassVar[str] = ServiceType.BROWSER

    @property
    def capability_description(self) -> str:
        return "Web browser automation and scraping capabilities"

    @abstractmethod
    async def navigate(self, url: str, options: BrowserNavigationOptions | None = None) -> None:
        """Navigate to a URL."""
        ...

    @abstractmethod
    async def screenshot(self, options: ScreenshotOptions | None = None) -> bytes:
        """Take a screenshot of the current page."""
        ...

    @abstractmethod
    async def extract_content(self, selector: str | None = None) -> ExtractedContent:
        """Extract text and content from the current page."""
        ...

    @abstractmethod
    async def click(
        self, selector: str | ElementSelector, options: ClickOptions | None = None
    ) -> None:
        """Click on an element."""
        ...

    @abstractmethod
    async def type_text(self, selector: str, text: str, options: TypeOptions | None = None) -> None:
        """Type text into an input field."""
        ...

    @abstractmethod
    async def wait_for_element(self, selector: str | ElementSelector) -> None:
        """Wait for an element to appear."""
        ...

    @abstractmethod
    async def evaluate(self, script: str, *args: object) -> object:
        """Evaluate JavaScript in the browser context."""
        ...

    @abstractmethod
    async def get_current_url(self) -> str:
        """Get the current page URL."""
        ...

    @abstractmethod
    async def go_back(self) -> None:
        """Go back in browser history."""
        ...

    @abstractmethod
    async def go_forward(self) -> None:
        """Go forward in browser history."""
        ...

    @abstractmethod
    async def refresh(self) -> None:
        """Refresh the current page."""
        ...


# ============================================================================
# PDF Interfaces
# ============================================================================


class PdfMetadata(BaseModel):
    """PDF metadata."""

    title: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    modified_at: datetime | None = None


class PdfExtractionResult(BaseModel):
    """PDF text extraction result."""

    text: str = Field(..., description="Extracted text")
    page_count: int = Field(..., description="Total page count")
    metadata: PdfMetadata | None = None


class PdfMargins(BaseModel):
    """PDF page margins."""

    top: float | None = None
    bottom: float | None = None
    left: float | None = None
    right: float | None = None


class PdfGenerationOptions(BaseModel):
    """PDF generation options."""

    format: Literal["A4", "A3", "Letter"] | None = None
    orientation: Literal["portrait", "landscape"] | None = None
    margins: PdfMargins | None = None
    header: str | None = None
    footer: str | None = None


class PdfConversionOptions(BaseModel):
    """PDF conversion options."""

    quality: Literal["high", "medium", "low"] | None = None
    output_format: Literal["pdf", "pdf/a"] | None = None
    compression: bool | None = None


class IPdfService(Service):
    """Interface for PDF processing services."""

    service_type: ClassVar[str] = ServiceType.PDF

    @property
    def capability_description(self) -> str:
        return "PDF processing, extraction, and generation capabilities"

    @abstractmethod
    async def extract_text(self, pdf_path: str | bytes) -> PdfExtractionResult:
        """Extract text and metadata from a PDF file."""
        ...

    @abstractmethod
    async def generate_pdf(
        self, html_content: str, options: PdfGenerationOptions | None = None
    ) -> bytes:
        """Generate a PDF from HTML content."""
        ...

    @abstractmethod
    async def convert_to_pdf(
        self, file_path: str, options: PdfConversionOptions | None = None
    ) -> bytes:
        """Convert a document to PDF format."""
        ...

    @abstractmethod
    async def merge_pdfs(self, pdf_paths: list[str | bytes]) -> bytes:
        """Merge multiple PDF files into one."""
        ...

    @abstractmethod
    async def split_pdf(self, pdf_path: str | bytes) -> list[bytes]:
        """Split a PDF into individual pages."""
        ...


# ============================================================================
# Web Search Interfaces
# ============================================================================


class SearchDateRange(BaseModel):
    """Date range for search filtering."""

    start: datetime | None = None
    end: datetime | None = None


class WebSearchBaseOptions(BaseModel):
    """Web search options."""

    limit: int | None = None
    offset: int | None = None
    language: str | None = None
    region: str | None = None
    date_range: SearchDateRange | None = None
    file_type: str | None = None
    site: str | None = None
    sort_by: Literal["relevance", "date", "popularity"] | None = None
    safe_search: Literal["strict", "moderate", "off"] | None = None


class SearchResult(BaseModel):
    """A single search result."""

    title: str = Field(..., description="Result title")
    url: str = Field(..., description="Result URL")
    description: str = Field(..., description="Result description")
    display_url: str | None = None
    thumbnail: str | None = None
    published_date: datetime | None = None
    source: str | None = None
    relevance_score: float | None = None
    snippet: str | None = None


class SearchResponse(BaseModel):
    """Search response containing results."""

    query: str = Field(..., description="Original query")
    results: list[SearchResult] = Field(default_factory=list, description="Search results")
    total_results: int | None = None
    search_time: float | None = None
    suggestions: list[str] | None = None
    next_page_token: str | None = None
    related_searches: list[str] | None = None


class NewsSearchOptions(WebSearchBaseOptions):
    """News search options."""

    category: (
        Literal["general", "business", "entertainment", "health", "science", "sports", "technology"]
        | None
    ) = None
    freshness: Literal["day", "week", "month"] | None = None


class ImageSearchOptions(WebSearchBaseOptions):
    """Image search options."""

    size: Literal["small", "medium", "large", "wallpaper", "any"] | None = None
    color: str | None = None
    image_type: Literal["photo", "clipart", "line", "animated"] | None = None
    layout: Literal["square", "wide", "tall", "any"] | None = None
    license: Literal["any", "public", "share", "sharecommercially", "modify"] | None = None


class VideoSearchOptions(WebSearchBaseOptions):
    """Video search options."""

    duration: Literal["short", "medium", "long", "any"] | None = None
    resolution: Literal["high", "standard", "any"] | None = None
    quality: Literal["high", "standard", "any"] | None = None


class PageInfo(BaseModel):
    """Detailed page information."""

    title: str = Field(..., description="Page title")
    description: str = Field(..., description="Page description")
    content: str = Field(..., description="Page content")
    metadata: dict[str, str] = Field(default_factory=dict, description="Page metadata")
    images: list[str] = Field(default_factory=list, description="Image URLs")
    links: list[str] = Field(default_factory=list, description="Link URLs")


class IWebSearchService(Service):
    """Interface for web search services."""

    service_type: ClassVar[str] = ServiceType.WEB_SEARCH

    @property
    def capability_description(self) -> str:
        return "Web search and content discovery capabilities"

    @abstractmethod
    async def search(
        self, query: str, options: WebSearchBaseOptions | None = None
    ) -> SearchResponse:
        """Perform a general web search."""
        ...

    @abstractmethod
    async def search_news(
        self, query: str, options: NewsSearchOptions | None = None
    ) -> SearchResponse:
        """Search for news articles."""
        ...

    @abstractmethod
    async def search_images(
        self, query: str, options: ImageSearchOptions | None = None
    ) -> SearchResponse:
        """Search for images."""
        ...

    @abstractmethod
    async def search_videos(
        self, query: str, options: VideoSearchOptions | None = None
    ) -> SearchResponse:
        """Search for videos."""
        ...

    @abstractmethod
    async def get_suggestions(self, query: str) -> list[str]:
        """Get search suggestions for a query."""
        ...

    @abstractmethod
    async def get_trending_searches(self, region: str | None = None) -> list[str]:
        """Get trending searches."""
        ...

    @abstractmethod
    async def get_page_info(self, url: str) -> PageInfo:
        """Get detailed information about a specific URL."""
        ...


# ============================================================================
# Email Interfaces
# ============================================================================


class EmailAddress(BaseModel):
    """Email address with optional name."""

    email: str = Field(..., description="Email address")
    name: str | None = None


class EmailAttachment(BaseModel):
    """Email attachment."""

    filename: str = Field(..., description="Filename")
    content: bytes | str = Field(..., description="Content as bytes or base64")
    content_type: str | None = None
    content_disposition: Literal["attachment", "inline"] | None = None
    cid: str | None = None


class EmailMessage(BaseModel):
    """Email message."""

    from_address: EmailAddress = Field(..., alias="from", description="Sender address")
    to: list[EmailAddress] = Field(..., description="Recipients")
    cc: list[EmailAddress] | None = None
    bcc: list[EmailAddress] | None = None
    subject: str = Field(..., description="Email subject")
    text: str | None = None
    html: str | None = None
    attachments: list[EmailAttachment] | None = None
    reply_to: EmailAddress | None = None
    date: datetime | None = None
    message_id: str | None = None
    references: list[str] | None = None
    in_reply_to: str | None = None
    priority: Literal["high", "normal", "low"] | None = None

    model_config = {"populate_by_name": True}


class EmailSendOptions(BaseModel):
    """Email send options."""

    retry: int | None = None
    timeout: int | None = None
    track_opens: bool | None = None
    track_clicks: bool | None = None
    tags: list[str] | None = None


class EmailSearchOptions(BaseModel):
    """Email search options."""

    query: str | None = None
    from_address: str | None = Field(None, alias="from")
    to: str | None = None
    subject: str | None = None
    folder: str | None = None
    since: datetime | None = None
    before: datetime | None = None
    limit: int | None = None
    offset: int | None = None
    unread: bool | None = None
    flagged: bool | None = None
    has_attachments: bool | None = None

    model_config = {"populate_by_name": True}


class EmailFolder(BaseModel):
    """Email folder."""

    name: str = Field(..., description="Folder name")
    path: str = Field(..., description="Folder path")
    folder_type: Literal["inbox", "sent", "drafts", "trash", "spam", "custom"] = Field(
        ..., alias="type", description="Folder type"
    )
    message_count: int | None = None
    unread_count: int | None = None
    children: list[EmailFolder] | None = None

    model_config = {"populate_by_name": True}


class EmailAccount(BaseModel):
    """Email account information."""

    email: str = Field(..., description="Email address")
    name: str | None = None
    provider: str | None = None
    folders: list[EmailFolder] | None = None
    quota_used: int | None = None
    quota_limit: int | None = None


class IEmailService(Service):
    """Interface for email services."""

    service_type: ClassVar[str] = ServiceType.EMAIL

    @property
    def capability_description(self) -> str:
        return "Email sending, receiving, and management capabilities"

    @abstractmethod
    async def send_email(
        self, message: EmailMessage, options: EmailSendOptions | None = None
    ) -> str:
        """Send an email."""
        ...

    @abstractmethod
    async def get_emails(self, options: EmailSearchOptions | None = None) -> list[EmailMessage]:
        """Get emails from a folder."""
        ...

    @abstractmethod
    async def get_email(self, message_id: str) -> EmailMessage:
        """Get a specific email by ID."""
        ...

    @abstractmethod
    async def delete_email(self, message_id: str) -> None:
        """Delete an email."""
        ...

    @abstractmethod
    async def mark_email_as_read(self, message_id: str, read: bool) -> None:
        """Mark an email as read/unread."""
        ...

    @abstractmethod
    async def flag_email(self, message_id: str, flagged: bool) -> None:
        """Flag/unflag an email."""
        ...

    @abstractmethod
    async def move_email(self, message_id: str, folder_path: str) -> None:
        """Move email to a different folder."""
        ...

    @abstractmethod
    async def get_folders(self) -> list[EmailFolder]:
        """Get available folders."""
        ...

    @abstractmethod
    async def create_folder(self, folder_name: str, parent_path: str | None = None) -> None:
        """Create a new folder."""
        ...

    @abstractmethod
    async def get_account_info(self) -> EmailAccount:
        """Get account information."""
        ...

    @abstractmethod
    async def search_emails(
        self, query: str, options: EmailSearchOptions | None = None
    ) -> list[EmailMessage]:
        """Search emails."""
        ...


# ============================================================================
# Messaging Interfaces
# ============================================================================


class MessageParticipant(BaseModel):
    """Message participant information."""

    id: str = Field(..., description="Participant ID (UUID)")
    name: str = Field(..., description="Display name")
    username: str | None = None
    avatar: str | None = None
    status: Literal["online", "offline", "away", "busy"] | None = None


class MessageAttachment(BaseModel):
    """Message attachment."""

    id: str = Field(..., description="Attachment ID (UUID)")
    filename: str = Field(..., description="Filename")
    url: str = Field(..., description="File URL")
    mime_type: str = Field(..., description="MIME type")
    size: int = Field(..., description="File size in bytes")
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    thumbnail: str | None = None


class MessageReaction(BaseModel):
    """Message reaction."""

    emoji: str = Field(..., description="Emoji used")
    count: int = Field(..., description="Number of reactions")
    users: list[str] = Field(default_factory=list, description="User IDs who reacted")
    has_reacted: bool = Field(..., description="Whether current user has reacted")


class MessageReference(BaseModel):
    """Message reference (reply/forward/quote)."""

    message_id: str = Field(..., description="Referenced message ID")
    channel_id: str = Field(..., description="Channel of referenced message")
    ref_type: Literal["reply", "forward", "quote"] = Field(
        ..., alias="type", description="Type of reference"
    )

    model_config = {"populate_by_name": True}


class EmbedField(BaseModel):
    """Embed field."""

    name: str = Field(..., description="Field name")
    value: str = Field(..., description="Field value")
    inline: bool | None = None


class MessageEmbed(BaseModel):
    """Message embed."""

    title: str | None = None
    description: str | None = None
    url: str | None = None
    image: str | None = None
    fields: list[EmbedField] | None = None


class MessageContent(BaseModel):
    """Message content."""

    text: str | None = None
    html: str | None = None
    markdown: str | None = None
    attachments: list[MessageAttachment] | None = None
    reactions: list[MessageReaction] | None = None
    reference: MessageReference | None = None
    mentions: list[str] | None = None
    embeds: list[MessageEmbed] | None = None


class MessageThread(BaseModel):
    """Thread information."""

    id: str = Field(..., description="Thread ID")
    message_count: int = Field(..., description="Number of messages")
    participants: list[str] = Field(default_factory=list, description="Participant IDs")
    last_message_at: datetime = Field(..., description="Last message timestamp")


class MessageInfo(BaseModel):
    """Message information."""

    id: str = Field(..., description="Message ID (UUID)")
    channel_id: str = Field(..., description="Channel ID")
    sender_id: str = Field(..., description="Sender ID")
    content: MessageContent = Field(..., description="Message content")
    timestamp: datetime = Field(..., description="Sent timestamp")
    edited: datetime | None = None
    deleted: datetime | None = None
    pinned: bool | None = None
    thread: MessageThread | None = None


class MessageSendOptions(BaseModel):
    """Message send options."""

    reply_to: str | None = None
    ephemeral: bool | None = None
    silent: bool | None = None
    scheduled: datetime | None = None
    thread: str | None = None
    nonce: str | None = None


class MessageSearchOptions(BaseModel):
    """Message search options."""

    query: str | None = None
    channel_id: str | None = None
    sender_id: str | None = None
    before: datetime | None = None
    after: datetime | None = None
    limit: int | None = None
    offset: int | None = None
    has_attachments: bool | None = None
    pinned: bool | None = None
    mentions: str | None = None


class ChannelPermissions(BaseModel):
    """Channel permissions."""

    can_send: bool = Field(..., description="Can send messages")
    can_read: bool = Field(..., description="Can read messages")
    can_delete: bool = Field(..., description="Can delete messages")
    can_pin: bool = Field(..., description="Can pin messages")
    can_manage: bool = Field(..., description="Can manage channel")


class MessageChannel(BaseModel):
    """Message channel."""

    id: str = Field(..., description="Channel ID (UUID)")
    name: str = Field(..., description="Channel name")
    channel_type: Literal["text", "voice", "dm", "group", "announcement", "thread"] = Field(
        ..., alias="type", description="Channel type"
    )
    description: str | None = None
    participants: list[MessageParticipant] | None = None
    permissions: ChannelPermissions | None = None
    last_message_at: datetime | None = None
    message_count: int | None = None
    unread_count: int | None = None

    model_config = {"populate_by_name": True}


class IMessagingService(Service):
    """Interface for platform messaging services (Discord, Slack, etc)."""

    service_type: ClassVar[str] = ServiceType.MESSAGE

    @property
    def capability_description(self) -> str:
        return "Platform messaging and channel management capabilities"

    @abstractmethod
    async def send_message(
        self, channel_id: str, content: MessageContent, options: MessageSendOptions | None = None
    ) -> str:
        """Send a message to a channel."""
        ...

    @abstractmethod
    async def get_messages(
        self, channel_id: str, options: MessageSearchOptions | None = None
    ) -> list[MessageInfo]:
        """Get messages from a channel."""
        ...

    @abstractmethod
    async def get_message(self, message_id: str) -> MessageInfo:
        """Get a specific message by ID."""
        ...

    @abstractmethod
    async def edit_message(self, message_id: str, content: MessageContent) -> None:
        """Edit a message."""
        ...

    @abstractmethod
    async def delete_message(self, message_id: str) -> None:
        """Delete a message."""
        ...

    @abstractmethod
    async def add_reaction(self, message_id: str, emoji: str) -> None:
        """Add a reaction to a message."""
        ...

    @abstractmethod
    async def remove_reaction(self, message_id: str, emoji: str) -> None:
        """Remove a reaction from a message."""
        ...

    @abstractmethod
    async def pin_message(self, message_id: str) -> None:
        """Pin a message."""
        ...

    @abstractmethod
    async def unpin_message(self, message_id: str) -> None:
        """Unpin a message."""
        ...

    @abstractmethod
    async def get_channels(self) -> list[MessageChannel]:
        """Get available channels."""
        ...

    @abstractmethod
    async def get_channel(self, channel_id: str) -> MessageChannel:
        """Get channel information."""
        ...

    @abstractmethod
    async def create_channel(
        self,
        name: str,
        channel_type: str,
        description: str | None = None,
        participants: list[str] | None = None,
        private: bool | None = None,
    ) -> str:
        """Create a new channel."""
        ...

    @abstractmethod
    async def search_messages(
        self, query: str, options: MessageSearchOptions | None = None
    ) -> list[MessageInfo]:
        """Search messages across channels."""
        ...


# ============================================================================
# Post/Social Media Interfaces
# ============================================================================


class PostMedia(BaseModel):
    """Post media content."""

    id: str = Field(..., description="Media ID (UUID)")
    url: str = Field(..., description="Media URL")
    media_type: Literal["image", "video", "audio", "document"] = Field(
        ..., alias="type", description="Media type"
    )
    mime_type: str = Field(..., description="MIME type")
    size: int = Field(..., description="File size in bytes")
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    thumbnail: str | None = None
    description: str | None = None
    alt_text: str | None = None

    model_config = {"populate_by_name": True}


class PostLocation(BaseModel):
    """Post location."""

    name: str = Field(..., description="Location name")
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    place_id: str | None = None


class PostAuthor(BaseModel):
    """Post author information."""

    id: str = Field(..., description="Author ID (UUID)")
    username: str = Field(..., description="Username")
    display_name: str = Field(..., description="Display name")
    avatar: str | None = None
    verified: bool | None = None
    follower_count: int | None = None
    following_count: int | None = None
    bio: str | None = None
    website: str | None = None


class PostEngagement(BaseModel):
    """Post engagement metrics."""

    likes: int = Field(..., description="Number of likes")
    shares: int = Field(..., description="Number of shares")
    comments: int = Field(..., description="Number of comments")
    views: int | None = None
    has_liked: bool = Field(..., description="Whether current user has liked")
    has_shared: bool = Field(..., description="Whether current user has shared")
    has_commented: bool = Field(..., description="Whether current user has commented")
    has_saved: bool = Field(..., description="Whether current user has saved")


class PostLinkPreview(BaseModel):
    """Link preview in post."""

    url: str = Field(..., description="Link URL")
    title: str | None = None
    description: str | None = None
    image: str | None = None


class PollOption(BaseModel):
    """Poll option."""

    text: str = Field(..., description="Option text")
    votes: int = Field(..., description="Number of votes")


class PostPoll(BaseModel):
    """Post poll."""

    question: str = Field(..., description="Poll question")
    options: list[PollOption] = Field(..., description="Poll options")
    expires_at: datetime | None = None
    multiple_choice: bool | None = None


class PostContent(BaseModel):
    """Post content."""

    text: str | None = None
    html: str | None = None
    media: list[PostMedia] | None = None
    location: PostLocation | None = None
    tags: list[str] | None = None
    mentions: list[str] | None = None
    links: list[PostLinkPreview] | None = None
    poll: PostPoll | None = None


class PostThread(BaseModel):
    """Post thread information."""

    id: str = Field(..., description="Thread ID")
    position: int = Field(..., description="Position in thread")
    total: int = Field(..., description="Total posts in thread")


class CrossPostedInfo(BaseModel):
    """Cross-post information."""

    platform: str = Field(..., description="Platform name")
    platform_id: str = Field(..., description="Platform-specific ID")
    url: str = Field(..., description="Post URL")


class PostInfo(BaseModel):
    """Post information."""

    id: str = Field(..., description="Post ID (UUID)")
    author: PostAuthor = Field(..., description="Post author")
    content: PostContent = Field(..., description="Post content")
    platform: str = Field(..., description="Platform name")
    platform_id: str = Field(..., description="Platform-specific ID")
    url: str = Field(..., description="Post URL")
    created_at: datetime = Field(..., description="Created timestamp")
    edited_at: datetime | None = None
    scheduled_at: datetime | None = None
    engagement: PostEngagement = Field(..., description="Engagement metrics")
    visibility: Literal["public", "private", "followers", "friends", "unlisted"] = Field(
        ..., description="Visibility level"
    )
    reply_to: str | None = None
    thread: PostThread | None = None
    cross_posted: list[CrossPostedInfo] | None = None


class PostCreateOptions(BaseModel):
    """Post creation options."""

    platforms: list[str] | None = None
    scheduled_at: datetime | None = None
    visibility: Literal["public", "private", "followers", "friends", "unlisted"] | None = None
    reply_to: str | None = None
    thread: bool | None = None
    location: PostLocation | None = None
    tags: list[str] | None = None
    mentions: list[str] | None = None
    enable_comments: bool | None = None
    enable_sharing: bool | None = None
    content_warning: str | None = None
    sensitive: bool | None = None


class PostSearchOptions(BaseModel):
    """Post search options."""

    query: str | None = None
    author: str | None = None
    platform: str | None = None
    tags: list[str] | None = None
    mentions: list[str] | None = None
    since: datetime | None = None
    before: datetime | None = None
    limit: int | None = None
    offset: int | None = None
    has_media: bool | None = None
    has_location: bool | None = None
    visibility: Literal["public", "private", "followers", "friends", "unlisted"] | None = None
    sort_by: Literal["date", "engagement", "relevance"] | None = None


class DemographicsData(BaseModel):
    """Demographics data."""

    age: dict[str, int] | None = None
    gender: dict[str, int] | None = None
    location: dict[str, int] | None = None


class PerformingHour(BaseModel):
    """Top performing hour."""

    hour: int = Field(..., description="Hour of day (0-23)")
    engagement: int = Field(..., description="Engagement count")


class PostAnalytics(BaseModel):
    """Post analytics."""

    post_id: str = Field(..., description="Post ID (UUID)")
    platform: str = Field(..., description="Platform name")
    impressions: int = Field(..., description="Total impressions")
    reach: int = Field(..., description="Unique reach")
    engagement: PostEngagement = Field(..., description="Engagement metrics")
    clicks: int = Field(..., description="Link clicks")
    shares: int = Field(..., description="Shares")
    saves: int = Field(..., description="Saves")
    demographics: DemographicsData | None = None
    top_performing_hours: list[PerformingHour] | None = None


class IPostService(Service):
    """Interface for social media posting services."""

    service_type: ClassVar[str] = ServiceType.POST

    @property
    def capability_description(self) -> str:
        return "Social media posting and content management capabilities"

    @abstractmethod
    async def create_post(
        self, content: PostContent, options: PostCreateOptions | None = None
    ) -> str:
        """Create and publish a new post."""
        ...

    @abstractmethod
    async def get_posts(self, options: PostSearchOptions | None = None) -> list[PostInfo]:
        """Get posts from timeline or specific user."""
        ...

    @abstractmethod
    async def get_post(self, post_id: str) -> PostInfo:
        """Get a specific post by ID."""
        ...

    @abstractmethod
    async def edit_post(self, post_id: str, content: PostContent) -> None:
        """Edit an existing post."""
        ...

    @abstractmethod
    async def delete_post(self, post_id: str) -> None:
        """Delete a post."""
        ...

    @abstractmethod
    async def like_post(self, post_id: str, like: bool) -> None:
        """Like/unlike a post."""
        ...

    @abstractmethod
    async def share_post(self, post_id: str, comment: str | None = None) -> str:
        """Share/repost a post."""
        ...

    @abstractmethod
    async def save_post(self, post_id: str, save: bool) -> None:
        """Save/unsave a post."""
        ...

    @abstractmethod
    async def comment_on_post(self, post_id: str, content: PostContent) -> str:
        """Comment on a post."""
        ...

    @abstractmethod
    async def get_comments(
        self, post_id: str, options: PostSearchOptions | None = None
    ) -> list[PostInfo]:
        """Get comments for a post."""
        ...

    @abstractmethod
    async def schedule_post(
        self, content: PostContent, scheduled_at: datetime, options: PostCreateOptions | None = None
    ) -> str:
        """Schedule a post for later publishing."""
        ...

    @abstractmethod
    async def get_post_analytics(self, post_id: str) -> PostAnalytics:
        """Get analytics for a post."""
        ...

    @abstractmethod
    async def get_trending_posts(self, options: PostSearchOptions | None = None) -> list[PostInfo]:
        """Get trending posts."""
        ...

    @abstractmethod
    async def search_posts(
        self, query: str, options: PostSearchOptions | None = None
    ) -> list[PostInfo]:
        """Search posts across platforms."""
        ...
