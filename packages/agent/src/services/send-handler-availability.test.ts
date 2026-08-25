/**
 * Behavioral coverage for send-handler availability gating: Map registry
 * lookups, non-Map fail-closed, once-per-context:source logging, and the
 * test-only reset that clears the module-level seen set. Drives the real
 * module; logger.info is spied only to observe the once-log contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetMissingSendHandlerLogsForTests,
  hasRuntimeSendHandler,
  logMissingSendHandlerOnce,
} from "./send-handler-availability.ts";

function runtimeWith(sendHandlers: unknown): IAgentRuntime {
  return { sendHandlers } as unknown as IAgentRuntime;
}

function missingLog(context: string, source: string): string {
  return `[${context}] Send handler "${source}" is not registered yet; skipping delivery until runtime wiring completes`;
}

describe("hasRuntimeSendHandler", () => {
  it("returns false for an empty Map", () => {
    expect(hasRuntimeSendHandler(runtimeWith(new Map()), "telegram")).toBe(
      false,
    );
  });

  it("returns true for a single registered source", () => {
    const sendHandlers = new Map<string, unknown>([["telegram", {}]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      true,
    );
  });

  it("returns false for a registered map that does not contain the source", () => {
    const sendHandlers = new Map<string, unknown>([["telegram", {}]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "discord")).toBe(
      false,
    );
  });

  it("looks up by exact source string, not case-folded identity", () => {
    const sendHandlers = new Map<string, unknown>([["Telegram", {}]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "Telegram")).toBe(
      true,
    );
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      false,
    );
  });

  it("returns true when the source is present even if the stored handler is undefined", () => {
    const sendHandlers = new Map<string, unknown>([["telegram", undefined]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      true,
    );
  });

  it("returns true for an empty-string source that is actually registered", () => {
    const sendHandlers = new Map<string, unknown>([["", {}]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "")).toBe(true);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      false,
    );
  });

  it("returns false after the registered source is deleted", () => {
    const sendHandlers = new Map<string, unknown>([
      ["telegram", {}],
      ["discord", {}],
    ]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      true,
    );
    expect(sendHandlers.delete("missing")).toBe(false);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      true,
    );
    expect(sendHandlers.delete("telegram")).toBe(true);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      false,
    );
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "discord")).toBe(
      true,
    );
  });

  it("treats a Map subclass as a registry", () => {
    class HandlerMap extends Map<string, unknown> {}
    const sendHandlers = new HandlerMap([["telegram", {}]]);
    expect(hasRuntimeSendHandler(runtimeWith(sendHandlers), "telegram")).toBe(
      true,
    );
  });

  it("returns false when sendHandlers is absent", () => {
    expect(
      hasRuntimeSendHandler({} as unknown as IAgentRuntime, "telegram"),
    ).toBe(false);
  });

  it("returns false when sendHandlers is not a Map, even if it has a has() method", () => {
    expect(hasRuntimeSendHandler(runtimeWith(undefined), "telegram")).toBe(
      false,
    );
    expect(hasRuntimeSendHandler(runtimeWith(null), "telegram")).toBe(false);
    expect(hasRuntimeSendHandler(runtimeWith([]), "telegram")).toBe(false);
    expect(
      hasRuntimeSendHandler(runtimeWith({ telegram: {} }), "telegram"),
    ).toBe(false);
    expect(
      hasRuntimeSendHandler(
        runtimeWith({ has: (source: string) => source === "telegram" }),
        "telegram",
      ),
    ).toBe(false);
  });
});

describe("logMissingSendHandlerOnce", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetMissingSendHandlerLogsForTests();
    info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    info.mockRestore();
    _resetMissingSendHandlerLogsForTests();
  });

  it("logs the skip message on the first call for a context:source pair", () => {
    logMissingSendHandlerOnce("escalation", "telegram");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(missingLog("escalation", "telegram"));
  });

  it("does not log again for the same context:source pair", () => {
    logMissingSendHandlerOnce("escalation", "telegram");
    logMissingSendHandlerOnce("escalation", "telegram");
    logMissingSendHandlerOnce("escalation", "telegram");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("logs separately for different sources under the same context", () => {
    logMissingSendHandlerOnce("escalation", "telegram");
    logMissingSendHandlerOnce("escalation", "discord");
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      1,
      missingLog("escalation", "telegram"),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      missingLog("escalation", "discord"),
    );
  });

  it("logs separately for the same source under different contexts", () => {
    logMissingSendHandlerOnce("escalation", "telegram");
    logMissingSendHandlerOnce("client-chat", "telegram");
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      1,
      missingLog("escalation", "telegram"),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      missingLog("client-chat", "telegram"),
    );
  });

  it("treats context:source as a single concatenated key, so overlapping colons collide", () => {
    logMissingSendHandlerOnce("a", "b:c");
    logMissingSendHandlerOnce("a:b", "c");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(missingLog("a", "b:c"));
  });

  it("re-logs the same pair after the test-only reset clears the seen set", () => {
    logMissingSendHandlerOnce("escalation", "telegram");
    _resetMissingSendHandlerLogsForTests();
    logMissingSendHandlerOnce("escalation", "telegram");
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      2,
      missingLog("escalation", "telegram"),
    );
  });
});
