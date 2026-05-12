import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ELIZA_1_TIERS } from "../src/services/local-inference/manifest/schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES_YAML = path.resolve(
  HERE,
  "../../training/benchmarks/eliza1_gates.yaml",
);

describe("eliza1_gates.yaml", () => {
  const doc = parse(readFileSync(GATES_YAML, "utf8")) as Record<
    string,
    unknown
  >;

  it("parses and has a version + gates + tiers + dflash section", () => {
    expect(typeof doc.version).toBe("number");
    expect(typeof doc.gates).toBe("object");
    expect(typeof doc.tiers).toBe("object");
    expect(typeof doc.dflash).toBe("object");
  });

  it("defines the dflash bench gate (acceptance + speedup) thresholds", () => {
    const dflash = doc.dflash as Record<string, unknown>;
    expect(typeof dflash.minAcceptanceRate).toBe("number");
    expect(typeof dflash.minSpeedup).toBe("number");
    expect(dflash.minAcceptanceRate).toBeGreaterThan(0);
    expect(dflash.minAcceptanceRate).toBeLessThanOrEqual(1);
    expect(dflash.minSpeedup).toBeGreaterThanOrEqual(1);
    // Stays provisional until a trained drafter exists.
    expect(dflash.provisional).toBe(true);
  });

  it("declares dflash_acceptance and dflash_speedup as gate definitions", () => {
    const gates = doc.gates as Record<string, Record<string, unknown>>;
    expect(gates.dflash_acceptance?.op).toBe(">=");
    expect(gates.dflash_acceptance?.manifest_field).toBe(
      "evals.dflashAcceptance",
    );
    expect(gates.dflash_speedup?.op).toBe(">=");
    expect(gates.dflash_speedup?.manifest_field).toBe("evals.dflashSpeedup");
    // Barge-in + endurance + mobile gates exist too.
    expect(gates.barge_in_cancel_ms?.op).toBe("<=");
    expect(gates.thirty_turn_ok?.op).toBe("bool");
    expect(gates.peak_rss_mb?.needs_hardware).toBe(true);
    expect(gates.thermal_throttle_pct?.needs_hardware).toBe(true);
  });

  it("covers every manifest tier", () => {
    const tiers = doc.tiers as Record<string, Record<string, unknown>>;
    for (const tier of ELIZA_1_TIERS) {
      expect(tiers[tier], `gates for tier ${tier}`).toBeDefined();
      // Every tier carries the core boolean contract gates.
      expect(tiers[tier]).toHaveProperty("thirty_turn_ok");
      expect(tiers[tier]).toHaveProperty("e2e_loop_ok");
      expect(tiers[tier]).toHaveProperty("dflash_acceptance");
      expect(tiers[tier]).toHaveProperty("dflash_speedup");
    }
  });

  it("each per-tier gate has a threshold and a required flag", () => {
    const tiers = doc.tiers as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    for (const [tier, gates] of Object.entries(tiers)) {
      for (const [gateName, cfg] of Object.entries(gates)) {
        expect(cfg, `${tier}.${gateName}`).toHaveProperty("threshold");
        expect(typeof cfg.required, `${tier}.${gateName}.required`).toBe(
          "boolean",
        );
      }
    }
  });
});
