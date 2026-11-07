/**
 * Large ASCII headings for dev startup banners.
 *
 * Why figlet: quick visual separation when four processes print similar tables
 * in sequence — humans/agents spot which child is speaking without reading prefixes.
 */

import { createRequire } from "node:module";
import {
  type DevSubsystemBannerKind,
  renderDevSubsystemFigletHeading as renderPlainHeading,
} from "../dev-tools.ts";

type FigletModule = {
  textSync: (
    text: string,
    options?: {
      font?: string;
      width?: number;
      whitespaceBreak?: boolean;
    },
  ) => string;
};

const require = createRequire(import.meta.url);

function loadFiglet(): FigletModule | null {
  try {
    return require("figlet") as FigletModule;
  } catch {
    // error-policy:J4 optional figlet module absent
    return null;
  }
}

/**
 * Renders a figlet block (Standard font, fits ~80 cols) for the given subsystem.
 * On failure (missing font), falls back to a short plain marker.
 */
export function renderDevSubsystemFigletHeading(
  kind: DevSubsystemBannerKind,
  options?: { maxWidth?: number; font?: string },
): string {
  const maxWidth = options?.maxWidth ?? 80;
  const font = options?.font ?? "Standard";
  const text = kind.toUpperCase();
  const figlet = loadFiglet();
  if (!figlet) {
    return renderPlainHeading(kind);
  }
  try {
    const block = figlet.textSync(text, {
      font,
      width: maxWidth,
      whitespaceBreak: true,
    });
    return block.replace(/\s+$/u, "");
  } catch {
    return renderPlainHeading(kind);
  }
}

/** Figlet block, blank line, then the settings table (and any trailing footer). */
export function prependDevSubsystemFigletHeading(
  kind: DevSubsystemBannerKind,
  tableAndFooter: string,
  options?: { maxWidth?: number; font?: string },
): string {
  const head = renderDevSubsystemFigletHeading(kind, options);
  return `${head}\n\n${tableAndFooter}`;
}
