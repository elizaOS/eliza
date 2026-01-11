/**
 * Manifest loading and management
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExamplesManifest } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedManifest: ExamplesManifest | null = null;

/**
 * Load the examples manifest
 */
export function loadManifest(): ExamplesManifest {
  if (cachedManifest) {
    return cachedManifest;
  }

  // Try to load from dist directory (when installed as package)
  const distManifestPath = path.join(__dirname, "examples-manifest.json");
  if (fs.existsSync(distManifestPath)) {
    const content = fs.readFileSync(distManifestPath, "utf-8");
    cachedManifest = JSON.parse(content) as ExamplesManifest;
    return cachedManifest;
  }

  // Try to load from package root (during development)
  const rootManifestPath = path.join(__dirname, "..", "examples-manifest.json");
  if (fs.existsSync(rootManifestPath)) {
    const content = fs.readFileSync(rootManifestPath, "utf-8");
    cachedManifest = JSON.parse(content) as ExamplesManifest;
    return cachedManifest;
  }

  throw new Error(
    "Could not find examples-manifest.json. Please run 'bun run build' first.",
  );
}

/**
 * Get examples filtered by language
 */
export function getExamplesByLanguage(
  language: string,
): ExamplesManifest["examples"] {
  const manifest = loadManifest();
  return manifest.examples.filter((example) =>
    example.languages.some((lang) => lang.language === language),
  );
}

/**
 * Get all available languages
 */
export function getAvailableLanguages(): string[] {
  const manifest = loadManifest();
  return manifest.languages;
}

/**
 * Get example by name
 */
export function getExampleByName(
  name: string,
): ExamplesManifest["examples"][0] | undefined {
  const manifest = loadManifest();
  return manifest.examples.find((e) => e.name === name);
}
