import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type IAgentRuntime,
	type IVideoService,
	type Media,
	ModelType,
	Service,
	ServiceType,
	type ServiceTypeName,
	logger,
	stringToUuid,
} from "@elizaos/core";
import ffmpeg from "fluent-ffmpeg";
import ytdl, { create } from "youtube-dl-exec";

/**
 * Function to get the Youtube DL executable path.
 * It first checks if /usr/local/bin/yt-dlp exists,
 * if it does, it returns the path to that executable.
 * If not, it checks if /usr/bin/yt-dlp exists,
 * and returns the path if found.
 * If neither paths exist, it returns the default ytdl executable.
 * @returns {string} The path to the Youtube DL executable.
 */
function getYoutubeDL() {
	// first check if /usr/local/bin/yt-dlp exists
	if (fs.existsSync("/usr/local/bin/yt-dlp")) {
		return create("/usr/local/bin/yt-dlp");
	}

	// if not, check if /usr/bin/yt-dlp exists
	if (fs.existsSync("/usr/bin/yt-dlp")) {
		return create("/usr/bin/yt-dlp");
	}

	// use default otherwise
	return ytdl;
}

/**
 * VideoService class that extends Service and implements IVideoService interface.
 * Defines the service type as VIDEO and sets capability description for processing videos.
 * Manages caching of video content with cacheKey and dataDir properties.
 * Maintains a queue of video processing tasks and tracks processing status.
 */
export class VideoService extends Service implements IVideoService {
	static serviceType: ServiceTypeName = ServiceType.VIDEO;
	capabilityDescription = "The agent is able to download and process videos";
	private cacheKey = "content/video";
	private dataDir = "./cache";

	private queue: string[] = [];
	private processing = false;

	/**
	 * Constructor for creating a new instance of the object.
	 *
	 * @param {IAgentRuntime} runtime - The runtime object to be used by the instance
	 */
	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
		this.ensureDataDirectoryExists();
	}

	/**
	 * Starts the VideoService by initializing it with the given IAgentRuntime instance.
	 *
	 * @param {IAgentRuntime} runtime - The IAgentRuntime instance to initialize the service with.
	 * @returns {Promise<VideoService>} A promise that resolves to the initialized VideoService instance.
	 */
	static async start(runtime: IAgentRuntime): Promise<VideoService> {
		const service = new VideoService(runtime);
		return service;
	}

	/**
	 * Stops the video service if it is running.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime instance
	 * @returns {Promise<void>} A promise that resolves once the video service is stopped
	 */
	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceType.VIDEO);
		if (service) {
			await service.stop();
		}
	}

	/**
	 * Asynchronous method to stop the operation.
	 */
	async stop() {
		// do nothing
	}

	/**
	 * Checks if the data directory exists, and if not, creates it.
	 */
	private ensureDataDirectoryExists() {
		if (!fs.existsSync(this.dataDir)) {
			fs.mkdirSync(this.dataDir);
		}
	}

	/**
	 * Check if a given URL is a video URL from YouTube or Vimeo.
	 *
	 * @param {string} url - The URL to check.
	 * @return {boolean} Returns true if the URL is from YouTube or Vimeo, false otherwise.
	 */
	public isVideoUrl(url: string): boolean {
		return (
			url.includes("youtube.com") ||
			url.includes("youtu.be") ||
			url.includes("vimeo.com")
		);
	}

	/**
	 * Downloads media from a given URL. If the media already exists, it returns the file path.
	 *
	 * @param {string} url - The URL of the media to download.
	 * @returns {Promise<string>} A promise that resolves to the file path of the downloaded media.
	 * @throws {Error} If there is an error downloading the media.
	 */
	public async downloadMedia(url: string): Promise<string> {
		const videoId = this.getVideoId(url);
		const outputFile = path.join(this.dataDir, `${videoId}.mp4`);

		// if it already exists, return it
		if (fs.existsSync(outputFile)) {
			return outputFile;
		}

		try {
			await getYoutubeDL()(url, {
				verbose: true,
				output: outputFile,
				writeInfoJson: true,
			});
			return outputFile;
		} catch (error) {
			logger.log("Error downloading media:", error);
			throw new Error("Failed to download media");
		}
	}

	/**
	 * Downloads a video using the videoInfo object provided and returns the path to the downloaded video file.
	 * If the video file already exists, it will return the path without re-downloading.
	 * @param {Object} videoInfo - Information about the video to download.
	 * @returns {Promise<string>} - Path to the downloaded video file.
	 */
	public async downloadVideo(videoInfo: any): Promise<string> {
		const videoId = this.getVideoId(videoInfo.webpage_url);
		const outputFile = path.join(this.dataDir, `${videoId}.mp4`);

		// if it already exists, return it
		if (fs.existsSync(outputFile)) {
			return outputFile;
		}

		try {
			await getYoutubeDL()(videoInfo.webpage_url, {
				verbose: true,
				output: outputFile,
				format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				writeInfoJson: true,
			});
			return outputFile;
		} catch (error) {
			logger.log("Error downloading video:", error);
			throw new Error("Failed to download video");
		}
	}

	/**
	 * Process a video from the given URL using the provided agent runtime.
	 *
	 * @param {string} url - The URL of the video to be processed
	 * @param {IAgentRuntime} runtime - The agent runtime to be used for processing the video
	 * @returns {Promise<Media>} A promise that resolves to the processed media
	 */
	public async processVideo(
		url: string,
		runtime: IAgentRuntime,
	): Promise<Media> {
		this.queue.push(url);
		await this.processQueue(runtime);

		return new Promise((resolve, reject) => {
			const checkQueue = async () => {
				const index = this.queue.indexOf(url);
				if (index !== -1) {
					setTimeout(checkQueue, 100);
				} else {
					this.processVideoFromUrl(url, runtime).then(resolve).catch(reject);
				}
			};
			checkQueue();
		});
	}

	/**
	 * Processes the queue of URLs by calling processVideoFromUrl for each URL.
	 *
	 * @param {any} runtime - The runtime information for processing the videos.
	 * @returns {Promise<void>} - A promise that resolves when the queue has been processed.
	 */
	private async processQueue(runtime): Promise<void> {
		if (this.processing || this.queue.length === 0) {
			return;
		}

		this.processing = true;

		while (this.queue.length > 0) {
			const url = this.queue.shift()!;
			await this.processVideoFromUrl(url, runtime);
		}

		this.processing = false;
	}

	/**
	 * Processes a video from a given URL.
	 * Retrieves video information, transcript, and caches the result.
	 *
	 * @param {string} url - The URL of the video to process.
	 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
	 * @returns {Promise<Media>} A promise that resolves to the processed video data.
	 * @throws {Error} If there is an error processing the video.
	 */
	private async processVideoFromUrl(
		url: string,
		runtime: IAgentRuntime,
	): Promise<Media> {
		const videoId =
			url.match(
				/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([^\/&?]+)/, // eslint-disable-line
			)?.[1] || "";
		const videoUuid = this.getVideoId(videoId);
		const cacheKey = `${this.cacheKey}/${videoUuid}`;

		const cached = await runtime.getCache<Media>(cacheKey);

		if (cached) {
			logger.log("Returning cached video file");
			return cached;
		}

		try {
			logger.log("Cache miss, processing video");
			logger.log("Fetching video info");
			const videoInfo = await this.fetchVideoInfo(url);
			console.log("Getting transcript");
			const transcript = await this.getTranscript(url, videoInfo, runtime);

			const result: Media = {
				id: videoUuid,
				url: url,
				title: videoInfo.title,
				source: videoInfo.channel,
				description: videoInfo.description,
				text: transcript,
			};

			await runtime.setCache<Media>(cacheKey, result);

			return result;
		} catch (error) {
			throw new Error(`Error processing video: ${error.message || error}`);
		}
	}

	/**
	 * Returns the unique video ID generated from the provided URL.
	 * @param {string} url - The URL used to generate the video ID.
	 * @returns {string} The unique video ID.
	 */
	private getVideoId(url: string): string {
		return stringToUuid(url);
	}

	/**
	 * Asynchronously fetches video information from the provided URL. If the URL ends with ".mp4" or includes ".mp4?", attempts to fetch the video directly using fetch. If successful, returns a simplified video info object with title, description, and channel. If direct download fails, falls back to using youtube-dl to fetch video information. Utilizes options such as dumpJson, verbose, callHome, noCheckCertificates, preferFreeFormats, youtubeSkipDashManifest, writeSub, writeAutoSub, subLang, and skipDownload when calling youtube-dl. Throws an error if the response from youtube-dl is empty or if there is an error during the process.
	 *
	 * @param {string} url - The URL from which to fetch video information
	 * @returns {Promise<any>} A Promise resolving to the fetched video information or rejecting with an error message
	 */
	async fetchVideoInfo(url: string): Promise<any> {
		console.log("url", url);
		if (url.endsWith(".mp4") || url.includes(".mp4?")) {
			try {
				const response = await fetch(url);
				if (response.ok) {
					// If the URL is a direct link to an MP4 file, return a simplified video info object
					return {
						title: path.basename(url),
						description: "",
						channel: "",
					};
				}
			} catch (error) {
				logger.log("Error downloading MP4 file:", error);
				// Fall back to using youtube-dl if direct download fails
			}
		}

		try {
			const result = await getYoutubeDL()(url, {
				dumpJson: true,
				verbose: true,
				callHome: false,
				noCheckCertificates: true,
				preferFreeFormats: true,
				youtubeSkipDashManifest: true,
				writeSub: true,
				writeAutoSub: true,
				subLang: "en",
				skipDownload: true,
			});

			if (!result || Object.keys(result).length === 0) {
				throw new Error("Empty response from youtube-dl");
			}

			return result;
		} catch (error) {
			throw new Error(
				`Failed to fetch video information: ${error.message || error}`,
			);
		}
	}

	/**
	 * Asynchronously retrieves the transcript of a video based on the provided URL, video information, and runtime environment.
	 *
	 * @param {string} url - The URL of the video.
	 * @param {any} videoInfo - Information about the video, including subtitles, automatic captions, and categories.
	 * @param {IAgentRuntime} runtime - The runtime environment of the agent.
	 * @returns {Promise<string>} A Promise that resolves to the transcript of the video.
	 */
	private async getTranscript(
		url: string,
		videoInfo: any,
		runtime: IAgentRuntime,
	): Promise<string> {
		logger.log("Getting transcript");
		try {
			// Check for manual subtitles
			if (videoInfo.subtitles?.en) {
				logger.log("Manual subtitles found");
				const srtContent = await this.downloadSRT(
					videoInfo.subtitles.en[0].url,
				);
				return this.parseSRT(srtContent);
			}

			// Check for automatic captions
			if (videoInfo.automatic_captions?.en) {
				logger.log("Automatic captions found");
				const captionUrl = videoInfo.automatic_captions.en[0].url;
				const captionContent = await this.downloadCaption(captionUrl);
				return this.parseCaption(captionContent);
			}

			// Check if it's a music video
			if (videoInfo.categories?.includes("Music")) {
				logger.log("Music video detected, no lyrics available");
				return "No lyrics available.";
			}

			// Fall back to audio transcription
			logger.log(
				"No subtitles or captions found, falling back to audio transcription",
			);
			return this.transcribeAudio(url, runtime);
		} catch (error) {
			logger.log("Error in getTranscript:", error);
			throw error;
		}
	}

	/**
	 * Downloads a caption from the specified URL.
	 * @param {string} url - The URL from which to download the caption.
	 * @returns {Promise<string>} A promise that resolves with the downloaded caption as a string.
	 * @throws {Error} If the caption download fails, an error is thrown with the reason.
	 */
	private async downloadCaption(url: string): Promise<string> {
		logger.log("Downloading caption from:", url);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download caption: ${response.statusText}`);
		}
		return await response.text();
	}

	/**
	 * Parses the given caption content to extract relevant information.
	 *
	 * @param {string} captionContent - The caption content to parse.
	 * @returns {string} The extracted caption information as a string.
	 */
	private parseCaption(captionContent: string): string {
		logger.log("Parsing caption");
		try {
			const jsonContent = JSON.parse(captionContent);
			if (jsonContent.events) {
				return jsonContent.events
					.filter((event) => event.segs)
					.map((event) => event.segs.map((seg) => seg.utf8).join(""))
					.join("")
					.replace("\n", " ");
			}
			logger.log("Unexpected caption format:", jsonContent);
			return "Error: Unable to parse captions";
		} catch (error) {
			logger.log("Error parsing caption:", error);
			return "Error: Unable to parse captions";
		}
	}

	/**
	 * Parses SRT (SubRip) content to extract subtitles.
	 *
	 * @param {string} srtContent - The SRT content to parse.
	 * @returns {string} The parsed subtitles as a single string.
	 */
	private parseSRT(srtContent: string): string {
		// Simple SRT parser (replace with a more robust solution if needed)
		return srtContent
			.split("\n\n")
			.map((block) => block.split("\n").slice(2).join(" "))
			.join(" ");
	}

	/**
	 * Asynchronously downloads a SubRip subtitle file from the specified URL.
	 *
	 * @param {string} url - The URL of the subtitle file to download.
	 * @returns {Promise<string>} A promise that resolves to the text content of the downloaded subtitle file.
	 */
	private async downloadSRT(url: string): Promise<string> {
		logger.log("downloadSRT");
		const response = await fetch(url);
		return await response.text();
	}

	/**
	 * Asynchronously transcribes audio from the provided URL using the agent runtime.
	 *
	 * @param {string} url - The URL of the audio file to transcribe.
	 * @param {IAgentRuntime} runtime - The agent runtime to use for transcription.
	 * @returns {Promise<string>} A promise that resolves with the transcription result, or "Transcription failed" if the process was unsuccessful.
	 */
	async transcribeAudio(url: string, runtime: IAgentRuntime): Promise<string> {
		logger.log("Preparing audio for transcription...");

		// Check if ffmpeg exists in PATH
		try {
			await new Promise((resolve, reject) => {
				ffmpeg.getAvailableCodecs((err, _codecs) => {
					if (err) reject(err);
					resolve(null);
				});
			});
		} catch (error) {
			logger.log("FFmpeg not found:", error);
			return null;
		}

		const mp4FilePath = path.join(this.dataDir, `${this.getVideoId(url)}.mp4`);

		const webmFilePath = path.join(
			this.dataDir,
			`${this.getVideoId(url)}.webm`,
		);

		const mp3FilePath = path.join(this.dataDir, `${this.getVideoId(url)}.mp3`);

		if (!fs.existsSync(mp3FilePath)) {
			if (fs.existsSync(webmFilePath)) {
				logger.log("WEBM file found. Converting to MP3...");
				await this.convertWebmToMp3(webmFilePath, mp3FilePath);
			} else if (fs.existsSync(mp4FilePath)) {
				logger.log("MP4 file found. Converting to MP3...");
				await this.convertMp4ToMp3(mp4FilePath, mp3FilePath);
			} else {
				logger.log("Downloading audio...");
				await this.downloadAudio(url, mp3FilePath);
			}
		}

		logger.log(`Audio prepared at ${mp3FilePath}`);

		const audioBuffer = fs.readFileSync(mp3FilePath);
		logger.log(`Audio file size: ${audioBuffer.length} bytes`);

		logger.log("Starting transcription...");
		const startTime = Date.now();
		const transcript = await runtime.useModel(
			ModelType.TRANSCRIPTION,
			audioBuffer,
		);

		const endTime = Date.now();
		logger.log(
			`Transcription completed in ${(endTime - startTime) / 1000} seconds`,
		);

		// Don't delete the MP3 file as it might be needed for future use
		return transcript || "Transcription failed";
	}

	/**
	 * Converts a given MP4 file to MP3 format.
	 *
	 * @param {string} inputPath - The path to the input MP4 file.
	 * @param {string} outputPath - The desired path for the output MP3 file.
	 * @returns {Promise<void>} A Promise that resolves once the conversion is complete or rejects with an error.
	 */
	private async convertMp4ToMp3(
		inputPath: string,
		outputPath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			ffmpeg(inputPath)
				.output(outputPath)
				.noVideo()
				.audioCodec("libmp3lame")
				.on("end", () => {
					logger.log("Conversion to MP3 complete");
					resolve();
				})
				.on("error", (err) => {
					logger.log("Error converting to MP3:", err);
					reject(err);
				})
				.run();
		});
	}

	/**
	 * Convert a WebM file to MP3 format.
	 *
	 * @param {string} inputPath - The path of the WebM file to convert.
	 * @param {string} outputPath - The path where the MP3 file will be saved.
	 * @returns {Promise<void>} Promise that resolves when the conversion is complete.
	 */
	private async convertWebmToMp3(
		inputPath: string,
		outputPath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			ffmpeg(inputPath)
				.output(outputPath)
				.noVideo()
				.audioCodec("libmp3lame")
				.on("end", () => {
					logger.log("Conversion to MP3 complete");
					resolve();
				})
				.on("error", (err) => {
					logger.log("Error converting to MP3:", err);
					reject(err);
				})
				.run();
		});
	}

	/**
	 * Downloads audio from a given URL and saves it to the specified output file.
	 * If no output file is provided, it will default to saving the audio in the data directory with the video ID as the filename.
	 * Supports downloading and converting MP4 files to MP3 as well as downloading audio from YouTube videos using youtube-dl.
	 *
	 * @param url - The URL of the audio to download.
	 * @param outputFile - The path to save the downloaded audio file. If not provided, it defaults to saving in the data directory with the video ID as the filename.
	 * @returns A Promise that resolves with the path to the downloaded audio file.
	 * @throws Error if there is an issue during the download process.
	 */
	private async downloadAudio(
		url: string,
		outputFile: string,
	): Promise<string> {
		logger.log("Downloading audio");
		outputFile =
			outputFile ?? path.join(this.dataDir, `${this.getVideoId(url)}.mp3`);

		try {
			if (url.endsWith(".mp4") || url.includes(".mp4?")) {
				logger.log(
					"Direct MP4 file detected, downloading and converting to MP3",
				);
				const tempMp4File = path.join(tmpdir(), `${this.getVideoId(url)}.mp4`);
				const response = await fetch(url);
				const arrayBuffer = await response.arrayBuffer();
				const buffer = Buffer.from(arrayBuffer);
				fs.writeFileSync(tempMp4File, buffer);

				await new Promise<void>((resolve, reject) => {
					ffmpeg(tempMp4File)
						.output(outputFile)
						.noVideo()
						.audioCodec("libmp3lame")
						.on("end", () => {
							fs.unlinkSync(tempMp4File);
							resolve();
						})
						.on("error", (err) => {
							reject(err);
						})
						.run();
				});
			} else {
				logger.log("YouTube video detected, downloading audio with youtube-dl");
				await getYoutubeDL()(url, {
					verbose: true,
					extractAudio: true,
					audioFormat: "mp3",
					output: outputFile,
					writeInfoJson: true,
				});
			}
			return outputFile;
		} catch (error) {
			logger.log("Error downloading audio:", error);
			throw new Error("Failed to download audio");
		}
	}
}
