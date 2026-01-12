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
    address: str = Field(..., description="Token mint address or native identifier")
    balance: str = Field(..., description="Raw balance as string for precision")
    decimals: int = Field(..., description="Number of decimal places")
    ui_amount: float | None = Field(None, description="User-friendly balance")
    name: str | None = Field(None, description="Token name")
    symbol: str | None = Field(None, description="Token symbol")
    logo_uri: str | None = Field(None, description="Token logo URI")


class TokenData(BaseModel):
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
    price_usd: float | None = Field(None, description="Current price in USD")
    value_usd: float | None = Field(None, description="Total value in USD")


class WalletPortfolio(BaseModel):
    total_value_usd: float = Field(..., description="Total portfolio value")
    assets: list[WalletAsset] = Field(default_factory=list, description="Portfolio assets")


class ITokenDataService(Service):
    service_type: ClassVar[str] = ServiceType.TOKEN_DATA

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to token market data."

    @abstractmethod
    async def get_token_details(self, address: str, chain: str) -> TokenData | None: ...

    @abstractmethod
    async def get_trending_tokens(
        self, chain: str | None = None, limit: int | None = None, time_period: str | None = None
    ) -> list[TokenData]: ...

    @abstractmethod
    async def search_tokens(
        self, query: str, chain: str | None = None, limit: int | None = None
    ) -> list[TokenData]: ...

    @abstractmethod
    async def get_tokens_by_addresses(
        self, addresses: list[str], chain: str
    ) -> list[TokenData]: ...


class IWalletService(Service):
    service_type: ClassVar[str] = ServiceType.WALLET

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to wallet balances and portfolios."

    @abstractmethod
    async def get_portfolio(self, owner: str | None = None) -> WalletPortfolio: ...

    @abstractmethod
    async def get_balance(self, asset_address: str, owner: str | None = None) -> float: ...

    @abstractmethod
    async def transfer_sol(self, from_keypair: object, to_pubkey: object, lamports: int) -> str: ...


# ============================================================================
# Liquidity Pool Interfaces
# ============================================================================


class PoolTokenInfo(BaseModel):
    mint: str = Field(..., description="Token mint address")
    symbol: str | None = Field(None, description="Token symbol")
    reserve: str | None = Field(None, description="Token reserve")
    decimals: int | None = Field(None, description="Token decimals")


class PoolInfo(BaseModel):
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
    success: bool = Field(..., description="Whether transaction succeeded")
    transaction_id: str | None = Field(None, description="Transaction ID")
    error: str | None = Field(None, description="Error message if failed")
    data: dict[str, Any] | None = Field(None, description="Additional data")


class ILpService(Service):
    service_type: ClassVar[str] = ServiceType.LP_POOL

    @property
    def capability_description(self) -> str:
        return "Provides standardized access to DEX liquidity pools."

    @abstractmethod
    def get_dex_name(self) -> str: ...

    @abstractmethod
    async def get_pools(
        self, token_a_mint: str | None = None, token_b_mint: str | None = None
    ) -> list[PoolInfo]: ...

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
    ) -> tuple[TransactionResult, TokenBalance | None]: ...

    @abstractmethod
    async def remove_liquidity(
        self,
        user_vault: object,
        pool_id: str,
        lp_token_amount_lamports: str,
        slippage_bps: int,
    ) -> tuple[TransactionResult, list[TokenBalance] | None]: ...

    @abstractmethod
    async def get_lp_position_details(
        self, user_account_public_key: str, pool_or_position_identifier: str
    ) -> LpPositionDetails | None: ...

    @abstractmethod
    async def get_market_data_for_pools(self, pool_ids: list[str]) -> dict[str, PoolInfo]: ...


# ============================================================================
# Transcription & Audio Interfaces
# ============================================================================


class TranscriptionOptions(BaseModel):
    language: str | None = None
    model: str | None = None
    temperature: float | None = None
    prompt: str | None = None
    response_format: Literal["json", "text", "srt", "vtt", "verbose_json"] | None = None
    timestamp_granularities: list[Literal["word", "segment"]] | None = None
    word_timestamps: bool | None = None
    segment_timestamps: bool | None = None


class TranscriptionSegment(BaseModel):
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
    word: str = Field(..., description="The word")
    start: float = Field(..., description="Start time in seconds")
    end: float = Field(..., description="End time in seconds")
    confidence: float | None = None


class TranscriptionResult(BaseModel):
    text: str = Field(..., description="Transcribed text")
    language: str | None = None
    duration: float | None = None
    segments: list[TranscriptionSegment] | None = None
    words: list[TranscriptionWord] | None = None
    confidence: float | None = None


class SpeechToTextOptions(BaseModel):
    language: str | None = None
    model: str | None = None
    continuous: bool | None = None
    interim_results: bool | None = None
    max_alternatives: int | None = None


class TextToSpeechOptions(BaseModel):
    voice: str | None = None
    model: str | None = None
    speed: float | None = None
    format: Literal["mp3", "wav", "flac", "aac"] | None = None
    response_format: Literal["mp3", "opus", "aac", "flac"] | None = None


class VoiceInfo(BaseModel):
    id: str = Field(..., description="Voice ID")
    name: str = Field(..., description="Voice name")
    language: str = Field(..., description="Voice language")
    gender: Literal["male", "female", "neutral"] | None = None


class ITranscriptionService(Service):
    service_type: ClassVar[str] = ServiceType.TRANSCRIPTION

    @property
    def capability_description(self) -> str:
        return "Audio transcription and speech processing capabilities"

    @abstractmethod
    async def transcribe_audio(
        self, audio_path: str | bytes, options: TranscriptionOptions | None = None
    ) -> TranscriptionResult: ...

    @abstractmethod
    async def transcribe_video(
        self, video_path: str | bytes, options: TranscriptionOptions | None = None
    ) -> TranscriptionResult: ...

    @abstractmethod
    async def speech_to_text(
        self, audio_stream: BufferedReader | bytes, options: SpeechToTextOptions | None = None
    ) -> TranscriptionResult: ...

    @abstractmethod
    async def text_to_speech(
        self, text: str, options: TextToSpeechOptions | None = None
    ) -> bytes: ...

    @abstractmethod
    async def get_supported_languages(self) -> list[str]: ...

    @abstractmethod
    async def get_available_voices(self) -> list[VoiceInfo]: ...

    @abstractmethod
    async def detect_language(self, audio_path: str | bytes) -> str: ...


# ============================================================================
# Video Interfaces
# ============================================================================


class VideoFormat(BaseModel):
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
    format: str | None = None
    quality: str | None = None
    output_path: str | None = None
    audio_only: bool | None = None
    video_only: bool | None = None
    subtitles: bool | None = None
    embed_subs: bool | None = None
    write_info_json: bool | None = None


class VideoProcessingOptions(BaseModel):
    start_time: float | None = None
    end_time: float | None = None
    output_format: str | None = None
    resolution: str | None = None
    bitrate: str | None = None
    framerate: int | None = None
    audio_codec: str | None = None
    video_codec: str | None = None


class IVideoService(Service):
    service_type: ClassVar[str] = ServiceType.VIDEO

    @property
    def capability_description(self) -> str:
        return "Video download, processing, and conversion capabilities"

    @abstractmethod
    async def get_video_info(self, url: str) -> VideoInfo: ...

    @abstractmethod
    async def download_video(
        self, url: str, options: VideoDownloadOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def extract_audio(self, video_path: str, output_path: str | None = None) -> str: ...

    @abstractmethod
    async def get_thumbnail(self, video_path: str, timestamp: float | None = None) -> str: ...

    @abstractmethod
    async def convert_video(
        self, video_path: str, output_path: str, options: VideoProcessingOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def get_available_formats(self, url: str) -> list[VideoFormat]: ...


# ============================================================================
# Browser Interfaces
# ============================================================================


class BrowserViewport(BaseModel):
    width: int = Field(..., description="Width in pixels")
    height: int = Field(..., description="Height in pixels")


class BrowserNavigationOptions(BaseModel):
    timeout: int | None = None
    wait_until: Literal["load", "domcontentloaded", "networkidle0", "networkidle2"] | None = None
    viewport: BrowserViewport | None = None
    user_agent: str | None = None
    headers: dict[str, str] | None = None


class ScreenshotClip(BaseModel):
    x: int = Field(..., description="X position")
    y: int = Field(..., description="Y position")
    width: int = Field(..., description="Width")
    height: int = Field(..., description="Height")


class ScreenshotOptions(BaseModel):
    full_page: bool | None = None
    clip: ScreenshotClip | None = None
    format: Literal["png", "jpeg", "webp"] | None = None
    quality: int | None = None
    omit_background: bool | None = None


class ElementSelector(BaseModel):
    selector: str = Field(..., description="CSS selector")
    text: str | None = None
    timeout: int | None = None


class ExtractedLink(BaseModel):
    url: str = Field(..., description="Link URL")
    text: str = Field(..., description="Link text")


class ExtractedImage(BaseModel):
    src: str = Field(..., description="Image source")
    alt: str | None = None


class ExtractedContent(BaseModel):
    text: str = Field(..., description="Text content")
    html: str = Field(..., description="HTML content")
    links: list[ExtractedLink] = Field(default_factory=list, description="Links found")
    images: list[ExtractedImage] = Field(default_factory=list, description="Images found")
    title: str | None = None
    metadata: dict[str, str] | None = None


class ClickOptions(BaseModel):
    timeout: int | None = None
    force: bool | None = None
    wait_for_navigation: bool | None = None


class TypeOptions(BaseModel):
    delay: int | None = None
    timeout: int | None = None
    clear: bool | None = None


class IBrowserService(Service):
    service_type: ClassVar[str] = ServiceType.BROWSER

    @property
    def capability_description(self) -> str:
        return "Web browser automation and scraping capabilities"

    @abstractmethod
    async def navigate(self, url: str, options: BrowserNavigationOptions | None = None) -> None: ...

    @abstractmethod
    async def screenshot(self, options: ScreenshotOptions | None = None) -> bytes: ...

    @abstractmethod
    async def extract_content(self, selector: str | None = None) -> ExtractedContent: ...

    @abstractmethod
    async def click(
        self, selector: str | ElementSelector, options: ClickOptions | None = None
    ) -> None: ...

    @abstractmethod
    async def type_text(
        self, selector: str, text: str, options: TypeOptions | None = None
    ) -> None: ...

    @abstractmethod
    async def wait_for_element(self, selector: str | ElementSelector) -> None: ...

    @abstractmethod
    async def evaluate(self, script: str, *args: object) -> object: ...

    @abstractmethod
    async def get_current_url(self) -> str: ...

    @abstractmethod
    async def go_back(self) -> None: ...

    @abstractmethod
    async def go_forward(self) -> None: ...

    @abstractmethod
    async def refresh(self) -> None: ...


# ============================================================================
# PDF Interfaces
# ============================================================================


class PdfMetadata(BaseModel):
    title: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    modified_at: datetime | None = None


class PdfExtractionResult(BaseModel):
    text: str = Field(..., description="Extracted text")
    page_count: int = Field(..., description="Total page count")
    metadata: PdfMetadata | None = None


class PdfMargins(BaseModel):
    top: float | None = None
    bottom: float | None = None
    left: float | None = None
    right: float | None = None


class PdfGenerationOptions(BaseModel):
    format: Literal["A4", "A3", "Letter"] | None = None
    orientation: Literal["portrait", "landscape"] | None = None
    margins: PdfMargins | None = None
    header: str | None = None
    footer: str | None = None


class PdfConversionOptions(BaseModel):
    quality: Literal["high", "medium", "low"] | None = None
    output_format: Literal["pdf", "pdf/a"] | None = None
    compression: bool | None = None


class IPdfService(Service):
    service_type: ClassVar[str] = ServiceType.PDF

    @property
    def capability_description(self) -> str:
        return "PDF processing, extraction, and generation capabilities"

    @abstractmethod
    async def extract_text(self, pdf_path: str | bytes) -> PdfExtractionResult: ...

    @abstractmethod
    async def generate_pdf(
        self, html_content: str, options: PdfGenerationOptions | None = None
    ) -> bytes: ...

    @abstractmethod
    async def convert_to_pdf(
        self, file_path: str, options: PdfConversionOptions | None = None
    ) -> bytes: ...

    @abstractmethod
    async def merge_pdfs(self, pdf_paths: list[str | bytes]) -> bytes: ...

    @abstractmethod
    async def split_pdf(self, pdf_path: str | bytes) -> list[bytes]: ...


# ============================================================================
# Web Search Interfaces
# ============================================================================


class SearchDateRange(BaseModel):
    start: datetime | None = None
    end: datetime | None = None


class WebSearchBaseOptions(BaseModel):
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
    query: str = Field(..., description="Original query")
    results: list[SearchResult] = Field(default_factory=list, description="Search results")
    total_results: int | None = None
    search_time: float | None = None
    suggestions: list[str] | None = None
    next_page_token: str | None = None
    related_searches: list[str] | None = None


class NewsSearchOptions(WebSearchBaseOptions):
    category: (
        Literal["general", "business", "entertainment", "health", "science", "sports", "technology"]
        | None
    ) = None
    freshness: Literal["day", "week", "month"] | None = None


class ImageSearchOptions(WebSearchBaseOptions):
    size: Literal["small", "medium", "large", "wallpaper", "any"] | None = None
    color: str | None = None
    image_type: Literal["photo", "clipart", "line", "animated"] | None = None
    layout: Literal["square", "wide", "tall", "any"] | None = None
    license: Literal["any", "public", "share", "sharecommercially", "modify"] | None = None


class VideoSearchOptions(WebSearchBaseOptions):
    duration: Literal["short", "medium", "long", "any"] | None = None
    resolution: Literal["high", "standard", "any"] | None = None
    quality: Literal["high", "standard", "any"] | None = None


class PageInfo(BaseModel):
    title: str = Field(..., description="Page title")
    description: str = Field(..., description="Page description")
    content: str = Field(..., description="Page content")
    metadata: dict[str, str] = Field(default_factory=dict, description="Page metadata")
    images: list[str] = Field(default_factory=list, description="Image URLs")
    links: list[str] = Field(default_factory=list, description="Link URLs")


class IWebSearchService(Service):
    service_type: ClassVar[str] = ServiceType.WEB_SEARCH

    @property
    def capability_description(self) -> str:
        return "Web search and content discovery capabilities"

    @abstractmethod
    async def search(
        self, query: str, options: WebSearchBaseOptions | None = None
    ) -> SearchResponse: ...

    @abstractmethod
    async def search_news(
        self, query: str, options: NewsSearchOptions | None = None
    ) -> SearchResponse: ...

    @abstractmethod
    async def search_images(
        self, query: str, options: ImageSearchOptions | None = None
    ) -> SearchResponse: ...

    @abstractmethod
    async def search_videos(
        self, query: str, options: VideoSearchOptions | None = None
    ) -> SearchResponse: ...

    @abstractmethod
    async def get_suggestions(self, query: str) -> list[str]: ...

    @abstractmethod
    async def get_trending_searches(self, region: str | None = None) -> list[str]: ...

    @abstractmethod
    async def get_page_info(self, url: str) -> PageInfo: ...


# ============================================================================
# Email Interfaces
# ============================================================================


class EmailAddress(BaseModel):
    email: str = Field(..., description="Email address")
    name: str | None = None


class EmailAttachment(BaseModel):
    filename: str = Field(..., description="Filename")
    content: bytes | str = Field(..., description="Content as bytes or base64")
    content_type: str | None = None
    content_disposition: Literal["attachment", "inline"] | None = None
    cid: str | None = None


class EmailMessage(BaseModel):
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
    retry: int | None = None
    timeout: int | None = None
    track_opens: bool | None = None
    track_clicks: bool | None = None
    tags: list[str] | None = None


class EmailSearchOptions(BaseModel):
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
    email: str = Field(..., description="Email address")
    name: str | None = None
    provider: str | None = None
    folders: list[EmailFolder] | None = None
    quota_used: int | None = None
    quota_limit: int | None = None


class IEmailService(Service):
    service_type: ClassVar[str] = ServiceType.EMAIL

    @property
    def capability_description(self) -> str:
        return "Email sending, receiving, and management capabilities"

    @abstractmethod
    async def send_email(
        self, message: EmailMessage, options: EmailSendOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def get_emails(self, options: EmailSearchOptions | None = None) -> list[EmailMessage]: ...

    @abstractmethod
    async def get_email(self, message_id: str) -> EmailMessage: ...

    @abstractmethod
    async def delete_email(self, message_id: str) -> None: ...

    @abstractmethod
    async def mark_email_as_read(self, message_id: str, read: bool) -> None: ...

    @abstractmethod
    async def flag_email(self, message_id: str, flagged: bool) -> None: ...

    @abstractmethod
    async def move_email(self, message_id: str, folder_path: str) -> None: ...

    @abstractmethod
    async def get_folders(self) -> list[EmailFolder]: ...

    @abstractmethod
    async def create_folder(self, folder_name: str, parent_path: str | None = None) -> None: ...

    @abstractmethod
    async def get_account_info(self) -> EmailAccount: ...

    @abstractmethod
    async def search_emails(
        self, query: str, options: EmailSearchOptions | None = None
    ) -> list[EmailMessage]: ...


# ============================================================================
# Messaging Interfaces
# ============================================================================


class MessageParticipant(BaseModel):
    id: str = Field(..., description="Participant ID (UUID)")
    name: str = Field(..., description="Display name")
    username: str | None = None
    avatar: str | None = None
    status: Literal["online", "offline", "away", "busy"] | None = None


class MessageAttachment(BaseModel):
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
    emoji: str = Field(..., description="Emoji used")
    count: int = Field(..., description="Number of reactions")
    users: list[str] = Field(default_factory=list, description="User IDs who reacted")
    has_reacted: bool = Field(..., description="Whether current user has reacted")


class MessageReference(BaseModel):
    message_id: str = Field(..., description="Referenced message ID")
    channel_id: str = Field(..., description="Channel of referenced message")
    ref_type: Literal["reply", "forward", "quote"] = Field(
        ..., alias="type", description="Type of reference"
    )

    model_config = {"populate_by_name": True}


class EmbedField(BaseModel):
    name: str = Field(..., description="Field name")
    value: str = Field(..., description="Field value")
    inline: bool | None = None


class MessageEmbed(BaseModel):
    title: str | None = None
    description: str | None = None
    url: str | None = None
    image: str | None = None
    fields: list[EmbedField] | None = None


class MessageContent(BaseModel):
    text: str | None = None
    html: str | None = None
    markdown: str | None = None
    attachments: list[MessageAttachment] | None = None
    reactions: list[MessageReaction] | None = None
    reference: MessageReference | None = None
    mentions: list[str] | None = None
    embeds: list[MessageEmbed] | None = None


class MessageThread(BaseModel):
    id: str = Field(..., description="Thread ID")
    message_count: int = Field(..., description="Number of messages")
    participants: list[str] = Field(default_factory=list, description="Participant IDs")
    last_message_at: datetime = Field(..., description="Last message timestamp")


class MessageInfo(BaseModel):
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
    reply_to: str | None = None
    ephemeral: bool | None = None
    silent: bool | None = None
    scheduled: datetime | None = None
    thread: str | None = None
    nonce: str | None = None


class MessageSearchOptions(BaseModel):
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
    can_send: bool = Field(..., description="Can send messages")
    can_read: bool = Field(..., description="Can read messages")
    can_delete: bool = Field(..., description="Can delete messages")
    can_pin: bool = Field(..., description="Can pin messages")
    can_manage: bool = Field(..., description="Can manage channel")


class MessageChannel(BaseModel):
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
    service_type: ClassVar[str] = ServiceType.MESSAGE

    @property
    def capability_description(self) -> str:
        return "Platform messaging and channel management capabilities"

    @abstractmethod
    async def send_message(
        self, channel_id: str, content: MessageContent, options: MessageSendOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def get_messages(
        self, channel_id: str, options: MessageSearchOptions | None = None
    ) -> list[MessageInfo]: ...

    @abstractmethod
    async def get_message(self, message_id: str) -> MessageInfo: ...

    @abstractmethod
    async def edit_message(self, message_id: str, content: MessageContent) -> None: ...

    @abstractmethod
    async def delete_message(self, message_id: str) -> None: ...

    @abstractmethod
    async def add_reaction(self, message_id: str, emoji: str) -> None: ...

    @abstractmethod
    async def remove_reaction(self, message_id: str, emoji: str) -> None: ...

    @abstractmethod
    async def pin_message(self, message_id: str) -> None: ...

    @abstractmethod
    async def unpin_message(self, message_id: str) -> None: ...

    @abstractmethod
    async def get_channels(self) -> list[MessageChannel]: ...

    @abstractmethod
    async def get_channel(self, channel_id: str) -> MessageChannel: ...

    @abstractmethod
    async def create_channel(
        self,
        name: str,
        channel_type: str,
        description: str | None = None,
        participants: list[str] | None = None,
        private: bool | None = None,
    ) -> str: ...

    @abstractmethod
    async def search_messages(
        self, query: str, options: MessageSearchOptions | None = None
    ) -> list[MessageInfo]: ...


# ============================================================================
# Post/Social Media Interfaces
# ============================================================================


class PostMedia(BaseModel):
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
    name: str = Field(..., description="Location name")
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    place_id: str | None = None


class PostAuthor(BaseModel):
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
    likes: int = Field(..., description="Number of likes")
    shares: int = Field(..., description="Number of shares")
    comments: int = Field(..., description="Number of comments")
    views: int | None = None
    has_liked: bool = Field(..., description="Whether current user has liked")
    has_shared: bool = Field(..., description="Whether current user has shared")
    has_commented: bool = Field(..., description="Whether current user has commented")
    has_saved: bool = Field(..., description="Whether current user has saved")


class PostLinkPreview(BaseModel):
    url: str = Field(..., description="Link URL")
    title: str | None = None
    description: str | None = None
    image: str | None = None


class PollOption(BaseModel):
    text: str = Field(..., description="Option text")
    votes: int = Field(..., description="Number of votes")


class PostPoll(BaseModel):
    question: str = Field(..., description="Poll question")
    options: list[PollOption] = Field(..., description="Poll options")
    expires_at: datetime | None = None
    multiple_choice: bool | None = None


class PostContent(BaseModel):
    text: str | None = None
    html: str | None = None
    media: list[PostMedia] | None = None
    location: PostLocation | None = None
    tags: list[str] | None = None
    mentions: list[str] | None = None
    links: list[PostLinkPreview] | None = None
    poll: PostPoll | None = None


class PostThread(BaseModel):
    id: str = Field(..., description="Thread ID")
    position: int = Field(..., description="Position in thread")
    total: int = Field(..., description="Total posts in thread")


class CrossPostedInfo(BaseModel):
    platform: str = Field(..., description="Platform name")
    platform_id: str = Field(..., description="Platform-specific ID")
    url: str = Field(..., description="Post URL")


class PostInfo(BaseModel):
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
    age: dict[str, int] | None = None
    gender: dict[str, int] | None = None
    location: dict[str, int] | None = None


class PerformingHour(BaseModel):
    hour: int = Field(..., description="Hour of day (0-23)")
    engagement: int = Field(..., description="Engagement count")


class PostAnalytics(BaseModel):
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
    service_type: ClassVar[str] = ServiceType.POST

    @property
    def capability_description(self) -> str:
        return "Social media posting and content management capabilities"

    @abstractmethod
    async def create_post(
        self, content: PostContent, options: PostCreateOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def get_posts(self, options: PostSearchOptions | None = None) -> list[PostInfo]: ...

    @abstractmethod
    async def get_post(self, post_id: str) -> PostInfo: ...

    @abstractmethod
    async def edit_post(self, post_id: str, content: PostContent) -> None: ...

    @abstractmethod
    async def delete_post(self, post_id: str) -> None: ...

    @abstractmethod
    async def like_post(self, post_id: str, like: bool) -> None: ...

    @abstractmethod
    async def share_post(self, post_id: str, comment: str | None = None) -> str: ...

    @abstractmethod
    async def save_post(self, post_id: str, save: bool) -> None: ...

    @abstractmethod
    async def comment_on_post(self, post_id: str, content: PostContent) -> str: ...

    @abstractmethod
    async def get_comments(
        self, post_id: str, options: PostSearchOptions | None = None
    ) -> list[PostInfo]: ...

    @abstractmethod
    async def schedule_post(
        self, content: PostContent, scheduled_at: datetime, options: PostCreateOptions | None = None
    ) -> str: ...

    @abstractmethod
    async def get_post_analytics(self, post_id: str) -> PostAnalytics: ...

    @abstractmethod
    async def get_trending_posts(
        self, options: PostSearchOptions | None = None
    ) -> list[PostInfo]: ...

    @abstractmethod
    async def search_posts(
        self, query: str, options: PostSearchOptions | None = None
    ) -> list[PostInfo]: ...
