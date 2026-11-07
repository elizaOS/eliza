/**
 * The portfolio provider reads the wallet through the BirdeyeService that the
 * runtime registered, against a local Birdeye-compatible server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Memory, State } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BIRDEYE_SERVICE_NAME } from "../constants";
import { BirdeyeService } from "../service";
import { agentPortfolioProvider } from "./agent-portfolio-provider";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let server: http.Server;
let baseUrl = "";
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          wallet: WALLET,
          totalUsd: 1500.25,
          items: [
            {
              address: SOL_MINT,
              symbol: "SOL",
              decimals: 9,
              balance: "10000000000",
              uiAmount: 10,
              chainId: "solana",
              priceUsd: 150.025,
              valueUsd: 1500.25,
            },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Birdeye portfolio provider", () => {
  it("renders the wallet holdings from the registered Birdeye service", async () => {
    const runtime = createSQLiteTestRuntime({
      logLevel: "fatal",
      character: {
        name: "Agent",
        bio: ["test"],
        settings: {
          BIRDEYE_WALLET_ADDR: WALLET,
          ELIZAOS_CLOUD_API_KEY: "test-cloud-key",
          ELIZAOS_CLOUD_ENABLED: true,
          ELIZAOS_CLOUD_BASE_URL: baseUrl,
        },
      },
    });
    cleanups.push(async () => {
      await runtime.stop();
      await runtime.close();
    });
    await runtime.initialize({ skipMigrations: true });
    await runtime.registerService(BirdeyeService);
    await runtime.getServiceLoadPromise(BIRDEYE_SERVICE_NAME);

    const result = await agentPortfolioProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );

    expect(result.text).toContain("status: ok");
    expect(result.text).toContain(SOL_MINT);
  });
});
