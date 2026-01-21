/**
 * Service Interface Definitions for elizaOS
 *
 * This module provides standardized service interface definitions that plugins implement.
 * Data types are proto-generated; runtime classes remain TypeScript.
 */

import type { Content, UUID } from "./primitives";
import type {
  JsonValue,
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  TokenData,
  TransactionResult,
  WalletAsset,
  WalletPortfolio,
} from "./proto.js";
import { Service, ServiceType } from "./service";

export type {
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  TokenData,
  TransactionResult,
  WalletAsset,
  WalletPortfolio,
};

// ============================================================================
// Message Bus Service Interface
// ============================================================================

export interface IMessageBusService extends Service {
  notifyActionStart(
    roomId: UUID,
    worldId: UUID,
    content: Content,
    messageId?: UUID,
  ): Promise<void>;

  notifyActionUpdate(
    roomId: UUID,
    worldId: UUID,
    content: Content,
    messageId?: UUID,
  ): Promise<void>;
}

// ============================================================================
// Token & Wallet Interfaces
// ============================================================================

export abstract class ITokenDataService extends Service {
  static override readonly serviceType = ServiceType.TOKEN_DATA;
  public readonly capabilityDescription =
    "Provides standardized access to token market data." as string;

  abstract getTokenDetails(
    address: string,
    chain: string,
  ): Promise<TokenData | null>;

  abstract getTrendingTokens(
    chain?: string,
    limit?: number,
    timePeriod?: string,
  ): Promise<TokenData[]>;

  abstract searchTokens(
    query: string,
    chain?: string,
    limit?: number,
  ): Promise<TokenData[]>;

  abstract getTokensByAddresses(
    addresses: string[],
    chain: string,
  ): Promise<TokenData[]>;
}

export abstract class IWalletService extends Service {
  static override readonly serviceType = ServiceType.WALLET;

  public readonly capabilityDescription =
    "Provides standardized access to wallet balances and portfolios.";

  abstract getPortfolio(owner?: string): Promise<WalletPortfolio>;

  abstract getBalance(assetAddress: string, owner?: string): Promise<number>;

  abstract transferSol(
    from: object,
    to: object,
    lamports: number,
  ): Promise<string>;
}

// ============================================================================
// Liquidity Pool Interfaces
// ============================================================================

export abstract class ILpService extends Service {
  static override readonly serviceType = "lp_pool";

  public readonly capabilityDescription =
    "Provides standardized access to DEX liquidity pools.";

  abstract getDexName(): string;

  abstract getPools(
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]>;

  abstract addLiquidity(params: {
    userVault: object;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    slippageBps: number;
    tickLowerIndex?: number;
    tickUpperIndex?: number;
  }): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }>;

  abstract removeLiquidity(params: {
    userVault: object;
    poolId: string;
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }>;

  abstract getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string,
  ): Promise<LpPositionDetails | null>;

  abstract getMarketDataForPools(
    poolIds: string[],
  ): Promise<Record<string, Partial<PoolInfo>>>;
}

// ============================================================================
// Transcription & Audio Interfaces
// ============================================================================

export abstract class ITranscriptionService extends Service {
  static override readonly serviceType = ServiceType.TRANSCRIPTION;

  public readonly capabilityDescription =
    "Audio transcription and speech processing capabilities";

  abstract transcribeAudio(
    audioPath: string | Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult>;

  abstract transcribeVideo(
    videoPath: string | Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult>;

  abstract speechToText(
    audioStream: NodeJS.ReadableStream | Buffer,
    options?: SpeechToTextOptions,
  ): Promise<TranscriptionResult>;

  abstract textToSpeech(
    text: string,
    options?: TextToSpeechOptions,
  ): Promise<Buffer>;

  abstract getSupportedLanguages(): Promise<string[]>;

  abstract getAvailableVoices(): Promise<
    Array<{
      id: string;
      name: string;
      language: string;
      gender?: "male" | "female" | "neutral";
    }>
  >;

  abstract detectLanguage(audioPath: string | Buffer): Promise<string>;
}

// ============================================================================
// Video Interfaces
// ============================================================================

export abstract class IVideoService extends Service {
  static override readonly serviceType = ServiceType.VIDEO;

  public readonly capabilityDescription =
    "Video download, processing, and conversion capabilities";

  abstract getVideoInfo(url: string): Promise<VideoInfo>;

  abstract downloadVideo(
    url: string,
    options?: VideoDownloadOptions,
  ): Promise<string>;

  abstract extractAudio(
    videoPath: string,
    outputPath?: string,
  ): Promise<string>;

  abstract getThumbnail(videoPath: string, timestamp?: number): Promise<string>;

  abstract convertVideo(
    videoPath: string,
    outputPath: string,
    options?: VideoProcessingOptions,
  ): Promise<string>;

  abstract getAvailableFormats(url: string): Promise<VideoFormat[]>;
}

// ============================================================================
// Browser Interfaces
// ============================================================================

export abstract class IBrowserService extends Service {
  static override readonly serviceType = ServiceType.BROWSER;

  public readonly capabilityDescription =
    "Web browser automation and scraping capabilities";

  abstract navigate(
    url: string,
    options?: BrowserNavigationOptions,
  ): Promise<void>;

  abstract screenshot(options?: ScreenshotOptions): Promise<Buffer>;

  abstract extractContent(selector?: string): Promise<ExtractedContent>;

  abstract click(
    selector: string | ElementSelector,
    options?: ClickOptions,
  ): Promise<void>;

  abstract type(
    selector: string,
    text: string,
    options?: TypeOptions,
  ): Promise<void>;

  abstract waitForElement(selector: string | ElementSelector): Promise<void>;

  abstract evaluate<T = JsonValue>(
    script: string,
    ...args: JsonValue[]
  ): Promise<T>;

  abstract getCurrentUrl(): Promise<string>;

  abstract goBack(): Promise<void>;

  abstract goForward(): Promise<void>;

  abstract refresh(): Promise<void>;
}

// ============================================================================
// PDF Interfaces
// ============================================================================

export abstract class IPdfService extends Service {
  static override readonly serviceType = ServiceType.PDF;

  public readonly capabilityDescription =
    "PDF processing, extraction, and generation capabilities";

  abstract extractText(pdfPath: string | Buffer): Promise<PdfExtractionResult>;

  abstract generatePdf(
    htmlContent: string,
    options?: PdfGenerationOptions,
  ): Promise<Buffer>;

  abstract convertToPdf(
    filePath: string,
    options?: PdfConversionOptions,
  ): Promise<Buffer>;

  abstract mergePdfs(pdfPaths: (string | Buffer)[]): Promise<Buffer>;

  abstract splitPdf(pdfPath: string | Buffer): Promise<Buffer[]>;
}

// ============================================================================
// Web Search Interfaces
// ============================================================================

export abstract class IWebSearchService extends Service {
  static override readonly serviceType = ServiceType.WEB_SEARCH;

  public readonly capabilityDescription =
    "Web search and content discovery capabilities";

  abstract search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse>;

  abstract searchNews(
    query: string,
    options?: NewsSearchOptions,
  ): Promise<SearchResponse>;

  abstract searchImages(
    query: string,
    options?: ImageSearchOptions,
  ): Promise<SearchResponse>;

  abstract searchVideos(
    query: string,
    options?: VideoSearchOptions,
  ): Promise<SearchResponse>;

  abstract getSuggestions(query: string): Promise<string[]>;

  abstract getTrendingSearches(region?: string): Promise<string[]>;

  abstract getPageInfo(url: string): Promise<{
    title: string;
    description: string;
    content: string;
    metadata: Record<string, string>;
    images: string[];
    links: string[];
  }>;
}

// ============================================================================
// Email Interfaces
// ============================================================================

export abstract class IEmailService extends Service {
  static override readonly serviceType = ServiceType.EMAIL;

  public readonly capabilityDescription =
    "Email sending, receiving, and management capabilities";

  abstract sendEmail(
    message: EmailMessage,
    options?: EmailSendOptions,
  ): Promise<string>;

  abstract getEmails(options?: EmailSearchOptions): Promise<EmailMessage[]>;

  abstract getEmail(messageId: string): Promise<EmailMessage>;

  abstract deleteEmail(messageId: string): Promise<void>;

  abstract markEmailAsRead(messageId: string, read: boolean): Promise<void>;

  abstract flagEmail(messageId: string, flagged: boolean): Promise<void>;

  abstract moveEmail(messageId: string, folderPath: string): Promise<void>;

  abstract getFolders(): Promise<EmailFolder[]>;

  abstract createFolder(folderName: string, parentPath?: string): Promise<void>;

  abstract getAccountInfo(): Promise<EmailAccount>;

  abstract searchEmails(
    query: string,
    options?: EmailSearchOptions,
  ): Promise<EmailMessage[]>;
}

// ============================================================================
// Message Interfaces
// ============================================================================

export abstract class IMessagingService extends Service {
  static override readonly serviceType = ServiceType.MESSAGE;

  public readonly capabilityDescription =
    "Platform messaging and channel management capabilities";

  abstract sendMessage(
    channelId: UUID,
    content: MessageContent,
    options?: MessageSendOptions,
  ): Promise<UUID>;

  abstract getMessages(
    channelId: UUID,
    options?: MessageSearchOptions,
  ): Promise<MessageInfo[]>;

  abstract getMessage(messageId: UUID): Promise<MessageInfo>;

  abstract editMessage(messageId: UUID, content: MessageContent): Promise<void>;

  abstract deleteMessage(messageId: UUID): Promise<void>;

  abstract addReaction(messageId: UUID, emoji: string): Promise<void>;

  abstract removeReaction(messageId: UUID, emoji: string): Promise<void>;

  abstract pinMessage(messageId: UUID): Promise<void>;

  abstract unpinMessage(messageId: UUID): Promise<void>;

  abstract getChannels(): Promise<MessageChannel[]>;

  abstract getChannel(channelId: UUID): Promise<MessageChannel>;

  abstract createChannel(
    name: string,
    type: MessageChannel["type"],
    options?: {
      description?: string;
      participants?: UUID[];
      private?: boolean;
    },
  ): Promise<UUID>;

  abstract searchMessages(
    query: string,
    options?: MessageSearchOptions,
  ): Promise<MessageInfo[]>;
}

// ============================================================================
// Post/Social Media Interfaces
// ============================================================================

export abstract class IPostService extends Service {
  static override readonly serviceType = ServiceType.POST;

  public readonly capabilityDescription =
    "Social media posting and content management capabilities";

  abstract createPost(
    content: PostContent,
    options?: PostCreateOptions,
  ): Promise<UUID>;

  abstract getPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  abstract getPost(postId: UUID): Promise<PostInfo>;

  abstract editPost(postId: UUID, content: PostContent): Promise<void>;

  abstract deletePost(postId: UUID): Promise<void>;

  abstract likePost(postId: UUID, like: boolean): Promise<void>;

  abstract sharePost(postId: UUID, comment?: string): Promise<UUID>;

  abstract savePost(postId: UUID, save: boolean): Promise<void>;

  abstract commentOnPost(postId: UUID, content: PostContent): Promise<UUID>;

  abstract getComments(
    postId: UUID,
    options?: PostSearchOptions,
  ): Promise<PostInfo[]>;

  abstract schedulePost(
    content: PostContent,
    scheduledAt: Date,
    options?: PostCreateOptions,
  ): Promise<UUID>;

  abstract getPostAnalytics(postId: UUID): Promise<PostAnalytics>;

  abstract getTrendingPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  abstract searchPosts(
    query: string,
    options?: PostSearchOptions,
  ): Promise<PostInfo[]>;
}

// ============================================================================
// Transcription & Audio Interfaces
// ============================================================================

/**
 * Options for audio transcription.
 */
export interface TranscriptionOptions {
  /** Language code for transcription */
  language?: string;
  /** Model to use for transcription */
  model?: string;
  /** Temperature for generation */
  temperature?: number;
  /** Prompt to guide transcription */
  prompt?: string;
  /** Response format */
  response_format?: "json" | "text" | "srt" | "vtt" | "verbose_json";
  /** Timestamp granularities to include */
  timestamp_granularities?: ("word" | "segment")[];
  /** Include word-level timestamps */
  word_timestamps?: boolean;
  /** Include segment-level timestamps */
  segment_timestamps?: boolean;
}

/**
 * Result of audio transcription.
 */
export interface TranscriptionResult {
  /** Transcribed text */
  text: string;
  /** Detected language */
  language?: string;
  /** Audio duration in seconds */
  duration?: number;
  /** Transcription segments */
  segments?: TranscriptionSegment[];
  /** Word-level transcription */
  words?: TranscriptionWord[];
  /** Overall confidence score */
  confidence?: number;
}

/**
 * A segment of transcription.
 */
export interface TranscriptionSegment {
  /** Segment ID */
  id: number;
  /** Segment text */
  text: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Confidence score */
  confidence?: number;
  /** Token IDs */
  tokens?: number[];
  /** Temperature used */
  temperature?: number;
  /** Average log probability */
  avg_logprob?: number;
  /** Compression ratio */
  compression_ratio?: number;
  /** No speech probability */
  no_speech_prob?: number;
}

/**
 * A word in transcription.
 */
export interface TranscriptionWord {
  /** The word */
  word: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Confidence score */
  confidence?: number;
}

/**
 * Options for speech-to-text.
 */
export interface SpeechToTextOptions {
  /** Language code */
  language?: string;
  /** Model to use */
  model?: string;
  /** Enable continuous recognition */
  continuous?: boolean;
  /** Return interim results */
  interimResults?: boolean;
  /** Maximum alternatives to return */
  maxAlternatives?: number;
}

/**
 * Options for text-to-speech.
 */
export interface TextToSpeechOptions {
  /** Voice to use */
  voice?: string;
  /** Model to use */
  model?: string;
  /** Speech speed */
  speed?: number;
  /** Output format */
  format?: "mp3" | "wav" | "flac" | "aac";
  /** Response format */
  response_format?: "mp3" | "opus" | "aac" | "flac";
}

// ============================================================================
// Video Interfaces
// ============================================================================

/**
 * Video information.
 */
export interface VideoInfo {
  /** Video title */
  title?: string;
  /** Duration in seconds */
  duration?: number;
  /** Video URL */
  url: string;
  /** Thumbnail URL */
  thumbnail?: string;
  /** Video description */
  description?: string;
  /** Uploader name */
  uploader?: string;
  /** View count */
  viewCount?: number;
  /** Upload date */
  uploadDate?: Date;
  /** Available formats */
  formats?: VideoFormat[];
}

/**
 * Video format information.
 */
export interface VideoFormat {
  /** Format ID */
  formatId: string;
  /** Download URL */
  url: string;
  /** File extension */
  extension: string;
  /** Quality label */
  quality: string;
  /** File size in bytes */
  fileSize?: number;
  /** Video codec */
  videoCodec?: string;
  /** Audio codec */
  audioCodec?: string;
  /** Resolution (e.g., "1920x1080") */
  resolution?: string;
  /** Frames per second */
  fps?: number;
  /** Bitrate */
  bitrate?: number;
}

/**
 * Video download options.
 */
export interface VideoDownloadOptions {
  /** Preferred format */
  format?: string;
  /** Quality preference */
  quality?: "best" | "worst" | "bestvideo" | "bestaudio" | string;
  /** Output file path */
  outputPath?: string;
  /** Extract audio only */
  audioOnly?: boolean;
  /** Extract video only (no audio) */
  videoOnly?: boolean;
  /** Download subtitles */
  subtitles?: boolean;
  /** Embed subtitles in video */
  embedSubs?: boolean;
  /** Write info JSON file */
  writeInfoJson?: boolean;
}

/**
 * Video processing options.
 */
export interface VideoProcessingOptions {
  /** Start time in seconds */
  startTime?: number;
  /** End time in seconds */
  endTime?: number;
  /** Output format */
  outputFormat?: string;
  /** Target resolution */
  resolution?: string;
  /** Target bitrate */
  bitrate?: string;
  /** Target framerate */
  framerate?: number;
  /** Audio codec */
  audioCodec?: string;
  /** Video codec */
  videoCodec?: string;
}

// ============================================================================
// Browser Interfaces
// ============================================================================

/**
 * Browser navigation options.
 */
export interface BrowserNavigationOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Wait until condition */
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  /** Viewport size */
  viewport?: {
    width: number;
    height: number;
  };
  /** User agent string */
  userAgent?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

/**
 * Screenshot options.
 */
export interface ScreenshotOptions {
  /** Capture full page */
  fullPage?: boolean;
  /** Clip region */
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Image format */
  format?: "png" | "jpeg" | "webp";
  /** Image quality (0-100) */
  quality?: number;
  /** Omit background */
  omitBackground?: boolean;
}

/**
 * Element selector options.
 */
export interface ElementSelector {
  /** CSS selector */
  selector: string;
  /** Text content to match */
  text?: string;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Extracted content from a page.
 */
export interface ExtractedContent {
  /** Text content */
  text: string;
  /** HTML content */
  html: string;
  /** Links found on page */
  links: Array<{
    url: string;
    text: string;
  }>;
  /** Images found on page */
  images: Array<{
    src: string;
    alt?: string;
  }>;
  /** Page title */
  title?: string;
  /** Page metadata */
  metadata?: Record<string, string>;
}

/**
 * Click options.
 */
export interface ClickOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Force click even if element is obscured */
  force?: boolean;
  /** Wait for navigation after click */
  waitForNavigation?: boolean;
}

/**
 * Type/input options.
 */
export interface TypeOptions {
  /** Delay between keystrokes */
  delay?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Clear field before typing */
  clear?: boolean;
}

// ============================================================================
// PDF Interfaces
// ============================================================================

/**
 * PDF text extraction result.
 */
export interface PdfExtractionResult {
  /** Extracted text */
  text: string;
  /** Total page count */
  pageCount: number;
  /** PDF metadata */
  metadata?: {
    title?: string;
    author?: string;
    createdAt?: Date;
    modifiedAt?: Date;
  };
}

/**
 * PDF generation options.
 */
export interface PdfGenerationOptions {
  /** Paper format */
  format?: "A4" | "A3" | "Letter";
  /** Page orientation */
  orientation?: "portrait" | "landscape";
  /** Page margins */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** Header content */
  header?: string;
  /** Footer content */
  footer?: string;
}

/**
 * PDF conversion options.
 */
export interface PdfConversionOptions {
  /** Output quality */
  quality?: "high" | "medium" | "low";
  /** Output format */
  outputFormat?: "pdf" | "pdf/a";
  /** Enable compression */
  compression?: boolean;
}

// ============================================================================
// Web Search Interfaces
// ============================================================================

/**
 * Web search options.
 */
export interface SearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Language code */
  language?: string;
  /** Region code */
  region?: string;
  /** Date range filter */
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  /** File type filter */
  fileType?: string;
  /** Limit to specific site */
  site?: string;
  /** Sort order */
  sortBy?: "relevance" | "date" | "popularity";
  /** Safe search level */
  safeSearch?: "strict" | "moderate" | "off";
}

/**
 * A single search result.
 */
export interface SearchResult {
  /** Result title */
  title: string;
  /** Result URL */
  url: string;
  /** Result description/snippet */
  description: string;
  /** Display URL */
  displayUrl?: string;
  /** Thumbnail URL */
  thumbnail?: string;
  /** Published date */
  publishedDate?: Date;
  /** Source name */
  source?: string;
  /** Relevance score */
  relevanceScore?: number;
  /** Text snippet */
  snippet?: string;
}

/**
 * Search response containing results.
 */
export interface SearchResponse {
  /** Original query */
  query: string;
  /** Search results */
  results: SearchResult[];
  /** Total available results */
  totalResults?: number;
  /** Search time in seconds */
  searchTime?: number;
  /** Query suggestions */
  suggestions?: string[];
  /** Token for next page */
  nextPageToken?: string;
  /** Related search queries */
  relatedSearches?: string[];
}

/**
 * News search options.
 */
export interface NewsSearchOptions extends SearchOptions {
  /** News category */
  category?:
    | "general"
    | "business"
    | "entertainment"
    | "health"
    | "science"
    | "sports"
    | "technology";
  /** Freshness filter */
  freshness?: "day" | "week" | "month";
}

/**
 * Image search options.
 */
export interface ImageSearchOptions extends SearchOptions {
  /** Image size filter */
  size?: "small" | "medium" | "large" | "wallpaper" | "any";
  /** Color filter */
  color?:
    | "color"
    | "monochrome"
    | "red"
    | "orange"
    | "yellow"
    | "green"
    | "blue"
    | "purple"
    | "pink"
    | "brown"
    | "black"
    | "gray"
    | "white";
  /** Image type filter */
  type?: "photo" | "clipart" | "line" | "animated";
  /** Image layout filter */
  layout?: "square" | "wide" | "tall" | "any";
  /** License filter */
  license?: "any" | "public" | "share" | "sharecommercially" | "modify";
}

/**
 * Video search options.
 */
export interface VideoSearchOptions extends SearchOptions {
  /** Duration filter */
  duration?: "short" | "medium" | "long" | "any";
  /** Resolution filter */
  resolution?: "high" | "standard" | "any";
  /** Quality filter */
  quality?: "high" | "standard" | "any";
}

// ============================================================================
// Email Interfaces
// ============================================================================

/**
 * Email address with optional name.
 */
export interface EmailAddress {
  /** Email address */
  email: string;
  /** Display name */
  name?: string;
}

/**
 * Email attachment.
 */
export interface EmailAttachment {
  /** Filename */
  filename: string;
  /** Content as buffer or base64 string */
  content: Buffer | string;
  /** MIME type */
  contentType?: string;
  /** Content disposition */
  contentDisposition?: "attachment" | "inline";
  /** Content ID for inline attachments */
  cid?: string;
}

/**
 * Email message.
 */
export interface EmailMessage {
  /** Sender address */
  from: EmailAddress;
  /** Recipients */
  to: EmailAddress[];
  /** CC recipients */
  cc?: EmailAddress[];
  /** BCC recipients */
  bcc?: EmailAddress[];
  /** Email subject */
  subject: string;
  /** Plain text body */
  text?: string;
  /** HTML body */
  html?: string;
  /** Attachments */
  attachments?: EmailAttachment[];
  /** Reply-to address */
  replyTo?: EmailAddress;
  /** Send date */
  date?: Date;
  /** Message ID */
  messageId?: string;
  /** References header */
  references?: string[];
  /** In-Reply-To header */
  inReplyTo?: string;
  /** Priority level */
  priority?: "high" | "normal" | "low";
}

/**
 * Email send options.
 */
export interface EmailSendOptions {
  /** Number of retries */
  retry?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Track email opens */
  trackOpens?: boolean;
  /** Track link clicks */
  trackClicks?: boolean;
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Email search options.
 */
export interface EmailSearchOptions {
  /** Search query */
  query?: string;
  /** Filter by sender */
  from?: string;
  /** Filter by recipient */
  to?: string;
  /** Filter by subject */
  subject?: string;
  /** Filter by folder */
  folder?: string;
  /** Filter emails since date */
  since?: Date;
  /** Filter emails before date */
  before?: Date;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter unread only */
  unread?: boolean;
  /** Filter flagged only */
  flagged?: boolean;
  /** Filter with attachments only */
  hasAttachments?: boolean;
}

/**
 * Email folder.
 */
export interface EmailFolder {
  /** Folder name */
  name: string;
  /** Folder path */
  path: string;
  /** Folder type */
  type: "inbox" | "sent" | "drafts" | "trash" | "spam" | "custom";
  /** Total message count */
  messageCount?: number;
  /** Unread message count */
  unreadCount?: number;
  /** Child folders */
  children?: EmailFolder[];
}

/**
 * Email account information.
 */
export interface EmailAccount {
  /** Email address */
  email: string;
  /** Display name */
  name?: string;
  /** Email provider */
  provider?: string;
  /** Available folders */
  folders?: EmailFolder[];
  /** Storage used in bytes */
  quotaUsed?: number;
  /** Storage limit in bytes */
  quotaLimit?: number;
}

// ============================================================================
// Message Interfaces
// ============================================================================

/**
 * Message participant information.
 */
export interface MessageParticipant {
  /** Participant ID */
  id: UUID;
  /** Display name */
  name: string;
  /** Username */
  username?: string;
  /** Avatar URL */
  avatar?: string;
  /** Online status */
  status?: "online" | "offline" | "away" | "busy";
}

/**
 * Message attachment.
 */
export interface MessageAttachment {
  /** Attachment ID */
  id: UUID;
  /** Filename */
  filename: string;
  /** File URL */
  url: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Width for images/videos */
  width?: number;
  /** Height for images/videos */
  height?: number;
  /** Duration for audio/video */
  duration?: number;
  /** Thumbnail URL */
  thumbnail?: string;
}

/**
 * Message reaction.
 */
export interface MessageReaction {
  /** Emoji used */
  emoji: string;
  /** Number of reactions */
  count: number;
  /** User IDs who reacted */
  users: UUID[];
  /** Whether current user has reacted */
  hasReacted: boolean;
}

/**
 * Message reference (reply/forward/quote).
 */
export interface MessageReference {
  /** Referenced message ID */
  messageId: UUID;
  /** Channel of referenced message */
  channelId: UUID;
  /** Type of reference */
  type: "reply" | "forward" | "quote";
}

/**
 * Message content.
 */
export interface MessageContent {
  /** Plain text content */
  text?: string;
  /** HTML content */
  html?: string;
  /** Markdown content */
  markdown?: string;
  /** Attachments */
  attachments?: MessageAttachment[];
  /** Reactions */
  reactions?: MessageReaction[];
  /** Reference to another message */
  reference?: MessageReference;
  /** Mentioned user IDs */
  mentions?: UUID[];
  /** Embedded content */
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    image?: string;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
  }>;
}

/**
 * Message information.
 */
export interface MessageInfo {
  /** Message ID */
  id: UUID;
  /** Channel ID */
  channelId: UUID;
  /** Sender ID */
  senderId: UUID;
  /** Message content */
  content: MessageContent;
  /** Sent timestamp */
  timestamp: Date;
  /** Edit timestamp */
  edited?: Date;
  /** Deletion timestamp */
  deleted?: Date;
  /** Whether message is pinned */
  pinned?: boolean;
  /** Thread information */
  thread?: {
    id: UUID;
    messageCount: number;
    participants: UUID[];
    lastMessageAt: Date;
  };
}

/**
 * Message send options.
 */
export interface MessageSendOptions {
  /** Reply to message ID */
  replyTo?: UUID;
  /** Ephemeral (only visible to sender) */
  ephemeral?: boolean;
  /** Silent (no notification) */
  silent?: boolean;
  /** Scheduled send time */
  scheduled?: Date;
  /** Thread ID */
  thread?: UUID;
  /** Nonce for deduplication */
  nonce?: string;
}

/**
 * Message search options.
 */
export interface MessageSearchOptions {
  /** Search query */
  query?: string;
  /** Filter by channel */
  channelId?: UUID;
  /** Filter by sender */
  senderId?: UUID;
  /** Filter messages before date */
  before?: Date;
  /** Filter messages after date */
  after?: Date;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter with attachments only */
  hasAttachments?: boolean;
  /** Filter pinned only */
  pinned?: boolean;
  /** Filter mentioning user */
  mentions?: UUID;
}

/**
 * Message channel.
 */
export interface MessageChannel {
  /** Channel ID */
  id: UUID;
  /** Channel name */
  name: string;
  /** Channel type */
  type: "text" | "voice" | "dm" | "group" | "announcement" | "thread";
  /** Channel description */
  description?: string;
  /** Channel participants */
  participants?: MessageParticipant[];
  /** User permissions */
  permissions?: {
    canSend: boolean;
    canRead: boolean;
    canDelete: boolean;
    canPin: boolean;
    canManage: boolean;
  };
  /** Last message timestamp */
  lastMessageAt?: Date;
  /** Total message count */
  messageCount?: number;
  /** Unread message count */
  unreadCount?: number;
}

// ============================================================================
// Post/Social Media Interfaces
// ============================================================================

/**
 * Post media content.
 */
export interface PostMedia {
  /** Media ID */
  id: UUID;
  /** Media URL */
  url: string;
  /** Media type */
  type: "image" | "video" | "audio" | "document";
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Width for images/videos */
  width?: number;
  /** Height for images/videos */
  height?: number;
  /** Duration for audio/video */
  duration?: number;
  /** Thumbnail URL */
  thumbnail?: string;
  /** Description */
  description?: string;
  /** Alt text for accessibility */
  altText?: string;
}

/**
 * Post location.
 */
export interface PostLocation {
  /** Location name */
  name: string;
  /** Address */
  address?: string;
  /** Coordinates */
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  /** Place ID from location service */
  placeId?: string;
}

/**
 * Post author information.
 */
export interface PostAuthor {
  /** Author ID */
  id: UUID;
  /** Username */
  username: string;
  /** Display name */
  displayName: string;
  /** Avatar URL */
  avatar?: string;
  /** Verified badge */
  verified?: boolean;
  /** Follower count */
  followerCount?: number;
  /** Following count */
  followingCount?: number;
  /** Bio */
  bio?: string;
  /** Website URL */
  website?: string;
}

/**
 * Post engagement metrics.
 */
export interface PostEngagement {
  /** Number of likes */
  likes: number;
  /** Number of shares */
  shares: number;
  /** Number of comments */
  comments: number;
  /** Number of views */
  views?: number;
  /** Whether current user has liked */
  hasLiked: boolean;
  /** Whether current user has shared */
  hasShared: boolean;
  /** Whether current user has commented */
  hasCommented: boolean;
  /** Whether current user has saved */
  hasSaved: boolean;
}

/**
 * Post content.
 */
export interface PostContent {
  /** Text content */
  text?: string;
  /** HTML content */
  html?: string;
  /** Media attachments */
  media?: PostMedia[];
  /** Location */
  location?: PostLocation;
  /** Hashtags */
  tags?: string[];
  /** Mentioned user IDs */
  mentions?: UUID[];
  /** Link previews */
  links?: Array<{
    url: string;
    title?: string;
    description?: string;
    image?: string;
  }>;
  /** Poll */
  poll?: {
    question: string;
    options: Array<{
      text: string;
      votes: number;
    }>;
    expiresAt?: Date;
    multipleChoice?: boolean;
  };
}

/**
 * Post information.
 */
export interface PostInfo {
  /** Post ID */
  id: UUID;
  /** Post author */
  author: PostAuthor;
  /** Post content */
  content: PostContent;
  /** Platform name */
  platform: string;
  /** Platform-specific ID */
  platformId: string;
  /** Post URL */
  url: string;
  /** Created timestamp */
  createdAt: Date;
  /** Edited timestamp */
  editedAt?: Date;
  /** Scheduled timestamp */
  scheduledAt?: Date;
  /** Engagement metrics */
  engagement: PostEngagement;
  /** Visibility level */
  visibility: "public" | "private" | "followers" | "friends" | "unlisted";
  /** Reply to post ID */
  replyTo?: UUID;
  /** Thread information */
  thread?: {
    id: UUID;
    position: number;
    total: number;
  };
  /** Cross-post information */
  crossPosted?: Array<{
    platform: string;
    platformId: string;
    url: string;
  }>;
}

/**
 * Post creation options.
 */
export interface PostCreateOptions {
  /** Target platforms */
  platforms?: string[];
  /** Scheduled time */
  scheduledAt?: Date;
  /** Visibility level */
  visibility?: PostInfo["visibility"];
  /** Reply to post ID */
  replyTo?: UUID;
  /** Create as thread */
  thread?: boolean;
  /** Location */
  location?: PostLocation;
  /** Hashtags */
  tags?: string[];
  /** Mentioned user IDs */
  mentions?: UUID[];
  /** Enable comments */
  enableComments?: boolean;
  /** Enable sharing */
  enableSharing?: boolean;
  /** Content warning */
  contentWarning?: string;
  /** Mark as sensitive */
  sensitive?: boolean;
}

/**
 * Post search options.
 */
export interface PostSearchOptions {
  /** Search query */
  query?: string;
  /** Filter by author */
  author?: UUID;
  /** Filter by platform */
  platform?: string;
  /** Filter by tags */
  tags?: string[];
  /** Filter by mentions */
  mentions?: UUID[];
  /** Filter posts since date */
  since?: Date;
  /** Filter posts before date */
  before?: Date;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter with media only */
  hasMedia?: boolean;
  /** Filter with location only */
  hasLocation?: boolean;
  /** Filter by visibility */
  visibility?: PostInfo["visibility"];
  /** Sort order */
  sortBy?: "date" | "engagement" | "relevance";
}

/**
 * Post analytics.
 */
export interface PostAnalytics {
  /** Post ID */
  postId: UUID;
  /** Platform name */
  platform: string;
  /** Total impressions */
  impressions: number;
  /** Unique reach */
  reach: number;
  /** Engagement metrics */
  engagement: PostEngagement;
  /** Link clicks */
  clicks: number;
  /** Shares */
  shares: number;
  /** Saves */
  saves: number;
  /** Demographics */
  demographics?: {
    age?: Record<string, number>;
    gender?: Record<string, number>;
    location?: Record<string, number>;
  };
  /** Top performing hours */
  topPerformingHours?: Array<{
    hour: number;
    engagement: number;
  }>;
}
