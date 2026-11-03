import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { OpenPosition } from "../src/book.ts";
import {
  companionResponse,
  expirePairTokenForTests,
  phoneMayCall,
  suggestionFromText,
} from "../src/companion.ts";
import { startDashboard } from "../src/dashboard.ts";
import { engineForTests } from "../src/engine.ts";
import { DEFAULT_SETTINGS } from "../src/user-settings.ts";

function position(): OpenPosition {
  return {
    id: "p1",
    mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    symbol: "T",
    lane: "main",
    status: "OPEN",
    costSol: 0.02,
    originalCostSol: 0.02,
    sizeSol: 0.02,
    entryPriceUsd: 1,
    markPriceUsd: 1,
    markAt: Date.now(),
    openedAt: Date.now(),
    tpNet10Taken: false,
    tpNet10Armed: false,
    peakPriceUsd: 1,
    trailArmed: false,
    transferTaxBps: 0,
    hold: false,
    riskTp1Taken: false,
    riskTp2Taken: false,
    rawAmount: "1",
    signature: null,
    paper: true,
  };
}

describe("phone companion", () => {
  it("restarts the loop only when no position is open", () => {
    const engine = engineForTests(path.join(tmpdir(), "valhalla-recover-closed"));
    try {
      engine.book.positions.push(position());
      engine.markStuckTickForTests(60_000);
      const blocked = engine.recoverFromPhone();
      expect(blocked.restarted).toBe(false);
      expect(blocked.message).toMatch(/not restarted/);
      engine.book.positions.length = 0;
      const recovered = engine.recoverFromPhone();
      expect(recovered.restarted).toBe(true);
      expect(recovered.message).toMatch(/No positions were open/);
      expect(engine.book.running).toBe(true);
    } finally {
      engine.stopLoop();
    }
  });

  it("reports a stalled heartbeat and leaves a healthy loop alone", () => {
    const stalled = engineForTests(path.join(tmpdir(), "valhalla-heart"));
    try {
      stalled.markStuckTickForTests(60_000);
      expect(stalled.heartbeat().stalled).toBe(true);
    } finally {
      stalled.stopLoop();
    }
    const healthy = engineForTests(path.join(tmpdir(), "valhalla-healthy"));
    try {
      healthy.startLoop();
      const result = healthy.recoverFromPhone();
      expect(result.restarted).toBe(false);
      expect(result.message).toMatch(/left as it is/);
    } finally {
      healthy.stopLoop();
    }
  });

  it("suggests a bounded preset and does not apply it before confirm", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-suggest-"));
    const engine = engineForTests(dir);
    await engine.load();
    const suggestion = suggestionFromText("please use a safer preset", engine.settings);
    expect(suggestion && "settings" in suggestion && suggestion.settings.preset).toBe("safe");
    expect(engine.settings.preset).toBe(DEFAULT_SETTINGS.preset);
    const loose = suggestionFromText("set the stop to zero", engine.settings);
    expect(loose).toBeNull();
    const saved = await engine.saveSettings({ stopLossPct: 0 }, true);
    expect(saved.ok).toBe(false);
    expect(engine.settings.stopLossPct).toBe(DEFAULT_SETTINGS.stopLossPct);
  });

  it("pairs, expires, and hides wallet secrets from the phone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-pair-"));
    const engine = engineForTests(dir);
    await engine.load();
    const pubkey = Keypair.generate().publicKey.toBase58();
    await engine.setWatch(pubkey);
    const desk = await startDashboard(engine, { port: 0, accessCode: "invite" });
    const base = `http://127.0.0.1:${desk.port}`;
    const denied = await fetch(`${base}/api/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "nope" }),
    });
    expect(denied.status).toBe(401);
    const paired = await fetch(`${base}/api/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "invite" }),
    });
    const issued = (await paired.json()) as { token: string };
    expect(paired.status).toBe(200);
    const beat = await fetch(`${base}/api/companion/heartbeat`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const body = (await beat.json()) as { state: Record<string, unknown> };
    const text = JSON.stringify(body);
    expect(text).not.toContain(pubkey);
    expect(text).not.toMatch(/backupOnce|ciphertext|secretKey|private key/i);
    expect(body.state.wallet).toBe(`…${pubkey.slice(-4)}`);
    expirePairTokenForTests(issued.token);
    const expired = await fetch(`${base}/api/companion/heartbeat`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const expiredBody = (await expired.json()) as { tokenExpired: boolean };
    expect(expired.status).toBe(401);
    expect(expiredBody.tokenExpired).toBe(true);
    const wallet = await fetch(`${base}/api/wallet/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({ password: "not-used" }),
    });
    expect(wallet.status).toBe(401);
    expect(phoneMayCall("/api/wallet/create")).toBe(false);
    expect(phoneMayCall("/api/companion/recover")).toBe(true);
    expect(phoneMayCall("/api/withdraw")).toBe(false);
    const chat = await fetch(`${base}/api/companion/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer missing",
      },
      body: JSON.stringify({ text: "withdraw the funds" }),
    });
    expect(chat.status).toBe(401);
    await desk.close();
    engine.stopLoop();
  });

  it("applies a chat suggestion only after the confirm flag", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-confirm-"));
    const engine = engineForTests(dir);
    await engine.load();
    const req = {
      method: "POST",
      headers: { authorization: "" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ text: "suggest a safer size" }));
      },
    };
    const issued = await companionResponse(
      engine,
      { ...req, headers: {}, url: "/api/companion/pair" } as never,
      "/api/companion/pair",
      ""
    );
    const token = (issued.body as { token: string }).token;
    const chat = await companionResponse(
      engine,
      {
        ...req,
        headers: { authorization: `Bearer ${token}` },
      } as never,
      "/api/companion/chat",
      ""
    );
    const chatBody = chat.body as { suggestion: { preset: string } | null };
    expect(chatBody.suggestion?.preset).toBe("safe");
    expect(engine.settings.preset).toBe("balanced");
    const early = await companionResponse(
      engine,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ confirm: false, settings: chatBody.suggestion }));
        },
      } as never,
      "/api/companion/settings",
      ""
    );
    expect(early.status).toBe(400);
    expect(engine.settings.preset).toBe("balanced");
    const confirmed = await companionResponse(
      engine,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ confirm: true, settings: chatBody.suggestion }));
        },
      } as never,
      "/api/companion/settings",
      ""
    );
    expect(confirmed.status).toBe(200);
    expect(engine.settings.preset).toBe("safe");
    expect(engine.settings.stopLossPct).toBeGreaterThanOrEqual(-0.25);
    expect(engine.settings.stopLossPct).toBeLessThanOrEqual(-0.05);
  });
});
