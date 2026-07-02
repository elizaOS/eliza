import { describe, expect, it } from "vitest";
import { resolveInitialTaskPromptTimeoutMs } from "../services/acp-service.ts";

describe("background initial task prompt timeout", () => {
  it("detaches spawned initial tasks from the service/chat-turn timeout when no explicit timeout is set", () => {
    expect(resolveInitialTaskPromptTimeoutMs(undefined)).toBe(0);
  });

  it("preserves explicit caller timeouts", () => {
    expect(resolveInitialTaskPromptTimeoutMs(120_000)).toBe(120_000);
  });
});
