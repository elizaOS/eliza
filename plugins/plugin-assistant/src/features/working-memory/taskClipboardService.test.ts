/**
 * Unit tests for the uncapped task clipboard service factory.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createTaskClipboardService } from "./taskClipboardService.ts";

describe("taskClipboardService", () => {
  it("creates task clipboard service instance with runtime", () => {
    const runtime = {} as IAgentRuntime;
    const service = createTaskClipboardService(runtime, {
      basePath: "/tmp/test",
    });
    expect(service).toBeDefined();
    expect(typeof service.addItem).toBe("function");
    expect(typeof service.getItem).toBe("function");
    expect(typeof service.removeItem).toBe("function");
  });
});
