/** Standardized service contracts that plugins implement and the data shapes they exchange. */

import type { ControlMessageAction } from "./messaging";
import type { Content, JsonObject, JsonValue, UUID } from "./primitives";
import { Service, ServiceType } from "./service";

export interface TokenBalance {
	address: string;
	balance: string;
	decimals: number;
	uiAmount?: number;
	name?: string;
	symbol?: string;
	logoUri?: string;
}

export interface TokenData {
	id: string;
	symbol: string;
	name: string;
	address: string;
	chain: string;
	sourceProvider: string;
	price?: number;
	priceChange24hPercent?: number;
	priceChange24hUsd?: number;
	volume24hUsd?: number;
	marketCapUsd?: number;
	liquidity?: number;
	holders?: number;
	logoUri?: string;
	decimals?: number;
	lastUpdatedAt?: Date;
	raw?: JsonObject;
}

export interface WalletAsset {
	address: string;
	balance: string;
	decimals: number;
	uiAmount?: number;
	name?: string;
	symbol?: string;
	logoUri?: string;
	priceUsd?: number;
	valueUsd?: number;
}

export interface WalletPortfolio {
	totalValueUsd: number;
	assets: WalletAsset[];
}

export interface PoolTokenInfo {
	mint: string;
	symbol?: string;
	reserve?: string;
	decimals?: number;
}

export interface PoolInfo {
	id: string;
	displayName?: string;
	dex: string;
	tokenA: PoolTokenInfo;
	tokenB: PoolTokenInfo;
	lpTokenMint?: string;
	apr?: number;
	apy?: number;
	tvl?: number;
	fee?: number;
	metadata?: JsonObject;
}

export interface LpPositionDetails {
	poolId: string;
	dex: string;
	lpTokenBalance: TokenBalance;
	underlyingTokens: TokenBalance[];
	valueUsd?: number;
	accruedFees: TokenBalance[];
	rewards: TokenBalance[];
	metadata?: JsonObject;
}

export interface TransactionResult {
	success: boolean;
	transactionId?: string;
	error?: string;
	data?: JsonObject;
}

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

export interface ControlTransportMessage {
	type: "controlMessage";
	payload: {
		action: ControlMessageAction;
		target?: string;
		roomId: UUID;
	};
}

export abstract class IControlTransportService extends Service {
	static override readonly serviceType = ServiceType.CONTROL_TRANSPORT;

	public readonly capabilityDescription =
		"Dispatches backend control messages to interactive clients.";

	abstract sendMessage(message: ControlTransportMessage): Promise<void>;
}

export abstract class ITokenDataService extends Service {
	static override readonly serviceType = ServiceType.TOKEN_DATA;
	static override readonly allowsMultiple = true;
	public readonly capabilityDescription =
		"Provides standardized access to token market data.";

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
	static override readonly allowsMultiple = true;

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

export abstract class ILpService extends Service {
	static override readonly serviceType = "lp_pool";
	static override readonly allowsMultiple = true;

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

export type MediaGenerationMediaType = "image" | "video" | "audio";
export type MediaGenerationAudioKind = "music" | "sfx" | "tts";

export interface MediaGenerationRequest {
	mediaType: MediaGenerationMediaType;
	prompt: string;
	audioKind?: MediaGenerationAudioKind;
	size?: string;
	quality?: "standard" | "hd";
	style?: "natural" | "vivid";
	negativePrompt?: string;
	seed?: number;
	duration?: number;
	aspectRatio?: string;
	resolution?: string;
	audio?: boolean;
	imageUrl?: string;
	instrumental?: boolean;
	genre?: string;
	voice?: string;
}

export interface MediaGenerationResponse {
	mediaType: MediaGenerationMediaType;
	audioKind?: MediaGenerationAudioKind;
	url?: string;
	imageUrl?: string;
	imageBase64?: string;
	videoUrl?: string;
	audioUrl?: string;
	thumbnailUrl?: string;
	revisedPrompt?: string;
	title?: string;
	duration?: number;
	mimeType?: string;
	provider?: string;
	raw?: Record<string, JsonValue>;
}

export abstract class IMediaGenerationService extends Service {
	static override readonly serviceType = ServiceType.MEDIA_GENERATION;

	public readonly capabilityDescription: string =
		"Generates image, video, and audio media from prompts.";

	canGenerateMedia(
		_request: Pick<MediaGenerationRequest, "mediaType" | "audioKind">,
	): boolean | Promise<boolean> {
		return true;
	}

	abstract generateMedia(
		request: MediaGenerationRequest,
	): Promise<MediaGenerationResponse>;
}

/** Options for {@link IScreenCaptureService.startFrameCapture}. */
export interface ScreenCaptureFrameOptions {
	fps?: number;
	quality?: number;
	/** Agent HTTP endpoint the captured JPEG frames are POSTed to. */
	endpoint?: string;
	/** When set, capture a game/canvas URL instead of the app window. */
	gameUrl?: string;
}

/**
 * Desktop screen-capture bridge. The desktop host registers a working
 * implementation via `runtime.registerService`; server + streaming route code
 * resolves it with `runtime.getService(ServiceType.SCREEN_CAPTURE)` instead of a
 * `globalThis` bridge. Absent (e.g. mobile/web) → capture falls back to another
 * mode.
 */
export abstract class IScreenCaptureService extends Service {
	static override readonly serviceType = ServiceType.SCREEN_CAPTURE;

	public readonly capabilityDescription =
		"Desktop screen/frame capture for live streaming";

	abstract isFrameCaptureActive(): boolean;

	abstract startFrameCapture(options: ScreenCaptureFrameOptions): Promise<void>;

	abstract stopFrameCapture(): void;
}

/** A stored file's identity + served handle. */
export interface StoredFile {
	/** Served URL for the bytes (e.g. `/api/media/<sha256>.<ext>`). */
	url: string;
	/** Lowercase hex sha256 of the bytes (the content-address). */
	hash: string;
	/** Stored filename (`<sha256>.<ext>`). */
	fileName: string;
	/** Authoritative MIME type. */
	mimeType: string;
	/** Byte size. */
	size: number;
}

/** A stored file that has no pre-authenticated served URL. */
export interface StoredPrivateFile extends Omit<StoredFile, "url"> {}

/** A stored file as listed by the Files surface. */
export interface StoredFileListItem extends StoredFile {
	/** Creation/last-served timestamp (ms since epoch). */
	createdAt: number;
}

/**
 * Content-addressed file storage: the single contract the rest of the system
 * codes against for storing, serving, listing, and deleting attachment bytes.
 * The default implementation is local-disk + content addressing (free dedup);
 * a cloud-backed implementation can fill the same slot later. Fills the
 * `ServiceType.REMOTE_FILES` slot — resolve via
 * `runtime.getService(ServiceType.REMOTE_FILES)`.
 */
export abstract class IFileStorageService extends Service {
	static override readonly serviceType = ServiceType.REMOTE_FILES;

	// Typed as `string` (not the literal) so implementations can override it.
	public readonly capabilityDescription: string =
		"Content-addressed file storage: store, serve, list, and delete attachment bytes";

	/** Persist bytes (idempotent by content) and return the served handle. */
	abstract store(
		bytes: Buffer | Uint8Array,
		mimeType: string,
	): Promise<StoredFile>;

	/** Persist sensitive bytes without creating a pre-authenticated media URL. */
	abstract storePrivate(
		bytes: Buffer | Uint8Array,
		mimeType: string,
	): Promise<StoredPrivateFile>;

	/** Read exact private bytes by their opaque content-addressed filename. */
	abstract readPrivate(fileName: string): Promise<Buffer | null>;

	/** Delete private bytes after their authorized lifecycle ends. */
	abstract deletePrivate(fileName: string): Promise<boolean>;

	/** Persist a `data:` URL's bytes; returns null for non-data URLs. */
	abstract storeDataUrl(dataUrl: string): Promise<StoredFile | null>;

	/** Resolve a served URL for a stored filename, or null if invalid/missing. */
	abstract getUrl(fileName: string): string | null;

	/** True when a stored file with this filename exists. */
	abstract exists(fileName: string): Promise<boolean>;

	/** Read exact stored bytes by content-addressed filename, or null when absent. */
	abstract read(fileName: string): Promise<Buffer | null>;

	/** List all stored files (for the Files surface). */
	abstract list(): Promise<StoredFileListItem[]>;

	/** Delete a stored file by filename. Returns true when removed. */
	abstract delete(fileName: string): Promise<boolean>;
}

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
