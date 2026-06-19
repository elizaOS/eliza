import { describe, expect, it, vi } from "vitest";
import { AuditDispatcher } from "../audit/dispatcher.js";
import { type AuditSink, HttpSink, InMemorySink } from "../audit/sink.js";
import type { AuditEvent } from "../audit/types.js";

class FailingSink implements AuditSink {
  readonly name = "failing";
  async emit(_event: AuditEvent): Promise<void> {
    throw new Error("boom");
  }
}

describe("AuditDispatcher", () => {
  it("fans out to every sink even if one fails", async () => {
    const memA = new InMemorySink();
    const memB = new InMemorySink();
    const failing = new FailingSink();
    const onSinkError = vi.fn();
    const d = new AuditDispatcher({
      sinks: [memA, failing, memB],
      onSinkError,
    });

    const event = await d.emit({
      actor: { type: "user", id: "u_123" },
      action: "auth.login",
      result: "success",
      metadata: { ip: "1.2.3.4", email_hash: "h", ua: "ua" },
    });

    expect(memA.snapshot()).toHaveLength(1);
    expect(memB.snapshot()).toHaveLength(1);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(event.action).toBe("auth.login");
    expect(event.event_id).toMatch(/^[0-9a-f]{8}-/);
  });

  it("rejects unknown action names", async () => {
    const d = new AuditDispatcher({ sinks: [new InMemorySink()] });
    await expect(
      d.emit({
        actor: { type: "user", id: "u" },
        action: "totally.made.up",
        result: "success",
      }),
    ).rejects.toThrow(/unknown audit action/);
  });

  it("redacts metadata keys not on the allowlist for the action prefix", async () => {
    const mem = new InMemorySink();
    const d = new AuditDispatcher({ sinks: [mem] });
    await d.emit({
      actor: { type: "user", id: "u" },
      action: "auth.login",
      result: "success",
      metadata: {
        ip: "1.2.3.4",
        email: "raw@example.com", // should be redacted
        email_hash: "abc",
        password: "nope", // should be redacted
      },
    });
    const ev = mem.snapshot()[0];
    expect(ev).toBeDefined();
    expect(ev?.metadata).toEqual({ ip: "1.2.3.4", email_hash: "abc" });
  });

  it("drops metadata entirely when no key matches the allowlist", async () => {
    const mem = new InMemorySink();
    const d = new AuditDispatcher({ sinks: [mem] });
    await d.emit({
      actor: { type: "api_key", id: "ak_1" },
      action: "api_key.use",
      result: "success",
      metadata: { totally_unrelated: "x" },
    });
    const ev = mem.snapshot()[0];
    expect(ev).toBeDefined();
    expect(ev?.metadata).toBeUndefined();
  });

  it("posts audit events through HttpSink", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const sink = new HttpSink({
      endpoint: "https://audit.example.test/events",
      fetch: fetchImpl,
      headers: { Authorization: "Bearer token" },
    });

    const event = await new AuditDispatcher({ sinks: [sink] }).emit({
      actor: { type: "system", id: "test" },
      action: "kms.key.access",
      result: "success",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://audit.example.test/events",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: JSON.stringify(event),
      }),
    );
  });

  it("surfaces HttpSink non-2xx responses as sink errors", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Nope" }),
    );
    const onSinkError = vi.fn();

    await new AuditDispatcher({
      sinks: [
        new HttpSink({
          endpoint: "https://audit.example.test/events",
          fetch: fetchImpl,
        }),
      ],
      onSinkError,
    }).emit({
      actor: { type: "system", id: "test" },
      action: "kms.key.access",
      result: "success",
    });

    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toMatchObject({ sink: "http" });
  });
});
