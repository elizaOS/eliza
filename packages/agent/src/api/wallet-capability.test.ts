import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  isPluginLoadedByName,
  resolvePluginEvmLoaded,
} from "./wallet-capability.js";

describe("wallet capability plugin detection", () => {
  it("detects @elizaos/plugin-wallet by short runtime plugin name", () => {
    const runtime = {
      plugins: [{ name: "wallet" }],
    } as unknown as AgentRuntime;

    expect(isPluginLoadedByName(runtime, "@elizaos/plugin-wallet")).toBe(true);
    expect(resolvePluginEvmLoaded(runtime)).toBe(true);
  });

  it("detects plugin-wallet from iterable plugin containers", () => {
    const runtime = {
      plugins: new Set([{ id: "wallet" }]),
    } as unknown as AgentRuntime;

    expect(isPluginLoadedByName(runtime, "@elizaos/plugin-wallet")).toBe(true);
  });

  it("detects EVM execution readiness from the runtime service alias", () => {
    const runtime = {
      plugins: [],
      getService: (name: string) => (name === "evmService" ? {} : null),
    } as unknown as AgentRuntime;

    expect(resolvePluginEvmLoaded(runtime)).toBe(true);
  });

  it("keeps checking EVM service aliases when the first lookup throws", () => {
    const runtime = {
      plugins: [],
      getService: (name: string) => {
        if (name === "evm") {
          throw new Error("legacy alias unavailable");
        }
        return name === "evmService" ? {} : null;
      },
    } as unknown as AgentRuntime;

    expect(resolvePluginEvmLoaded(runtime)).toBe(true);
  });
});
