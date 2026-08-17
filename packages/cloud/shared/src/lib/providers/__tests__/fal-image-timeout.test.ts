/**
 * Proves Fal image provider fetch timeout (rank 8 clone of atlas/openai batches).
 * Both fetches now have AbortSignal.timeout(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS) matching download sibling.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const falPath = new URL("../image/fal-image-generation.ts", import.meta.url).pathname;
const atlasPath = new URL("../image/atlascloud-image-generation.ts", import.meta.url).pathname;
const sunoPath = new URL("../audio/suno-audio-generation.ts", import.meta.url).pathname;

describe("fal image fetch timeout — bounded provider", () => {
  test("generation fetch has AbortSignal.timeout", () => {
    const src = readFileSync(falPath, "utf8");
    expect(src).toContain('fetch(`${baseUrl}/${request.model}`');
    expect(src).toContain("signal: AbortSignal.timeout(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS),");
    const timeouts = (src.match(/AbortSignal\.timeout\(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS\)/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(2); // download + generate
  });

  test("download already bounded sibling proves intent", () => {
    const src = readFileSync(falPath, "utf8");
    expect(src).toContain("const response = await fetch(url, { signal: AbortSignal.timeout(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS) });");
  });

  test("no unbounded fetch remains in fal image provider", () => {
    const src = readFileSync(falPath, "utf8");
    const fetches = (src.match(/await fetch\(/g) || []).length;
    const timeouts = (src.match(/AbortSignal\.timeout/g) || []).length;
    expect(timeouts).toBe(fetches); // 2 == 2
  });

  test("sibling correct — atlas and suno already bounded", () => {
    const atlas = readFileSync(atlasPath, "utf8");
    expect(atlas).toContain("AbortSignal.timeout");
    const suno = readFileSync(sunoPath, "utf8");
    expect(suno).toContain("AbortSignal.timeout");
  });
});
