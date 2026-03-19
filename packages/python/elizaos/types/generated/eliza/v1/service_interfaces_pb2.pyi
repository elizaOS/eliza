from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TokenBalance(_message.Message):
    __slots__ = ("address", "balance", "decimals", "ui_amount", "name", "symbol", "logo_uri")
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    BALANCE_FIELD_NUMBER: _ClassVar[int]
    DECIMALS_FIELD_NUMBER: _ClassVar[int]
    UI_AMOUNT_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    SYMBOL_FIELD_NUMBER: _ClassVar[int]
    LOGO_URI_FIELD_NUMBER: _ClassVar[int]
    address: str
    balance: str
    decimals: int
    ui_amount: float
    name: str
    symbol: str
    logo_uri: str
    def __init__(self, address: _Optional[str] = ..., balance: _Optional[str] = ..., decimals: _Optional[int] = ..., ui_amount: _Optional[float] = ..., name: _Optional[str] = ..., symbol: _Optional[str] = ..., logo_uri: _Optional[str] = ...) -> None: ...

class TokenData(_message.Message):
    __slots__ = ("id", "symbol", "name", "address", "chain", "source_provider", "price", "price_change_24h_percent", "price_change_24h_usd", "volume_24h_usd", "market_cap_usd", "liquidity", "holders", "logo_uri", "decimals", "last_updated_at", "raw")
    ID_FIELD_NUMBER: _ClassVar[int]
    SYMBOL_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    CHAIN_FIELD_NUMBER: _ClassVar[int]
    SOURCE_PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    PRICE_CHANGE_24H_PERCENT_FIELD_NUMBER: _ClassVar[int]
    PRICE_CHANGE_24H_USD_FIELD_NUMBER: _ClassVar[int]
    VOLUME_24H_USD_FIELD_NUMBER: _ClassVar[int]
    MARKET_CAP_USD_FIELD_NUMBER: _ClassVar[int]
    LIQUIDITY_FIELD_NUMBER: _ClassVar[int]
    HOLDERS_FIELD_NUMBER: _ClassVar[int]
    LOGO_URI_FIELD_NUMBER: _ClassVar[int]
    DECIMALS_FIELD_NUMBER: _ClassVar[int]
    LAST_UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    RAW_FIELD_NUMBER: _ClassVar[int]
    id: str
    symbol: str
    name: str
    address: str
    chain: str
    source_provider: str
    price: float
    price_change_24h_percent: float
    price_change_24h_usd: float
    volume_24h_usd: float
    market_cap_usd: float
    liquidity: float
    holders: float
    logo_uri: str
    decimals: int
    last_updated_at: _timestamp_pb2.Timestamp
    raw: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., symbol: _Optional[str] = ..., name: _Optional[str] = ..., address: _Optional[str] = ..., chain: _Optional[str] = ..., source_provider: _Optional[str] = ..., price: _Optional[float] = ..., price_change_24h_percent: _Optional[float] = ..., price_change_24h_usd: _Optional[float] = ..., volume_24h_usd: _Optional[float] = ..., market_cap_usd: _Optional[float] = ..., liquidity: _Optional[float] = ..., holders: _Optional[float] = ..., logo_uri: _Optional[str] = ..., decimals: _Optional[int] = ..., last_updated_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., raw: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class WalletAsset(_message.Message):
    __slots__ = ("address", "balance", "decimals", "ui_amount", "name", "symbol", "logo_uri", "price_usd", "value_usd")
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    BALANCE_FIELD_NUMBER: _ClassVar[int]
    DECIMALS_FIELD_NUMBER: _ClassVar[int]
    UI_AMOUNT_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    SYMBOL_FIELD_NUMBER: _ClassVar[int]
    LOGO_URI_FIELD_NUMBER: _ClassVar[int]
    PRICE_USD_FIELD_NUMBER: _ClassVar[int]
    VALUE_USD_FIELD_NUMBER: _ClassVar[int]
    address: str
    balance: str
    decimals: int
    ui_amount: float
    name: str
    symbol: str
    logo_uri: str
    price_usd: float
    value_usd: float
    def __init__(self, address: _Optional[str] = ..., balance: _Optional[str] = ..., decimals: _Optional[int] = ..., ui_amount: _Optional[float] = ..., name: _Optional[str] = ..., symbol: _Optional[str] = ..., logo_uri: _Optional[str] = ..., price_usd: _Optional[float] = ..., value_usd: _Optional[float] = ...) -> None: ...

class WalletPortfolio(_message.Message):
    __slots__ = ("total_value_usd", "assets")
    TOTAL_VALUE_USD_FIELD_NUMBER: _ClassVar[int]
    ASSETS_FIELD_NUMBER: _ClassVar[int]
    total_value_usd: float
    assets: _containers.RepeatedCompositeFieldContainer[WalletAsset]
    def __init__(self, total_value_usd: _Optional[float] = ..., assets: _Optional[_Iterable[_Union[WalletAsset, _Mapping]]] = ...) -> None: ...

class PoolTokenInfo(_message.Message):
    __slots__ = ("mint", "symbol", "reserve", "decimals")
    MINT_FIELD_NUMBER: _ClassVar[int]
    SYMBOL_FIELD_NUMBER: _ClassVar[int]
    RESERVE_FIELD_NUMBER: _ClassVar[int]
    DECIMALS_FIELD_NUMBER: _ClassVar[int]
    mint: str
    symbol: str
    reserve: str
    decimals: int
    def __init__(self, mint: _Optional[str] = ..., symbol: _Optional[str] = ..., reserve: _Optional[str] = ..., decimals: _Optional[int] = ...) -> None: ...

class PoolInfo(_message.Message):
    __slots__ = ("id", "display_name", "dex", "token_a", "token_b", "lp_token_mint", "apr", "apy", "tvl", "fee", "metadata")
    ID_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    DEX_FIELD_NUMBER: _ClassVar[int]
    TOKEN_A_FIELD_NUMBER: _ClassVar[int]
    TOKEN_B_FIELD_NUMBER: _ClassVar[int]
    LP_TOKEN_MINT_FIELD_NUMBER: _ClassVar[int]
    APR_FIELD_NUMBER: _ClassVar[int]
    APY_FIELD_NUMBER: _ClassVar[int]
    TVL_FIELD_NUMBER: _ClassVar[int]
    FEE_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    display_name: str
    dex: str
    token_a: PoolTokenInfo
    token_b: PoolTokenInfo
    lp_token_mint: str
    apr: float
    apy: float
    tvl: float
    fee: float
    metadata: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., display_name: _Optional[str] = ..., dex: _Optional[str] = ..., token_a: _Optional[_Union[PoolTokenInfo, _Mapping]] = ..., token_b: _Optional[_Union[PoolTokenInfo, _Mapping]] = ..., lp_token_mint: _Optional[str] = ..., apr: _Optional[float] = ..., apy: _Optional[float] = ..., tvl: _Optional[float] = ..., fee: _Optional[float] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class LpPositionDetails(_message.Message):
    __slots__ = ("pool_id", "dex", "lp_token_balance", "underlying_tokens", "value_usd", "accrued_fees", "rewards", "metadata")
    POOL_ID_FIELD_NUMBER: _ClassVar[int]
    DEX_FIELD_NUMBER: _ClassVar[int]
    LP_TOKEN_BALANCE_FIELD_NUMBER: _ClassVar[int]
    UNDERLYING_TOKENS_FIELD_NUMBER: _ClassVar[int]
    VALUE_USD_FIELD_NUMBER: _ClassVar[int]
    ACCRUED_FEES_FIELD_NUMBER: _ClassVar[int]
    REWARDS_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    pool_id: str
    dex: str
    lp_token_balance: TokenBalance
    underlying_tokens: _containers.RepeatedCompositeFieldContainer[TokenBalance]
    value_usd: float
    accrued_fees: _containers.RepeatedCompositeFieldContainer[TokenBalance]
    rewards: _containers.RepeatedCompositeFieldContainer[TokenBalance]
    metadata: _struct_pb2.Struct
    def __init__(self, pool_id: _Optional[str] = ..., dex: _Optional[str] = ..., lp_token_balance: _Optional[_Union[TokenBalance, _Mapping]] = ..., underlying_tokens: _Optional[_Iterable[_Union[TokenBalance, _Mapping]]] = ..., value_usd: _Optional[float] = ..., accrued_fees: _Optional[_Iterable[_Union[TokenBalance, _Mapping]]] = ..., rewards: _Optional[_Iterable[_Union[TokenBalance, _Mapping]]] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class TransactionResult(_message.Message):
    __slots__ = ("success", "transaction_id", "error", "data")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TRANSACTION_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    success: bool
    transaction_id: str
    error: str
    data: _struct_pb2.Struct
    def __init__(self, success: bool = ..., transaction_id: _Optional[str] = ..., error: _Optional[str] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class TranscriptionOptions(_message.Message):
    __slots__ = ("language", "model", "temperature", "prompt", "response_format", "timestamp_granularities", "word_timestamps", "segment_timestamps")
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FORMAT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_GRANULARITIES_FIELD_NUMBER: _ClassVar[int]
    WORD_TIMESTAMPS_FIELD_NUMBER: _ClassVar[int]
    SEGMENT_TIMESTAMPS_FIELD_NUMBER: _ClassVar[int]
    language: str
    model: str
    temperature: float
    prompt: str
    response_format: str
    timestamp_granularities: _containers.RepeatedScalarFieldContainer[str]
    word_timestamps: bool
    segment_timestamps: bool
    def __init__(self, language: _Optional[str] = ..., model: _Optional[str] = ..., temperature: _Optional[float] = ..., prompt: _Optional[str] = ..., response_format: _Optional[str] = ..., timestamp_granularities: _Optional[_Iterable[str]] = ..., word_timestamps: bool = ..., segment_timestamps: bool = ...) -> None: ...

class TranscriptionResult(_message.Message):
    __slots__ = ("text", "language", "duration", "segments", "words", "confidence")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    SEGMENTS_FIELD_NUMBER: _ClassVar[int]
    WORDS_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    text: str
    language: str
    duration: float
    segments: _containers.RepeatedCompositeFieldContainer[TranscriptionSegment]
    words: _containers.RepeatedCompositeFieldContainer[TranscriptionWord]
    confidence: float
    def __init__(self, text: _Optional[str] = ..., language: _Optional[str] = ..., duration: _Optional[float] = ..., segments: _Optional[_Iterable[_Union[TranscriptionSegment, _Mapping]]] = ..., words: _Optional[_Iterable[_Union[TranscriptionWord, _Mapping]]] = ..., confidence: _Optional[float] = ...) -> None: ...

class TranscriptionSegment(_message.Message):
    __slots__ = ("id", "text", "start", "end", "confidence", "tokens", "temperature", "avg_logprob", "compression_ratio", "no_speech_prob")
    ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    START_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    TOKENS_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    AVG_LOGPROB_FIELD_NUMBER: _ClassVar[int]
    COMPRESSION_RATIO_FIELD_NUMBER: _ClassVar[int]
    NO_SPEECH_PROB_FIELD_NUMBER: _ClassVar[int]
    id: int
    text: str
    start: float
    end: float
    confidence: float
    tokens: _containers.RepeatedScalarFieldContainer[int]
    temperature: float
    avg_logprob: float
    compression_ratio: float
    no_speech_prob: float
    def __init__(self, id: _Optional[int] = ..., text: _Optional[str] = ..., start: _Optional[float] = ..., end: _Optional[float] = ..., confidence: _Optional[float] = ..., tokens: _Optional[_Iterable[int]] = ..., temperature: _Optional[float] = ..., avg_logprob: _Optional[float] = ..., compression_ratio: _Optional[float] = ..., no_speech_prob: _Optional[float] = ...) -> None: ...

class TranscriptionWord(_message.Message):
    __slots__ = ("word", "start", "end", "confidence")
    WORD_FIELD_NUMBER: _ClassVar[int]
    START_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    word: str
    start: float
    end: float
    confidence: float
    def __init__(self, word: _Optional[str] = ..., start: _Optional[float] = ..., end: _Optional[float] = ..., confidence: _Optional[float] = ...) -> None: ...

class SpeechToTextOptions(_message.Message):
    __slots__ = ("language", "model", "continuous", "interim_results", "max_alternatives")
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    CONTINUOUS_FIELD_NUMBER: _ClassVar[int]
    INTERIM_RESULTS_FIELD_NUMBER: _ClassVar[int]
    MAX_ALTERNATIVES_FIELD_NUMBER: _ClassVar[int]
    language: str
    model: str
    continuous: bool
    interim_results: bool
    max_alternatives: int
    def __init__(self, language: _Optional[str] = ..., model: _Optional[str] = ..., continuous: bool = ..., interim_results: bool = ..., max_alternatives: _Optional[int] = ...) -> None: ...

class TextToSpeechOptions(_message.Message):
    __slots__ = ("voice", "model", "speed", "format", "response_format")
    VOICE_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    SPEED_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FORMAT_FIELD_NUMBER: _ClassVar[int]
    voice: str
    model: str
    speed: float
    format: str
    response_format: str
    def __init__(self, voice: _Optional[str] = ..., model: _Optional[str] = ..., speed: _Optional[float] = ..., format: _Optional[str] = ..., response_format: _Optional[str] = ...) -> None: ...

class VideoInfo(_message.Message):
    __slots__ = ("title", "duration", "url", "thumbnail", "description", "uploader", "view_count", "upload_date", "formats")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    THUMBNAIL_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    UPLOADER_FIELD_NUMBER: _ClassVar[int]
    VIEW_COUNT_FIELD_NUMBER: _ClassVar[int]
    UPLOAD_DATE_FIELD_NUMBER: _ClassVar[int]
    FORMATS_FIELD_NUMBER: _ClassVar[int]
    title: str
    duration: float
    url: str
    thumbnail: str
    description: str
    uploader: str
    view_count: float
    upload_date: _timestamp_pb2.Timestamp
    formats: _containers.RepeatedCompositeFieldContainer[VideoFormat]
    def __init__(self, title: _Optional[str] = ..., duration: _Optional[float] = ..., url: _Optional[str] = ..., thumbnail: _Optional[str] = ..., description: _Optional[str] = ..., uploader: _Optional[str] = ..., view_count: _Optional[float] = ..., upload_date: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., formats: _Optional[_Iterable[_Union[VideoFormat, _Mapping]]] = ...) -> None: ...

class VideoFormat(_message.Message):
    __slots__ = ("format_id", "url", "extension", "quality", "file_size", "video_codec", "audio_codec", "resolution", "fps", "bitrate")
    FORMAT_ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    EXTENSION_FIELD_NUMBER: _ClassVar[int]
    QUALITY_FIELD_NUMBER: _ClassVar[int]
    FILE_SIZE_FIELD_NUMBER: _ClassVar[int]
    VIDEO_CODEC_FIELD_NUMBER: _ClassVar[int]
    AUDIO_CODEC_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    FPS_FIELD_NUMBER: _ClassVar[int]
    BITRATE_FIELD_NUMBER: _ClassVar[int]
    format_id: str
    url: str
    extension: str
    quality: str
    file_size: int
    video_codec: str
    audio_codec: str
    resolution: str
    fps: float
    bitrate: float
    def __init__(self, format_id: _Optional[str] = ..., url: _Optional[str] = ..., extension: _Optional[str] = ..., quality: _Optional[str] = ..., file_size: _Optional[int] = ..., video_codec: _Optional[str] = ..., audio_codec: _Optional[str] = ..., resolution: _Optional[str] = ..., fps: _Optional[float] = ..., bitrate: _Optional[float] = ...) -> None: ...

class VideoDownloadOptions(_message.Message):
    __slots__ = ("format", "quality", "output_path", "audio_only", "video_only", "subtitles", "embed_subs", "write_info_json")
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    QUALITY_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_PATH_FIELD_NUMBER: _ClassVar[int]
    AUDIO_ONLY_FIELD_NUMBER: _ClassVar[int]
    VIDEO_ONLY_FIELD_NUMBER: _ClassVar[int]
    SUBTITLES_FIELD_NUMBER: _ClassVar[int]
    EMBED_SUBS_FIELD_NUMBER: _ClassVar[int]
    WRITE_INFO_JSON_FIELD_NUMBER: _ClassVar[int]
    format: str
    quality: str
    output_path: str
    audio_only: bool
    video_only: bool
    subtitles: bool
    embed_subs: bool
    write_info_json: bool
    def __init__(self, format: _Optional[str] = ..., quality: _Optional[str] = ..., output_path: _Optional[str] = ..., audio_only: bool = ..., video_only: bool = ..., subtitles: bool = ..., embed_subs: bool = ..., write_info_json: bool = ...) -> None: ...

class VideoProcessingOptions(_message.Message):
    __slots__ = ("start_time", "end_time", "output_format", "resolution", "bitrate", "framerate", "audio_codec", "video_codec")
    START_TIME_FIELD_NUMBER: _ClassVar[int]
    END_TIME_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_FORMAT_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    BITRATE_FIELD_NUMBER: _ClassVar[int]
    FRAMERATE_FIELD_NUMBER: _ClassVar[int]
    AUDIO_CODEC_FIELD_NUMBER: _ClassVar[int]
    VIDEO_CODEC_FIELD_NUMBER: _ClassVar[int]
    start_time: float
    end_time: float
    output_format: str
    resolution: str
    bitrate: str
    framerate: float
    audio_codec: str
    video_codec: str
    def __init__(self, start_time: _Optional[float] = ..., end_time: _Optional[float] = ..., output_format: _Optional[str] = ..., resolution: _Optional[str] = ..., bitrate: _Optional[str] = ..., framerate: _Optional[float] = ..., audio_codec: _Optional[str] = ..., video_codec: _Optional[str] = ...) -> None: ...

class BrowserViewport(_message.Message):
    __slots__ = ("width", "height")
    WIDTH_FIELD_NUMBER: _ClassVar[int]
    HEIGHT_FIELD_NUMBER: _ClassVar[int]
    width: int
    height: int
    def __init__(self, width: _Optional[int] = ..., height: _Optional[int] = ...) -> None: ...

class BrowserNavigationOptions(_message.Message):
    __slots__ = ("timeout", "wait_until", "viewport", "user_agent", "headers")
    class HeadersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    WAIT_UNTIL_FIELD_NUMBER: _ClassVar[int]
    VIEWPORT_FIELD_NUMBER: _ClassVar[int]
    USER_AGENT_FIELD_NUMBER: _ClassVar[int]
    HEADERS_FIELD_NUMBER: _ClassVar[int]
    timeout: int
    wait_until: str
    viewport: BrowserViewport
    user_agent: str
    headers: _containers.ScalarMap[str, str]
    def __init__(self, timeout: _Optional[int] = ..., wait_until: _Optional[str] = ..., viewport: _Optional[_Union[BrowserViewport, _Mapping]] = ..., user_agent: _Optional[str] = ..., headers: _Optional[_Mapping[str, str]] = ...) -> None: ...

class ScreenshotClip(_message.Message):
    __slots__ = ("x", "y", "width", "height")
    X_FIELD_NUMBER: _ClassVar[int]
    Y_FIELD_NUMBER: _ClassVar[int]
    WIDTH_FIELD_NUMBER: _ClassVar[int]
    HEIGHT_FIELD_NUMBER: _ClassVar[int]
    x: int
    y: int
    width: int
    height: int
    def __init__(self, x: _Optional[int] = ..., y: _Optional[int] = ..., width: _Optional[int] = ..., height: _Optional[int] = ...) -> None: ...

class ScreenshotOptions(_message.Message):
    __slots__ = ("full_page", "clip", "format", "quality", "omit_background")
    FULL_PAGE_FIELD_NUMBER: _ClassVar[int]
    CLIP_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    QUALITY_FIELD_NUMBER: _ClassVar[int]
    OMIT_BACKGROUND_FIELD_NUMBER: _ClassVar[int]
    full_page: bool
    clip: ScreenshotClip
    format: str
    quality: int
    omit_background: bool
    def __init__(self, full_page: bool = ..., clip: _Optional[_Union[ScreenshotClip, _Mapping]] = ..., format: _Optional[str] = ..., quality: _Optional[int] = ..., omit_background: bool = ...) -> None: ...

class ElementSelector(_message.Message):
    __slots__ = ("selector", "text", "timeout")
    SELECTOR_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    selector: str
    text: str
    timeout: int
    def __init__(self, selector: _Optional[str] = ..., text: _Optional[str] = ..., timeout: _Optional[int] = ...) -> None: ...

class LinkInfo(_message.Message):
    __slots__ = ("url", "text")
    URL_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    url: str
    text: str
    def __init__(self, url: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class ImageInfo(_message.Message):
    __slots__ = ("src", "alt")
    SRC_FIELD_NUMBER: _ClassVar[int]
    ALT_FIELD_NUMBER: _ClassVar[int]
    src: str
    alt: str
    def __init__(self, src: _Optional[str] = ..., alt: _Optional[str] = ...) -> None: ...

class ExtractedContent(_message.Message):
    __slots__ = ("text", "html", "links", "images", "title", "metadata")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HTML_FIELD_NUMBER: _ClassVar[int]
    LINKS_FIELD_NUMBER: _ClassVar[int]
    IMAGES_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    text: str
    html: str
    links: _containers.RepeatedCompositeFieldContainer[LinkInfo]
    images: _containers.RepeatedCompositeFieldContainer[ImageInfo]
    title: str
    metadata: _containers.ScalarMap[str, str]
    def __init__(self, text: _Optional[str] = ..., html: _Optional[str] = ..., links: _Optional[_Iterable[_Union[LinkInfo, _Mapping]]] = ..., images: _Optional[_Iterable[_Union[ImageInfo, _Mapping]]] = ..., title: _Optional[str] = ..., metadata: _Optional[_Mapping[str, str]] = ...) -> None: ...

class ClickOptions(_message.Message):
    __slots__ = ("timeout", "force", "wait_for_navigation")
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    FORCE_FIELD_NUMBER: _ClassVar[int]
    WAIT_FOR_NAVIGATION_FIELD_NUMBER: _ClassVar[int]
    timeout: int
    force: bool
    wait_for_navigation: bool
    def __init__(self, timeout: _Optional[int] = ..., force: bool = ..., wait_for_navigation: bool = ...) -> None: ...

class TypeOptions(_message.Message):
    __slots__ = ("delay", "timeout", "clear")
    DELAY_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    CLEAR_FIELD_NUMBER: _ClassVar[int]
    delay: int
    timeout: int
    clear: bool
    def __init__(self, delay: _Optional[int] = ..., timeout: _Optional[int] = ..., clear: bool = ...) -> None: ...

class PdfMetadata(_message.Message):
    __slots__ = ("title", "author", "created_at", "modified_at")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    MODIFIED_AT_FIELD_NUMBER: _ClassVar[int]
    title: str
    author: str
    created_at: _timestamp_pb2.Timestamp
    modified_at: _timestamp_pb2.Timestamp
    def __init__(self, title: _Optional[str] = ..., author: _Optional[str] = ..., created_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., modified_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class PdfExtractionResult(_message.Message):
    __slots__ = ("text", "page_count", "metadata")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    PAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    text: str
    page_count: int
    metadata: PdfMetadata
    def __init__(self, text: _Optional[str] = ..., page_count: _Optional[int] = ..., metadata: _Optional[_Union[PdfMetadata, _Mapping]] = ...) -> None: ...

class PdfMargins(_message.Message):
    __slots__ = ("top", "bottom", "left", "right")
    TOP_FIELD_NUMBER: _ClassVar[int]
    BOTTOM_FIELD_NUMBER: _ClassVar[int]
    LEFT_FIELD_NUMBER: _ClassVar[int]
    RIGHT_FIELD_NUMBER: _ClassVar[int]
    top: float
    bottom: float
    left: float
    right: float
    def __init__(self, top: _Optional[float] = ..., bottom: _Optional[float] = ..., left: _Optional[float] = ..., right: _Optional[float] = ...) -> None: ...

class PdfGenerationOptions(_message.Message):
    __slots__ = ("format", "orientation", "margins", "header", "footer")
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    ORIENTATION_FIELD_NUMBER: _ClassVar[int]
    MARGINS_FIELD_NUMBER: _ClassVar[int]
    HEADER_FIELD_NUMBER: _ClassVar[int]
    FOOTER_FIELD_NUMBER: _ClassVar[int]
    format: str
    orientation: str
    margins: PdfMargins
    header: str
    footer: str
    def __init__(self, format: _Optional[str] = ..., orientation: _Optional[str] = ..., margins: _Optional[_Union[PdfMargins, _Mapping]] = ..., header: _Optional[str] = ..., footer: _Optional[str] = ...) -> None: ...

class PdfConversionOptions(_message.Message):
    __slots__ = ("quality", "output_format", "compression")
    QUALITY_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_FORMAT_FIELD_NUMBER: _ClassVar[int]
    COMPRESSION_FIELD_NUMBER: _ClassVar[int]
    quality: str
    output_format: str
    compression: bool
    def __init__(self, quality: _Optional[str] = ..., output_format: _Optional[str] = ..., compression: bool = ...) -> None: ...

class DateRange(_message.Message):
    __slots__ = ("start", "end")
    START_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    start: _timestamp_pb2.Timestamp
    end: _timestamp_pb2.Timestamp
    def __init__(self, start: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., end: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class SearchOptions(_message.Message):
    __slots__ = ("limit", "offset", "language", "region", "date_range", "file_type", "site", "sort_by", "safe_search")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    REGION_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_FIELD_NUMBER: _ClassVar[int]
    FILE_TYPE_FIELD_NUMBER: _ClassVar[int]
    SITE_FIELD_NUMBER: _ClassVar[int]
    SORT_BY_FIELD_NUMBER: _ClassVar[int]
    SAFE_SEARCH_FIELD_NUMBER: _ClassVar[int]
    limit: int
    offset: int
    language: str
    region: str
    date_range: DateRange
    file_type: str
    site: str
    sort_by: str
    safe_search: str
    def __init__(self, limit: _Optional[int] = ..., offset: _Optional[int] = ..., language: _Optional[str] = ..., region: _Optional[str] = ..., date_range: _Optional[_Union[DateRange, _Mapping]] = ..., file_type: _Optional[str] = ..., site: _Optional[str] = ..., sort_by: _Optional[str] = ..., safe_search: _Optional[str] = ...) -> None: ...

class SearchResult(_message.Message):
    __slots__ = ("title", "url", "description", "display_url", "thumbnail", "published_date", "source", "relevance_score", "snippet")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_URL_FIELD_NUMBER: _ClassVar[int]
    THUMBNAIL_FIELD_NUMBER: _ClassVar[int]
    PUBLISHED_DATE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    RELEVANCE_SCORE_FIELD_NUMBER: _ClassVar[int]
    SNIPPET_FIELD_NUMBER: _ClassVar[int]
    title: str
    url: str
    description: str
    display_url: str
    thumbnail: str
    published_date: _timestamp_pb2.Timestamp
    source: str
    relevance_score: float
    snippet: str
    def __init__(self, title: _Optional[str] = ..., url: _Optional[str] = ..., description: _Optional[str] = ..., display_url: _Optional[str] = ..., thumbnail: _Optional[str] = ..., published_date: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., source: _Optional[str] = ..., relevance_score: _Optional[float] = ..., snippet: _Optional[str] = ...) -> None: ...

class SearchResponse(_message.Message):
    __slots__ = ("query", "results", "total_results", "search_time", "suggestions", "next_page_token", "related_searches")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_RESULTS_FIELD_NUMBER: _ClassVar[int]
    SEARCH_TIME_FIELD_NUMBER: _ClassVar[int]
    SUGGESTIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    RELATED_SEARCHES_FIELD_NUMBER: _ClassVar[int]
    query: str
    results: _containers.RepeatedCompositeFieldContainer[SearchResult]
    total_results: int
    search_time: float
    suggestions: _containers.RepeatedScalarFieldContainer[str]
    next_page_token: str
    related_searches: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, query: _Optional[str] = ..., results: _Optional[_Iterable[_Union[SearchResult, _Mapping]]] = ..., total_results: _Optional[int] = ..., search_time: _Optional[float] = ..., suggestions: _Optional[_Iterable[str]] = ..., next_page_token: _Optional[str] = ..., related_searches: _Optional[_Iterable[str]] = ...) -> None: ...

class NewsSearchOptions(_message.Message):
    __slots__ = ("base", "category", "freshness")
    BASE_FIELD_NUMBER: _ClassVar[int]
    CATEGORY_FIELD_NUMBER: _ClassVar[int]
    FRESHNESS_FIELD_NUMBER: _ClassVar[int]
    base: SearchOptions
    category: str
    freshness: str
    def __init__(self, base: _Optional[_Union[SearchOptions, _Mapping]] = ..., category: _Optional[str] = ..., freshness: _Optional[str] = ...) -> None: ...

class ImageSearchOptions(_message.Message):
    __slots__ = ("base", "size", "color", "type", "layout", "license")
    BASE_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    COLOR_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    LAYOUT_FIELD_NUMBER: _ClassVar[int]
    LICENSE_FIELD_NUMBER: _ClassVar[int]
    base: SearchOptions
    size: str
    color: str
    type: str
    layout: str
    license: str
    def __init__(self, base: _Optional[_Union[SearchOptions, _Mapping]] = ..., size: _Optional[str] = ..., color: _Optional[str] = ..., type: _Optional[str] = ..., layout: _Optional[str] = ..., license: _Optional[str] = ...) -> None: ...

class VideoSearchOptions(_message.Message):
    __slots__ = ("base", "duration", "resolution", "quality")
    BASE_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    QUALITY_FIELD_NUMBER: _ClassVar[int]
    base: SearchOptions
    duration: str
    resolution: str
    quality: str
    def __init__(self, base: _Optional[_Union[SearchOptions, _Mapping]] = ..., duration: _Optional[str] = ..., resolution: _Optional[str] = ..., quality: _Optional[str] = ...) -> None: ...

class EmailAddress(_message.Message):
    __slots__ = ("email", "name")
    EMAIL_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    email: str
    name: str
    def __init__(self, email: _Optional[str] = ..., name: _Optional[str] = ...) -> None: ...

class EmailAttachment(_message.Message):
    __slots__ = ("filename", "content_bytes", "content_text", "content_type", "content_disposition", "cid")
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_BYTES_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TEXT_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_DISPOSITION_FIELD_NUMBER: _ClassVar[int]
    CID_FIELD_NUMBER: _ClassVar[int]
    filename: str
    content_bytes: bytes
    content_text: str
    content_type: str
    content_disposition: str
    cid: str
    def __init__(self, filename: _Optional[str] = ..., content_bytes: _Optional[bytes] = ..., content_text: _Optional[str] = ..., content_type: _Optional[str] = ..., content_disposition: _Optional[str] = ..., cid: _Optional[str] = ...) -> None: ...

class EmailMessage(_message.Message):
    __slots__ = ("to", "cc", "bcc", "subject", "text", "html", "attachments", "reply_to", "date", "message_id", "references", "in_reply_to", "priority")
    FROM_FIELD_NUMBER: _ClassVar[int]
    TO_FIELD_NUMBER: _ClassVar[int]
    CC_FIELD_NUMBER: _ClassVar[int]
    BCC_FIELD_NUMBER: _ClassVar[int]
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HTML_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    DATE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    REFERENCES_FIELD_NUMBER: _ClassVar[int]
    IN_REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    to: _containers.RepeatedCompositeFieldContainer[EmailAddress]
    cc: _containers.RepeatedCompositeFieldContainer[EmailAddress]
    bcc: _containers.RepeatedCompositeFieldContainer[EmailAddress]
    subject: str
    text: str
    html: str
    attachments: _containers.RepeatedCompositeFieldContainer[EmailAttachment]
    reply_to: EmailAddress
    date: _timestamp_pb2.Timestamp
    message_id: str
    references: _containers.RepeatedScalarFieldContainer[str]
    in_reply_to: str
    priority: str
    def __init__(self, to: _Optional[_Iterable[_Union[EmailAddress, _Mapping]]] = ..., cc: _Optional[_Iterable[_Union[EmailAddress, _Mapping]]] = ..., bcc: _Optional[_Iterable[_Union[EmailAddress, _Mapping]]] = ..., subject: _Optional[str] = ..., text: _Optional[str] = ..., html: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[EmailAttachment, _Mapping]]] = ..., reply_to: _Optional[_Union[EmailAddress, _Mapping]] = ..., date: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., message_id: _Optional[str] = ..., references: _Optional[_Iterable[str]] = ..., in_reply_to: _Optional[str] = ..., priority: _Optional[str] = ..., **kwargs) -> None: ...

class EmailSendOptions(_message.Message):
    __slots__ = ("retry", "timeout", "track_opens", "track_clicks", "tags")
    RETRY_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    TRACK_OPENS_FIELD_NUMBER: _ClassVar[int]
    TRACK_CLICKS_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    retry: int
    timeout: int
    track_opens: bool
    track_clicks: bool
    tags: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, retry: _Optional[int] = ..., timeout: _Optional[int] = ..., track_opens: bool = ..., track_clicks: bool = ..., tags: _Optional[_Iterable[str]] = ...) -> None: ...

class EmailSearchOptions(_message.Message):
    __slots__ = ("query", "to", "subject", "folder", "since", "before", "limit", "offset", "unread", "flagged", "has_attachments")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    FROM_FIELD_NUMBER: _ClassVar[int]
    TO_FIELD_NUMBER: _ClassVar[int]
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    FOLDER_FIELD_NUMBER: _ClassVar[int]
    SINCE_FIELD_NUMBER: _ClassVar[int]
    BEFORE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    UNREAD_FIELD_NUMBER: _ClassVar[int]
    FLAGGED_FIELD_NUMBER: _ClassVar[int]
    HAS_ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    query: str
    to: str
    subject: str
    folder: str
    since: _timestamp_pb2.Timestamp
    before: _timestamp_pb2.Timestamp
    limit: int
    offset: int
    unread: bool
    flagged: bool
    has_attachments: bool
    def __init__(self, query: _Optional[str] = ..., to: _Optional[str] = ..., subject: _Optional[str] = ..., folder: _Optional[str] = ..., since: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., before: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ..., unread: bool = ..., flagged: bool = ..., has_attachments: bool = ..., **kwargs) -> None: ...

class EmailFolder(_message.Message):
    __slots__ = ("name", "path", "type", "message_count", "unread_count", "children")
    NAME_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    UNREAD_COUNT_FIELD_NUMBER: _ClassVar[int]
    CHILDREN_FIELD_NUMBER: _ClassVar[int]
    name: str
    path: str
    type: str
    message_count: int
    unread_count: int
    children: _containers.RepeatedCompositeFieldContainer[EmailFolder]
    def __init__(self, name: _Optional[str] = ..., path: _Optional[str] = ..., type: _Optional[str] = ..., message_count: _Optional[int] = ..., unread_count: _Optional[int] = ..., children: _Optional[_Iterable[_Union[EmailFolder, _Mapping]]] = ...) -> None: ...

class EmailAccount(_message.Message):
    __slots__ = ("email", "name", "provider", "folders", "quota_used", "quota_limit")
    EMAIL_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    FOLDERS_FIELD_NUMBER: _ClassVar[int]
    QUOTA_USED_FIELD_NUMBER: _ClassVar[int]
    QUOTA_LIMIT_FIELD_NUMBER: _ClassVar[int]
    email: str
    name: str
    provider: str
    folders: _containers.RepeatedCompositeFieldContainer[EmailFolder]
    quota_used: int
    quota_limit: int
    def __init__(self, email: _Optional[str] = ..., name: _Optional[str] = ..., provider: _Optional[str] = ..., folders: _Optional[_Iterable[_Union[EmailFolder, _Mapping]]] = ..., quota_used: _Optional[int] = ..., quota_limit: _Optional[int] = ...) -> None: ...

class MessageParticipant(_message.Message):
    __slots__ = ("id", "name", "username", "avatar", "status")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    USERNAME_FIELD_NUMBER: _ClassVar[int]
    AVATAR_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    username: str
    avatar: str
    status: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., username: _Optional[str] = ..., avatar: _Optional[str] = ..., status: _Optional[str] = ...) -> None: ...

class MessageAttachment(_message.Message):
    __slots__ = ("id", "filename", "url", "mime_type", "size", "width", "height", "duration", "thumbnail")
    ID_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    WIDTH_FIELD_NUMBER: _ClassVar[int]
    HEIGHT_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    THUMBNAIL_FIELD_NUMBER: _ClassVar[int]
    id: str
    filename: str
    url: str
    mime_type: str
    size: int
    width: int
    height: int
    duration: float
    thumbnail: str
    def __init__(self, id: _Optional[str] = ..., filename: _Optional[str] = ..., url: _Optional[str] = ..., mime_type: _Optional[str] = ..., size: _Optional[int] = ..., width: _Optional[int] = ..., height: _Optional[int] = ..., duration: _Optional[float] = ..., thumbnail: _Optional[str] = ...) -> None: ...

class MessageReaction(_message.Message):
    __slots__ = ("emoji", "count", "users", "has_reacted")
    EMOJI_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    USERS_FIELD_NUMBER: _ClassVar[int]
    HAS_REACTED_FIELD_NUMBER: _ClassVar[int]
    emoji: str
    count: int
    users: _containers.RepeatedScalarFieldContainer[str]
    has_reacted: bool
    def __init__(self, emoji: _Optional[str] = ..., count: _Optional[int] = ..., users: _Optional[_Iterable[str]] = ..., has_reacted: bool = ...) -> None: ...

class MessageReference(_message.Message):
    __slots__ = ("message_id", "channel_id", "type")
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    message_id: str
    channel_id: str
    type: str
    def __init__(self, message_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., type: _Optional[str] = ...) -> None: ...

class EmbedField(_message.Message):
    __slots__ = ("name", "value", "inline")
    NAME_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    INLINE_FIELD_NUMBER: _ClassVar[int]
    name: str
    value: str
    inline: bool
    def __init__(self, name: _Optional[str] = ..., value: _Optional[str] = ..., inline: bool = ...) -> None: ...

class MessageEmbed(_message.Message):
    __slots__ = ("title", "description", "url", "image", "fields")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    IMAGE_FIELD_NUMBER: _ClassVar[int]
    FIELDS_FIELD_NUMBER: _ClassVar[int]
    title: str
    description: str
    url: str
    image: str
    fields: _containers.RepeatedCompositeFieldContainer[EmbedField]
    def __init__(self, title: _Optional[str] = ..., description: _Optional[str] = ..., url: _Optional[str] = ..., image: _Optional[str] = ..., fields: _Optional[_Iterable[_Union[EmbedField, _Mapping]]] = ...) -> None: ...

class MessageContent(_message.Message):
    __slots__ = ("text", "html", "markdown", "attachments", "reactions", "reference", "mentions", "embeds")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HTML_FIELD_NUMBER: _ClassVar[int]
    MARKDOWN_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    REACTIONS_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    EMBEDS_FIELD_NUMBER: _ClassVar[int]
    text: str
    html: str
    markdown: str
    attachments: _containers.RepeatedCompositeFieldContainer[MessageAttachment]
    reactions: _containers.RepeatedCompositeFieldContainer[MessageReaction]
    reference: MessageReference
    mentions: _containers.RepeatedScalarFieldContainer[str]
    embeds: _containers.RepeatedCompositeFieldContainer[MessageEmbed]
    def __init__(self, text: _Optional[str] = ..., html: _Optional[str] = ..., markdown: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[MessageAttachment, _Mapping]]] = ..., reactions: _Optional[_Iterable[_Union[MessageReaction, _Mapping]]] = ..., reference: _Optional[_Union[MessageReference, _Mapping]] = ..., mentions: _Optional[_Iterable[str]] = ..., embeds: _Optional[_Iterable[_Union[MessageEmbed, _Mapping]]] = ...) -> None: ...

class MessageThreadInfo(_message.Message):
    __slots__ = ("id", "message_count", "participants", "last_message_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    PARTICIPANTS_FIELD_NUMBER: _ClassVar[int]
    LAST_MESSAGE_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    message_count: int
    participants: _containers.RepeatedScalarFieldContainer[str]
    last_message_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., message_count: _Optional[int] = ..., participants: _Optional[_Iterable[str]] = ..., last_message_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class MessageInfo(_message.Message):
    __slots__ = ("id", "channel_id", "sender_id", "content", "timestamp", "edited", "deleted", "pinned", "thread")
    ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    SENDER_ID_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    EDITED_FIELD_NUMBER: _ClassVar[int]
    DELETED_FIELD_NUMBER: _ClassVar[int]
    PINNED_FIELD_NUMBER: _ClassVar[int]
    THREAD_FIELD_NUMBER: _ClassVar[int]
    id: str
    channel_id: str
    sender_id: str
    content: MessageContent
    timestamp: _timestamp_pb2.Timestamp
    edited: _timestamp_pb2.Timestamp
    deleted: _timestamp_pb2.Timestamp
    pinned: bool
    thread: MessageThreadInfo
    def __init__(self, id: _Optional[str] = ..., channel_id: _Optional[str] = ..., sender_id: _Optional[str] = ..., content: _Optional[_Union[MessageContent, _Mapping]] = ..., timestamp: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., edited: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., deleted: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., pinned: bool = ..., thread: _Optional[_Union[MessageThreadInfo, _Mapping]] = ...) -> None: ...

class MessageSendOptions(_message.Message):
    __slots__ = ("reply_to", "ephemeral", "silent", "scheduled", "thread", "nonce")
    REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    SILENT_FIELD_NUMBER: _ClassVar[int]
    SCHEDULED_FIELD_NUMBER: _ClassVar[int]
    THREAD_FIELD_NUMBER: _ClassVar[int]
    NONCE_FIELD_NUMBER: _ClassVar[int]
    reply_to: str
    ephemeral: bool
    silent: bool
    scheduled: _timestamp_pb2.Timestamp
    thread: str
    nonce: str
    def __init__(self, reply_to: _Optional[str] = ..., ephemeral: bool = ..., silent: bool = ..., scheduled: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., thread: _Optional[str] = ..., nonce: _Optional[str] = ...) -> None: ...

class MessageSearchOptions(_message.Message):
    __slots__ = ("query", "channel_id", "sender_id", "before", "after", "limit", "offset", "has_attachments", "pinned", "mentions")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    SENDER_ID_FIELD_NUMBER: _ClassVar[int]
    BEFORE_FIELD_NUMBER: _ClassVar[int]
    AFTER_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    HAS_ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    PINNED_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    query: str
    channel_id: str
    sender_id: str
    before: _timestamp_pb2.Timestamp
    after: _timestamp_pb2.Timestamp
    limit: int
    offset: int
    has_attachments: bool
    pinned: bool
    mentions: str
    def __init__(self, query: _Optional[str] = ..., channel_id: _Optional[str] = ..., sender_id: _Optional[str] = ..., before: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., after: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ..., has_attachments: bool = ..., pinned: bool = ..., mentions: _Optional[str] = ...) -> None: ...

class ChannelPermissions(_message.Message):
    __slots__ = ("can_send", "can_read", "can_delete", "can_pin", "can_manage")
    CAN_SEND_FIELD_NUMBER: _ClassVar[int]
    CAN_READ_FIELD_NUMBER: _ClassVar[int]
    CAN_DELETE_FIELD_NUMBER: _ClassVar[int]
    CAN_PIN_FIELD_NUMBER: _ClassVar[int]
    CAN_MANAGE_FIELD_NUMBER: _ClassVar[int]
    can_send: bool
    can_read: bool
    can_delete: bool
    can_pin: bool
    can_manage: bool
    def __init__(self, can_send: bool = ..., can_read: bool = ..., can_delete: bool = ..., can_pin: bool = ..., can_manage: bool = ...) -> None: ...

class MessageChannel(_message.Message):
    __slots__ = ("id", "name", "type", "description", "participants", "permissions", "last_message_at", "message_count", "unread_count")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    PARTICIPANTS_FIELD_NUMBER: _ClassVar[int]
    PERMISSIONS_FIELD_NUMBER: _ClassVar[int]
    LAST_MESSAGE_AT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    UNREAD_COUNT_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    type: str
    description: str
    participants: _containers.RepeatedCompositeFieldContainer[MessageParticipant]
    permissions: ChannelPermissions
    last_message_at: _timestamp_pb2.Timestamp
    message_count: int
    unread_count: int
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., type: _Optional[str] = ..., description: _Optional[str] = ..., participants: _Optional[_Iterable[_Union[MessageParticipant, _Mapping]]] = ..., permissions: _Optional[_Union[ChannelPermissions, _Mapping]] = ..., last_message_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., message_count: _Optional[int] = ..., unread_count: _Optional[int] = ...) -> None: ...

class PostMedia(_message.Message):
    __slots__ = ("id", "url", "type", "mime_type", "size", "width", "height", "duration", "thumbnail", "description", "alt_text")
    ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    WIDTH_FIELD_NUMBER: _ClassVar[int]
    HEIGHT_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    THUMBNAIL_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    ALT_TEXT_FIELD_NUMBER: _ClassVar[int]
    id: str
    url: str
    type: str
    mime_type: str
    size: int
    width: int
    height: int
    duration: float
    thumbnail: str
    description: str
    alt_text: str
    def __init__(self, id: _Optional[str] = ..., url: _Optional[str] = ..., type: _Optional[str] = ..., mime_type: _Optional[str] = ..., size: _Optional[int] = ..., width: _Optional[int] = ..., height: _Optional[int] = ..., duration: _Optional[float] = ..., thumbnail: _Optional[str] = ..., description: _Optional[str] = ..., alt_text: _Optional[str] = ...) -> None: ...

class PostLocationCoordinates(_message.Message):
    __slots__ = ("latitude", "longitude")
    LATITUDE_FIELD_NUMBER: _ClassVar[int]
    LONGITUDE_FIELD_NUMBER: _ClassVar[int]
    latitude: float
    longitude: float
    def __init__(self, latitude: _Optional[float] = ..., longitude: _Optional[float] = ...) -> None: ...

class PostLocation(_message.Message):
    __slots__ = ("name", "address", "coordinates", "place_id")
    NAME_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    COORDINATES_FIELD_NUMBER: _ClassVar[int]
    PLACE_ID_FIELD_NUMBER: _ClassVar[int]
    name: str
    address: str
    coordinates: PostLocationCoordinates
    place_id: str
    def __init__(self, name: _Optional[str] = ..., address: _Optional[str] = ..., coordinates: _Optional[_Union[PostLocationCoordinates, _Mapping]] = ..., place_id: _Optional[str] = ...) -> None: ...

class PostAuthor(_message.Message):
    __slots__ = ("id", "username", "display_name", "avatar", "verified", "follower_count", "following_count", "bio", "website")
    ID_FIELD_NUMBER: _ClassVar[int]
    USERNAME_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    AVATAR_FIELD_NUMBER: _ClassVar[int]
    VERIFIED_FIELD_NUMBER: _ClassVar[int]
    FOLLOWER_COUNT_FIELD_NUMBER: _ClassVar[int]
    FOLLOWING_COUNT_FIELD_NUMBER: _ClassVar[int]
    BIO_FIELD_NUMBER: _ClassVar[int]
    WEBSITE_FIELD_NUMBER: _ClassVar[int]
    id: str
    username: str
    display_name: str
    avatar: str
    verified: bool
    follower_count: int
    following_count: int
    bio: str
    website: str
    def __init__(self, id: _Optional[str] = ..., username: _Optional[str] = ..., display_name: _Optional[str] = ..., avatar: _Optional[str] = ..., verified: bool = ..., follower_count: _Optional[int] = ..., following_count: _Optional[int] = ..., bio: _Optional[str] = ..., website: _Optional[str] = ...) -> None: ...

class PostEngagement(_message.Message):
    __slots__ = ("likes", "shares", "comments", "views", "has_liked", "has_shared", "has_commented", "has_saved")
    LIKES_FIELD_NUMBER: _ClassVar[int]
    SHARES_FIELD_NUMBER: _ClassVar[int]
    COMMENTS_FIELD_NUMBER: _ClassVar[int]
    VIEWS_FIELD_NUMBER: _ClassVar[int]
    HAS_LIKED_FIELD_NUMBER: _ClassVar[int]
    HAS_SHARED_FIELD_NUMBER: _ClassVar[int]
    HAS_COMMENTED_FIELD_NUMBER: _ClassVar[int]
    HAS_SAVED_FIELD_NUMBER: _ClassVar[int]
    likes: int
    shares: int
    comments: int
    views: int
    has_liked: bool
    has_shared: bool
    has_commented: bool
    has_saved: bool
    def __init__(self, likes: _Optional[int] = ..., shares: _Optional[int] = ..., comments: _Optional[int] = ..., views: _Optional[int] = ..., has_liked: bool = ..., has_shared: bool = ..., has_commented: bool = ..., has_saved: bool = ...) -> None: ...

class PostLinkPreview(_message.Message):
    __slots__ = ("url", "title", "description", "image")
    URL_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    IMAGE_FIELD_NUMBER: _ClassVar[int]
    url: str
    title: str
    description: str
    image: str
    def __init__(self, url: _Optional[str] = ..., title: _Optional[str] = ..., description: _Optional[str] = ..., image: _Optional[str] = ...) -> None: ...

class PostPollOption(_message.Message):
    __slots__ = ("text", "votes")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VOTES_FIELD_NUMBER: _ClassVar[int]
    text: str
    votes: int
    def __init__(self, text: _Optional[str] = ..., votes: _Optional[int] = ...) -> None: ...

class PostPoll(_message.Message):
    __slots__ = ("question", "options", "expires_at", "multiple_choice")
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    MULTIPLE_CHOICE_FIELD_NUMBER: _ClassVar[int]
    question: str
    options: _containers.RepeatedCompositeFieldContainer[PostPollOption]
    expires_at: _timestamp_pb2.Timestamp
    multiple_choice: bool
    def __init__(self, question: _Optional[str] = ..., options: _Optional[_Iterable[_Union[PostPollOption, _Mapping]]] = ..., expires_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., multiple_choice: bool = ...) -> None: ...

class PostContent(_message.Message):
    __slots__ = ("text", "html", "media", "location", "tags", "mentions", "links", "poll")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HTML_FIELD_NUMBER: _ClassVar[int]
    MEDIA_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    LINKS_FIELD_NUMBER: _ClassVar[int]
    POLL_FIELD_NUMBER: _ClassVar[int]
    text: str
    html: str
    media: _containers.RepeatedCompositeFieldContainer[PostMedia]
    location: PostLocation
    tags: _containers.RepeatedScalarFieldContainer[str]
    mentions: _containers.RepeatedScalarFieldContainer[str]
    links: _containers.RepeatedCompositeFieldContainer[PostLinkPreview]
    poll: PostPoll
    def __init__(self, text: _Optional[str] = ..., html: _Optional[str] = ..., media: _Optional[_Iterable[_Union[PostMedia, _Mapping]]] = ..., location: _Optional[_Union[PostLocation, _Mapping]] = ..., tags: _Optional[_Iterable[str]] = ..., mentions: _Optional[_Iterable[str]] = ..., links: _Optional[_Iterable[_Union[PostLinkPreview, _Mapping]]] = ..., poll: _Optional[_Union[PostPoll, _Mapping]] = ...) -> None: ...

class PostThreadInfo(_message.Message):
    __slots__ = ("id", "position", "total")
    ID_FIELD_NUMBER: _ClassVar[int]
    POSITION_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    id: str
    position: int
    total: int
    def __init__(self, id: _Optional[str] = ..., position: _Optional[int] = ..., total: _Optional[int] = ...) -> None: ...

class CrossPostInfo(_message.Message):
    __slots__ = ("platform", "platform_id", "url")
    PLATFORM_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    platform: str
    platform_id: str
    url: str
    def __init__(self, platform: _Optional[str] = ..., platform_id: _Optional[str] = ..., url: _Optional[str] = ...) -> None: ...

class PostInfo(_message.Message):
    __slots__ = ("id", "author", "content", "platform", "platform_id", "url", "created_at", "edited_at", "scheduled_at", "engagement", "visibility", "reply_to", "thread", "cross_posted")
    ID_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    EDITED_AT_FIELD_NUMBER: _ClassVar[int]
    SCHEDULED_AT_FIELD_NUMBER: _ClassVar[int]
    ENGAGEMENT_FIELD_NUMBER: _ClassVar[int]
    VISIBILITY_FIELD_NUMBER: _ClassVar[int]
    REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    THREAD_FIELD_NUMBER: _ClassVar[int]
    CROSS_POSTED_FIELD_NUMBER: _ClassVar[int]
    id: str
    author: PostAuthor
    content: PostContent
    platform: str
    platform_id: str
    url: str
    created_at: _timestamp_pb2.Timestamp
    edited_at: _timestamp_pb2.Timestamp
    scheduled_at: _timestamp_pb2.Timestamp
    engagement: PostEngagement
    visibility: str
    reply_to: str
    thread: PostThreadInfo
    cross_posted: _containers.RepeatedCompositeFieldContainer[CrossPostInfo]
    def __init__(self, id: _Optional[str] = ..., author: _Optional[_Union[PostAuthor, _Mapping]] = ..., content: _Optional[_Union[PostContent, _Mapping]] = ..., platform: _Optional[str] = ..., platform_id: _Optional[str] = ..., url: _Optional[str] = ..., created_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., edited_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., scheduled_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., engagement: _Optional[_Union[PostEngagement, _Mapping]] = ..., visibility: _Optional[str] = ..., reply_to: _Optional[str] = ..., thread: _Optional[_Union[PostThreadInfo, _Mapping]] = ..., cross_posted: _Optional[_Iterable[_Union[CrossPostInfo, _Mapping]]] = ...) -> None: ...

class PostCreateOptions(_message.Message):
    __slots__ = ("platforms", "scheduled_at", "visibility", "reply_to", "thread", "location", "tags", "mentions", "enable_comments", "enable_sharing", "content_warning", "sensitive")
    PLATFORMS_FIELD_NUMBER: _ClassVar[int]
    SCHEDULED_AT_FIELD_NUMBER: _ClassVar[int]
    VISIBILITY_FIELD_NUMBER: _ClassVar[int]
    REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    THREAD_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    ENABLE_COMMENTS_FIELD_NUMBER: _ClassVar[int]
    ENABLE_SHARING_FIELD_NUMBER: _ClassVar[int]
    CONTENT_WARNING_FIELD_NUMBER: _ClassVar[int]
    SENSITIVE_FIELD_NUMBER: _ClassVar[int]
    platforms: _containers.RepeatedScalarFieldContainer[str]
    scheduled_at: _timestamp_pb2.Timestamp
    visibility: str
    reply_to: str
    thread: bool
    location: PostLocation
    tags: _containers.RepeatedScalarFieldContainer[str]
    mentions: _containers.RepeatedScalarFieldContainer[str]
    enable_comments: bool
    enable_sharing: bool
    content_warning: str
    sensitive: bool
    def __init__(self, platforms: _Optional[_Iterable[str]] = ..., scheduled_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., visibility: _Optional[str] = ..., reply_to: _Optional[str] = ..., thread: bool = ..., location: _Optional[_Union[PostLocation, _Mapping]] = ..., tags: _Optional[_Iterable[str]] = ..., mentions: _Optional[_Iterable[str]] = ..., enable_comments: bool = ..., enable_sharing: bool = ..., content_warning: _Optional[str] = ..., sensitive: bool = ...) -> None: ...

class PostSearchOptions(_message.Message):
    __slots__ = ("query", "author", "platform", "tags", "mentions", "since", "before", "limit", "offset", "has_media", "has_location", "visibility", "sort_by")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    SINCE_FIELD_NUMBER: _ClassVar[int]
    BEFORE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    HAS_MEDIA_FIELD_NUMBER: _ClassVar[int]
    HAS_LOCATION_FIELD_NUMBER: _ClassVar[int]
    VISIBILITY_FIELD_NUMBER: _ClassVar[int]
    SORT_BY_FIELD_NUMBER: _ClassVar[int]
    query: str
    author: str
    platform: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    mentions: _containers.RepeatedScalarFieldContainer[str]
    since: _timestamp_pb2.Timestamp
    before: _timestamp_pb2.Timestamp
    limit: int
    offset: int
    has_media: bool
    has_location: bool
    visibility: str
    sort_by: str
    def __init__(self, query: _Optional[str] = ..., author: _Optional[str] = ..., platform: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ..., mentions: _Optional[_Iterable[str]] = ..., since: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., before: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ..., has_media: bool = ..., has_location: bool = ..., visibility: _Optional[str] = ..., sort_by: _Optional[str] = ...) -> None: ...

class Demographics(_message.Message):
    __slots__ = ("age", "gender", "location")
    class AgeEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    class GenderEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    class LocationEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    AGE_FIELD_NUMBER: _ClassVar[int]
    GENDER_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    age: _containers.ScalarMap[str, float]
    gender: _containers.ScalarMap[str, float]
    location: _containers.ScalarMap[str, float]
    def __init__(self, age: _Optional[_Mapping[str, float]] = ..., gender: _Optional[_Mapping[str, float]] = ..., location: _Optional[_Mapping[str, float]] = ...) -> None: ...

class TopPerformingHour(_message.Message):
    __slots__ = ("hour", "engagement")
    HOUR_FIELD_NUMBER: _ClassVar[int]
    ENGAGEMENT_FIELD_NUMBER: _ClassVar[int]
    hour: int
    engagement: int
    def __init__(self, hour: _Optional[int] = ..., engagement: _Optional[int] = ...) -> None: ...

class PostAnalytics(_message.Message):
    __slots__ = ("post_id", "platform", "impressions", "reach", "engagement", "clicks", "shares", "saves", "demographics", "top_performing_hours")
    POST_ID_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_FIELD_NUMBER: _ClassVar[int]
    IMPRESSIONS_FIELD_NUMBER: _ClassVar[int]
    REACH_FIELD_NUMBER: _ClassVar[int]
    ENGAGEMENT_FIELD_NUMBER: _ClassVar[int]
    CLICKS_FIELD_NUMBER: _ClassVar[int]
    SHARES_FIELD_NUMBER: _ClassVar[int]
    SAVES_FIELD_NUMBER: _ClassVar[int]
    DEMOGRAPHICS_FIELD_NUMBER: _ClassVar[int]
    TOP_PERFORMING_HOURS_FIELD_NUMBER: _ClassVar[int]
    post_id: str
    platform: str
    impressions: int
    reach: int
    engagement: PostEngagement
    clicks: int
    shares: int
    saves: int
    demographics: Demographics
    top_performing_hours: _containers.RepeatedCompositeFieldContainer[TopPerformingHour]
    def __init__(self, post_id: _Optional[str] = ..., platform: _Optional[str] = ..., impressions: _Optional[int] = ..., reach: _Optional[int] = ..., engagement: _Optional[_Union[PostEngagement, _Mapping]] = ..., clicks: _Optional[int] = ..., shares: _Optional[int] = ..., saves: _Optional[int] = ..., demographics: _Optional[_Union[Demographics, _Mapping]] = ..., top_performing_hours: _Optional[_Iterable[_Union[TopPerformingHour, _Mapping]]] = ...) -> None: ...
