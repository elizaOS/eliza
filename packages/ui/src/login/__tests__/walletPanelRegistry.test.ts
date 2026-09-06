/**
 * Unit tests for the wallet panel registry.
 *
 * The registry decouples `<LoginForm>` (root entry) from the optional
 * wallet peer deps. These tests verify the register / read / reset cycle and
 * the "consumer never imported @elizaos/ui" fallback (undefined).
 */

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _resetWalletPanelRegistry,
  getEvmWalletPanel,
  getSolanaWalletPanel,
  registerEvmWalletPanel,
  registerSolanaWalletPanel,
  type WalletPanelLoader,
} from "../internal/walletPanelRegistry.js";

const noopPanel = (() => null) as ComponentType<unknown>;
function makeLoader(): WalletPanelLoader {
  return { load: async () => ({ default: noopPanel }) };
}

describe("walletPanelRegistry", () => {
  beforeEach(() => {
    _resetWalletPanelRegistry();
  });
  afterEach(() => {
    _resetWalletPanelRegistry();
  });

  test("getters return undefined before any registration", () => {
    expect(getEvmWalletPanel()).toBeUndefined();
    expect(getSolanaWalletPanel()).toBeUndefined();
  });

  test("registerEvmWalletPanel makes the EVM loader readable", () => {
    const loader = makeLoader();
    registerEvmWalletPanel(loader);
    expect(getEvmWalletPanel()).toBe(loader);
    // Solana stays unregistered.
    expect(getSolanaWalletPanel()).toBeUndefined();
  });

  test("registerSolanaWalletPanel makes the Solana loader readable", () => {
    const loader = makeLoader();
    registerSolanaWalletPanel(loader);
    expect(getSolanaWalletPanel()).toBe(loader);
    expect(getEvmWalletPanel()).toBeUndefined();
  });

  test("registering both keeps each loader independent", () => {
    const evm = makeLoader();
    const sol = makeLoader();
    registerEvmWalletPanel(evm);
    registerSolanaWalletPanel(sol);
    expect(getEvmWalletPanel()).toBe(evm);
    expect(getSolanaWalletPanel()).toBe(sol);
    expect(getEvmWalletPanel()).not.toBe(getSolanaWalletPanel());
  });

  test("re-registering overwrites the previous loader", () => {
    const first = makeLoader();
    const second = makeLoader();
    registerEvmWalletPanel(first);
    registerEvmWalletPanel(second);
    expect(getEvmWalletPanel()).toBe(second);
  });

  test("_resetWalletPanelRegistry clears both loaders", () => {
    registerEvmWalletPanel(makeLoader());
    registerSolanaWalletPanel(makeLoader());
    _resetWalletPanelRegistry();
    expect(getEvmWalletPanel()).toBeUndefined();
    expect(getSolanaWalletPanel()).toBeUndefined();
  });

  test("a registered loader actually resolves to a component module", async () => {
    const loader = makeLoader();
    registerEvmWalletPanel(loader);
    const mod = await getEvmWalletPanel()?.load();
    expect(mod?.default).toBe(noopPanel);
  });
});
