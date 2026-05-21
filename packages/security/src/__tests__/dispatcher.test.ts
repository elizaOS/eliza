import { describe, expect, it, vi } from "vitest";
import { AuditDispatcher } from "../audit/dispatcher.js";
import { InMemorySink, type AuditSink } from "../audit/sink.js";
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
    const ev = mem.snapshot()[0]!;
    expect(ev.metadata).toEqual({ ip: "1.2.3.4", email_hash: "abc" });
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
    expect(mem.snapshot()[0]!.metadata).toBeUndefined();
  });
});
