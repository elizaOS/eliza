/**
 * Unit tests for producible evidence: validates backend capability resolution.
 */
import { describe, expect, it } from "vitest";
import {
  capabilitiesForBackend,
  DETERMINISTIC_LEDGER_VERIFIER_NAME,
} from "./producible-evidence.ts";

describe("producible-evidence", () => {
  it("exports verifier name constant", () => {
    expect(DETERMINISTIC_LEDGER_VERIFIER_NAME).toBe(
      "deterministic-ledger-verifier",
    );
  });

  it("resolves completionEnvelope capability for supported frameworks", () => {
    const claude = capabilitiesForBackend("claude");
    expect(claude.completionEnvelope).toBe(true);

    const codex = capabilitiesForBackend("codex");
    expect(codex.completionEnvelope).toBe(true);
  });

  it("resolves fail-closed for unknown or empty framework name", () => {
    const unknownCaps = capabilitiesForBackend(null);
    expect(unknownCaps.completionEnvelope).toBe(false);
    expect(unknownCaps.browser).toBe(false);
  });
});
