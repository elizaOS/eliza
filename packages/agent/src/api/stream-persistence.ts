/**
 * Stream persistence layer — overlay layout and visual/voice settings I/O.
 *
 * Extracted from stream-routes.ts to keep that file focused on route handling.
 * All functions here deal with reading/writing JSON files under the
 * `data/stream/` directory.
 *
 * @module api/stream-persistence
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import type { StreamingDestination } from "./streaming-types.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface StreamVoiceSettings {
  enabled: boolean;
  provider?: string;
  autoSpeak?: boolean;
}

export interface StreamVisualSettings {
  theme?: string;
  avatarIndex?: number;
  voice?: StreamVoiceSettings;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERLAY_DIR = path.join(
  process.env.ELIZA_DATA_DIR || path.join(process.cwd(), "data"),
  "stream",
);

const SETTINGS_FILE = path.join(OVERLAY_DIR, "stream-settings.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sanitize destination ID for use as a filename segment. */
export function safeDestId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Return the layout file path for a given destination (or global default). */
function overlayFileForDestination(destinationId?: string | null): string {
  if (destinationId) {
    return path.join(
      OVERLAY_DIR,
      `overlay-layout-${safeDestId(destinationId)}.json`,
    );
  }
  return path.join(OVERLAY_DIR, "overlay-layout.json");
}

/** Extract `?destination=<id>` from the raw request URL. */
export function parseDestinationQuery(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get("destination") || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Overlay layout persistence (per-destination JSON files)
// ---------------------------------------------------------------------------

/** Read overlay layout as JSON string for seeding into headless browser. */
function getOverlayLayoutJson(destinationId?: string | null): string | null {
  const files = destinationId
    ? [
        overlayFileForDestination(destinationId),
        overlayFileForDestination(null),
      ]
    : [overlayFileForDestination(null)];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        return fs.readFileSync(f, "utf-8");
      }
    } catch {
      // Not available
    }
  }
  return null;
}

/**
 * Read overlay layout for a destination.
 * Falls back: destination-specific -> global -> plugin default -> null.
 */
export function readOverlayLayout(
  destinationId?: string | null,
  destination?: StreamingDestination,
): unknown {
  if (destinationId) {
    const destFile = overlayFileForDestination(destinationId);
    try {
      if (fs.existsSync(destFile)) {
        return JSON.parse(fs.readFileSync(destFile, "utf-8"));
      }
    } catch {
      logger.warn(
        `[stream] Failed to read overlay layout for ${destinationId}`,
      );
    }
  }

  const globalFile = overlayFileForDestination(null);
  try {
    if (fs.existsSync(globalFile)) {
      return JSON.parse(fs.readFileSync(globalFile, "utf-8"));
    }
  } catch {
    logger.warn("[stream] Failed to read global overlay layout file");
  }

  if (destination?.defaultOverlayLayout) {
    return destination.defaultOverlayLayout;
  }

  return null;
}

/** Write overlay layout (to destination-specific or global file). */
export function writeOverlayLayout(
  layout: unknown,
  destinationId?: string | null,
): void {
  fs.mkdirSync(OVERLAY_DIR, { recursive: true });
  const file = overlayFileForDestination(destinationId);
  fs.writeFileSync(file, JSON.stringify(layout, null, 2), "utf-8");
  const label = destinationId ? `[${destinationId}]` : "[global]";
  logger.info(`[stream] Overlay layout ${label} saved`);
}

/**
 * Seed the plugin's default overlay layout on first stream start.
 * Only writes if no destination-specific layout file exists yet.
 */
export function seedOverlayDefaults(destination: StreamingDestination): void {
  if (!destination.defaultOverlayLayout) return;
  const destFile = overlayFileForDestination(destination.id);
  if (fs.existsSync(destFile)) return;
  writeOverlayLayout(destination.defaultOverlayLayout, destination.id);
  logger.info(`[stream] Seeded default overlay layout for ${destination.name}`);
}

// ---------------------------------------------------------------------------
// Stream visual/voice settings persistence
// ---------------------------------------------------------------------------

const SETTINGS_MAX_JSON_BYTES = 4096;

/**
 * Validate and sanitize a raw settings object into a safe StreamVisualSettings.
 * Only allows known keys with expected types — rejects everything else.
 * Returns null with an error message if validation fails.
 */
export function validateStreamSettings(
  raw: unknown,
):
  | { settings: StreamVisualSettings; error?: undefined }
  | { settings?: undefined; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Settings must be a non-array object" };
  }

  // Reject if serialized payload is too large
  const serialized = JSON.stringify(raw);
  if (serialized.length > SETTINGS_MAX_JSON_BYTES) {
    return {
      error: `Settings payload exceeds ${SETTINGS_MAX_JSON_BYTES} byte limit`,
    };
  }

  const input = raw as Record<string, unknown>;
  const result: StreamVisualSettings = {};

  // theme: optional string, max 64 chars
  if ("theme" in input) {
    if (typeof input.theme !== "string" || input.theme.length > 64) {
      return { error: "theme must be a string (max 64 chars)" };
    }
    result.theme = input.theme;
  }

  // avatarIndex: optional non-negative integer
  if ("avatarIndex" in input) {
    if (
      typeof input.avatarIndex !== "number" ||
      !Number.isInteger(input.avatarIndex) ||
      input.avatarIndex < 0 ||
      input.avatarIndex > 999
    ) {
      return { error: "avatarIndex must be an integer between 0 and 999" };
    }
    result.avatarIndex = input.avatarIndex;
  }

  // voice: optional object with known fields
  if ("voice" in input) {
    if (
      !input.voice ||
      typeof input.voice !== "object" ||
      Array.isArray(input.voice)
    ) {
      return { error: "voice must be an object" };
    }
    const v = input.voice as Record<string, unknown>;
    const voice: StreamVoiceSettings = {
      enabled: false,
    };
    if ("enabled" in v) {
      if (typeof v.enabled !== "boolean") {
        return { error: "voice.enabled must be a boolean" };
      }
      voice.enabled = v.enabled;
    }
    if ("autoSpeak" in v) {
      if (typeof v.autoSpeak !== "boolean") {
        return { error: "voice.autoSpeak must be a boolean" };
      }
      voice.autoSpeak = v.autoSpeak;
    }
    if ("provider" in v) {
      if (typeof v.provider !== "string" || v.provider.length > 64) {
        return { error: "voice.provider must be a string (max 64 chars)" };
      }
      voice.provider = v.provider;
    }
    result.voice = voice;
  }

  // Reject unknown top-level keys
  const knownKeys = new Set(["theme", "avatarIndex", "voice"]);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      return { error: `Unknown settings key: ${key}` };
    }
  }

  return { settings: result };
}

export function readStreamSettings(): StreamVisualSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    logger.warn("[stream] Failed to read stream settings file");
  }
  return {};
}

export function writeStreamSettings(settings: StreamVisualSettings): void {
  fs.mkdirSync(OVERLAY_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
  logger.info("[stream] Stream settings saved");
}

/**
 * Build the visual config for browser-capture by merging:
 *   1. Server-side stream-settings.json (authoritative)
 *   2. Environment variables (STREAM_THEME, STREAM_AVATAR_INDEX) as fallback
 *
 * Reads the active destination's overlay layout when available.
 */
export function getHeadlessCaptureConfig(destinationId?: string | null): {
  overlayLayout?: string;
  theme?: string;
  avatarIndex?: number;
  destinationId?: string;
} {
  const settings = readStreamSettings();
  return {
    overlayLayout: getOverlayLayoutJson(destinationId) ?? undefined,
    theme: settings.theme ?? process.env.STREAM_THEME,
    avatarIndex:
      settings.avatarIndex ??
      (process.env.STREAM_AVATAR_INDEX
        ? parseInt(process.env.STREAM_AVATAR_INDEX, 10)
        : undefined),
    destinationId: destinationId ?? undefined,
  };
}
