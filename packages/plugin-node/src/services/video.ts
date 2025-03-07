import {
	type IAgentRuntime,
	type IVideoService,
	type Media,
	Service,
	ServiceTypes,
	type ServiceType,
	stringToUuid,
	logger,
	ModelTypes,
} from "@elizaos/core";
import ffmpeg from "fluent-ffmpeg";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ytdl, { create } from "youtube-dl-exec";

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

export class VideoService extends Service implements IVideoService {
	static serviceType: ServiceType = ServiceTypes.VIDEO;
	capabilityDescription = "The agent is able to download and process videos";
	private cacheKey = "content/video";
	private dataDir = "./content_cache";

	private queue: string[] = [];
	private processing = false;

	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
		this.ensureDataDirectoryExists();
	}

	static async start(runtime: IAgentRuntime): Promise<VideoService> {
		const service = new VideoService(runtime);
		return service;
	}

	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceTypes.VIDEO);
		if (service) {
			await service.stop();
		}
	}

	async stop() {
		// do nothing
	}

	private ensureDataDirectoryExists() {
		if (!fs.existsSync(this.dataDir)) {
			fs.mkdirSync(this.dataDir);
		}
	}

	public isVideoUrl(url: string): boolean {
		return (
			url.includes("youtube.com") ||
			url.includes("youtu.be") ||
			url.includes("vimeo.com")
		);
	}

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

		const cached = await runtime.getDatabaseAdapter().getCache<Media>(cacheKey);

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

			await runtime.getDatabaseAdapter().setCache<Media>(cacheKey, result);

			return result;
		} catch (error) {
			throw new Error(`Error processing video: ${error.message || error}`);
		}
	}

	private getVideoId(url: string): string {
		return stringToUuid(url);
	}

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

	private async downloadCaption(url: string): Promise<string> {
		logger.log("Downloading caption from:", url);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download caption: ${response.statusText}`);
		}
		return await response.text();
	}

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

	private parseSRT(srtContent: string): string {
		// Simple SRT parser (replace with a more robust solution if needed)
		return srtContent
			.split("\n\n")
			.map((block) => block.split("\n").slice(2).join(" "))
			.join(" ");
	}

	private async downloadSRT(url: string): Promise<string> {
		logger.log("downloadSRT");
		const response = await fetch(url);
		return await response.text();
	}

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
			ModelTypes.TRANSCRIPTION,
			audioBuffer,
		);

		const endTime = Date.now();
		logger.log(
			`Transcription completed in ${(endTime - startTime) / 1000} seconds`,
		);

		// Don't delete the MP3 file as it might be needed for future use
		return transcript || "Transcription failed";
	}

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
