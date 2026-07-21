import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked BEFORE importing the plugin so `get-yield-signal.ts` picks up the
// mock, not the real implementation. Without this, `fetchYieldSignal` (via
// `@x402/fetch`'s `wrapFetchWithPayment`) makes a real HTTP request to
// yieldsignal.vercel.app to receive the initial 402 challenge before it ever
// gets to checking for CDP credentials — a real network call inside a unit
// test, flaky and disallowed in CI. Confirmed by reading @x402/fetch's
// source: the very first thing `wrapFetchWithPayment`'s wrapped fetch does is
// `await fetch(request)` against the real URL.
vi.mock("./client.js", () => ({
  fetchYieldSignal: vi.fn(),
}));

import { fetchYieldSignal } from "./client.js";
import { yieldSignalPlugin } from "./index.js";

const mockFetchYieldSignal = vi.mocked(fetchYieldSignal);

describe("yieldSignalPlugin", () => {
  beforeEach(() => {
    mockFetchYieldSignal.mockReset();
  });

  it("expõe a action GET_YIELD_SIGNAL com similes e descrição corretos", () => {
    expect(yieldSignalPlugin.name).toBe("yieldsignal");
    expect(yieldSignalPlugin.actions).toHaveLength(1);

    const action = (yieldSignalPlugin.actions ?? [])[0];
    expect(action.name).toBe("GET_YIELD_SIGNAL");
    expect(action.similes).toContain("BEST_LENDING_RATE");
  });

  it("validate sempre resolve true", async () => {
    const action = (yieldSignalPlugin.actions ?? [])[0];
    await expect(action.validate({} as never, {} as never)).resolves.toBe(true);
  });

  it("handler retorna ActionResult com success:true e o texto formatado quando a chamada paga funciona", async () => {
    mockFetchYieldSignal.mockResolvedValue({
      asset: "USDC",
      bestProtocol: "aave",
      gapBps: 42,
    });
    const action = (yieldSignalPlugin.actions ?? [])[0];
    const message = {
      content: { text: "what's the best USDC rate?" },
    } as never;
    const result = await action.handler(
      {} as never,
      message,
      undefined,
      undefined,
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(true);
    expect((result as { text: string }).text).toContain("aave");
    expect(mockFetchYieldSignal).toHaveBeenCalledWith("USDC");
  });

  it("handler retorna ActionResult com success:false quando a chamada paga falha (ex: sem credenciais CDP configuradas) — sem rede real", async () => {
    mockFetchYieldSignal.mockRejectedValue(
      new Error(
        "Missing required CDP credentials: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET.",
      ),
    );
    const action = (yieldSignalPlugin.actions ?? [])[0];
    const message = {
      content: { text: "what's the best USDC rate?" },
    } as never;
    const result = await action.handler(
      {} as never,
      message,
      undefined,
      undefined,
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it("detecta WETH pela menção no texto e repassa pro client", async () => {
    mockFetchYieldSignal.mockResolvedValue({
      asset: "WETH",
      bestProtocol: "morpho",
      gapBps: 10,
    });
    const action = (yieldSignalPlugin.actions ?? [])[0];
    const message = { content: { text: "best WETH lending rate?" } } as never;
    await action.handler({} as never, message, undefined, undefined, undefined);
    expect(mockFetchYieldSignal).toHaveBeenCalledWith("WETH");
  });
});
