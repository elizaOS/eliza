// src/plugins/SttTtsPlugin.ts

import { spawn } from "child_process";
import { ITranscriptionService } from "@elizaos/core";
import { Space, JanusClient, AudioDataWithUser } from "agent-twitter-client";

interface PluginConfig {
    openAiApiKey?: string; // for STT & ChatGPT
    elevenLabsApiKey?: string; // for TTS
    sttLanguage?: string; // e.g. "en" for Whisper
    gptModel?: string; // e.g. "gpt-3.5-turbo"
    silenceThreshold?: number; // amplitude threshold for ignoring silence
    voiceId?: string; // specify which ElevenLabs voice to use
    elevenLabsModel?: string; // e.g. "eleven_monolingual_v1"
    systemPrompt?: string; // ex. "You are a helpful AI assistant"
    chatContext?: Array<{
        role: "system" | "user" | "assistant";
        content: string;
    }>;
    transcriptionService: ITranscriptionService;
}

/**
 * MVP plugin for speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)
 * Approach:
 *   - Collect each speaker's unmuted PCM in a memory buffer (only if above silence threshold)
 *   - On speaker mute -> flush STT -> GPT -> TTS -> push to Janus
 */
export class SttTtsPlugin implements Plugin {
    private space?: Space;
    private janus?: JanusClient;

    private openAiApiKey?: string;
    private elevenLabsApiKey?: string;

    private gptModel = "gpt-3.5-turbo";
    private voiceId = "21m00Tcm4TlvDq8ikWAM";
    private elevenLabsModel = "eleven_monolingual_v1";
    private systemPrompt = "You are a helpful AI assistant.";
    private chatContext: Array<{
        role: "system" | "user" | "assistant";
        content: string;
    }> = [];

    private transcriptionService: ITranscriptionService;

    /**
     * userId => arrayOfChunks (PCM Int16)
     */
    private pcmBuffers = new Map<string, Int16Array[]>();

    /**
     * Track mute states: userId => boolean (true=unmuted)
     */
    private speakerUnmuted = new Map<string, boolean>();

    /**
     * For ignoring near-silence frames (if amplitude < threshold)
     */
    private silenceThreshold = 50;

    // TTS queue for sequentially speaking
    private ttsQueue: string[] = [];
    private isSpeaking = false;

    onAttach(_space: Space) {
        console.log("[SttTtsPlugin] onAttach => space was attached");
    }

    init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
        console.log(
            "[SttTtsPlugin] init => Space fully ready. Subscribing to events."
        );

        this.space = params.space;
        this.janus = (this.space as any)?.janusClient as
            | JanusClient
            | undefined;

        const config = params.pluginConfig as PluginConfig;
        this.openAiApiKey = config?.openAiApiKey;
        this.elevenLabsApiKey = config?.elevenLabsApiKey;
        this.transcriptionService = config.transcriptionService;
        if (config?.gptModel) this.gptModel = config.gptModel;
        if (typeof config?.silenceThreshold === "number") {
            this.silenceThreshold = config.silenceThreshold;
        }
        if (config?.voiceId) {
            this.voiceId = config.voiceId;
        }
        if (config?.elevenLabsModel) {
            this.elevenLabsModel = config.elevenLabsModel;
        }
        if (config?.systemPrompt) {
            this.systemPrompt = config.systemPrompt;
        }
        if (config?.chatContext) {
            this.chatContext = config.chatContext;
        }
        console.log("[SttTtsPlugin] Plugin config =>", config);

        // Listen for mute events
        this.space.on(
            "muteStateChanged",
            (evt: { userId: string; muted: boolean }) => {
                console.log("[SttTtsPlugin] Speaker muteStateChanged =>", evt);
                if (evt.muted) {
                    this.handleMute(evt.userId).catch((err) =>
                        console.error("[SttTtsPlugin] handleMute error =>", err)
                    );
                } else {
                    this.speakerUnmuted.set(evt.userId, true);
                    if (!this.pcmBuffers.has(evt.userId)) {
                        this.pcmBuffers.set(evt.userId, []);
                    }
                }
            }
        );
    }

    /**
     * Called whenever we receive PCM from a speaker
     */
    onAudioData(data: AudioDataWithUser): void {
        if (!this.speakerUnmuted.get(data.userId)) return;

        let maxVal = 0;
        for (let i = 0; i < data.samples.length; i++) {
            const val = Math.abs(data.samples[i]);
            if (val > maxVal) maxVal = val;
        }
        if (maxVal < this.silenceThreshold) {
            return;
        }

        let arr = this.pcmBuffers.get(data.userId);
        if (!arr) {
            arr = [];
            this.pcmBuffers.set(data.userId, arr);
        }
        arr.push(data.samples);
    }

    // /src/sttTtsPlugin.ts
    private async convertPcmToWavInMemory(
        pcmData: Int16Array,
        sampleRate: number
    ): Promise<ArrayBuffer> {
        // number of channels
        const numChannels = 1;
        // byte rate = (sampleRate * numChannels * bitsPerSample/8)
        const byteRate = sampleRate * numChannels * 2;
        const blockAlign = numChannels * 2;
        // data chunk size = pcmData.length * (bitsPerSample/8)
        const dataSize = pcmData.length * 2;

        // WAV header is 44 bytes
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // RIFF chunk descriptor
        this.writeString(view, 0, "RIFF");
        view.setUint32(4, 36 + dataSize, true); // file size - 8
        this.writeString(view, 8, "WAVE");

        // fmt sub-chunk
        this.writeString(view, 12, "fmt ");
        view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
        view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
        view.setUint16(22, numChannels, true); // NumChannels
        view.setUint32(24, sampleRate, true); // SampleRate
        view.setUint32(28, byteRate, true); // ByteRate
        view.setUint16(32, blockAlign, true); // BlockAlign
        view.setUint16(34, 16, true); // BitsPerSample (16)

        // data sub-chunk
        this.writeString(view, 36, "data");
        view.setUint32(40, dataSize, true);

        // Write PCM samples
        let offset = 44;
        for (let i = 0; i < pcmData.length; i++, offset += 2) {
            view.setInt16(offset, pcmData[i], true);
        }

        return buffer;
    }

    private writeString(view: DataView, offset: number, text: string) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    /**
     * On speaker mute => flush STT => GPT => TTS => push to Janus
     */
    private async handleMute(userId: string): Promise<void> {
        this.speakerUnmuted.set(userId, false);
        const chunks = this.pcmBuffers.get(userId) || [];
        this.pcmBuffers.set(userId, []);

        if (!chunks.length) {
            console.log("[SttTtsPlugin] No audio chunks for user =>", userId);
            return;
        }
        console.log(
            `[SttTtsPlugin] Flushing STT buffer for user=${userId}, chunks=${chunks.length}`
        );

        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
        }

        // Convert PCM to WAV for STT
        const wavBuffer = await this.convertPcmToWavInMemory(merged, 48000);

        // Whisper STT
        const sttText = await this.transcriptionService.transcribe(wavBuffer);

        if (!sttText || !sttText.trim()) {
            console.log(
                "[SttTtsPlugin] No speech recognized for user =>",
                userId
            );
            return;
        }
        console.log(`[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`);

        // GPT answer
        const replyText = await this.askChatGPT(sttText);
        console.log(
            `[SttTtsPlugin] GPT => user=${userId}, reply="${replyText}"`
        );

        // Use the standard speak method with queue
        await this.speakText(replyText);
    }

    /**
     * Public method to queue a TTS request
     */
    public async speakText(text: string): Promise<void> {
        this.ttsQueue.push(text);
        if (!this.isSpeaking) {
            this.isSpeaking = true;
            this.processTtsQueue().catch((err) => {
                console.error("[SttTtsPlugin] processTtsQueue error =>", err);
            });
        }
    }

    /**
     * Process TTS requests one by one
     */
    private async processTtsQueue(): Promise<void> {
        while (this.ttsQueue.length > 0) {
            const text = this.ttsQueue.shift();
            if (!text) continue;

            try {
                const ttsAudio = await this.elevenLabsTts(text);
                const pcm = await this.convertMp3ToPcm(ttsAudio, 48000);
                await this.streamToJanus(pcm, 48000);
            } catch (err) {
                console.error("[SttTtsPlugin] TTS streaming error =>", err);
            }
        }
        this.isSpeaking = false;
    }

    /**
     * Simple ChatGPT call
     */
    private async askChatGPT(userText: string): Promise<string> {
        if (!this.openAiApiKey) {
            throw new Error("[SttTtsPlugin] No OpenAI API key for ChatGPT");
        }
        const url = "https://api.openai.com/v1/chat/completions";
        const messages = [
            { role: "system", content: this.systemPrompt },
            ...this.chatContext,
            { role: "user", content: userText },
        ];

        const resp = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.openAiApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.gptModel,
                messages,
            }),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(
                `[SttTtsPlugin] ChatGPT error => ${resp.status} ${errText}`
            );
        }

        const json = await resp.json();
        const reply = json.choices?.[0]?.message?.content || "";
        this.chatContext.push({ role: "user", content: userText });
        this.chatContext.push({ role: "assistant", content: reply });
        return reply.trim();
    }

    /**
     * ElevenLabs TTS => returns MP3 Buffer
     */
    private async elevenLabsTts(text: string): Promise<Buffer> {
        if (!this.elevenLabsApiKey) {
            throw new Error("[SttTtsPlugin] No ElevenLabs API key");
        }
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": this.elevenLabsApiKey,
            },
            body: JSON.stringify({
                text,
                model_id: this.elevenLabsModel,
                voice_settings: { stability: 0.4, similarity_boost: 0.8 },
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(
                `[SttTtsPlugin] ElevenLabs TTS error => ${resp.status} ${errText}`
            );
        }
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
    }

    /**
     * Convert MP3 => PCM via ffmpeg
     */
    private convertMp3ToPcm(
        mp3Buf: Buffer,
        outRate: number
    ): Promise<Int16Array> {
        return new Promise((resolve, reject) => {
            const ff = spawn("ffmpeg", [
                "-i",
                "pipe:0",
                "-f",
                "s16le",
                "-ar",
                outRate.toString(),
                "-ac",
                "1",
                "pipe:1",
            ]);
            let raw = Buffer.alloc(0);

            ff.stdout.on("data", (chunk: Buffer) => {
                raw = Buffer.concat([raw, chunk]);
            });
            ff.stderr.on("data", () => {
                // ignoring ffmpeg logs
            });
            ff.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`ffmpeg error code=${code}`));
                    return;
                }
                const samples = new Int16Array(
                    raw.buffer,
                    raw.byteOffset,
                    raw.byteLength / 2
                );
                resolve(samples);
            });

            ff.stdin.write(mp3Buf);
            ff.stdin.end();
        });
    }

    /**
     * Push PCM back to Janus in small frames
     * We'll do 10ms @48k => 960 samples per frame
     */
    private async streamToJanus(
        samples: Int16Array,
        sampleRate: number
    ): Promise<void> {
        // TODO: Check if better than 480 fixed
        const FRAME_SIZE = Math.floor(sampleRate * 0.01); // 10ms frames => 480 @48kHz

        for (
            let offset = 0;
            offset + FRAME_SIZE <= samples.length;
            offset += FRAME_SIZE
        ) {
            const frame = new Int16Array(FRAME_SIZE);
            frame.set(samples.subarray(offset, offset + FRAME_SIZE));
            this.janus?.pushLocalAudio(frame, sampleRate, 1);

            // Short pause so we don't overload
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    public setSystemPrompt(prompt: string) {
        this.systemPrompt = prompt;
        console.log("[SttTtsPlugin] setSystemPrompt =>", prompt);
    }

    /**
     * Change the GPT model at runtime (e.g. "gpt-4", "gpt-3.5-turbo", etc.).
     */
    public setGptModel(model: string) {
        this.gptModel = model;
        console.log("[SttTtsPlugin] setGptModel =>", model);
    }

    /**
     * Add a message (system, user or assistant) to the chat context.
     * E.g. to store conversation history or inject a persona.
     */
    public addMessage(role: "system" | "user" | "assistant", content: string) {
        this.chatContext.push({ role, content });
        console.log(
            `[SttTtsPlugin] addMessage => role=${role}, content=${content}`
        );
    }

    /**
     * Clear the chat context if needed.
     */
    public clearChatContext() {
        this.chatContext = [];
        console.log("[SttTtsPlugin] clearChatContext => done");
    }

    cleanup(): void {
        console.log("[SttTtsPlugin] cleanup => releasing resources");
        this.pcmBuffers.clear();
        this.speakerUnmuted.clear();
        this.ttsQueue = [];
        this.isSpeaking = false;
    }
}
