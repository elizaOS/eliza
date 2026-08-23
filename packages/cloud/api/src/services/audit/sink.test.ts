/**
 * Tests LoggerSink identity, optional-delivery flag, and structured-logger forwarding.
 *
 * Vitest cannot resolve the `@/lib/*` alias that `sink.ts` imports, so the mock
 * below is the logger collaborator surface. LoggerSink, AuditDispatcher, and
 * InMemorySink are the real modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/utils/logger";
import { AuditDispatcher } from "./dispatcher.js";
import { type AuditSink, LoggerSink } from "./sink.js";
import { InMemorySink } from "./testing.js";
import type { AuditEvent } from "./types.js";

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function sampleEvent(extra?: {
  ip?: string;
  user_agent?: string;
  request_id?: string;
  org_id?: string;
  metadata?: AuditEvent["metadata"];
  resource?: AuditEvent["resource"];
  result?: AuditEvent["result"];
}): AuditEvent {
  return {
    event_id: "01234567-89ab-7def-8123-456789abcdef",
    ts: "2026-08-23T12:00:00.000Z",
    actor: { type: "user", id: "u_123" },
    action: "auth.login",
    result: extra?.result ?? "success",
    resource: extra?.resource === undefined ? null : extra.resource,
    ...(extra?.ip !== undefined ? { ip: extra.ip } : {}),
    ...(extra?.user_agent !== undefined
      ? { user_agent: extra.user_agent }
      : {}),
    ...(extra?.request_id !== undefined
      ? { request_id: extra.request_id }
      : {}),
    ...(extra?.org_id !== undefined ? { org_id: extra.org_id } : {}),
    ...(extra?.metadata !== undefined ? { metadata: extra.metadata } : {}),
  };
}

describe("LoggerSink", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info")
      .mockReset()
      .mockImplementation(() => undefined);
    vi.spyOn(logger, "error")
      .mockReset()
      .mockImplementation(() => undefined);
    vi.spyOn(logger, "warn")
      .mockReset()
      .mockImplementation(() => undefined);
    vi.spyOn(logger, "debug")
      .mockReset()
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("satisfies AuditSink as the optional named logger implementation", () => {
    const sink: AuditSink = new LoggerSink();
    expect(sink.name).toBe("logger");
    expect(sink.required).toBe(false);
    expect(typeof sink.emit).toBe("function");
  });

  it("keeps name and required stable across independent instances", () => {
    const a = new LoggerSink();
    const b = new LoggerSink();
    expect(a).not.toBe(b);
    expect(a.name).toBe("logger");
    expect(b.name).toBe("logger");
    expect(a.required).toBe(false);
    expect(b.required).toBe(false);
  });

  it("forwards the event to logger.info without copying or mutating it", async () => {
    const sink = new LoggerSink();
    const event = sampleEvent({
      ip: "1.2.3.4",
      metadata: { method: "password" },
    });
    const before = structuredClone(event);

    const payloads: unknown[] = [];
    vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      payloads.push(args[1]);
    });

    const result = await sink.emit(event);

    expect(result).toBeUndefined();
    expect(event).toEqual(before);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("[AuditSink] event emitted", {
      audit: event,
    });
    expect((payloads[0] as { audit: AuditEvent }).audit).toBe(event);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("forwards every optional AuditEvent field the caller supplied", async () => {
    const sink = new LoggerSink();
    const event = sampleEvent({
      ip: "203.0.113.9",
      user_agent: "ua/1.0",
      request_id: "req_1",
      org_id: "org_1",
      resource: { type: "session", id: "sess_1" },
      result: "denied",
      metadata: { reason: "mfa" },
    });

    await sink.emit(event);

    expect(logger.info).toHaveBeenCalledWith("[AuditSink] event emitted", {
      audit: event,
    });
  });

  it("forwards a required-fields-only event with resource null", async () => {
    const sink = new LoggerSink();
    const event = sampleEvent();
    expect(event.resource).toBeNull();
    expect(event.ip).toBeUndefined();
    expect(event.metadata).toBeUndefined();

    await sink.emit(event);

    expect(logger.info).toHaveBeenCalledWith("[AuditSink] event emitted", {
      audit: event,
    });
  });

  it("emits sequential events in call order, one log line each", async () => {
    const sink = new LoggerSink();
    const first = sampleEvent({ request_id: "r1" });
    const second = sampleEvent({ request_id: "r2", result: "failure" });
    const payloads: unknown[] = [];
    vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      payloads.push(args[1]);
    });

    await sink.emit(first);
    await sink.emit(second);

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "[AuditSink] event emitted",
      { audit: first },
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      "[AuditSink] event emitted",
      { audit: second },
    );
    expect((payloads[0] as { audit: AuditEvent }).audit).toBe(first);
    expect((payloads[1] as { audit: AuditEvent }).audit).toBe(second);
  });

  it("rejects with the same error when logger.info throws", async () => {
    const boom = new Error("log boom");
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw boom;
    });
    const sink = new LoggerSink();

    await expect(sink.emit(sampleEvent())).rejects.toBe(boom);
  });

  it("does not fail AuditDispatcher fan-out when logger.info throws", async () => {
    const boom = new Error("log boom");
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw boom;
    });
    const mem = new InMemorySink();
    const onSinkError = vi.fn();
    const dispatcher = new AuditDispatcher({
      sinks: [new LoggerSink(), mem],
      onSinkError,
    });

    const emitted = await dispatcher.emit({
      actor: { type: "user", id: "u_123" },
      action: "auth.login",
      result: "success",
      metadata: { ip: "1.2.3.4", email_hash: "h", ua: "ua" },
    });

    expect(emitted.action).toBe("auth.login");
    expect(mem.snapshot()).toHaveLength(1);
    expect(mem.snapshot()[0]?.event_id).toBe(emitted.event_id);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toEqual({
      sink: "logger",
      error: boom,
    });
  });
});
