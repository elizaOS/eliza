import { logger } from "@elizaos/core";
import { nodewhisper } from "nodejs-whisper";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

interface TranscriptionResult {
	text: string;
}

export class TranscribeManager {
	private static instance: TranscribeManager | null = null;
	private cacheDir: string;
	private ffmpegAvailable = false;
	private ffmpegVersion: string | null = null;
	private ffmpegPath: string | null = null;
	private ffmpegInitialized = false;

	private constructor(cacheDir: string) {
		this.cacheDir = path.join(cacheDir, "whisper");
		logger.info("Initializing TranscribeManager", {
			cacheDir: this.cacheDir,
			timestamp: new Date().toISOString(),
		});
		this.ensureCacheDirectory();
	}

	public async ensureFFmpeg(): Promise<boolean> {
		if (!this.ffmpegInitialized) {
			try {
				await this.initializeFFmpeg();
				this.ffmpegInitialized = true;
			} catch (error) {
				logger.error("FFmpeg initialization failed:", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					timestamp: new Date().toISOString(),
				});
				return false;
			}
		}
		return this.ffmpegAvailable;
	}

	public isFFmpegAvailable(): boolean {
		return this.ffmpegAvailable;
	}

	public async getFFmpegVersion(): Promise<string | null> {
		if (!this.ffmpegVersion) {
			await this.fetchFFmpegVersion();
		}
		return this.ffmpegVersion;
	}

	private async fetchFFmpegVersion(): Promise<void> {
		try {
			const { stdout } = await execAsync("ffmpeg -version");
			this.ffmpegVersion = stdout.split("\n")[0];
			logger.info("FFmpeg version:", {
				version: this.ffmpegVersion,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			this.ffmpegVersion = null;
			logger.error("Failed to get FFmpeg version:", {
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			});
		}
	}

	private async initializeFFmpeg(): Promise<void> {
		try {
			// First check if ffmpeg exists in PATH
			await this.checkFFmpegAvailability();

			if (this.ffmpegAvailable) {
				// Get FFmpeg version info
				await this.fetchFFmpegVersion();

				// Verify FFmpeg capabilities
				await this.verifyFFmpegCapabilities();

				// logger.success("FFmpeg initialized successfully", {
				//   version: this.ffmpegVersion,
				//   path: this.ffmpegPath,
				//   timestamp: new Date().toISOString()
				// });
			} else {
				this.logFFmpegInstallInstructions();
			}
		} catch (error) {
			this.ffmpegAvailable = false;
			logger.error("FFmpeg initialization failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				timestamp: new Date().toISOString(),
			});
			this.logFFmpegInstallInstructions();
		}
	}

	private async checkFFmpegAvailability(): Promise<void> {
		try {
			const { stdout, stderr } = await execAsync(
				"which ffmpeg || where ffmpeg",
			);
			this.ffmpegPath = stdout.trim();
			this.ffmpegAvailable = true;
			logger.info("FFmpeg found at:", {
				path: this.ffmpegPath,
				stderr: stderr ? stderr.trim() : undefined,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			this.ffmpegAvailable = false;
			this.ffmpegPath = null;
			logger.error("FFmpeg not found in PATH:", {
				error: error instanceof Error ? error.message : String(error),
				stderr:
					error instanceof Error && "stderr" in error
						? error.stderr
						: undefined,
				timestamp: new Date().toISOString(),
			});
		}
	}

	private async verifyFFmpegCapabilities(): Promise<void> {
		try {
			// Check if FFmpeg supports required codecs and formats
			const { stdout } = await execAsync("ffmpeg -codecs");
			const hasRequiredCodecs =
				stdout.includes("pcm_s16le") && stdout.includes("wav");

			if (!hasRequiredCodecs) {
				throw new Error(
					"FFmpeg installation missing required codecs (pcm_s16le, wav)",
				);
			}

			// logger.info("FFmpeg capabilities verified", {
			//   hasRequiredCodecs,
			//   timestamp: new Date().toISOString()
			// });
		} catch (error) {
			logger.error("FFmpeg capabilities verification failed:", {
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			});
			throw error;
		}
	}

	private logFFmpegInstallInstructions(): void {
		logger.warn(
			"FFmpeg is required but not properly installed. Please install FFmpeg:",
			{
				instructions: {
					mac: "brew install ffmpeg",
					ubuntu: "sudo apt-get install ffmpeg",
					windows: "choco install ffmpeg",
					manual: "Download from https://ffmpeg.org/download.html",
				},
				requiredVersion: "4.0 or later",
				requiredCodecs: ["pcm_s16le", "wav"],
				timestamp: new Date().toISOString(),
			},
		);
	}

	public static getInstance(cacheDir: string): TranscribeManager {
		if (!TranscribeManager.instance) {
			TranscribeManager.instance = new TranscribeManager(cacheDir);
		}
		return TranscribeManager.instance;
	}

	private ensureCacheDirectory(): void {
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
			// logger.info("Created whisper cache directory:", this.cacheDir);
		}
	}

	private async convertToWav(
		inputPath: string,
		outputPath: string,
	): Promise<void> {
		if (!this.ffmpegAvailable) {
			throw new Error(
				"FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription.",
			);
		}

		try {
			// Add -loglevel error to suppress FFmpeg output unless there's an error
			const { stderr } = await execAsync(
				`ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
			);

			if (stderr) {
				logger.warn("FFmpeg conversion error:", {
					stderr,
					inputPath,
					outputPath,
					timestamp: new Date().toISOString(),
				});
			}

			if (!fs.existsSync(outputPath)) {
				throw new Error("WAV file was not created successfully");
			}
		} catch (error) {
			logger.error("Audio conversion failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				command: `ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
				ffmpegAvailable: this.ffmpegAvailable,
				ffmpegVersion: this.ffmpegVersion,
				ffmpegPath: this.ffmpegPath,
				timestamp: new Date().toISOString(),
			});
			throw new Error(
				`Failed to convert audio to WAV format: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async preprocessAudio(audioBuffer: Buffer): Promise<string> {
		if (!this.ffmpegAvailable) {
			throw new Error(
				"FFmpeg is not installed. Please install FFmpeg to use audio transcription.",
			);
		}

		try {
			const tempInputFile = path.join(
				this.cacheDir,
				`temp_input_${Date.now()}`,
			);
			const tempWavFile = path.join(this.cacheDir, `temp_${Date.now()}.wav`);

			// logger.info("Creating temporary files", {
			//   inputFile: tempInputFile,
			//   wavFile: tempWavFile,
			//   bufferSize: audioBuffer.length,
			//   timestamp: new Date().toISOString()
			// });

			// Write buffer to temporary file
			fs.writeFileSync(tempInputFile, audioBuffer);
			// logger.info("Temporary input file created", {
			//   path: tempInputFile,
			//   size: audioBuffer.length,
			//   timestamp: new Date().toISOString()
			// });

			// Convert to WAV format
			await this.convertToWav(tempInputFile, tempWavFile);

			// Clean up the input file
			if (fs.existsSync(tempInputFile)) {
				fs.unlinkSync(tempInputFile);
				// logger.info("Temporary input file cleaned up", {
				//   path: tempInputFile,
				//   timestamp: new Date().toISOString()
				// });
			}

			return tempWavFile;
		} catch (error) {
			logger.error("Audio preprocessing failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				ffmpegAvailable: this.ffmpegAvailable,
				timestamp: new Date().toISOString(),
			});
			throw new Error(
				`Failed to preprocess audio: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	public async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
		await this.ensureFFmpeg();

		if (!this.ffmpegAvailable) {
			throw new Error(
				"FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription.",
			);
		}

		try {
			// Preprocess audio to WAV format
			const wavFile = await this.preprocessAudio(audioBuffer);

			logger.info("Starting transcription with whisper...");

			// Save original stdout and stderr write functions
			const originalStdoutWrite = process.stdout.write;
			const originalStderrWrite = process.stderr.write;

			// Create a no-op function to suppress output
			const noopWrite = () => true;

			// Redirect stdout and stderr to suppress whisper output
			process.stdout.write = noopWrite;
			process.stderr.write = noopWrite;

			let output: string;
			try {
				// Transcribe using whisper with output suppressed
				output = await nodewhisper(wavFile, {
					modelName: "base.en",
					autoDownloadModelName: "base.en",
					verbose: false,
					whisperOptions: {
						outputInText: true,
						language: "en",
					},
				});
			} finally {
				// Restore original stdout and stderr
				process.stdout.write = originalStdoutWrite;
				process.stderr.write = originalStderrWrite;
			}

			// Clean up temporary WAV file
			if (fs.existsSync(wavFile)) {
				fs.unlinkSync(wavFile);
				logger.info("Temporary WAV file cleaned up");
			}

			// Extract just the text content without timestamps
			const cleanText = output
				.split("\n")
				.map((line) => {
					// Remove timestamps if present [00:00:00.000 --> 00:00:00.000]
					const textMatch = line.match(/](.+)$/);
					return textMatch ? textMatch[1].trim() : line.trim();
				})
				.filter((line) => line) // Remove empty lines
				.join(" ");

			logger.success("Transcription complete:", {
				textLength: cleanText.length,
				timestamp: new Date().toISOString(),
			});

			return { text: cleanText };
		} catch (error) {
			logger.error("Transcription failed:", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				ffmpegAvailable: this.ffmpegAvailable,
			});
			throw error;
		}
	}
}
