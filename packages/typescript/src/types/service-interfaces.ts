/**
 * Service Interface Definitions for elizaOS
 *
 * This module provides standardized service interface definitions that plugins implement.
 * Each interface extends the base Service class and defines the contract for a specific
 * capability (e.g., transcription, wallet, browser automation).
 *
 * Plugin developers should implement these interfaces to provide their service functionality.
 */

import type { Content, Metadata, UUID } from "./primitives";
import { Service, ServiceType } from "./service";

// ============================================================================
// Message Bus Service Interface
// ============================================================================

/**
 * Interface for the message bus service that provides action notifications.
 * This is an optional service that may be registered by plugins.
 */
export interface IMessageBusService extends Service {
  /**
   * Notify that an action has started.
   * @param roomId The room where the action is occurring.
   * @param worldId The world ID.
   * @param content The action content.
   * @param messageId Optional message ID for tracking.
   */
  notifyActionStart(
    roomId: UUID,
    worldId: UUID,
    content: Content,
    messageId?: UUID,
  ): Promise<void>;

  /**
   * Notify that an action has been updated/completed.
   * @param roomId The room where the action is occurring.
   * @param worldId The world ID.
   * @param content The action content.
   * @param messageId Optional message ID for tracking.
   */
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

/**
 * A standardized representation of a token holding.
 */
export interface TokenBalance {
  /** Token mint address, or a native identifier like 'SOL' or 'ETH' */
  address: string;
  /** Raw balance as a string to handle large numbers with precision */
  balance: string;
  /** Number of decimal places for this token */
  decimals: number;
  /** User-friendly balance, adjusted for decimals */
  uiAmount?: number;
  /** Token name */
  name?: string;
  /** Token symbol */
  symbol?: string;
  /** Token logo URI */
  logoURI?: string;
}

/**
 * Generic representation of token data that can be provided by various services.
 */
export interface TokenData {
  /** Unique identifier (e.g., contract address or a composite ID) */
  id: string;
  /** Token symbol */
  symbol: string;
  /** Token name */
  name: string;
  /** Contract address */
  address: string;
  /** Chain identifier (e.g., 'solana', 'ethereum', 'base') */
  chain: string;
  /** Source provider (e.g., 'birdeye', 'coinmarketcap') */
  sourceProvider: string;

  /** Current price in USD */
  price?: number;
  /** 24h price change percentage */
  priceChange24hPercent?: number;
  /** 24h price change in USD (absolute) */
  priceChange24hUSD?: number;

  /** 24h trading volume in USD */
  volume24hUSD?: number;
  /** Market capitalization in USD */
  marketCapUSD?: number;

  /** Liquidity in USD */
  liquidity?: number;
  /** Number of token holders */
  holders?: number;

  /** Token logo URI */
  logoURI?: string;
  /** Token decimals */
  decimals?: number;

  /** When this specific data point was last updated from the source */
  lastUpdatedAt?: Date;

  /** Optional raw data from the provider */
  raw?: Record<string, unknown>;
}

/**
 * Represents a single asset holding within a wallet, including its value.
 */
export interface WalletAsset extends TokenBalance {
  /** Current price in USD */
  priceUsd?: number;
  /** Total value in USD */
  valueUsd?: number;
}

/**
 * Represents the entire portfolio of assets in a wallet.
 */
export interface WalletPortfolio {
  /** Total portfolio value in USD */
  totalValueUsd: number;
  /** Array of assets in the portfolio */
  assets: WalletAsset[];
}

/**
 * Interface for a generic service that provides token data.
 */
export abstract class ITokenDataService extends Service {
  static override readonly serviceType = ServiceType.TOKEN_DATA;
  public readonly capabilityDescription =
    "Provides standardized access to token market data." as string;

  /**
   * Fetches detailed information for a single token.
   * @param address The token's contract address.
   * @param chain The blockchain the token resides on.
   * @returns A Promise resolving to TokenData or null if not found.
   */
  abstract getTokenDetails(
    address: string,
    chain: string,
  ): Promise<TokenData | null>;

  /**
   * Fetches a list of trending tokens.
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of tokens to return.
   * @param timePeriod Optional: Time period for trending data (e.g., '24h', '7d').
   * @returns A Promise resolving to an array of TokenData.
   */
  abstract getTrendingTokens(
    chain?: string,
    limit?: number,
    timePeriod?: string,
  ): Promise<TokenData[]>;

  /**
   * Searches for tokens based on a query string.
   * @param query The search query (e.g., symbol, name, address).
   * @param chain Optional: Filter by a specific blockchain.
   * @param limit Optional: Number of results to return.
   * @returns A Promise resolving to an array of TokenData.
   */
  abstract searchTokens(
    query: string,
    chain?: string,
    limit?: number,
  ): Promise<TokenData[]>;

  /**
   * Fetches data for multiple tokens by their addresses on a specific chain.
   * @param addresses Array of token contract addresses.
   * @param chain The blockchain the tokens reside on.
   * @returns A Promise resolving to an array of TokenData.
   */
  abstract getTokensByAddresses(
    addresses: string[],
    chain: string,
  ): Promise<TokenData[]>;
}

/**
 * Abstract interface for a Wallet Service.
 * Plugins that provide wallet functionality should implement this service.
 */
export abstract class IWalletService extends Service {
  static override readonly serviceType = ServiceType.WALLET;

  public readonly capabilityDescription =
    "Provides standardized access to wallet balances and portfolios.";

  /**
   * Retrieves the entire portfolio of assets held by the wallet.
   * @param owner Optional: The specific wallet address/owner to query.
   * @returns A promise that resolves to the wallet's portfolio.
   */
  abstract getPortfolio(owner?: string): Promise<WalletPortfolio>;

  /**
   * Retrieves the balance of a specific asset in the wallet.
   * @param assetAddress The mint address or native identifier of the asset.
   * @param owner Optional: The specific wallet address/owner to query.
   * @returns A promise that resolves to the user-friendly balance.
   */
  abstract getBalance(assetAddress: string, owner?: string): Promise<number>;

  /**
   * Transfers native tokens (SOL/ETH) from a specified keypair to a recipient.
   * @param from The keypair of the sender.
   * @param to The public key of the recipient.
   * @param lamports The amount in smallest units to transfer.
   * @returns A promise that resolves with the transaction signature.
   */
  abstract transferSol(
    from: unknown,
    to: unknown,
    lamports: number,
  ): Promise<string>;
}

// ============================================================================
// Liquidity Pool Interfaces
// ============================================================================

/**
 * A standardized representation of a liquidity pool from any DEX.
 */
export interface PoolInfo {
  /** Unique identifier for the pool */
  id: string;
  /** User-friendly name for the pool */
  displayName?: string;
  /** Identifier for the DEX (e.g., "orca", "raydium") */
  dex: string;
  /** First token in the pair */
  tokenA: {
    mint: string;
    symbol?: string;
    reserve?: string;
    decimals?: number;
  };
  /** Second token in the pair */
  tokenB: {
    mint: string;
    symbol?: string;
    reserve?: string;
    decimals?: number;
  };
  /** LP token mint address */
  lpTokenMint?: string;
  /** Annual Percentage Rate */
  apr?: number;
  /** Annual Percentage Yield */
  apy?: number;
  /** Total Value Locked in USD */
  tvl?: number;
  /** Trading fee percentage */
  fee?: number;
  /** DEX-specific extra data */
  metadata?: Metadata;
}

/**
 * A standardized representation of a user's position in a liquidity pool.
 */
export interface LpPositionDetails {
  /** Pool ID */
  poolId: string;
  /** DEX identifier */
  dex: string;
  /** LP token balance */
  lpTokenBalance: TokenBalance;
  /** Array of underlying token balances */
  underlyingTokens: TokenBalance[];
  /** Position value in USD */
  valueUsd?: number;
  /** Accrued trading fees */
  accruedFees?: TokenBalance[];
  /** Farming rewards */
  rewards?: TokenBalance[];
  /** Additional DEX-specific position data */
  metadata?: Metadata;
}

/**
 * A standardized result for blockchain transactions.
 */
export interface TransactionResult {
  /** Whether the transaction succeeded */
  success: boolean;
  /** Transaction ID/signature */
  transactionId?: string;
  /** Error message if failed */
  error?: string;
  /** Additional transaction data */
  data?: Record<string, unknown>;
}

/**
 * Abstract interface for a Liquidity Pool Service.
 * DEX-specific plugins must implement this service.
 */
export abstract class ILpService extends Service {
  static override readonly serviceType = "lp_pool";

  public readonly capabilityDescription =
    "Provides standardized access to DEX liquidity pools.";

  /**
   * Returns the name of the DEX this service interacts with.
   */
  abstract getDexName(): string;

  /**
   * Fetches a list of available liquidity pools from the DEX.
   * @param tokenAMint Optional: Filter pools by first token mint.
   * @param tokenBMint Optional: Filter pools by second token mint.
   */
  abstract getPools(
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]>;

  /**
   * Adds liquidity to a specified pool.
   */
  abstract addLiquidity(params: {
    userVault: unknown;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    slippageBps: number;
    tickLowerIndex?: number;
    tickUpperIndex?: number;
  }): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }>;

  /**
   * Removes liquidity from a specified pool.
   */
  abstract removeLiquidity(params: {
    userVault: unknown;
    poolId: string;
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }>;

  /**
   * Fetches the details of a specific LP position for a user.
   */
  abstract getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string,
  ): Promise<LpPositionDetails | null>;

  /**
   * Fetches the latest market data for a list of pools.
   */
  abstract getMarketDataForPools(
    poolIds: string[],
  ): Promise<Record<string, Partial<PoolInfo>>>;
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

/**
 * Interface for audio transcription and speech services.
 */
export abstract class ITranscriptionService extends Service {
  static override readonly serviceType = ServiceType.TRANSCRIPTION;

  public readonly capabilityDescription =
    "Audio transcription and speech processing capabilities";

  /**
   * Transcribe audio file to text.
   * @param audioPath Path to audio file or audio buffer.
   * @param options Transcription options.
   */
  abstract transcribeAudio(
    audioPath: string | Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult>;

  /**
   * Transcribe video file to text (extracts audio first).
   * @param videoPath Path to video file or video buffer.
   * @param options Transcription options.
   */
  abstract transcribeVideo(
    videoPath: string | Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult>;

  /**
   * Real-time speech to text from audio stream.
   * @param audioStream Audio stream or buffer.
   * @param options Speech to text options.
   */
  abstract speechToText(
    audioStream: NodeJS.ReadableStream | Buffer,
    options?: SpeechToTextOptions,
  ): Promise<TranscriptionResult>;

  /**
   * Convert text to speech.
   * @param text Text to convert to speech.
   * @param options Text to speech options.
   * @returns Audio buffer.
   */
  abstract textToSpeech(
    text: string,
    options?: TextToSpeechOptions,
  ): Promise<Buffer>;

  /**
   * Get supported languages for transcription.
   */
  abstract getSupportedLanguages(): Promise<string[]>;

  /**
   * Get available voices for text to speech.
   */
  abstract getAvailableVoices(): Promise<
    Array<{
      id: string;
      name: string;
      language: string;
      gender?: "male" | "female" | "neutral";
    }>
  >;

  /**
   * Detect language of audio file.
   * @param audioPath Path to audio file or audio buffer.
   */
  abstract detectLanguage(audioPath: string | Buffer): Promise<string>;
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

/**
 * Interface for video processing and download services.
 */
export abstract class IVideoService extends Service {
  static override readonly serviceType = ServiceType.VIDEO;

  public readonly capabilityDescription =
    "Video download, processing, and conversion capabilities";

  /**
   * Get video information without downloading.
   * @param url Video URL.
   */
  abstract getVideoInfo(url: string): Promise<VideoInfo>;

  /**
   * Download a video from URL.
   * @param url Video URL.
   * @param options Download options.
   * @returns Downloaded file path.
   */
  abstract downloadVideo(
    url: string,
    options?: VideoDownloadOptions,
  ): Promise<string>;

  /**
   * Extract audio from video.
   * @param videoPath Path to video file or video URL.
   * @param outputPath Optional output path for audio file.
   * @returns Audio file path.
   */
  abstract extractAudio(
    videoPath: string,
    outputPath?: string,
  ): Promise<string>;

  /**
   * Generate thumbnail from video.
   * @param videoPath Path to video file or video URL.
   * @param timestamp Timestamp in seconds to capture thumbnail.
   * @returns Thumbnail image path.
   */
  abstract getThumbnail(videoPath: string, timestamp?: number): Promise<string>;

  /**
   * Convert video to different format.
   * @param videoPath Path to input video file.
   * @param outputPath Path for output video file.
   * @param options Processing options.
   * @returns Converted video path.
   */
  abstract convertVideo(
    videoPath: string,
    outputPath: string,
    options?: VideoProcessingOptions,
  ): Promise<string>;

  /**
   * Get available formats for a video URL.
   * @param url Video URL.
   */
  abstract getAvailableFormats(url: string): Promise<VideoFormat[]>;
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

/**
 * Interface for browser automation services.
 */
export abstract class IBrowserService extends Service {
  static override readonly serviceType = ServiceType.BROWSER;

  public readonly capabilityDescription =
    "Web browser automation and scraping capabilities";

  /**
   * Navigate to a URL.
   * @param url URL to navigate to.
   * @param options Navigation options.
   */
  abstract navigate(
    url: string,
    options?: BrowserNavigationOptions,
  ): Promise<void>;

  /**
   * Take a screenshot of the current page.
   * @param options Screenshot options.
   * @returns Screenshot buffer.
   */
  abstract screenshot(options?: ScreenshotOptions): Promise<Buffer>;

  /**
   * Extract text and content from the current page.
   * @param selector Optional CSS selector to extract from.
   */
  abstract extractContent(selector?: string): Promise<ExtractedContent>;

  /**
   * Click on an element.
   * @param selector CSS selector or element selector.
   * @param options Click options.
   */
  abstract click(
    selector: string | ElementSelector,
    options?: ClickOptions,
  ): Promise<void>;

  /**
   * Type text into an input field.
   * @param selector CSS selector for input field.
   * @param text Text to type.
   * @param options Typing options.
   */
  abstract type(
    selector: string,
    text: string,
    options?: TypeOptions,
  ): Promise<void>;

  /**
   * Wait for an element to appear.
   * @param selector CSS selector or element selector.
   */
  abstract waitForElement(selector: string | ElementSelector): Promise<void>;

  /**
   * Evaluate JavaScript in the browser context.
   * @param script JavaScript code to evaluate.
   * @param args Arguments to pass to the script.
   */
  abstract evaluate<T = unknown>(
    script: string,
    ...args: unknown[]
  ): Promise<T>;

  /**
   * Get the current page URL.
   */
  abstract getCurrentUrl(): Promise<string>;

  /**
   * Go back in browser history.
   */
  abstract goBack(): Promise<void>;

  /**
   * Go forward in browser history.
   */
  abstract goForward(): Promise<void>;

  /**
   * Refresh the current page.
   */
  abstract refresh(): Promise<void>;
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

/**
 * Interface for PDF processing services.
 */
export abstract class IPdfService extends Service {
  static override readonly serviceType = ServiceType.PDF;

  public readonly capabilityDescription =
    "PDF processing, extraction, and generation capabilities";

  /**
   * Extract text and metadata from a PDF file.
   * @param pdfPath Path to the PDF file or buffer.
   */
  abstract extractText(pdfPath: string | Buffer): Promise<PdfExtractionResult>;

  /**
   * Generate a PDF from HTML content.
   * @param htmlContent HTML content to convert.
   * @param options PDF generation options.
   * @returns PDF buffer.
   */
  abstract generatePdf(
    htmlContent: string,
    options?: PdfGenerationOptions,
  ): Promise<Buffer>;

  /**
   * Convert a document to PDF format.
   * @param filePath Path to the document file.
   * @param options Conversion options.
   * @returns PDF buffer.
   */
  abstract convertToPdf(
    filePath: string,
    options?: PdfConversionOptions,
  ): Promise<Buffer>;

  /**
   * Merge multiple PDF files into one.
   * @param pdfPaths Array of PDF file paths or buffers.
   * @returns Merged PDF buffer.
   */
  abstract mergePdfs(pdfPaths: (string | Buffer)[]): Promise<Buffer>;

  /**
   * Split a PDF into individual pages.
   * @param pdfPath Path to the PDF file or buffer.
   * @returns Array of page buffers.
   */
  abstract splitPdf(pdfPath: string | Buffer): Promise<Buffer[]>;
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

/**
 * Interface for web search services.
 */
export abstract class IWebSearchService extends Service {
  static override readonly serviceType = ServiceType.WEB_SEARCH;

  public readonly capabilityDescription =
    "Web search and content discovery capabilities";

  /**
   * Perform a general web search.
   * @param query Search query.
   * @param options Search options.
   */
  abstract search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse>;

  /**
   * Search for news articles.
   * @param query Search query.
   * @param options News search options.
   */
  abstract searchNews(
    query: string,
    options?: NewsSearchOptions,
  ): Promise<SearchResponse>;

  /**
   * Search for images.
   * @param query Search query.
   * @param options Image search options.
   */
  abstract searchImages(
    query: string,
    options?: ImageSearchOptions,
  ): Promise<SearchResponse>;

  /**
   * Search for videos.
   * @param query Search query.
   * @param options Video search options.
   */
  abstract searchVideos(
    query: string,
    options?: VideoSearchOptions,
  ): Promise<SearchResponse>;

  /**
   * Get search suggestions for a query.
   * @param query Partial search query.
   */
  abstract getSuggestions(query: string): Promise<string[]>;

  /**
   * Get trending searches.
   * @param region Optional region code.
   */
  abstract getTrendingSearches(region?: string): Promise<string[]>;

  /**
   * Get detailed information about a specific URL.
   * @param url URL to analyze.
   */
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

/**
 * Interface for email services.
 */
export abstract class IEmailService extends Service {
  static override readonly serviceType = ServiceType.EMAIL;

  public readonly capabilityDescription =
    "Email sending, receiving, and management capabilities";

  /**
   * Send an email.
   * @param message Email message to send.
   * @param options Send options.
   * @returns Message ID.
   */
  abstract sendEmail(
    message: EmailMessage,
    options?: EmailSendOptions,
  ): Promise<string>;

  /**
   * Get emails from a folder.
   * @param options Search options.
   */
  abstract getEmails(options?: EmailSearchOptions): Promise<EmailMessage[]>;

  /**
   * Get a specific email by ID.
   * @param messageId Message ID.
   */
  abstract getEmail(messageId: string): Promise<EmailMessage>;

  /**
   * Delete an email.
   * @param messageId Message ID.
   */
  abstract deleteEmail(messageId: string): Promise<void>;

  /**
   * Mark an email as read/unread.
   * @param messageId Message ID.
   * @param read True to mark as read.
   */
  abstract markEmailAsRead(messageId: string, read: boolean): Promise<void>;

  /**
   * Flag/unflag an email.
   * @param messageId Message ID.
   * @param flagged True to flag.
   */
  abstract flagEmail(messageId: string, flagged: boolean): Promise<void>;

  /**
   * Move email to a different folder.
   * @param messageId Message ID.
   * @param folderPath Destination folder path.
   */
  abstract moveEmail(messageId: string, folderPath: string): Promise<void>;

  /**
   * Get available folders.
   */
  abstract getFolders(): Promise<EmailFolder[]>;

  /**
   * Create a new folder.
   * @param folderName Name of the folder.
   * @param parentPath Optional parent folder path.
   */
  abstract createFolder(folderName: string, parentPath?: string): Promise<void>;

  /**
   * Get account information.
   */
  abstract getAccountInfo(): Promise<EmailAccount>;

  /**
   * Search emails.
   * @param query Search query.
   * @param options Search options.
   */
  abstract searchEmails(
    query: string,
    options?: EmailSearchOptions,
  ): Promise<EmailMessage[]>;
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

/**
 * Interface for platform messaging services (Discord, Slack, etc).
 * Distinct from IMessageService which handles internal message processing.
 */
export abstract class IMessagingService extends Service {
  static override readonly serviceType = ServiceType.MESSAGE;

  public readonly capabilityDescription =
    "Platform messaging and channel management capabilities";

  /**
   * Send a message to a channel.
   * @param channelId Channel ID.
   * @param content Message content.
   * @param options Send options.
   * @returns Message ID.
   */
  abstract sendMessage(
    channelId: UUID,
    content: MessageContent,
    options?: MessageSendOptions,
  ): Promise<UUID>;

  /**
   * Get messages from a channel.
   * @param channelId Channel ID.
   * @param options Search options.
   */
  abstract getMessages(
    channelId: UUID,
    options?: MessageSearchOptions,
  ): Promise<MessageInfo[]>;

  /**
   * Get a specific message by ID.
   * @param messageId Message ID.
   */
  abstract getMessage(messageId: UUID): Promise<MessageInfo>;

  /**
   * Edit a message.
   * @param messageId Message ID.
   * @param content New message content.
   */
  abstract editMessage(messageId: UUID, content: MessageContent): Promise<void>;

  /**
   * Delete a message.
   * @param messageId Message ID.
   */
  abstract deleteMessage(messageId: UUID): Promise<void>;

  /**
   * Add a reaction to a message.
   * @param messageId Message ID.
   * @param emoji Reaction emoji.
   */
  abstract addReaction(messageId: UUID, emoji: string): Promise<void>;

  /**
   * Remove a reaction from a message.
   * @param messageId Message ID.
   * @param emoji Reaction emoji.
   */
  abstract removeReaction(messageId: UUID, emoji: string): Promise<void>;

  /**
   * Pin a message.
   * @param messageId Message ID.
   */
  abstract pinMessage(messageId: UUID): Promise<void>;

  /**
   * Unpin a message.
   * @param messageId Message ID.
   */
  abstract unpinMessage(messageId: UUID): Promise<void>;

  /**
   * Get available channels.
   */
  abstract getChannels(): Promise<MessageChannel[]>;

  /**
   * Get channel information.
   * @param channelId Channel ID.
   */
  abstract getChannel(channelId: UUID): Promise<MessageChannel>;

  /**
   * Create a new channel.
   * @param name Channel name.
   * @param type Channel type.
   * @param options Channel options.
   * @returns New channel ID.
   */
  abstract createChannel(
    name: string,
    type: MessageChannel["type"],
    options?: {
      description?: string;
      participants?: UUID[];
      private?: boolean;
    },
  ): Promise<UUID>;

  /**
   * Search messages across channels.
   * @param query Search query.
   * @param options Search options.
   */
  abstract searchMessages(
    query: string,
    options?: MessageSearchOptions,
  ): Promise<MessageInfo[]>;
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

/**
 * Interface for social media posting services.
 */
export abstract class IPostService extends Service {
  static override readonly serviceType = ServiceType.POST;

  public readonly capabilityDescription =
    "Social media posting and content management capabilities";

  /**
   * Create and publish a new post.
   * @param content Post content.
   * @param options Publishing options.
   * @returns Post ID.
   */
  abstract createPost(
    content: PostContent,
    options?: PostCreateOptions,
  ): Promise<UUID>;

  /**
   * Get posts from timeline or specific user.
   * @param options Search options.
   */
  abstract getPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  /**
   * Get a specific post by ID.
   * @param postId Post ID.
   */
  abstract getPost(postId: UUID): Promise<PostInfo>;

  /**
   * Edit an existing post.
   * @param postId Post ID.
   * @param content New post content.
   */
  abstract editPost(postId: UUID, content: PostContent): Promise<void>;

  /**
   * Delete a post.
   * @param postId Post ID.
   */
  abstract deletePost(postId: UUID): Promise<void>;

  /**
   * Like/unlike a post.
   * @param postId Post ID.
   * @param like True to like, false to unlike.
   */
  abstract likePost(postId: UUID, like: boolean): Promise<void>;

  /**
   * Share/repost a post.
   * @param postId Post ID.
   * @param comment Optional comment when sharing.
   * @returns Share ID.
   */
  abstract sharePost(postId: UUID, comment?: string): Promise<UUID>;

  /**
   * Save/unsave a post.
   * @param postId Post ID.
   * @param save True to save, false to unsave.
   */
  abstract savePost(postId: UUID, save: boolean): Promise<void>;

  /**
   * Comment on a post.
   * @param postId Post ID.
   * @param content Comment content.
   * @returns Comment ID.
   */
  abstract commentOnPost(postId: UUID, content: PostContent): Promise<UUID>;

  /**
   * Get comments for a post.
   * @param postId Post ID.
   * @param options Search options.
   */
  abstract getComments(
    postId: UUID,
    options?: PostSearchOptions,
  ): Promise<PostInfo[]>;

  /**
   * Schedule a post for later publishing.
   * @param content Post content.
   * @param scheduledAt When to publish.
   * @param options Publishing options.
   * @returns Scheduled post ID.
   */
  abstract schedulePost(
    content: PostContent,
    scheduledAt: Date,
    options?: PostCreateOptions,
  ): Promise<UUID>;

  /**
   * Get analytics for a post.
   * @param postId Post ID.
   */
  abstract getPostAnalytics(postId: UUID): Promise<PostAnalytics>;

  /**
   * Get trending posts.
   * @param options Search options.
   */
  abstract getTrendingPosts(options?: PostSearchOptions): Promise<PostInfo[]>;

  /**
   * Search posts across platforms.
   * @param query Search query.
   * @param options Search options.
   */
  abstract searchPosts(
    query: string,
    options?: PostSearchOptions,
  ): Promise<PostInfo[]>;
}
