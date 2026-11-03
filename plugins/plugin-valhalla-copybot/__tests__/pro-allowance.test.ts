import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { liveTradeBlocked, proTradeView, recordLiveTrade, verifySigned } from "../src/pro-allowance.ts";

describe("Pro trade allowance", () => {
  it("counts one live trade id once and clamps a raised local file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-pro-"));
    const first = await recordLiveTrade(dir, "trade-1", 100, "");
    expect(first.remaining).toBe(99);
    const again = await recordLiveTrade(dir, "trade-1", 100, "");
    expect(again.remaining).toBe(99);
    const file = path.join(dir, "pro-trades.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as { remaining: number };
    raw.remaining = 500;
    await writeFile(file, JSON.stringify(raw));
    const view = await proTradeView(dir, 100);
    expect(view.remaining).toBe(100);
    expect(liveTradeBlocked({ ...view, remaining: 0 })).toBe(true);
    expect(verifySigned("proTradeAllowance=100\ntrialDays=15", "not-a-signature")).toBe(false);
  });
});
