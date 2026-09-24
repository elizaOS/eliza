/**
 * Owns native desktop speech synthesis and forwards renderer speech events.
 * Each speech operation owns its process or stream; cancellation prevents stale
 * completions from changing a newer operation's state.
 */

import { ElizaError } from "@elizaos/common";
import type { TalkModeConfig, TalkModeState } from "../rpc-schema";
import type { SendToWebview } from "../types.js";
import { diagnosticLog } from "./agent";

function talkmodeLog(message: string): void {
  diagnosticLog(`[TalkMode] ${message}`);
}

export class TalkModeManager {
  private sendToWebview: SendToWebview | null = null;
  private state: TalkModeState = "idle";
  private speaking = false;
  private config: TalkModeConfig = {
    engine: "web",
    modelSize: "base",
    language: "en",
  };
  /** In-flight system TTS process — killed by stopSpeaking(). */
  private _speakProc: ReturnType<typeof Bun.spawn> | null = null;
  /** AbortController for in-flight ElevenLabs fetch — aborted by stopSpeaking(). */
  private _speakAbort: AbortController | null = null;
  private speechGeneration = 0;

  setSendToWebview(fn: SendToWebview): void {
    this.sendToWebview = fn;
  }

  private setState(newState: TalkModeState): void {
    this.state = newState;
    this.sendToWebview?.("talkmodeStateChanged", { state: newState });
  }

  async start() {
    talkmodeLog(
      `start platform=${process.platform} engine=${this.config.engine ?? "web"}`,
    );
    this.setState("listening");
    return {
      available: true,
      reason: "Using Web Speech API for STT (native whisper pipeline removed)",
    };
  }

  async stop(): Promise<void> {
    await this.stopSpeaking();
  }

  async speak(options: {
    text: string;
    directive?: Record<string, unknown>;
  }): Promise<void> {
    this.cancelSpeech();
    const generation = this.speechGeneration;
    const apiKey = process.env.ELEVEN_LABS_API_KEY?.trim();
    const source = apiKey ? "elevenlabs" : "system";
    this.speaking = true;
    this.setState("speaking");
    try {
      if (apiKey) {
        await this.speakElevenLabs(options, apiKey, generation);
      } else {
        await this.speakSystem(options.text);
      }
      if (generation === this.speechGeneration) {
        this.sendToWebview?.("talkmodeSpeakComplete");
      }
    } catch (cause) {
      // error-policy:J2 Native failures reject the RPC with their cause; deliberate cancellation is observed by generation ownership.
      if (generation !== this.speechGeneration) return;
      const error =
        cause instanceof ElizaError
          ? cause
          : new ElizaError(
              cause instanceof Error ? cause.message : String(cause),
              {
                code: "TTS_FAILED",
                cause,
                context: { source, platform: process.platform },
              },
            );
      talkmodeLog(
        `speech failed code=${error.code} source=${source}: ${error.message}`,
      );
      this.sendToWebview?.("talkmodeError", { source, message: error.message });
      this.setState("error");
      throw error;
    } finally {
      if (generation === this.speechGeneration) {
        this._speakProc = null;
        this._speakAbort = null;
        this.speaking = false;
        if (this.state !== "error") this.setState("idle");
      }
    }
  }

  private async speakSystem(text: string): Promise<void> {
    let proc: ReturnType<typeof Bun.spawn>;
    if (process.platform === "darwin") {
      proc = Bun.spawn(["say", text], { stderr: "pipe" });
    } else if (process.platform === "linux") {
      const executable = Bun.which("espeak-ng") ?? Bun.which("espeak");
      if (!executable) {
        throw new ElizaError(
          "Install espeak-ng to enable Linux system speech",
          {
            code: "SYSTEM_TTS_UNAVAILABLE",
            context: { platform: "linux" },
          },
        );
      }
      // Standard input preserves complete text, including leading option-like
      // strings, without hitting the OS command-line argument size boundary.
      proc = Bun.spawn([executable, "--stdin"], {
        stdin: new Blob([text]),
        stdout: "ignore",
        stderr: "pipe",
      });
    } else if (process.platform === "win32") {
      proc = Bun.spawn(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:ELIZA_TTS_TEXT)",
        ],
        { stderr: "pipe", env: { ...process.env, ELIZA_TTS_TEXT: text } },
      );
    } else {
      throw new ElizaError("System speech is unavailable on this platform", {
        code: "SYSTEM_TTS_UNAVAILABLE",
        context: { platform: process.platform },
      });
    }
    this._speakProc = proc;
    if (!proc.stderr || typeof proc.stderr === "number") {
      proc.kill();
      throw new ElizaError("System speech diagnostic pipe is unavailable", {
        code: "SYSTEM_TTS_PIPE_FAILED",
      });
    }
    const [exitCode, diagnostic] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new ElizaError(`System speech exited with status ${exitCode}`, {
        code: "SYSTEM_TTS_FAILED",
        context: { platform: process.platform, exitCode, diagnostic },
      });
    }
  }

  private async speakElevenLabs(
    options: { text: string; directive?: Record<string, unknown> },
    apiKey: string,
    generation: number,
  ): Promise<void> {
    const abort = new AbortController();
    this._speakAbort = abort;
    const voiceId =
      (options.directive?.voiceId as string) ??
      this.config.voiceId ??
      "21m00Tcm4TlvDq8ikWAM";
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        signal: abort.signal,
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: options.text,
          model_id: (options.directive?.modelId as string) ?? "eleven_v3",
          voice_settings: {
            stability: (options.directive?.stability as number) ?? 0.5,
            similarity_boost: (options.directive?.similarity as number) ?? 0.75,
          },
        }),
      },
    );
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new ElizaError(
        `ElevenLabs API error: ${resp.status} ${resp.statusText}`,
        {
          code: "TTS_HTTP_FAILED",
          context: { status: resp.status },
        },
      );
    }
    if (!resp.body)
      throw new ElizaError("Speech response contained no audio", {
        code: "TTS_AUDIO_MISSING",
      });
    const reader = resp.body.getReader();
    let receivedAudio = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (generation !== this.speechGeneration) {
          await reader.cancel();
          return;
        }
        if (done) break;
        if (value.byteLength === 0) continue;
        receivedAudio = true;
        this.sendToWebview?.("talkmodeAudioChunkPush", {
          data: Buffer.from(value).toString("base64"),
        });
      }
    } finally {
      reader.releaseLock();
    }
    if (!receivedAudio)
      throw new ElizaError("Speech response contained no audio", {
        code: "TTS_AUDIO_MISSING",
      });
  }

  private cancelSpeech(): void {
    this.speechGeneration += 1;
    const proc = this._speakProc;
    this._speakProc = null;
    if (proc) {
      try {
        proc.kill();
      } catch (error) {
        // error-policy:J6 Process teardown can race its exit; the speech promise still observes completion.
        talkmodeLog(
          `speech process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this._speakAbort?.abort();
    this._speakAbort = null;
  }

  async stopSpeaking(): Promise<void> {
    this.cancelSpeech();
    this.speaking = false;
    this.setState("idle");
  }

  async getState() {
    return { state: this.state };
  }

  async isEnabled() {
    return { enabled: true };
  }

  async isSpeaking() {
    return { speaking: this.speaking };
  }

  async updateConfig(config: TalkModeConfig): Promise<void> {
    Object.assign(this.config, config);
    talkmodeLog(
      `updateConfig engine=${this.config.engine ?? "unset"} modelSize=${this.config.modelSize ?? "unset"} language=${this.config.language ?? "unset"}`,
    );
  }

  async audioChunk(options: { data: string }): Promise<void> {
    // Only forward audio while listening — Web Speech API in the renderer
    // drives recognition; the native whisper.cpp pipeline has been removed.
    if (this.state !== "listening") {
      return;
    }
    this.sendToWebview?.("talkmodeAudioChunkPush", { data: options.data });
  }

  dispose(): void {
    this.cancelSpeech();
    this.speaking = false;
    this.state = "idle";
    this.sendToWebview = null;
  }
}

let talkModeManager: TalkModeManager | null = null;

export function getTalkModeManager(): TalkModeManager {
  if (!talkModeManager) {
    talkModeManager = new TalkModeManager();
  }
  return talkModeManager;
}
