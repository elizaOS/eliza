import { describe, expect, it } from "vitest";
import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

async function getJson(pathname: string): Promise<unknown> {
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`),
  );

  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(pathname: string, body: unknown): Promise<unknown> {
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

  expect(response.status).toBe(200);
  return response.json();
}

describe("handleIosLocalAgentRequest", () => {
  it("matches app catalog response contracts", async () => {
    await expect(getJson("/api/apps")).resolves.toEqual([]);
    await expect(getJson("/api/catalog/apps")).resolves.toEqual([]);
  });

  it("matches plugin and skill list response contracts", async () => {
    await expect(getJson("/api/plugins")).resolves.toEqual({ plugins: [] });
    await expect(getJson("/api/skills")).resolves.toEqual({ skills: [] });
  });

  it("serves empty local wallet contracts instead of 404s", async () => {
    await expect(getJson("/api/wallet/addresses")).resolves.toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    await expect(getJson("/api/wallet/balances")).resolves.toEqual({
      evm: null,
      solana: null,
    });

    const config = await getJson("/api/wallet/config");
    expect(config).toMatchObject({
      evmAddress: null,
      solanaAddress: null,
      walletSource: "none",
      executionReady: false,
      wallets: [],
    });

    const overview = await getJson("/api/wallet/market-overview");
    expect(overview).toMatchObject({
      prices: [],
      movers: [],
      predictions: [],
    });
  });

  it("serves local web browser workspace contracts instead of 404s", async () => {
    await expect(getJson("/api/browser-workspace")).resolves.toEqual({
      mode: "web",
      tabs: [],
    });

    const opened = await postJson("/api/browser-workspace/tabs", {
      url: "https://docs.elizaos.ai/",
      title: "Docs",
    });
    expect(opened).toMatchObject({
      tab: {
        title: "Docs",
        url: "https://docs.elizaos.ai/",
        visible: true,
      },
    });
  });
});
