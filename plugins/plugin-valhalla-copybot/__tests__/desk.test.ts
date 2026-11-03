import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refusesUnsafe } from "../src/chat.ts";
import { startDashboard } from "../src/dashboard.ts";
import { engineForTests } from "../src/engine.ts";
import { createTradingKeystore, decryptSecret, readKeystore } from "../src/keystore.ts";
import { withTimeout } from "../src/net.ts";
import { parseSettings } from "../src/user-settings.ts";

describe("safety controls", () => {
  it("rejects a disabled stop and keeps rug checks out of the settings", () => {
    const loose = parseSettings({ stopLossPct: 0, preset: "off" });
    expect("ok" in loose).toBe(true);
    if ("ok" in loose) expect(loose.errors.join(" ")).toMatch(/stop-loss|preset/);
  });

  it("refuses send and withdraw chat", () => {
    expect(refusesUnsafe("please withdraw my SOL to another wallet")).toBe(true);
    expect(refusesUnsafe("disable the rug check")).toBe(true);
    expect(refusesUnsafe("what is my P&L")).toBe(false);
  });

  it("encrypts a wallet and does not store the raw secret", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-"));
    const created = await createTradingKeystore(dir, "correct horse battery");
    expect(created.backupOnce).toBeTruthy();
    const file = await readKeystore(dir);
    expect(file).toBeTruthy();
    const raw = await readFile(path.join(dir, "keystore.json"), "utf8");
    expect(raw).not.toContain(created.backupOnce);
    const secret = await decryptSecret(file!, "correct horse battery");
    expect(secret).toBe(created.backupOnce);
  });

  it("times out a stalled network call", async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, "rpc")).rejects.toThrow(/timed out/);
  });

  it("has no withdraw route and pauses after three losses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-desk-"));
    const engine = engineForTests(dir);
    await engine.load();
    const desk = await startDashboard(engine, { port: 0 });
    const base = `http://127.0.0.1:${desk.port}`;
    const missing = await fetch(`${base}/api/withdraw`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(404);
    const page = await fetch(base);
    const html = await page.text();
    expect(html).toContain("ACCELERATION");
    expect(html).not.toMatch(/<button[^>]*>WITHDRAW/);
    for (let i = 0; i < 3; i += 1) {
      engine.book.positions.push({
        id: `p${i}`,
        mint: `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        symbol: "T",
        lane: "main",
        status: "OPEN",
        costSol: 0.02,
        originalCostSol: 0.02,
        sizeSol: 0.02,
        entryPriceUsd: 1,
        markPriceUsd: 0.5,
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
      });
      await engine.sellOne(`p${i}`);
    }
    expect(engine.buysPaused).toBe(true);
    await desk.close();
  });
});
