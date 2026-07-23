/**
 * EVM prompt context reads only background-refreshed wallet state.
 */
import { AgentRuntime, type Memory, type State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { evmWalletProvider } from "../../providers/wallet";
import { EVMService } from "../../service";

const message = {} as Memory;
const state = { agentName: "Agent" } as State;

describe("evmWalletProvider cache-only prompt path", () => {
  function runtimeWithService(): { runtime: AgentRuntime; service: EVMService } {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const service = new EVMService(runtime);
    vi.spyOn(runtime, "getService").mockReturnValue(service);
    return { runtime, service };
  }

  it("returns explicit loading context without awaiting network work", async () => {
    const { runtime, service } = runtimeWithService();
    const getCachedData = vi.fn(async () => undefined);
    vi.spyOn(service, "getCachedData").mockImplementation(getCachedData);

    const result = await evmWalletProvider.get(runtime, message, state);

    expect(getCachedData).toHaveBeenCalledOnce();
    expect(result.data).toEqual({ status: "loading" });
    expect(result.values).toMatchObject({
      walletReady: false,
      walletStatus: "loading",
    });
  });

  it("renders the cached address and balances", async () => {
    const { runtime, service } = runtimeWithService();
    vi.spyOn(service, "getCachedData").mockResolvedValue({
      address: "0x1234",
      chains: [{ name: "Ethereum", balance: "1", symbol: "ETH" }],
      timestamp: Date.now(),
    });

    const result = await evmWalletProvider.get(runtime, message, state);

    expect(result.text).toContain("0x1234");
    expect(result.text).toContain("Ethereum: 1 ETH");
  });
});
