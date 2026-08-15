/**
 * Runs the production Shared turn adapter inside Workerd while an external
 * deterministic OpenAI-compatible endpoint supplies the model response.
 */

import { searchKeylessWeb } from "@elizaos/core/edge";
import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import { runSharedAgentTurn } from "../../../shared/src/lib/services/shared-runtime/run-shared-agent-turn";

type Env = {
  NODE_ENV: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await runWithCloudBindingsAsync(env, async () => {
      const url = new URL(request.url);
      if (url.pathname === "/search-turn") {
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message: "What is the latest ElizaOS release?",
          messageIds: {
            user: "6328e4cb-4a1f-4d9c-a2fd-769e5fd33aa1",
            assistant: "059e33bc-8215-49f4-841f-7642e7505bc7",
          },
          execution: {
            engine: "eliza-runtime",
            agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
          },
        });
        return Response.json(result);
      }
      if (url.pathname === "/search") {
        const result = await searchKeylessWeb(url.searchParams.get("q") ?? "");
        return Response.json(result ?? { error: "search unavailable" }, {
          status: result ? 200 : 503,
        });
      }
      const result = await runSharedAgentTurn({
        character: {
          name: "Shared Eliza Workerd Probe",
          system: "You are Eliza.",
          model: "local/shared-runtime-probe",
        },
        history: [],
        message: "say hello",
        messageIds: {
          user: "c92f5aaa-59ce-40a6-994b-e9e16dc85198",
          assistant: "f492130b-2fc6-4b2b-bdca-51f441b0483d",
        },
        execution: {
          engine: "eliza-runtime",
          agentKey: "personal:39e40424-28eb-41fc-8844-63d16e84e14f",
        },
      });
      return Response.json(result);
    });
  },
};
