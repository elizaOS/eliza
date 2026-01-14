import crypto from "node:crypto";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertValidChatBody,
  createRobloxBridgeApp,
  verifySharedSecret,
  type HeaderReader,
  type RuntimeLike,
} from "./app";
import { elizaClassicXmlPlugin } from "./elizaClassicXmlPlugin";

function makeReq(headers: Record<string, string>, rawBody: string): HeaderReader {
  return {
    rawBody,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

describe("roblox bridge helpers", () => {
  it("accepts when no shared secret configured", () => {
    const req = makeReq({}, "{}");
    expect(verifySharedSecret(req, "")).toBe(true);
  });

  it("accepts when x-eliza-secret matches", () => {
    const req = makeReq({ "x-eliza-secret": "s3cr3t" }, "{}");
    expect(verifySharedSecret(req, "s3cr3t")).toBe(true);
  });

  it("rejects when x-eliza-secret mismatches", () => {
    const req = makeReq({ "x-eliza-secret": "wrong" }, "{}");
    expect(verifySharedSecret(req, "right")).toBe(false);
  });

  it("accepts when HMAC signature matches raw body", () => {
    const secret = "s3cr3t";
    const rawBody = JSON.stringify({ hello: "world" });
    const sig =
      "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const req = makeReq({ "x-eliza-signature": sig }, rawBody);
    expect(verifySharedSecret(req, secret)).toBe(true);
  });

  it("rejects when HMAC signature mismatches", () => {
    const secret = "s3cr3t";
    const rawBody = JSON.stringify({ hello: "world" });
    const req = makeReq({ "x-eliza-signature": "sha256=deadbeef" }, rawBody);
    expect(verifySharedSecret(req, secret)).toBe(false);
  });

  it("validates required chat fields", () => {
    expect(() =>
      assertValidChatBody({ playerId: 1, playerName: "A", text: "hi" })
    ).not.toThrow();
    expect(() =>
      assertValidChatBody({ playerId: Number.NaN, playerName: "A", text: "hi" })
    ).toThrow();
    expect(() =>
      assertValidChatBody({ playerId: 1, playerName: "", text: "hi" })
    ).toThrow();
    expect(() =>
      assertValidChatBody({ playerId: 1, playerName: "A", text: "" })
    ).toThrow();
  });

  it("echo-to-game is best-effort and does not crash when service missing", async () => {
    const old = process.env.ROBLOX_ECHO_TO_GAME;
    process.env.ROBLOX_ECHO_TO_GAME = "true";
    try {
      const runtime: RuntimeLike = {
        agentId: "00000000-0000-0000-0000-000000000000",
        character: { name: "Eliza" },
        ensureConnection: async () => {},
        messageService: {
          handleMessage: async (_runtime, _message, callback) => {
            if (callback) await callback({ text: "hello" });
            return {
              didRespond: true,
              responseContent: { text: "hello", actions: ["REPLY"] },
              responseMessages: [],
              state: { values: {}, data: {}, text: "" },
              mode: "simple",
            };
          },
        },
        getService: () => null,
      };

      const app = createRobloxBridgeApp(runtime, "");
      const server = app.listen(0);
      await once(server, "listening");
      const port = (server.address() as AddressInfo).port;

      const resp = await fetch(`http://127.0.0.1:${port}/roblox/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: 1, playerName: "A", text: "hi", jobId: "j" }),
      });
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as { reply: string };
      expect(json.reply).toContain("hello");
      server.close();
    } finally {
      process.env.ROBLOX_ECHO_TO_GAME = old;
    }
  });

  it("elizaClassicXmlPlugin returns <response> XML", async () => {
    const out = await elizaClassicXmlPlugin.models?.TEXT_LARGE?.(
      {} as import("@elizaos/core").IAgentRuntime,
      { prompt: "You: hello" }
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("<response>");
    expect(out).toContain("<text>");
    expect(out).toContain("</response>");
  });
});

