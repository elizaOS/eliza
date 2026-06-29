import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditDispatcher, AuditEvent, EmitInput } from "@elizaos/security";
import fc from "fast-check";
import {
  pruneOldSessions,
  redactTranscriptLine,
  SessionRecorder,
} from "./session-recorder.js";

describe("sub-agent session transcript redaction", () => {
  it("redacts common credential and PII shapes before transcript persistence", () => {
    const redacted = redactTranscriptLine(
      [
        "email=user@example.com",
        "openai=sk-abcdefghijklmnopqrstuvwxyz",
        "github=ghp_abcdefghijklmnopqrstuvwxyz",
        "slack=xoxb-1234567890-secret",
        "wallet=0x1234567890abcdef1234567890ABCDEF12345678",
        "card=4242424242424242",
      ].join(" "),
    );

    expect(redacted).toContain("email=<EMAIL>");
    expect(redacted).toContain("openai=<API_KEY>");
    expect(redacted).toContain("github=<GH_TOKEN>");
    expect(redacted).toContain("slack=<SLACK_TOKEN>");
    expect(redacted).toContain("wallet=<ETH_ADDR>");
    expect(redacted).toContain("card=<CARD>");
    expect(redacted).not.toContain("user@example.com");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("4242424242424242");
  });

  it("leaves ordinary sub-agent output intact", () => {
    expect(redactTranscriptLine("created src/App.tsx and ran bun test")).toBe(
      "created src/App.tsx and ran bun test",
    );
  });

  it("fuzzes embedded OpenAI-style keys so transcript output never preserves them", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ minLength: 20, maxLength: 80 }).filter((value) => {
          return /^[A-Za-z0-9_-]+$/.test(value);
        }),
        fc.string({ maxLength: 80 }),
        (prefix, tokenBody, suffix) => {
          const token = `sk-${tokenBody}`;
          const redacted = redactTranscriptLine(`${prefix}${token}${suffix}`);

          expect(redacted).not.toContain(token);
          expect(redacted).toContain("<API_KEY>");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("persists redacted transcript bytes and emits a single audit event on finalize", async () => {
    const sessionsRoot = mkTempRoot();
    const events: unknown[] = [];
    const auditDispatcher = {
      emit: async (event: EmitInput) => {
        events.push(event);
        return {
          event_id: "event-1",
          ts: "2026-01-01T00:00:00.000Z",
          ...event,
        } as AuditEvent;
      },
    } as unknown as AuditDispatcher;
    const recorder = new SessionRecorder({
      sessionId: "session-1",
      actorId: "user-1",
      sessionsRoot,
      auditDispatcher,
    });

    recorder.record("token sk-abcdefghijklmnopqrstuvwxyz");
    recorder.record("plain line\n");
    await recorder.finalize();
    recorder.record("ignored after finalize");
    await recorder.finalize();

    const persisted = readFileSync(
      join(sessionsRoot, "session-1", "transcript.log"),
      "utf8",
    );
    expect(persisted).toBe("token <API_KEY>\nplain line\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: "user", id: "user-1" },
      action: "agent.session_record",
      result: "success",
      resource: { type: "sub-agent.session", id: "session-1" },
      metadata: {
        session_id: "session-1",
        transcript_hash: createHash("sha256").update(persisted).digest("hex"),
        transcript_bytes: Buffer.byteLength(persisted),
      },
    });

    rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("prunes only old session directories", () => {
    const sessionsRoot = mkTempRoot();
    const now = Date.parse("2026-01-31T00:00:00.000Z");
    const oldDir = join(sessionsRoot, "old");
    const recentDir = join(sessionsRoot, "recent");
    mkdirSync(oldDir);
    mkdirSync(recentDir);
    writeFileSync(join(sessionsRoot, "not-a-session"), "keep");
    const oldTime = new Date(now - 31 * 24 * 60 * 60 * 1000);
    const recentTime = new Date(now - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldDir, oldTime, oldTime);
    utimesSync(recentDir, recentTime, recentTime);

    expect(pruneOldSessions(now, sessionsRoot)).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(recentDir)).toBe(true);
    expect(existsSync(join(sessionsRoot, "not-a-session"))).toBe(true);

    rmSync(sessionsRoot, { recursive: true, force: true });
  });
});

function mkTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "sub-agent-recorder-"));
}
