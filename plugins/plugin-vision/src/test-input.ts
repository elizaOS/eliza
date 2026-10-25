/**
 * Test-input shim for plugin-vision.
 *
 * Lets tests inject a fixture image into the vision analysis pipeline
 * without monkey-patching platform capture code.
 *
 * Selection: read `ELIZA_VISION_TEST_INPUT`:
 *   - "image"  → return the fixture bytes (resolved via
 *     `ELIZA_VISION_TEST_FIXTURE` env var, default the bundled
 *     test/fixtures/sample-scene.png path).
 *   - "camera" / "screen" / unset → return null, signaling that the caller
 *     should use the existing platform capture path.
 *
 * Single-purpose helper: anything that wants test-injected pixels reads
 * `getTestImage()`. When it returns a Buffer, use those bytes. When it
 * returns null, fall through to live capture.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "@elizaos/core";

export type TestInputMode = "image" | "camera" | "screen" | "unset";

export function getTestInputMode(): TestInputMode {
  const raw = (process.env.ELIZA_VISION_TEST_INPUT ?? "").trim().toLowerCase();
  if (raw === "image") return "image";
  if (raw === "camera") return "camera";
  if (raw === "screen") return "screen";
  return "unset";
}

const FIXTURE_DEFAULT_REL = "test/fixtures/sample-scene.png";

function resolveFixturePath(): string {
  const fromEnv = process.env.ELIZA_VISION_TEST_FIXTURE;
  if (fromEnv) return resolve(fromEnv);
  // Resolve relative to the package root (parent of `src` / `dist`).
  return resolve(process.cwd(), FIXTURE_DEFAULT_REL);
}

let cached: Buffer | null = null;
let cachedKey: string | null = null;

/**
 * If `ELIZA_VISION_TEST_INPUT=image`, return fixture bytes (PNG buffer);
 * otherwise return null. Result is cached per-fixture-path for the process.
 */
export function getTestImage(): Buffer | null {
  if (getTestInputMode() !== "image") return null;
  const path = resolveFixturePath();
  if (cachedKey === path && cached) return cached;
  if (!existsSync(path)) {
    logger.warn(
      `[plugin-vision] ELIZA_VISION_TEST_INPUT=image set but fixture not found at ${path}.`,
    );
    return null;
  }
  cached = readFileSync(path);
  cachedKey = path;
  return cached;
}
