/**
 * Download action tests for structured query routing.
 *
 * They pin media-context validation and prevent the handler from extracting
 * download targets from free-form message text.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleDownloadMusic, validateDownloadMusic } from "./downloadMusic";

function message(text = ""): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn(() => undefined),
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("DOWNLOAD_MUSIC action", () => {
  it("does not validate English prose without a structured query or active context", async () => {
    await expect(
      validateDownloadMusic(
        runtime(),
        message("download Comfortably Numb by Pink Floyd"),
        undefined,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("validates structured query parameters independent of message language", async () => {
    await expect(
      validateDownloadMusic(runtime(), message("保存して"), undefined, {
        parameters: { query: "Comfortably Numb Pink Floyd" },
      }),
    ).resolves.toBe(true);
  });

  it("keeps selected media context eligible without extracting message text", async () => {
    const state = {
      values: { selectedContexts: ["media"] },
    } as unknown as State;

    await expect(
      validateDownloadMusic(
        runtime(),
        message("download Comfortably Numb by Pink Floyd"),
        state,
        undefined,
      ),
    ).resolves.toBe(true);
  });

  it("asks for a query instead of using message text when parameters are missing", async () => {
    const callback = vi.fn(async () => undefined);

    const result = await handleDownloadMusic(
      runtime(),
      message("download Comfortably Numb by Pink Floyd"),
      undefined,
      undefined,
      callback,
    );

    expect(result).toBeUndefined();
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("Please tell me what song"),
      source: "test",
    });
  });
});
