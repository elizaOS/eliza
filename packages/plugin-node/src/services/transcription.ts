import {
    elizaLogger,
    IAgentRuntime,
    ITranscriptionService,
    settings,
    TranscriptionProvider,
} from "@elizaos/core";
import { Service, ServiceType } from "@elizaos/core";
import { exec } from "child_process";
import { File } from "formdata-node";
import fs from "fs";
import { nodewhisper } from "nodejs-whisper";
import OpenAI from "openai"; // todo, can probably move this to model provider or whateer
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { createClient, DeepgramClient } from "@deepgram/sdk";

// const __dirname = path.dirname(new URL(import.meta.url).pathname); #compatibility issues with windows
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

export class TranscriptionService
    extends Service
    implements ITranscriptionService
{
    private runtime: IAgentRuntime | null = null;
    static serviceType: ServiceType = ServiceType.TRANSCRIPTION;
    private CONTENT_CACHE_DIR: string;
    private DEBUG_AUDIO_DIR: string;
    private TARGET_SAMPLE_RATE = 16000; // Common sample rate for speech recognition
    private isCudaAvailable: boolean = false;

    /**
     * CHANGED: We now use TranscriptionProvider instead of separate flags/strings.
     * This allows us to handle character settings, env variables, and fallback logic.
     */
    private transcriptionProvider: TranscriptionProvider | null = null;

    private deepgram: DeepgramClient | null = null;
    private openai: OpenAI | null = null;

    /**
     * We keep the queue and processing logic as is.
     */
    private queue: { audioBuffer: ArrayBuffer; resolve: Function }[] = [];
    private processing: boolean = false;

    /**
     * CHANGED: initialize() now checks:
     * 1) character.settings.transcription (if available and keys exist),
     * 2) then the .env TRANSCRIPTION_PROVIDER,
     * 3) then old fallback logic (Deepgram -> OpenAI -> local).
     */
    async initialize(_runtime: IAgentRuntime): Promise<void> {
        this.runtime = _runtime;

        // 1) Check character settings
        let chosenProvider: TranscriptionProvider | null = null;
        const charSetting = this.runtime.character?.settings?.transcription;

        if (charSetting === TranscriptionProvider.Deepgram) {
            const deepgramKey = this.runtime.getSetting("DEEPGRAM_API_KEY");
            if (deepgramKey) {
                this.deepgram = createClient(deepgramKey);
                chosenProvider = TranscriptionProvider.Deepgram;
            }
        } else if (charSetting === TranscriptionProvider.OpenAI) {
            const openaiKey = this.runtime.getSetting("OPENAI_API_KEY");
            if (openaiKey) {
                this.openai = new OpenAI({ apiKey: openaiKey });
                chosenProvider = TranscriptionProvider.OpenAI;
            }
        } else if (charSetting === TranscriptionProvider.Local) {
            chosenProvider = TranscriptionProvider.Local;
        }

        // 2) If not chosen from character, check .env
        if (!chosenProvider) {
            const envProvider = this.runtime.getSetting("TRANSCRIPTION_PROVIDER");
            if (envProvider) {
                switch (envProvider.toLowerCase()) {
                    case "deepgram":
                    {
                        const dgKey = this.runtime.getSetting("DEEPGRAM_API_KEY");
                        if (dgKey) {
                            this.deepgram = createClient(dgKey);
                            chosenProvider = TranscriptionProvider.Deepgram;
                        }
                    }
                        break;
                    case "openai":
                    {
                        const openaiKey = this.runtime.getSetting("OPENAI_API_KEY");
                        if (openaiKey) {
                            this.openai = new OpenAI({ apiKey: openaiKey });
                            chosenProvider = TranscriptionProvider.OpenAI;
                        }
                    }
                        break;
                    case "local":
                        chosenProvider = TranscriptionProvider.Local;
                        break;
                }
            }
        }

        // 3) If still none, fallback to old logic: Deepgram -> OpenAI -> local
        if (!chosenProvider) {
            const deepgramKey = this.runtime.getSetting("DEEPGRAM_API_KEY");
            if (deepgramKey) {
                this.deepgram = createClient(deepgramKey);
                chosenProvider = TranscriptionProvider.Deepgram;
            } else {
                const openaiKey = this.runtime.getSetting("OPENAI_API_KEY");
                if (openaiKey) {
                    this.openai = new OpenAI({ apiKey: openaiKey });
                    chosenProvider = TranscriptionProvider.OpenAI;
                } else {
                    chosenProvider = TranscriptionProvider.Local;
                }
            }
        }

        this.transcriptionProvider = chosenProvider;

        // Leave detectCuda as is.
        this.detectCuda();
    }

    constructor() {
        super();
        const rootDir = path.resolve(__dirname, "../../");
        this.CONTENT_CACHE_DIR = path.join(rootDir, "content_cache");
        this.DEBUG_AUDIO_DIR = path.join(rootDir, "debug_audio");
        this.ensureCacheDirectoryExists();
        this.ensureDebugDirectoryExists();
        // TODO: It'd be nice to handle this more gracefully, but we can do local transcription for now
        // TODO: remove the runtime from here, use it when called
        // if (runtime.getSetting("OPENAI_API_KEY")) {
        //     this.openai = new OpenAI({
        //         apiKey: runtime.getSetting("OPENAI_API_KEY"),
        //     });
        // } else {
        //     this.detectCuda();
        // }
    }

    private ensureCacheDirectoryExists() {
        if (!fs.existsSync(this.CONTENT_CACHE_DIR)) {
            fs.mkdirSync(this.CONTENT_CACHE_DIR, { recursive: true });
        }
    }

    private ensureDebugDirectoryExists() {
        if (!fs.existsSync(this.DEBUG_AUDIO_DIR)) {
            fs.mkdirSync(this.DEBUG_AUDIO_DIR, { recursive: true });
        }
    }

    private detectCuda() {
        const platform = os.platform();
        if (platform === "linux") {
            try {
                fs.accessSync("/usr/local/cuda/bin/nvcc", fs.constants.X_OK);
                this.isCudaAvailable = true;
                console.log(
                    "CUDA detected. Transcription will use CUDA acceleration."
                );
                // eslint-disable-next-line
            } catch (_error) {
                console.log(
                    "CUDA not detected. Transcription will run on CPU."
                );
            }
        } else if (platform === "win32") {
            const cudaPath = path.join(
                settings.CUDA_PATH ||
                "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v11.0",
                "bin",
                "nvcc.exe"
            );
            if (fs.existsSync(cudaPath)) {
                this.isCudaAvailable = true;
                console.log(
                    "CUDA detected. Transcription will use CUDA acceleration."
                );
            } else {
                console.log(
                    "CUDA not detected. Transcription will run on CPU."
                );
            }
        } else {
            console.log(
                "CUDA not supported on this platform. Transcription will run on CPU."
            );
        }
    }

    private async convertAudio(inputBuffer: ArrayBuffer): Promise<Buffer> {
        const inputPath = path.join(
            this.CONTENT_CACHE_DIR,
            `input_${Date.now()}.wav`
        );
        const outputPath = path.join(
            this.CONTENT_CACHE_DIR,
            `output_${Date.now()}.wav`
        );

        fs.writeFileSync(inputPath, Buffer.from(inputBuffer));

        try {
            const { stdout } = await execAsync(
                `ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of json "${inputPath}"`
            );
            const probeResult = JSON.parse(stdout);
            const stream = probeResult.streams[0];

            elizaLogger.log("Input audio info:", stream);

            let ffmpegCommand = `ffmpeg -i "${inputPath}" -ar ${this.TARGET_SAMPLE_RATE} -ac 1`;

            if (stream.codec_name === "pcm_f32le") {
                ffmpegCommand += " -acodec pcm_s16le";
            }

            ffmpegCommand += ` "${outputPath}"`;

            elizaLogger.log("FFmpeg command:", ffmpegCommand);

            await execAsync(ffmpegCommand);

            const convertedBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            return convertedBuffer;
        } catch (error) {
            elizaLogger.error("Error converting audio:", error);
            throw error;
        }
    }

    private async saveDebugAudio(audioBuffer: ArrayBuffer, prefix: string) {
        this.ensureDebugDirectoryExists();

        const filename = `${prefix}_${Date.now()}.wav`;
        const filePath = path.join(this.DEBUG_AUDIO_DIR, filename);

        fs.writeFileSync(filePath, Buffer.from(audioBuffer));
        elizaLogger.log(`Debug audio saved: ${filePath}`);
    }

    public async transcribeAttachment(
        audioBuffer: ArrayBuffer
    ): Promise<string | null> {
        return await this.transcribe(audioBuffer);
    }

    /**
     * If the audio buffer is too short, return null. Otherwise push to queue.
     */
    public async transcribe(audioBuffer: ArrayBuffer): Promise<string | null> {
        // if the audio buffer is less than .2 seconds, just return null
        if (audioBuffer.byteLength < 0.2 * 16000) {
            return null;
        }
        return new Promise((resolve) => {
            this.queue.push({ audioBuffer, resolve });
            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    public async transcribeAttachmentLocally(
        audioBuffer: ArrayBuffer
    ): Promise<string | null> {
        return this.transcribeLocally(audioBuffer);
    }

    /**
     * CHANGED: processQueue() uses the final transcriptionProvider enum set in initialize().
     */
    private async processQueue(): Promise<void> {
        // Exit if already processing or if the queue is empty
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const { audioBuffer, resolve } = this.queue.shift()!;
            let result: string | null = null;

            switch (this.transcriptionProvider) {
                case TranscriptionProvider.Deepgram:
                    result = await this.transcribeWithDeepgram(audioBuffer);
                    break;
                case TranscriptionProvider.OpenAI:
                    result = await this.transcribeWithOpenAI(audioBuffer);
                    break;
                default:
                    result = await this.transcribeLocally(audioBuffer);
            }

            resolve(result);
        }

        this.processing = false;
    }

    /**
     * Original logic from main is now handled by the final fallback in initialize().
     * We'll keep transcribeUsingDefaultLogic() if needed by other code references,
     * but it’s no longer invoked in the new flow.
     */
    private async transcribeUsingDefaultLogic(audioBuffer: ArrayBuffer): Promise<string | null> {
        if (this.deepgram) {
            return await this.transcribeWithDeepgram(audioBuffer);
        } else if (this.openai) {
            return await this.transcribeWithOpenAI(audioBuffer);
        }
        return await this.transcribeLocally(audioBuffer);
    }

    private async transcribeWithDeepgram(
        audioBuffer: ArrayBuffer
    ): Promise<string | null> {
        const buffer = Buffer.from(audioBuffer);
        const response = await this.deepgram.listen.prerecorded.transcribeFile(
            buffer,
            {
                model: "nova-2",
                language: "en-US",
                smart_format: true,
            }
        );
        const result =
            response.result.results.channels[0].alternatives[0].transcript;
        return result;
    }

    private async transcribeWithOpenAI(
        audioBuffer: ArrayBuffer
    ): Promise<string | null> {
        elizaLogger.log("Transcribing audio with OpenAI...");

        try {
            await this.saveDebugAudio(audioBuffer, "openai_input_original");

            const convertedBuffer = await this.convertAudio(audioBuffer);

            await this.saveDebugAudio(
                convertedBuffer,
                "openai_input_converted"
            );

            const file = new File([convertedBuffer], "audio.wav", {
                type: "audio/wav",
            });

            const result = await this.openai!.audio.transcriptions.create({
                model: "whisper-1",
                language: "en",
                response_format: "text",
                file: file,
            });

            const trimmedResult = (result as any).trim();
            elizaLogger.log(`OpenAI speech to text result: "${trimmedResult}"`);

            return trimmedResult;
        } catch (error) {
            elizaLogger.error(
                "Error in OpenAI speech-to-text conversion:",
                error
            );
            if (error.response) {
                elizaLogger.error("Response data:", error.response.data);
                elizaLogger.error("Response status:", error.response.status);
                elizaLogger.error("Response headers:", error.response.headers);
            } else if (error.request) {
                elizaLogger.error("No response received:", error.request);
            } else {
                elizaLogger.error("Error setting up request:", error.message);
            }
            return null;
        }
    }

    /**
     * Local transcription with nodejs-whisper. We keep it as it was,
     * just making sure to handle CUDA if available.
     */
    public async transcribeLocally(
        audioBuffer: ArrayBuffer
    ): Promise<string | null> {
        try {
            elizaLogger.log("Transcribing audio locally...");

            await this.saveDebugAudio(audioBuffer, "local_input_original");

            const convertedBuffer = await this.convertAudio(audioBuffer);

            await this.saveDebugAudio(convertedBuffer, "local_input_converted");

            const tempWavFile = path.join(
                this.CONTENT_CACHE_DIR,
                `temp_${Date.now()}.wav`
            );
            fs.writeFileSync(tempWavFile, convertedBuffer);

            elizaLogger.debug(`Temporary WAV file created: ${tempWavFile}`);

            let output = await nodewhisper(tempWavFile, {
                modelName: "base.en",
                autoDownloadModelName: "base.en",
                verbose: false,
                removeWavFileAfterTranscription: false,
                withCuda: this.isCudaAvailable,
                whisperOptions: {
                    outputInText: true,
                    outputInVtt: false,
                    outputInSrt: false,
                    outputInCsv: false,
                    translateToEnglish: false,
                    wordTimestamps: false,
                    timestamps_length: 60,
                    // splitOnWord: true,
                },
            });

            output = output
                .split("\n")
                .map((line) => {
                    if (line.trim().startsWith("[")) {
                        const endIndex = line.indexOf("]");
                        return line.substring(endIndex + 1);
                    }
                    return line;
                })
                .join("\n");

            fs.unlinkSync(tempWavFile);

            if (!output || output.length < 5) {
                elizaLogger.log("Output is null or too short, returning null");
                return null;
            }
            return output;
        } catch (error) {
            elizaLogger.error(
                "Error in local speech-to-text conversion:",
                error
            );
            return null;
        }
    }
}
