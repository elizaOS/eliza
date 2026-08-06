import { readFile } from "fs/promises";
import path from "path";

export const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";

export interface GrokSttEngineConfig {
  apiKey: string;
  baseURL?: string;
  language?: string;
}

export interface GrokSttTranscriptionInput {
  audioPath: string;
  fileName?: string;
  mimeType?: string;
}

export interface GrokSttWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
}

export interface GrokSttTranscriptionResult {
  text: string;
  engine: "grok-stt";
  language: string;
  duration: number;
  words?: GrokSttWord[];
}

export class GrokSttEngine {
  constructor(private readonly config: GrokSttEngineConfig) {
    if (!config.apiKey?.trim()) {
      throw new Error("API key required for STT.");
    }
  }

  async transcribe(input: GrokSttTranscriptionInput): Promise<GrokSttTranscriptionResult> {
    const bytes = await readFile(input.audioPath);
    const fileName = input.fileName || path.basename(input.audioPath);
    const mimeType = input.mimeType || inferMimeTypeFromFileName(fileName);
    const baseURL = normalizeBaseURL(this.config.baseURL);
    const language = this.config.language?.trim();

    const form = new FormData();
    const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    form.append("file", new Blob([uint8], { type: mimeType }), fileName);
    if (language) {
      form.append("language", language);
      form.append("format", "true");
    }

    const response = await fetch(`${baseURL}/stt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Grok STT request failed (${response.status}): ${body || response.statusText}`);
    }

    const payload = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      words?: GrokSttWord[];
    };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      throw new Error("Grok STT returned an empty transcript.");
    }

    return {
      text,
      engine: "grok-stt",
      language: typeof payload.language === "string" ? payload.language : "",
      duration: typeof payload.duration === "number" ? payload.duration : 0,
      words: Array.isArray(payload.words) ? payload.words : undefined,
    };
  }
}

export function inferMimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".flac":
      return "audio/flac";
    case ".aac":
      return "audio/aac";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".mkv":
      return "audio/x-matroska";
    default:
      return "application/octet-stream";
  }
}

function normalizeBaseURL(baseURL?: string): string {
  return (baseURL?.trim() || DEFAULT_STT_BASE_URL).replace(/\/+$/, "");
}
