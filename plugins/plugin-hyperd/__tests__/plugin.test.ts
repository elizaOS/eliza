/**
 * Smoke tests: verify the plugin exports a well-formed shape and each
 * action's validate() responds correctly to representative messages.
 *
 * No network calls — handler execution requires a wallet and is exercised
 * via integration tests, not these unit tests.
 */

import { describe, it, expect } from "vitest";
import type { Memory } from "@elizaos/core";
import {
  hyperdPlugin,
  walletRiskAction,
  tokenSecurityAction,
  liquidationRiskAction,
  walletPnlAction,
  dexQuoteAction,
} from "../src/index.js";

// Minimal Memory shape — enough to flow through validate(). The action code
// only reads .content.text, so we can cast a partial.
const msg = (text: string): Memory =>
  ({ content: { text } } as unknown as Memory);

const runtime = {} as never; // validate() never reads the runtime

describe("hyperdPlugin manifest", () => {
  it("exposes the expected metadata", () => {
    expect(hyperdPlugin.name).toBe("hyperd");
    expect(hyperdPlugin.description).toMatch(/DeFi/i);
    expect(hyperdPlugin.actions).toBeDefined();
    expect(hyperdPlugin.actions?.length).toBe(5);
  });

  it("each action has name + handler + validate + description", () => {
    for (const action of hyperdPlugin.actions ?? []) {
      expect(action.name).toMatch(/^HYPERD_/);
      expect(typeof action.handler).toBe("function");
      expect(typeof action.validate).toBe("function");
      expect(action.description).toBeTruthy();
    }
  });

  it("action names are unique", () => {
    const names = (hyperdPlugin.actions ?? []).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("walletRiskAction.validate", () => {
  it("returns true when message contains a 0x address", async () => {
    const r = await walletRiskAction.validate!(
      runtime,
      msg("Is 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 safe?"),
    );
    expect(r).toBe(true);
  });

  it("returns false when no address is present", async () => {
    const r = await walletRiskAction.validate!(runtime, msg("Is this address safe?"));
    expect(r).toBe(false);
  });
});

describe("tokenSecurityAction.validate", () => {
  it("returns true when message contains a contract address", async () => {
    const r = await tokenSecurityAction.validate!(
      runtime,
      msg("Is 0x4200000000000000000000000000000000000006 a scam token?"),
    );
    expect(r).toBe(true);
  });

  it("returns false without an address", async () => {
    const r = await tokenSecurityAction.validate!(runtime, msg("Is this token a scam?"));
    expect(r).toBe(false);
  });
});

describe("liquidationRiskAction.validate", () => {
  it("returns true with an address present", async () => {
    const r = await liquidationRiskAction.validate!(
      runtime,
      msg("Am I about to get liquidated 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
    );
    expect(r).toBe(true);
  });

  it("returns false without an address", async () => {
    const r = await liquidationRiskAction.validate!(runtime, msg("am I about to get liquidated"));
    expect(r).toBe(false);
  });
});

describe("walletPnlAction.validate", () => {
  it("returns true with an address present", async () => {
    const r = await walletPnlAction.validate!(
      runtime,
      msg("What's my pnl? 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
    );
    expect(r).toBe(true);
  });

  it("returns false without an address", async () => {
    const r = await walletPnlAction.validate!(runtime, msg("what's my P&L?"));
    expect(r).toBe(false);
  });
});

describe("dexQuoteAction.validate", () => {
  it("returns true on a recognizable swap phrase", async () => {
    const r = await dexQuoteAction.validate!(runtime, msg("100 USDC to WETH on base"));
    expect(r).toBe(true);
  });

  it("returns true on alternative phrasing", async () => {
    const r = await dexQuoteAction.validate!(runtime, msg("swap 0.5 ETH for USDT"));
    expect(r).toBe(true);
  });

  it("returns false without a recognizable swap", async () => {
    const r = await dexQuoteAction.validate!(runtime, msg("what's the price of ETH?"));
    expect(r).toBe(false);
  });
});
