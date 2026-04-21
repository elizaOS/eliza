/**
 * Types, constants, and utility functions for media settings.
 */

import {
  COMPANION_HALF_FRAMERATE_OPTIONS,
  COMPANION_VRM_POWER_OPTIONS,
} from "@elizaos/app-companion/types/render-modes";
import type { DesktopClickAuditItem } from "../../utils";

export { COMPANION_HALF_FRAMERATE_OPTIONS, COMPANION_VRM_POWER_OPTIONS };

// ── Types ─────────────────────────────────────────────────────────────

export type MediaCategory = "image" | "video" | "audio" | "vision" | "voice";

export interface ProviderOption {
  id: string;
  labelKey: string;
  hint: string;
}

// ── Constants ─────────────────────────────────────────────────────────

export const DESKTOP_MEDIA_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "media-refresh-native",
    entryPoint: "settings:media",
    label: "Refresh Native Media",
    expectedAction:
      "Refresh camera devices, permissions, screen sources, and recording state.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "media-camera-preview",
    entryPoint: "settings:media",
    label: "Start/Stop Camera Preview",
    expectedAction: "Start or stop the native camera preview.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "media-camera-capture",
    entryPoint: "settings:media",
    label: "Capture Photo",
    expectedAction: "Capture a still photo from the native camera surface.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "media-camera-recording",
    entryPoint: "settings:media",
    label: "Start/Stop Camera Recording",
    expectedAction: "Start or stop native camera recording.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "media-screen-screenshot",
    entryPoint: "settings:media",
    label: "Take Screenshot",
    expectedAction:
      "Capture and save a screenshot using the native screen capture API.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "media-screen-recording",
    entryPoint: "settings:media",
    label: "Start/Stop Screen Recording",
    expectedAction: "Start or stop native screen recording.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
] as const;

export const IMAGE_PROVIDERS: ProviderOption[] = [
  {
    id: "cloud",
    labelKey: "provider.elizaCloud",
    hint: "elizaclouddashboard.NoSetupNeeded",
  },
  {
    id: "fal",
    labelKey: "provider.fal",
    hint: "mediasettingssection.ProviderHintFalImage",
  },
  {
    id: "openai",
    labelKey: "provider.openai",
    hint: "mediasettingssection.DALLE3",
  },
  {
    id: "google",
    labelKey: "provider.google",
    hint: "mediasettingssection.ProviderHintGoogleImage",
  },
  {
    id: "xai",
    labelKey: "provider.xai",
    hint: "mediasettingssection.ProviderHintXAIAurora",
  },
];

export const VIDEO_PROVIDERS: ProviderOption[] = [
  {
    id: "cloud",
    labelKey: "provider.elizaCloud",
    hint: "elizaclouddashboard.NoSetupNeeded",
  },
  {
    id: "fal",
    labelKey: "provider.fal",
    hint: "mediasettingssection.ProviderHintFalVideo",
  },
  {
    id: "openai",
    labelKey: "provider.openai",
    hint: "mediasettingssection.ProviderHintOpenAIVideo",
  },
  {
    id: "google",
    labelKey: "provider.google",
    hint: "mediasettingssection.ProviderHintGoogleVideo",
  },
];

export const AUDIO_PROVIDERS: ProviderOption[] = [
  {
    id: "cloud",
    labelKey: "provider.elizaCloud",
    hint: "elizaclouddashboard.NoSetupNeeded",
  },
  {
    id: "suno",
    labelKey: "provider.suno",
    hint: "mediasettingssection.ProviderHintSuno",
  },
  {
    id: "elevenlabs",
    labelKey: "provider.elevenlabs",
    hint: "mediasettingssection.ProviderHintElevenLabs",
  },
];

export const VISION_PROVIDERS: ProviderOption[] = [
  {
    id: "cloud",
    labelKey: "provider.elizaCloud",
    hint: "elizaclouddashboard.NoSetupNeeded",
  },
  {
    id: "openai",
    labelKey: "provider.openai",
    hint: "mediasettingssection.ProviderHintOpenAIVision",
  },
  {
    id: "google",
    labelKey: "provider.google",
    hint: "mediasettingssection.ProviderHintGoogleVision",
  },
  {
    id: "anthropic",
    labelKey: "provider.anthropic",
    hint: "mediasettingssection.ProviderHintAnthropicVision",
  },
  {
    id: "xai",
    labelKey: "provider.xai",
    hint: "mediasettingssection.ProviderHintXAIVision",
  },
];

export const CATEGORY_LABELS: Record<MediaCategory, string> = {
  image: "mediasettingssection.ImageGeneration",
  video: "mediasettingssection.VideoGeneration",
  audio: "mediasettingssection.AudioMusic",
  vision: "mediasettingssection.VisionAnalysis",
  voice: "settings.sections.voice.label",
};

/** Short noun for "{category} API source" (not the longer tab titles). */
export const MEDIA_API_SOURCE_CATEGORY_KEYS = {
  image: "mediasettingssection.MediaApiSourceCategory.image",
  video: "mediasettingssection.MediaApiSourceCategory.video",
  audio: "mediasettingssection.MediaApiSourceCategory.audio",
  vision: "mediasettingssection.MediaApiSourceCategory.vision",
} as const;

// ── Utility functions ─────────────────────────────────────────────────

export function getProvidersForCategory(
  category: MediaCategory,
): ProviderOption[] {
  switch (category) {
    case "image":
      return IMAGE_PROVIDERS;
    case "video":
      return VIDEO_PROVIDERS;
    case "audio":
      return AUDIO_PROVIDERS;
    case "vision":
      return VISION_PROVIDERS;
    case "voice":
      return [];
  }
}

export function getApiKeyField(
  category: MediaCategory,
  provider: string,
): { path: string; labelKey: string } | null {
  if (provider === "cloud") return null;

  switch (category) {
    case "image":
    case "video":
      if (provider === "fal")
        return {
          path: `${category}.fal.apiKey`,
          labelKey: "mediasettingssection.FalApiKey",
        };
      if (provider === "openai")
        return {
          path: `${category}.openai.apiKey`,
          labelKey: "mediasettingssection.OpenAIApiKey",
        };
      if (provider === "google")
        return {
          path: `${category}.google.apiKey`,
          labelKey: "mediasettingssection.GoogleApiKey",
        };
      if (provider === "xai")
        return {
          path: `${category}.xai.apiKey`,
          labelKey: "mediasettingssection.XAIApiKey",
        };
      break;
    case "audio":
      if (provider === "suno")
        return {
          path: "audio.suno.apiKey",
          labelKey: "mediasettingssection.SunoApiKey",
        };
      if (provider === "elevenlabs")
        return {
          path: "audio.elevenlabs.apiKey",
          labelKey: "voiceconfigview.ElevenLabsAPIKey",
        };
      break;
    case "vision":
      if (provider === "openai")
        return {
          path: "vision.openai.apiKey",
          labelKey: "mediasettingssection.OpenAIApiKey",
        };
      if (provider === "google")
        return {
          path: "vision.google.apiKey",
          labelKey: "mediasettingssection.GoogleApiKey",
        };
      if (provider === "anthropic")
        return {
          path: "vision.anthropic.apiKey",
          labelKey: "mediasettingssection.AnthropicApiKey",
        };
      if (provider === "xai")
        return {
          path: "vision.xai.apiKey",
          labelKey: "mediasettingssection.XAIApiKey",
        };
      break;
  }
  return null;
}

export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split(".");
  const result = structuredClone(obj);
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}
