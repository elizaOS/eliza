/**
 * Resolves and renders the strongest available plugin visual, from connector
 * brand icons through provider logos to deterministic monogram tiles.
 */
import { useState } from "react";
import type { PluginInfo } from "../../api";
import { getProviderLogo } from "../../providers";
import { getBrandIcon } from "../conversations/brand-icons";
import { Card } from "../ui/card";
import {
  iconImageSource,
  pluginMonogram,
  pluginTileGradient,
  resolveIcon,
} from "./plugin-list-utils";

function isDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  return (
    root.classList.contains("dark") ||
    root.getAttribute("data-theme") === "dark"
  );
}

/** Provider IDs that ship a brand PNG in the provider-logo registry. */
const PROVIDER_LOGO_IDS = new Set([
  "openai",
  "anthropic",
  "groq",
  "google",
  "gemini",
  "ollama",
  "xai",
  "grok",
  "openrouter",
  "elizacloud",
  "deepseek",
  "mistral",
  "together",
  "together-ai",
  "zai",
]);

/**
 * Resolve the strongest available visual for a plugin and render it as a square
 * tile. Resolution order: brand SVG logo (connectors) → AI-provider brand PNG →
 * explicit plugin image → registry Lucide glyph → deterministic monogram tile
 * (initials over a name-hashed orange-family gradient).
 */
export function PluginVisual({
  plugin,
  size = "md",
}: {
  plugin: PluginInfo;
  size?: "md" | "lg";
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const dimension = size === "lg" ? "h-14 w-14" : "h-11 w-11";
  const glyph = size === "lg" ? "h-7 w-7" : "h-6 w-6";
  const monogramText = size === "lg" ? "text-lg" : "text-base";

  const BrandIcon = getBrandIcon(plugin.id);
  if (BrandIcon) {
    return (
      <Card
        variant="connectorAvatar"
        tone="text"
        className={`flex ${dimension} shrink-0 items-center justify-center`}
      >
        <BrandIcon className={glyph} />
      </Card>
    );
  }

  if (!imgFailed && PROVIDER_LOGO_IDS.has(plugin.id)) {
    const logo = getProviderLogo(plugin.id, isDarkTheme());
    return (
      <Card
        variant="connectorAvatar"
        padding="compact"
        className={`flex ${dimension} shrink-0 items-center justify-center`}
      >
        <img
          src={logo}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setImgFailed(true)}
        />
      </Card>
    );
  }

  const icon = resolveIcon(plugin);
  if (!imgFailed && typeof icon === "string") {
    const imageSrc = iconImageSource(icon);
    if (imageSrc) {
      return (
        <Card
          variant="connectorAvatar"
          padding="compact"
          className={`flex ${dimension} shrink-0 items-center justify-center`}
        >
          <img
            src={imageSrc}
            alt=""
            className="h-full w-full object-contain"
            onError={() => setImgFailed(true)}
          />
        </Card>
      );
    }
  }

  if (icon && typeof icon !== "string") {
    const Glyph = icon;
    return (
      <Card
        variant="connectorAvatar"
        className={`flex ${dimension} shrink-0 items-center justify-center`}
      >
        <Glyph className={glyph} />
      </Card>
    );
  }

  // Generative monogram tile — deterministic gradient + initials.
  return (
    <Card
      variant="connectorAvatar"
      className={`flex ${dimension} shrink-0 select-none items-center justify-center font-bold tracking-tight ${monogramText}`}
      visualStyle={{
        background: pluginTileGradient(plugin),
      }}
      wallpaperText
      aria-hidden="true"
    >
      {pluginMonogram(plugin)}
    </Card>
  );
}
