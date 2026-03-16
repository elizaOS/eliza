/**
 * TalkMode Plugin for Electron
 *
 * Provides full conversation mode with STT → chat → TTS on desktop platforms.
 *
 * STT Options:
 * - Web Speech API (online, Chrome-based)
 * - Whisper.cpp via Node.js bindings (offline, requires setup)
 *
 * TTS Options:
 * - ElevenLabs API streaming (online, high quality)
 * - System TTS via speechSynthesis API
 * - Native TTS via Electron IPC (platform-specific)
 */
/**
 * TalkMode Plugin implementation for Electron
 */
export class TalkModeElectron {
    constructor() {
        this.config = {};
        this.state = "idle";
        this.statusText = "Off";
        this.enabled = false;
        this.isSpeakingValue = false;
        this.usedSystemTts = false;
        this.listeners = [];
        // Speech recognition
        this.recognition = null;
        // TTS
        this.synthesis = null;
        this.currentUtterance = null;
        this.audioContext = null;
        this.audioSource = null;
        // Audio capture for Whisper (renderer -> main)
        this.captureContext = null;
        this.captureStream = null;
        this.captureProcessor = null;
        this.captureGain = null;
        this.captureSampleRate = 16000;
        // Native TTS playback tracking
        this.pendingNativeSpeakResolve = null;
        this.pendingNativeSpeakComplete = null;
        this.awaitingNativeAudio = false;
        this.ipcHandlers = [];
        if (typeof window !== "undefined" && window.speechSynthesis) {
            this.synthesis = window.speechSynthesis;
        }
    }
    // MARK: - Plugin Methods
    async start(options) {
        if (options?.config) {
            this.config = { ...this.config, ...options.config };
        }
        // Try native STT/TTS via Electron IPC first
        if (window.electron?.ipcRenderer) {
            try {
                const result = await window.electron.ipcRenderer.invoke("talkmode:start", options);
                if (result.started) {
                    this.enabled = true;
                    this.setupElectronListeners();
                    this.setState("listening", "Listening");
                    const whisperStatus = await window.electron.ipcRenderer.invoke("talkmode:isWhisperAvailable");
                    if (whisperStatus.available) {
                        this.captureSampleRate = this.config.stt?.sampleRate ?? 16000;
                        await this.startAudioCapture();
                    }
                    return result;
                }
            }
            catch {
                // Fall through to web implementation
            }
        }
        // Fallback to Web Speech API
        const SpeechRecognitionAPI = window.SpeechRecognition ||
            window.webkitSpeechRecognition;
        if (!SpeechRecognitionAPI) {
            return {
                started: false,
                error: "Speech recognition not supported. Consider installing Whisper.cpp for offline support.",
            };
        }
        this.enabled = true;
        this.recognition = new SpeechRecognitionAPI();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.onresult = (event) => {
            const result = event.results[event.results.length - 1];
            const transcript = result[0].transcript;
            const isFinal = result.isFinal;
            this.notifyListeners("transcript", { transcript, isFinal });
        };
        this.recognition.onerror = (event) => {
            this.notifyListeners("error", {
                code: event.error,
                message: event.message || event.error,
                recoverable: event.error !== "not-allowed",
            });
        };
        this.recognition.onend = () => {
            if (this.enabled && this.state === "listening") {
                try {
                    this.recognition?.start();
                }
                catch {
                    // Ignore - may already be starting
                }
            }
        };
        try {
            this.recognition.start();
            this.setState("listening", "Listening");
            return { started: true };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to start";
            return { started: false, error: message };
        }
    }
    setupElectronListeners() {
        if (!window.electron?.ipcRenderer)
            return;
        this.removeElectronListeners();
        const events = ["stateChange", "transcript", "speaking", "error"];
        const handlers = [
            ...events.map((eventName) => ({
                channel: `talkmode:${eventName}`,
                handler: (data) => this.notifyListeners(eventName, data),
            })),
            {
                channel: "talkmode:speakComplete",
                handler: (data) => this.handleNativeSpeakComplete(data),
            },
            {
                channel: "talkmode:audioComplete",
                handler: (data) => void this.handleNativeAudioComplete(data),
            },
        ];
        for (const entry of handlers) {
            window.electron.ipcRenderer.on(entry.channel, entry.handler);
            this.ipcHandlers.push(entry);
        }
    }
    removeElectronListeners() {
        if (!window.electron?.ipcRenderer)
            return;
        for (const entry of this.ipcHandlers) {
            window.electron.ipcRenderer.removeListener(entry.channel, entry.handler);
        }
        this.ipcHandlers = [];
    }
    async stop() {
        this.enabled = false;
        this.stopAudioCapture();
        this.removeElectronListeners();
        if (window.electron?.ipcRenderer) {
            try {
                await window.electron.ipcRenderer.invoke("talkmode:stop");
            }
            catch {
                // Ignore
            }
        }
        this.recognition?.stop();
        this.recognition = null;
        this.synthesis?.cancel();
        this.currentUtterance = null;
        this.stopAudio();
        this.awaitingNativeAudio = false;
        this.pendingNativeSpeakComplete = null;
        this.pendingNativeSpeakResolve = null;
        this.setState("idle", "Off");
    }
    async isEnabled() {
        return { enabled: this.enabled };
    }
    async getState() {
        return { state: this.state, statusText: this.statusText };
    }
    async updateConfig(options) {
        this.config = { ...this.config, ...options.config };
        if (window.electron?.ipcRenderer) {
            try {
                await window.electron.ipcRenderer.invoke("talkmode:updateConfig", options);
            }
            catch {
                // Ignore
            }
        }
    }
    async speak(options) {
        const text = options.text.trim();
        if (!text) {
            return { completed: true, interrupted: false, usedSystemTts: false };
        }
        if (this.pendingNativeSpeakResolve) {
            await this.stopSpeaking();
        }
        this.awaitingNativeAudio = false;
        this.pendingNativeSpeakComplete = null;
        // Try ElevenLabs via Electron IPC if available
        if (!options.useSystemTts && window.electron?.ipcRenderer && this.config.tts?.apiKey) {
            try {
                this.awaitingNativeAudio = true;
                this.isSpeakingValue = true;
                this.usedSystemTts = false;
                this.setState("speaking", "Speaking");
                const pending = new Promise((resolve) => {
                    this.pendingNativeSpeakResolve = resolve;
                });
                const result = await window.electron.ipcRenderer.invoke("talkmode:speak", options);
                if (!result.completed) {
                    this.awaitingNativeAudio = false;
                    this.isSpeakingValue = false;
                    this.pendingNativeSpeakResolve = null;
                    return result;
                }
                return pending;
            }
            catch (error) {
                console.warn("[TalkMode] Electron TTS failed, falling back to system:", error);
                this.awaitingNativeAudio = false;
                this.isSpeakingValue = false;
                this.pendingNativeSpeakResolve = null;
            }
        }
        // Try ElevenLabs via fetch (may have CORS issues in Electron)
        if (!options.useSystemTts && this.config.tts?.apiKey && this.config.tts?.voiceId) {
            try {
                return await this.speakWithElevenLabs(text, options);
            }
            catch (error) {
                console.warn("[TalkMode] ElevenLabs TTS failed, falling back to system:", error);
            }
        }
        // Fallback to system TTS
        return this.speakWithSystemTts(text);
    }
    async speakWithElevenLabs(text, options) {
        const voiceId = options.directive?.voiceId || this.config.tts?.voiceId;
        const apiKey = this.config.tts?.apiKey;
        const modelId = options.directive?.modelId || this.config.tts?.modelId || "eleven_v3";
        if (!voiceId || !apiKey) {
            throw new Error("Missing voiceId or apiKey for ElevenLabs");
        }
        this.isSpeakingValue = true;
        this.usedSystemTts = false;
        this.setState("speaking", "Speaking");
        this.notifyListeners("speaking", { text, isSystemTts: false });
        try {
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "xi-api-key": apiKey,
                },
                body: JSON.stringify({
                    text,
                    model_id: modelId,
                    output_format: "mp3_44100_128",
                    voice_settings: {
                        stability: options.directive?.stability ?? 0.5,
                        similarity_boost: options.directive?.similarity ?? 0.75,
                        speed: options.directive?.speed ?? 1.0,
                    },
                }),
            });
            if (!response.ok) {
                throw new Error(`ElevenLabs API error: ${response.status}`);
            }
            const audioData = await response.arrayBuffer();
            await this.playAudioBuffer(audioData);
            this.isSpeakingValue = false;
            this.notifyListeners("speakComplete", { completed: true });
            this.setState("listening", "Listening");
            return { completed: true, interrupted: false, usedSystemTts: false };
        }
        catch (error) {
            this.isSpeakingValue = false;
            throw error;
        }
    }
    async playAudioBuffer(arrayBuffer) {
        return new Promise((resolve, reject) => {
            this.audioContext = new AudioContext();
            this.audioContext.decodeAudioData(arrayBuffer, (buffer) => {
                this.audioSource = this.audioContext.createBufferSource();
                this.audioSource.buffer = buffer;
                this.audioSource.connect(this.audioContext.destination);
                this.audioSource.onended = () => {
                    this.stopAudio();
                    resolve();
                };
                this.audioSource.start(0);
            }, (error) => {
                this.stopAudio();
                reject(error);
            });
        });
    }
    async playBase64Audio(audioBase64) {
        const binaryString = atob(audioBase64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        await this.playAudioBuffer(bytes.buffer);
    }
    async startAudioCapture() {
        if (this.captureContext || !window.electron?.ipcRenderer)
            return;
        this.captureStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.captureContext = new AudioContext();
        const source = this.captureContext.createMediaStreamSource(this.captureStream);
        const processor = this.captureContext.createScriptProcessor(4096, 1, 1);
        const gain = this.captureContext.createGain();
        gain.gain.value = 0;
        this.captureProcessor = processor;
        this.captureGain = gain;
        const inputSampleRate = this.captureContext.sampleRate;
        processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            const downsampled = this.downsampleBuffer(input, inputSampleRate, this.captureSampleRate);
            if (downsampled.length > 0) {
                window.electron?.ipcRenderer.send("talkmode:audioChunk", downsampled);
            }
        };
        source.connect(processor);
        processor.connect(gain);
        gain.connect(this.captureContext.destination);
    }
    stopAudioCapture() {
        if (this.captureProcessor) {
            this.captureProcessor.disconnect();
            this.captureProcessor = null;
        }
        if (this.captureGain) {
            this.captureGain.disconnect();
            this.captureGain = null;
        }
        if (this.captureContext) {
            void this.captureContext.close();
            this.captureContext = null;
        }
        if (this.captureStream) {
            this.captureStream.getTracks().forEach((track) => track.stop());
            this.captureStream = null;
        }
    }
    downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
        if (targetSampleRate >= inputSampleRate) {
            return buffer;
        }
        const ratio = inputSampleRate / targetSampleRate;
        const newLength = Math.round(buffer.length / ratio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
            let acc = 0;
            let count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                acc += buffer[i];
                count += 1;
            }
            result[offsetResult] = count > 0 ? acc / count : 0;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }
    stopAudio() {
        if (this.audioSource) {
            try {
                this.audioSource.stop();
            }
            catch {
                // Ignore - may already be stopped
            }
            this.audioSource = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
    async speakWithSystemTts(text) {
        if (!this.synthesis) {
            return {
                completed: false,
                interrupted: false,
                usedSystemTts: true,
                error: "Speech synthesis not available",
            };
        }
        this.isSpeakingValue = true;
        this.usedSystemTts = true;
        this.setState("speaking", "Speaking (System)");
        this.notifyListeners("speaking", { text, isSystemTts: true });
        return new Promise((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            this.currentUtterance = utterance;
            utterance.onend = () => {
                this.currentUtterance = null;
                this.isSpeakingValue = false;
                this.notifyListeners("speakComplete", { completed: true });
                this.setState("listening", "Listening");
                resolve({ completed: true, interrupted: false, usedSystemTts: true });
            };
            utterance.onerror = (event) => {
                this.currentUtterance = null;
                this.isSpeakingValue = false;
                this.notifyListeners("speakComplete", { completed: false });
                this.setState("idle", "Speech error");
                resolve({
                    completed: false,
                    interrupted: event.error === "interrupted",
                    usedSystemTts: true,
                    error: event.error,
                });
            };
            this.synthesis.speak(utterance);
        });
    }
    resolveNativeSpeak(result) {
        if (this.pendingNativeSpeakResolve) {
            this.pendingNativeSpeakResolve(result);
            this.pendingNativeSpeakResolve = null;
        }
    }
    handleNativeSpeakComplete(event) {
        if (!this.awaitingNativeAudio && !this.pendingNativeSpeakResolve) {
            return;
        }
        this.pendingNativeSpeakComplete = event;
        if (!this.awaitingNativeAudio) {
            this.isSpeakingValue = false;
            this.setState(event.completed ? "listening" : "idle", event.completed ? "Listening" : "Speech error");
            this.notifyListeners("speakComplete", event);
            this.resolveNativeSpeak({
                completed: event.completed,
                interrupted: !event.completed,
                interruptedAt: event.interruptedAt,
                usedSystemTts: false,
            });
            this.pendingNativeSpeakComplete = null;
        }
    }
    async handleNativeAudioComplete(payload) {
        if (!payload.audioBase64)
            return;
        const event = this.pendingNativeSpeakComplete ?? { completed: true };
        try {
            await this.playBase64Audio(payload.audioBase64);
            this.isSpeakingValue = false;
            this.setState(event.completed ? "listening" : "idle", event.completed ? "Listening" : "Speech error");
            this.notifyListeners("speakComplete", event);
            this.resolveNativeSpeak({
                completed: event.completed,
                interrupted: !event.completed,
                interruptedAt: event.interruptedAt,
                usedSystemTts: false,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Native TTS playback failed";
            this.isSpeakingValue = false;
            this.setState("idle", "Speech error");
            this.notifyListeners("error", {
                code: "native_tts_playback_failed",
                message,
                recoverable: true,
            });
            this.resolveNativeSpeak({
                completed: false,
                interrupted: true,
                usedSystemTts: false,
                error: message,
            });
        }
        finally {
            this.awaitingNativeAudio = false;
            this.pendingNativeSpeakComplete = null;
        }
    }
    async stopSpeaking() {
        this.stopAudio();
        if (this.synthesis && this.currentUtterance) {
            this.synthesis.cancel();
            this.currentUtterance = null;
        }
        if (window.electron?.ipcRenderer) {
            try {
                await window.electron.ipcRenderer.invoke("talkmode:stopSpeaking");
            }
            catch {
                // Ignore
            }
        }
        if (this.pendingNativeSpeakResolve) {
            this.awaitingNativeAudio = false;
            this.pendingNativeSpeakComplete = null;
            this.resolveNativeSpeak({
                completed: false,
                interrupted: true,
                usedSystemTts: false,
            });
        }
        this.isSpeakingValue = false;
        return {};
    }
    async isSpeaking() {
        return { speaking: this.isSpeakingValue || (this.synthesis?.speaking ?? false) };
    }
    async checkPermissions() {
        let microphone = "prompt";
        try {
            const result = await navigator.permissions.query({ name: "microphone" });
            microphone = result.state;
        }
        catch {
            // Permissions API may not support microphone query
        }
        const SpeechRecognitionAPI = window.SpeechRecognition ||
            window.webkitSpeechRecognition;
        let speechRecognition = SpeechRecognitionAPI ? "prompt" : "not_supported";
        if (window.electron?.ipcRenderer) {
            try {
                const whisperStatus = await window.electron.ipcRenderer.invoke("talkmode:isWhisperAvailable");
                if (whisperStatus.available) {
                    speechRecognition = "granted";
                }
            }
            catch {
                // Ignore
            }
        }
        return { microphone, speechRecognition };
    }
    async requestPermissions() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
        }
        catch {
            // Permission denied
        }
        return this.checkPermissions();
    }
    // MARK: - State Management
    setState(state, statusText) {
        const previousState = this.state;
        this.state = state;
        this.statusText = statusText;
        this.notifyListeners("stateChange", {
            state,
            previousState,
            statusText,
            usingSystemTts: this.usedSystemTts,
        });
    }
    // MARK: - Event Listeners
    notifyListeners(eventName, data) {
        for (const listener of this.listeners) {
            if (listener.eventName === eventName) {
                listener.callback(data);
            }
        }
    }
    async addListener(eventName, listenerFunc) {
        const entry = { eventName, callback: listenerFunc };
        this.listeners.push(entry);
        return {
            remove: async () => {
                const idx = this.listeners.indexOf(entry);
                if (idx >= 0) {
                    this.listeners.splice(idx, 1);
                }
            },
        };
    }
    async removeAllListeners() {
        this.listeners = [];
    }
}
// Export the plugin instance
export const TalkMode = new TalkModeElectron();
