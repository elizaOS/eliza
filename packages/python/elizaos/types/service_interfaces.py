from __future__ import annotations

from abc import ABC
from dataclasses import dataclass, field
from typing import Any

from elizaos.types.generated.eliza.v1 import service_interfaces_pb2

TokenBalance = service_interfaces_pb2.TokenBalance
TokenData = service_interfaces_pb2.TokenData
WalletAsset = service_interfaces_pb2.WalletAsset
WalletPortfolio = service_interfaces_pb2.WalletPortfolio
PoolTokenInfo = service_interfaces_pb2.PoolTokenInfo
PoolInfo = service_interfaces_pb2.PoolInfo
LpPositionDetails = service_interfaces_pb2.LpPositionDetails
TransactionResult = service_interfaces_pb2.TransactionResult
TranscriptionOptions = service_interfaces_pb2.TranscriptionOptions
TranscriptionSegment = service_interfaces_pb2.TranscriptionSegment
TranscriptionWord = service_interfaces_pb2.TranscriptionWord
TranscriptionResult = service_interfaces_pb2.TranscriptionResult
SpeechToTextOptions = service_interfaces_pb2.SpeechToTextOptions
TextToSpeechOptions = service_interfaces_pb2.TextToSpeechOptions
VideoFormat = service_interfaces_pb2.VideoFormat
VideoInfo = service_interfaces_pb2.VideoInfo
VideoDownloadOptions = service_interfaces_pb2.VideoDownloadOptions
VideoProcessingOptions = service_interfaces_pb2.VideoProcessingOptions
BrowserViewport = service_interfaces_pb2.BrowserViewport
BrowserNavigationOptions = service_interfaces_pb2.BrowserNavigationOptions
ScreenshotClip = service_interfaces_pb2.ScreenshotClip
ScreenshotOptions = service_interfaces_pb2.ScreenshotOptions
ElementSelector = service_interfaces_pb2.ElementSelector
ExtractedLink = service_interfaces_pb2.LinkInfo
ExtractedImage = service_interfaces_pb2.ImageInfo
ExtractedContent = service_interfaces_pb2.ExtractedContent
ClickOptions = service_interfaces_pb2.ClickOptions
TypeOptions = service_interfaces_pb2.TypeOptions
PdfMetadata = service_interfaces_pb2.PdfMetadata
PdfExtractionResult = service_interfaces_pb2.PdfExtractionResult
PdfMargins = service_interfaces_pb2.PdfMargins
PdfGenerationOptions = service_interfaces_pb2.PdfGenerationOptions
PdfConversionOptions = service_interfaces_pb2.PdfConversionOptions
SearchDateRange = service_interfaces_pb2.DateRange
WebSearchBaseOptions = service_interfaces_pb2.SearchOptions
SearchResult = service_interfaces_pb2.SearchResult
SearchResponse = service_interfaces_pb2.SearchResponse
NewsSearchOptions = service_interfaces_pb2.NewsSearchOptions
ImageSearchOptions = service_interfaces_pb2.ImageSearchOptions
VideoSearchOptions = service_interfaces_pb2.VideoSearchOptions
EmailAddress = service_interfaces_pb2.EmailAddress
EmailAttachment = service_interfaces_pb2.EmailAttachment
EmailMessage = service_interfaces_pb2.EmailMessage
EmailSendOptions = service_interfaces_pb2.EmailSendOptions
EmailSearchOptions = service_interfaces_pb2.EmailSearchOptions
EmailFolder = service_interfaces_pb2.EmailFolder
EmailAccount = service_interfaces_pb2.EmailAccount
MessageParticipant = service_interfaces_pb2.MessageParticipant
MessageAttachment = service_interfaces_pb2.MessageAttachment
MessageReaction = service_interfaces_pb2.MessageReaction
MessageReference = service_interfaces_pb2.MessageReference
EmbedField = service_interfaces_pb2.EmbedField
MessageEmbed = service_interfaces_pb2.MessageEmbed
MessageContent = service_interfaces_pb2.MessageContent
MessageThread = service_interfaces_pb2.MessageThreadInfo
MessageInfo = service_interfaces_pb2.MessageInfo
MessageSendOptions = service_interfaces_pb2.MessageSendOptions
MessageSearchOptions = service_interfaces_pb2.MessageSearchOptions
ChannelPermissions = service_interfaces_pb2.ChannelPermissions
MessageChannel = service_interfaces_pb2.MessageChannel
PostMedia = service_interfaces_pb2.PostMedia
PostLocation = service_interfaces_pb2.PostLocation
PostAuthor = service_interfaces_pb2.PostAuthor
PostEngagement = service_interfaces_pb2.PostEngagement
PostLinkPreview = service_interfaces_pb2.PostLinkPreview
PollOption = service_interfaces_pb2.PostPollOption
PostPoll = service_interfaces_pb2.PostPoll
PostContent = service_interfaces_pb2.PostContent
PostThread = service_interfaces_pb2.PostThreadInfo
CrossPostedInfo = service_interfaces_pb2.CrossPostInfo
PostInfo = service_interfaces_pb2.PostInfo
PostCreateOptions = service_interfaces_pb2.PostCreateOptions
PostSearchOptions = service_interfaces_pb2.PostSearchOptions
DemographicsData = service_interfaces_pb2.Demographics
PerformingHour = service_interfaces_pb2.TopPerformingHour
PostAnalytics = service_interfaces_pb2.PostAnalytics


# Types not in protobuf - define as dataclasses
@dataclass
class VoiceInfo:
    """Voice information for text-to-speech."""

    voice_id: str
    name: str
    language: str | None = None
    gender: str | None = None
    provider: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PageInfo:
    """Pagination information for search results."""

    page: int = 1
    per_page: int = 10
    total: int = 0
    has_more: bool = False


class ITokenDataService(ABC):
    """Runtime service interface (implementation-specific)."""


class IWalletService(ABC):
    """Runtime service interface (implementation-specific)."""


class ILpService(ABC):
    """Runtime service interface (implementation-specific)."""


class ITranscriptionService(ABC):
    """Runtime service interface (implementation-specific)."""


class IVideoService(ABC):
    """Runtime service interface (implementation-specific)."""


class IBrowserService(ABC):
    """Runtime service interface (implementation-specific)."""


class IPdfService(ABC):
    """Runtime service interface (implementation-specific)."""


class IWebSearchService(ABC):
    """Runtime service interface (implementation-specific)."""


class IEmailService(ABC):
    """Runtime service interface (implementation-specific)."""


class IMessagingService(ABC):
    """Runtime service interface (implementation-specific)."""


class IPostService(ABC):
    """Runtime service interface (implementation-specific)."""


__all__ = [
    "TokenBalance",
    "TokenData",
    "WalletAsset",
    "WalletPortfolio",
    "PoolTokenInfo",
    "PoolInfo",
    "LpPositionDetails",
    "TransactionResult",
    "TranscriptionOptions",
    "TranscriptionSegment",
    "TranscriptionWord",
    "TranscriptionResult",
    "SpeechToTextOptions",
    "TextToSpeechOptions",
    "VoiceInfo",
    "VideoFormat",
    "VideoInfo",
    "VideoDownloadOptions",
    "VideoProcessingOptions",
    "BrowserViewport",
    "BrowserNavigationOptions",
    "ScreenshotClip",
    "ScreenshotOptions",
    "ElementSelector",
    "ExtractedLink",
    "ExtractedImage",
    "ExtractedContent",
    "ClickOptions",
    "TypeOptions",
    "PdfMetadata",
    "PdfExtractionResult",
    "PdfMargins",
    "PdfGenerationOptions",
    "PdfConversionOptions",
    "SearchDateRange",
    "WebSearchBaseOptions",
    "SearchResult",
    "SearchResponse",
    "NewsSearchOptions",
    "ImageSearchOptions",
    "VideoSearchOptions",
    "PageInfo",
    "EmailAddress",
    "EmailAttachment",
    "EmailMessage",
    "EmailSendOptions",
    "EmailSearchOptions",
    "EmailFolder",
    "EmailAccount",
    "MessageParticipant",
    "MessageAttachment",
    "MessageReaction",
    "MessageReference",
    "EmbedField",
    "MessageEmbed",
    "MessageContent",
    "MessageThread",
    "MessageInfo",
    "MessageSendOptions",
    "MessageSearchOptions",
    "ChannelPermissions",
    "MessageChannel",
    "PostMedia",
    "PostLocation",
    "PostAuthor",
    "PostEngagement",
    "PostLinkPreview",
    "PollOption",
    "PostPoll",
    "PostContent",
    "PostThread",
    "CrossPostedInfo",
    "PostInfo",
    "PostCreateOptions",
    "PostSearchOptions",
    "DemographicsData",
    "PerformingHour",
    "PostAnalytics",
    "ITokenDataService",
    "IWalletService",
    "ILpService",
    "ITranscriptionService",
    "IVideoService",
    "IBrowserService",
    "IPdfService",
    "IWebSearchService",
    "IEmailService",
    "IMessagingService",
    "IPostService",
]
