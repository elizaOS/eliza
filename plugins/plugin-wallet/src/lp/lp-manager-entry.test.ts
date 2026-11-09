/**
 * lpManagerPlugin.init loads the configured DEX sub-plugins, and each one
 * registers its LP protocol provider with LpManagementService. The runtime
 * runs a plugin's init before it registers that plugin's services, so the
 * registration has to work while the registry service is not up yet.
 */
import { type AgentRuntime, createCharacter } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import lpManagerPlugin from "./lp-manager-entry.ts";
import {
  LP_MANAGEMENT_SERVICE_TYPE,
  type LpManagementService,
} from "./services/LpManagementService.ts";

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    // A runtime whose initialize() never settled may not stop cleanly.
    await Promise.race([
      runtime.stop().then(() => runtime.close()),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function makeRuntime(plugins: AgentRuntime["plugins"]): AgentRuntime {
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({
      name: "LpManagerAgent",
      // A Base RPC selects the Aerodrome and Uniswap DEXes; init makes no call.
      settings: { secrets: { BASE_RPC_URL: "http://127.0.0.1:9/base" } },
    }),
    plugins,
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  return runtime;
}

async function registeredDexes(runtime: AgentRuntime): Promise<string[]> {
  const lp = (await runtime.getServiceLoadPromise(
    LP_MANAGEMENT_SERVICE_TYPE,
  )) as LpManagementService;
  return lp
    .listProtocols()
    .map((protocol) => protocol.dex)
    .sort();
}

describe("lpManagerPlugin DEX provider registration", () => {
  it("initializes a runtime that lists the plugin and registers the DEX providers", async () => {
    const runtime = makeRuntime([lpManagerPlugin]);

    const outcome = await Promise.race([
      runtime.initialize({ skipMigrations: true }).then(() => "initialized"),
      new Promise<string>((resolve) =>
        setTimeout(
          () => resolve("initialize() still pending after 10 s"),
          10_000,
        ),
      ),
    ]);

    expect(outcome).toBe("initialized");
    expect(await registeredDexes(runtime)).toEqual(["aerodrome", "uniswap"]);
  }, 30_000);

  it("registers the DEX providers when the plugin is added to a running runtime", async () => {
    const runtime = makeRuntime([]);
    await runtime.initialize({ skipMigrations: true });

    await runtime.registerPlugin(lpManagerPlugin);

    expect(await registeredDexes(runtime)).toEqual(["aerodrome", "uniswap"]);
  }, 30_000);
});
