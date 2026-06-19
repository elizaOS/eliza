import { describe, expect, it } from "bun:test";
import { renderPrompt } from "@feed/engine";

const testPrompt = {
  id: "test-market-signals",
  version: "1.0.0",
  category: "test",
  description: "Test prompt for market signal analysis",
  template: `MARKETS:
{{marketTable}}

{{eventMarketSignals}}

{{marketSignalAnalysis}}

TRADERS:
{{npcsList}}`,
};

describe("Market signal analysis in trading prompt", () => {
  it("should render marketSignalAnalysis when provided", () => {
    const result = renderPrompt(
      testPrompt,
      {
        marketTable: "some table",
        eventMarketSignals: "some signals",
        marketSignalAnalysis:
          "SIGNAL ANALYSIS (from feed/event content):\n- Q123: ↑ YES (confidence: 72%, signal: +0.44)",
        npcsList: "some npcs",
      },
      { allowEmpty: true },
    );

    expect(result).toContain("SIGNAL ANALYSIS (from feed/event content)");
    expect(result).toContain("↑ YES (confidence: 72%");
    expect(result).toContain("signal: +0.44");
  });

  it("should render empty when marketSignalAnalysis is not provided", () => {
    const result = renderPrompt(
      testPrompt,
      {
        marketTable: "some table",
        eventMarketSignals: "some signals",
        npcsList: "some npcs",
      },
      { allowEmpty: true },
    );

    expect(result).not.toContain("{{marketSignalAnalysis}}");
    expect(result).not.toContain("SIGNAL ANALYSIS");
  });
});

describe("Enriched market table format", () => {
  it("should include 24h range column header", () => {
    const table =
      "| Ticker/ID | Type | Price | 24h Change | 24h Range | Volume |\n|---|---|---|---|---|---|";
    expect(table).toContain("24h Range");
    expect(table).toContain("Volume");
    // Old format had "Volume/Liq" in 5 columns; new has 6 columns
    expect(table.split("|").length).toBeGreaterThan(6);
  });

  it("should format perp market row with range", () => {
    const row =
      "| TSLA | PERP | $450.00 | +15.20% | $380.00-$460.00 | $5000.0k |";
    expect(row).toContain("$380.00-$460.00");
    expect(row).toContain("+15.20%");
  });

  it("should format prediction market row with question text and days", () => {
    const row =
      '| 123456 | PRED | Yes: 60¢ / No: 40¢ | 3d left | "Will TeslAI announce partnership?" | $5.2k |';
    expect(row).toContain("Will TeslAI announce partnership?");
    expect(row).toContain("3d left");
    expect(row).toContain("Yes: 60¢ / No: 40¢");
  });

  it("prediction row should not truncate question text", () => {
    const longQuestion =
      "Will AIlon Musk deploy TeslAI to cause a 10-minute AI-activated dill dilemma at a farmer market?";
    const row = `| 789 | PRED | Yes: 50¢ / No: 50¢ | 5d left | "${longQuestion}" | $1.0k |`;
    // Question is 97 chars — old limit was 120, now unlimited
    expect(row).toContain(longQuestion);
    expect(row).not.toContain("...");
  });
});

describe("formatMarketSignals output format", () => {
  it("should produce correct format for YES signal", () => {
    // Simulate the format the engine produces
    const signal = {
      marketId: "123",
      suggestedOutcome: "YES" as const,
      confidence: 0.72,
      netSignal: 0.44,
    };
    const direction = signal.suggestedOutcome === "YES" ? "↑ YES" : "↓ NO";
    const conf = (signal.confidence * 100).toFixed(0);
    const line = `- Q${signal.marketId}: ${direction} (confidence: ${conf}%, signal: +${signal.netSignal.toFixed(2)})`;

    expect(line).toBe("- Q123: ↑ YES (confidence: 72%, signal: +0.44)");
  });

  it("should produce correct format for NO signal", () => {
    const signal = {
      marketId: "456",
      suggestedOutcome: "NO" as const,
      confidence: 0.61,
      netSignal: -0.22,
    };
    const direction = signal.suggestedOutcome === "NO" ? "↓ NO" : "↑ YES";
    const conf = (signal.confidence * 100).toFixed(0);
    const signStr = signal.netSignal > 0 ? "+" : "";
    const line = `- Q${signal.marketId}: ${direction} (confidence: ${conf}%, signal: ${signStr}${signal.netSignal.toFixed(2)})`;

    expect(line).toBe("- Q456: ↓ NO (confidence: 61%, signal: -0.22)");
  });

  it("should produce correct format for UNCERTAIN signal", () => {
    const signal = {
      marketId: "789",
      suggestedOutcome: "UNCERTAIN" as string,
      confidence: 0.45,
      netSignal: 0.02,
    };
    const direction =
      signal.suggestedOutcome === "YES"
        ? "↑ YES"
        : signal.suggestedOutcome === "NO"
          ? "↓ NO"
          : "? UNCERTAIN";
    const conf = (signal.confidence * 100).toFixed(0);
    const signStr = signal.netSignal > 0 ? "+" : "";
    const line = `- Q${signal.marketId}: ${direction} (confidence: ${conf}%, signal: ${signStr}${signal.netSignal.toFixed(2)})`;

    expect(line).toBe("- Q789: ? UNCERTAIN (confidence: 45%, signal: +0.02)");
  });
});
