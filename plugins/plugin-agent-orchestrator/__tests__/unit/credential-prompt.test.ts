/**
 * Verifies emitCredentialPrompt (#8907).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  emitCredentialPrompt,
  emitCredentialResolved,
} from "../../src/api/credential-prompt.js";

function makeRuntime(opts: { withSend?: boolean; appUrl?: string } = {}) {
  const send = vi.fn(async () => undefined);
  const runtime = {
    agentId: "agent-1",
    getSetting: (k: string) =>
      k === "ELIZA_APP_URL" ? opts.appUrl : undefined,
    ...(opts.withSend === false ? {} : { sendMessageToTarget: send }),
  };
  return { runtime, send };
}

const ROOM = "11111111-1111-1111-1111-111111111111";

describe("emitCredentialPrompt (#8907)", () => {
  it("posts a prompt to the origin room with key names + dashboard link", async () => {
    const { runtime, send } = makeRuntime({ appUrl: "https://app.test/" });
    const ok = await emitCredentialPrompt({
      runtime: runtime as never,
      metadata: { roomId: ROOM, source: "telegram" },
      credentialKeys: ["STRIPE_KEY", "OPENAI_API_KEY"],
      label: "fix-billing",
    });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [target, content] = send.mock.calls[0];
    expect(target).toEqual({ source: "telegram", roomId: ROOM });
    expect(content.text).toContain("STRIPE_KEY");
    expect(content.text).toContain("OPENAI_API_KEY");
    expect(content.text).toContain("fix-billing");
    expect(content.text).toContain(
      "https://app.test/settings?section=credentials",
    );
  });

  it("posts only the announcement (no reply-with-secret instruction) when no app URL is configured", async () => {
    const { runtime, send } = makeRuntime();
    const ok = await emitCredentialPrompt({
      runtime: runtime as never,
      metadata: { roomId: ROOM, source: "telegram" },
      credentialKeys: ["KEY"],
    });
    expect(ok).toBe(true);
    const [, content] = send.mock.calls[0];
    expect(content.text).toContain("KEY");
    // Secrets never transit chat text: the dead "Reply here" fallback that
    // instructed pasting a secret nothing captures is gone.
    expect(content.text).not.toContain("Reply here");
  });

  it("is a no-op when the session has no origin room", async () => {
    const { runtime, send } = makeRuntime({ appUrl: "https://app.test" });
    const ok = await emitCredentialPrompt({
      runtime: runtime as never,
      metadata: { source: "telegram" },
      credentialKeys: ["KEY"],
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("is a no-op when the runtime cannot send to a target", async () => {
    const { runtime } = makeRuntime({ withSend: false });
    const ok = await emitCredentialPrompt({
      runtime: runtime as never,
      metadata: { roomId: ROOM, source: "telegram" },
      credentialKeys: ["KEY"],
    });
    expect(ok).toBe(false);
  });

  it("never throws when the send fails (best-effort side-effect)", async () => {
    const send = vi.fn(async () => {
      throw new Error("connector down");
    });
    const runtime = {
      agentId: "agent-1",
      getSetting: () => undefined,
      sendMessageToTarget: send,
    };
    const ok = await emitCredentialPrompt({
      runtime: runtime as never,
      metadata: { roomId: ROOM, source: "telegram" },
      credentialKeys: ["KEY"],
    });
    expect(ok).toBe(false);
  });
});

describe("emitCredentialResolved (#8907)", () => {
  it("posts a resolution follow-up naming the key", async () => {
    const { runtime, send } = makeRuntime();
    const ok = await emitCredentialResolved({
      runtime: runtime as never,
      metadata: { roomId: ROOM, source: "discord" },
      key: "STRIPE_KEY",
      label: "fix-billing",
    });
    expect(ok).toBe(true);
    const [target, content] = send.mock.calls[0];
    expect(target).toEqual({ source: "discord", roomId: ROOM });
    expect(content.text).toContain("STRIPE_KEY");
    expect(content.text).toContain("received");
    expect(content.text).toContain("fix-billing");
  });
});
