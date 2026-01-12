/**
 * Integration tests for the Bluesky agent
 *
 * These tests require real credentials and can be run with:
 *   LIVE_TEST=true bun test
 *
 * Without LIVE_TEST=true, these tests are skipped.
 */

import { config } from "dotenv";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Load environment
config({ path: "../../.env" });
config();

const isLiveTest = process.env.LIVE_TEST === "true";

/**
 * Live integration tests - require credentials and built plugins
 * Run with: LIVE_TEST=true bun test
 */
describe.skipIf(!isLiveTest)("Bluesky Agent Live Integration", () => {
  beforeAll(() => {
    if (!process.env.BLUESKY_HANDLE || !process.env.BLUESKY_PASSWORD) {
      throw new Error(
        "BLUESKY_HANDLE and BLUESKY_PASSWORD required for live tests",
      );
    }
  });

  it("should authenticate with Bluesky", async () => {
    // Dynamic import to handle workspace build order
    // @ts-expect-error - Workspace plugin resolved at runtime after build
    const { BlueSkyClient } = await import("@elizaos/plugin-bluesky");

    const client = new BlueSkyClient({
      service: process.env.BLUESKY_SERVICE || "https://bsky.social",
      handle: process.env.BLUESKY_HANDLE as string,
      password: process.env.BLUESKY_PASSWORD as string,
      dryRun: true,
    });

    const session = await client.authenticate();

    expect(session.did).toBeDefined();
    expect(session.handle).toBe(process.env.BLUESKY_HANDLE);
  });

  it("should fetch timeline", async () => {
    // @ts-expect-error - Workspace plugin resolved at runtime after build
    const { BlueSkyClient } = await import("@elizaos/plugin-bluesky");

    const client = new BlueSkyClient({
      service: process.env.BLUESKY_SERVICE || "https://bsky.social",
      handle: process.env.BLUESKY_HANDLE as string,
      password: process.env.BLUESKY_PASSWORD as string,
      dryRun: true,
    });

    await client.authenticate();
    const timeline = await client.getTimeline({ limit: 5 });

    expect(timeline.feed).toBeDefined();
    expect(Array.isArray(timeline.feed)).toBe(true);
  });

  it("should fetch notifications", async () => {
    // @ts-expect-error - Workspace plugin resolved at runtime after build
    const { BlueSkyClient } = await import("@elizaos/plugin-bluesky");

    const client = new BlueSkyClient({
      service: process.env.BLUESKY_SERVICE || "https://bsky.social",
      handle: process.env.BLUESKY_HANDLE as string,
      password: process.env.BLUESKY_PASSWORD as string,
      dryRun: true,
    });

    await client.authenticate();
    const { notifications } = await client.getNotifications(10);

    expect(notifications).toBeDefined();
    expect(Array.isArray(notifications)).toBe(true);
  });

  it("should simulate post creation in dry run mode", async () => {
    // @ts-expect-error - Workspace plugin resolved at runtime after build
    const { BlueSkyClient } = await import("@elizaos/plugin-bluesky");

    const client = new BlueSkyClient({
      service: process.env.BLUESKY_SERVICE || "https://bsky.social",
      handle: process.env.BLUESKY_HANDLE as string,
      password: process.env.BLUESKY_PASSWORD as string,
      dryRun: true,
    });

    await client.authenticate();

    const post = await client.sendPost({
      content: { text: "Test post from integration test" },
    });

    expect(post.uri).toContain("mock://");
    expect(post.cid).toContain("mock-cid");
  });

  it("should fetch own profile", async () => {
    // @ts-expect-error - Workspace plugin resolved at runtime after build
    const { BlueSkyClient } = await import("@elizaos/plugin-bluesky");

    const client = new BlueSkyClient({
      service: process.env.BLUESKY_SERVICE || "https://bsky.social",
      handle: process.env.BLUESKY_HANDLE as string,
      password: process.env.BLUESKY_PASSWORD as string,
      dryRun: true,
    });

    await client.authenticate();
    const profile = await client.getProfile(
      process.env.BLUESKY_HANDLE as string,
    );

    expect(profile.handle).toBe(process.env.BLUESKY_HANDLE);
    expect(profile.did).toBeDefined();
  });
});

/**
 * Unit tests that don't require external dependencies
 */
describe("Bluesky Agent Unit Tests", () => {
  it("should have valid character configuration", async () => {
    const { character } = await import("../character");

    expect(character.name).toBe("BlueSkyBot");
    expect(character.bio).toBeDefined();
    expect(character.system).toBeDefined();
  });

  it("should have message examples in character", async () => {
    const { character } = await import("../character");

    expect(character.messageExamples).toBeDefined();
    expect(character.messageExamples?.length).toBeGreaterThan(0);
  });

  it("should have post examples in character", async () => {
    const { character } = await import("../character");

    expect(character.postExamples).toBeDefined();
    expect(character.postExamples?.length).toBeGreaterThan(0);
  });

  it("should export handler functions", async () => {
    const {
      handleMentionReceived,
      handleCreatePost,
      handleShouldRespond,
      registerBlueskyHandlers,
    } = await import("../handlers");

    expect(typeof handleMentionReceived).toBe("function");
    expect(typeof handleCreatePost).toBe("function");
    expect(typeof handleShouldRespond).toBe("function");
    expect(typeof registerBlueskyHandlers).toBe("function");
  });

  it("should create runtime with character", async () => {
    const { AgentRuntime } = await import("@elizaos/core");
    const { character } = await import("../character");

    const runtime = new AgentRuntime({ character });

    expect(runtime.character.name).toBe(character.name);
    expect(runtime.agentId).toBeDefined();
  });

  it("should register event handlers", async () => {
    const { AgentRuntime } = await import("@elizaos/core");
    const { character } = await import("../character");
    const { registerBlueskyHandlers } = await import("../handlers");

    const runtime = new AgentRuntime({ character });
    const registerSpy = vi.spyOn(runtime, "registerEvent");

    registerBlueskyHandlers(runtime);

    expect(registerSpy).toHaveBeenCalledTimes(3);
    expect(registerSpy).toHaveBeenCalledWith(
      "bluesky.mention_received",
      expect.any(Function),
    );
    expect(registerSpy).toHaveBeenCalledWith(
      "bluesky.should_respond",
      expect.any(Function),
    );
    expect(registerSpy).toHaveBeenCalledWith(
      "bluesky.create_post",
      expect.any(Function),
    );
  });
});
