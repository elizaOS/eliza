/**
 * Proves Atlas Cloud provider fetch timeout (rank 8 clone of openai/er c8004/meteora batches).
 * All 5 external fetches now have AbortSignal.timeout (image submit/poll + video submit/poll/status).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const imagePath = new URL("../image/atlascloud-image-generation.ts", import.meta.url).pathname;
const videoPath = new URL("../video/atlascloud-video-generation.ts", import.meta.url).pathname;
const sunoPath = new URL("../audio/suno-audio-generation.ts", import.meta.url).pathname;

describe("atlas fetch timeout — bounded provider", () => {
  test("image submit and poll have AbortSignal.timeout", () => {
    const src = readFileSync(imagePath, "utf8");
    expect(src).toContain('fetch(`${baseUrl}/api/v1/model/generateImage`');
    expect(src).toContain("signal: AbortSignal.timeout(ATLAS_IMAGE_DOWNLOAD_TIMEOUT_MS),");
    const timeouts = (src.match(/AbortSignal\.timeout\(ATLAS_IMAGE_DOWNLOAD_TIMEOUT_MS\)/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(3);
    expect(src).toContain("const pollResponse = await fetch(pollUrl, {");
  });

  test("video submit, poll and status have timeout", () => {
    const src = readFileSync(videoPath, "utf8");
    expect(src).toContain('fetch(`${baseUrl}/api/v1/model/generateVideo`');
    expect(src).toContain('fetch(`${baseUrl}/api/v1/model/prediction/${req.requestId}`');
    expect(src).toContain("signal: AbortSignal.timeout(ATLAS_FETCH_TIMEOUT_MS),");
    const timeouts = (src.match(/AbortSignal\.timeout\(ATLAS_FETCH_TIMEOUT_MS\)/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(3);
    expect(src).toContain("const ATLAS_FETCH_TIMEOUT_MS = 30_000;");
  });

  test("no unbounded fetch remains without signal in atlas providers", () => {
    const image = readFileSync(imagePath, "utf8");
    const video = readFileSync(videoPath, "utf8");
    const imageFetches = (image.match(/await fetch\(/g) || []).length;
    const imageTimeouts = (image.match(/AbortSignal\.timeout/g) || []).length;
    expect(imageTimeouts).toBe(imageFetches);
    const videoFetches = (video.match(/await fetch\(/g) || []).length;
    const videoTimeouts = (video.match(/AbortSignal\.timeout/g) || []).length;
    expect(videoTimeouts).toBe(videoFetches);
  });

  test("sibling correct — image download and suno already bounded", () => {
    const image = readFileSync(imagePath, "utf8");
    expect(image).toContain("signal: AbortSignal.timeout(ATLAS_IMAGE_DOWNLOAD_TIMEOUT_MS),");
    const suno = readFileSync(sunoPath, "utf8");
    expect(suno).toContain("AbortSignal.timeout");
  });
});
