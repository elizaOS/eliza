// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import { resolveCloudRoute, toRuntimeSettings } from "@elizaos/cloud-routing";
import type { IAgentRuntime, Plugin, ServiceTypeName } from "@elizaos/core";
import { parseBooleanFromText } from "@elizaos/core";
import { tokenInfoAction } from "../token-info/action";
import { TokenInfoService } from "../token-info/service";
import Birdeye from "./birdeye-task";
import { BIRDEYE_SERVICE_NAME } from "./constants";
import { agentPortfolioProvider } from "./providers/agent-portfolio-provider";
import { marketProvider } from "./providers/market";
import { trendingProvider } from "./providers/trending";
import { registerBirdeyeSearchCategories } from "./search-category";
import { BIRDEYE_ROUTE_SPEC, BirdeyeService } from "./service";
//import { tradePortfolioProvider } from './providers/wallet'; // trade history

// create a new plugin
export const birdeyePlugin: Plugin = {
  name: "birdeye",
  description: "birdeye plugin",
  actions: [tokenInfoAction],
  // injected later if set up is fine
  providers: [],
  services: [TokenInfoService],
  init: async (_, runtime: IAgentRuntime) => {
    const taskReadyPromise = new Promise((resolve) => {
      runtime.initPromise.then(async () => {
        // clean old tasks
        const tasks = await runtime.getTasks({
          tags: ["queue", "repeat", "plugin_birdeye"],
          agentIds: [runtime.agentId],
        });
        for (const task of tasks) {
          if (task.id) {
            await runtime.deleteTask(task.id);
          }
        }
        resolve(void 0);
      });
    });

    const birdeyeRoute = resolveCloudRoute(
      toRuntimeSettings(runtime),
      BIRDEYE_ROUTE_SPEC,
    );
    registerBirdeyeSearchCategories(runtime, {
      enabled: birdeyeRoute.source !== "disabled",
      disabledReason:
        birdeyeRoute.source === "disabled"
          ? "BIRDEYE_API_KEY or Eliza Cloud route is not configured."
          : undefined,
    });
    if (birdeyeRoute.source === "disabled") {
      runtime.logger.log(
        "birdeye: no BIRDEYE_API_KEY and Eliza Cloud not connected, skipping plugin-birdeye init",
      );
      return;
    }

    // options
    const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");
    taskReadyPromise.then(() => {
      // should be a list of wallets
      // one for agent, another for one for wallets to be tracked...

      if (walletAddr) {
        // task to update wallet contents & trade history
        // needs to be deprecated once service has caching & providers use the service directly
        // well we still might need this if providers need to be snappy (under x ms)
        // so an option to control this is best
        const birdeye = new Birdeye(runtime);
        runtime.registerTaskWorker({
          name: "BIRDEYE_SYNC_WALLET",
          validate: async (_runtime, _message, _state) => {
            return true; // TODO: validate after certain time
          },
          execute: async (runtime, _options, _task) => {
            try {
              await birdeye.syncWallet();
            } catch (error) {
              runtime.logger.error(
                `Failed to sync trending tokens: ${error instanceof Error ? error.message : String(error)}`,
              );
              //runtime.logger.error({ error }, 'Failed to sync wallet');
            }
            return undefined;
          },
        });

        const worldId = runtime.agentId; // this is global data for the agent
        runtime.createTask({
          name: "BIRDEYE_SYNC_WALLET",
          description: "Sync wallet from Birdeye",
          worldId,
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: Date.now(),
            updateInterval: 1000 * 60 * 5, // 5 minutes
          },
          tags: ["queue", "repeat", "plugin_birdeye", "immediate"],
        });
        runtime.logger.log("birdeye init - tasks registered");
      }
    });

    if (walletAddr) {
      // agent's wallet contents (was using provider)
      runtime.registerProvider(agentPortfolioProvider);

      // disbaled because it's not working right now
      // agent's wallet trade history (was task-based)
      //runtime.registerProvider(tradePortfolioProvider) // needs BIRDEYE_SYNC_WALLET
    }

    runtime.registerService(BirdeyeService); // register service (async but not awaiting)
    runtime.registerProvider(marketProvider); // SOL, ETH, BTC price
    // option to disable including this...
    const beNoTrending = parseBooleanFromText(
      String(runtime.getSetting("BIRDEYE_NO_TRENDING") ?? ""),
    );
    if (!beNoTrending) {
      runtime.registerProvider(trendingProvider); // top 100 solana tokens
    } else {
      runtime.logger.log(
        "BIRDEYE_NO_TRENDING is set, skipping trending provider",
      );
    }

    // extensions - register with INTEL_DATAPROVIDER if available
    Promise.all(
      ["INTEL_DATAPROVIDER", BIRDEYE_SERVICE_NAME].map((p) =>
        runtime.getServiceLoadPromise(p as ServiceTypeName),
      ),
    )
      .then(() => {
        const infoService = runtime.getService("INTEL_DATAPROVIDER") as
          | { registerDataProvder?: (provider: unknown) => void }
          | undefined;

        // Guard against missing service
        if (!infoService) {
          runtime.logger?.warn(
            "INTEL_DATAPROVIDER service not available, skipping data provider registration",
          );
          return;
        }

        if (typeof infoService.registerDataProvder !== "function") {
          runtime.logger?.warn(
            "INTEL_DATAPROVIDER service does not have registerDataProvder method",
          );
          return;
        }

        const me = {
          name: "Birdeye",
          trendingService: BIRDEYE_SERVICE_NAME,
          lookupService: BIRDEYE_SERVICE_NAME,
        };

        try {
          infoService.registerDataProvder(me);
          runtime.logger?.log(
            "Birdeye data provider registered with INTEL_DATAPROVIDER",
          );
        } catch (error) {
          runtime.logger?.error(
            `Failed to register Birdeye data provider: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .catch((e) => {
        runtime.logger?.error(
          `Failed to load services for data provider registration: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  },
};
