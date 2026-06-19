import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Trader example shell", () => {
  test("mounts the Vite app and renders the trading workflow panels", () => {
    expect(read("index.html")).toContain('<div id="root"></div>');

    const app = read("src/App.tsx");
    expect(app).toContain("<WalletSetup");
    expect(app).toContain("<TradingPanel");
    expect(app).toContain("<PositionList");
    expect(app).toContain("<TradeHistory");
  });

  test("defaults runtime initialization to paper trading", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('tradingMode: "paper"');
    expect(app).toContain("Only trade with");
    expect(app).toContain("funds you can afford to lose");
  });
});
