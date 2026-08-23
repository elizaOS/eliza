import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn() },
}));

import { logger } from "@elizaos/core";
import {
  _resetMissingSendHandlerLogsForTests,
  hasRuntimeSendHandler,
  logMissingSendHandlerOnce,
} from "../send-handler-availability.ts";

beforeEach(() => {
  _resetMissingSendHandlerLogsForTests();
  vi.clearAllMocks();
});
afterEach(() => _resetMissingSendHandlerLogsForTests());

describe("hasRuntimeSendHandler", () => {
  it("checks the sendHandlers map", () => {
    const runtime = { sendHandlers: new Map([["telegram", {}]]) } as never;
    expect(hasRuntimeSendHandler(runtime, "telegram")).toBe(true);
    expect(hasRuntimeSendHandler(runtime, "discord")).toBe(false);
  });

  it("returns false when sendHandlers is absent or not a Map", () => {
    expect(hasRuntimeSendHandler({} as never, "telegram")).toBe(false);
    expect(
      hasRuntimeSendHandler({ sendHandlers: [] } as never, "telegram"),
    ).toBe(false);
  });
});

describe("logMissingSendHandlerOnce", () => {
  it("logs once per context:source pair", () => {
    logMissingSendHandlerOnce("ctx", "src");
    logMissingSendHandlerOnce("ctx", "src");
    logMissingSendHandlerOnce("ctx", "src");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("logs separately for different sources", () => {
    logMissingSendHandlerOnce("ctx", "a");
    logMissingSendHandlerOnce("ctx", "b");
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("re-logs after reset", () => {
    logMissingSendHandlerOnce("ctx", "a");
    _resetMissingSendHandlerLogsForTests();
    logMissingSendHandlerOnce("ctx", "a");
    expect(logger.info).toHaveBeenCalledTimes(2);
  });
});
