export type VoiceTtsChunkingConfig = {
  minChars: number;
  maxChars: number;
  flushOnPunctuation: boolean;
  maxDelayMs: number;
};

export type VoiceTtsChunk = {
  sequence: number;
  text: string;
  final: boolean;
  reason: "punctuation" | "max-chars" | "max-delay" | "final";
};

type VoiceTtsChunkerOptions = {
  config?: Partial<VoiceTtsChunkingConfig>;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

const DEFAULT_TTS_CHUNKING_CONFIG: VoiceTtsChunkingConfig = {
  minChars: 40,
  maxChars: 240,
  flushOnPunctuation: true,
  maxDelayMs: 300,
};

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return fallback;
}

export function getDefaultVoiceTtsChunkingConfig(): VoiceTtsChunkingConfig {
  return { ...DEFAULT_TTS_CHUNKING_CONFIG };
}

export function getVoiceTtsChunkingConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceTtsChunkingConfig {
  const defaults = getDefaultVoiceTtsChunkingConfig();
  return {
    minChars: readPositiveInt(
      env,
      "ELIZA_VOICE_TTS_CHUNK_MIN_CHARS",
      defaults.minChars,
    ),
    maxChars: readPositiveInt(
      env,
      "ELIZA_VOICE_TTS_CHUNK_MAX_CHARS",
      defaults.maxChars,
    ),
    flushOnPunctuation: readBoolean(
      env,
      "ELIZA_VOICE_TTS_CHUNK_FLUSH_ON_PUNCTUATION",
      defaults.flushOnPunctuation,
    ),
    maxDelayMs: readPositiveInt(
      env,
      "ELIZA_VOICE_TTS_CHUNK_MAX_DELAY_MS",
      defaults.maxDelayMs,
    ),
  };
}

function normalizeConfig(
  config: VoiceTtsChunkingConfig,
): VoiceTtsChunkingConfig {
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  return {
    minChars,
    maxChars,
    flushOnPunctuation: config.flushOnPunctuation,
    maxDelayMs: Math.max(1, Math.floor(config.maxDelayMs)),
  };
}

function endsWithSentencePunctuation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!/[.!?]$/.test(trimmed)) return false;
  return !/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/.test(trimmed);
}

export class VoiceTtsChunker {
  private readonly config: VoiceTtsChunkingConfig;
  private readonly now: () => number;
  private buffer = "";
  private sequence = 0;
  private firstBufferedAt: number | null = null;

  constructor(options: VoiceTtsChunkerOptions = {}) {
    this.config = normalizeConfig({
      ...getVoiceTtsChunkingConfigFromEnv(options.env),
      ...(options.config ?? {}),
    });
    this.now = options.now ?? (() => Date.now());
  }

  pushDelta(text: string): VoiceTtsChunk[] {
    if (!text) return [];
    if (this.firstBufferedAt === null) {
      this.firstBufferedAt = this.now();
    }
    this.buffer += text;
    return this.drain(false);
  }

  flushDue(): VoiceTtsChunk[] {
    if (this.firstBufferedAt === null || !this.buffer) return [];
    const elapsed = this.now() - this.firstBufferedAt;
    if (elapsed < this.config.maxDelayMs) return [];
    return this.emit("max-delay", false, this.buffer.length);
  }

  flush(): VoiceTtsChunk[] {
    if (!this.buffer) return [];
    return this.emit("final", true, this.buffer.length);
  }

  reset(): void {
    this.buffer = "";
    this.sequence = 0;
    this.firstBufferedAt = null;
  }

  private drain(final: boolean): VoiceTtsChunk[] {
    const chunks: VoiceTtsChunk[] = [];
    while (this.buffer.length >= this.config.maxChars) {
      chunks.push(
        ...this.emit(
          "max-chars",
          final,
          this.findSplitIndex(this.config.maxChars),
        ),
      );
    }
    if (
      this.config.flushOnPunctuation &&
      this.buffer.trim().length >= this.config.minChars &&
      endsWithSentencePunctuation(this.buffer)
    ) {
      chunks.push(...this.emit("punctuation", final, this.buffer.length));
    }
    return chunks;
  }

  private findSplitIndex(limit: number): number {
    const window = this.buffer.slice(0, limit);
    const whitespace = window.lastIndexOf(" ");
    if (whitespace >= this.config.minChars) return whitespace + 1;
    return limit;
  }

  private emit(
    reason: VoiceTtsChunk["reason"],
    final: boolean,
    length: number,
  ): VoiceTtsChunk[] {
    const text = this.buffer.slice(0, length).trim();
    this.buffer = this.buffer.slice(length);
    this.firstBufferedAt = this.buffer ? this.now() : null;
    if (!text) return [];
    return [
      {
        sequence: ++this.sequence,
        text,
        final,
        reason,
      },
    ];
  }
}
