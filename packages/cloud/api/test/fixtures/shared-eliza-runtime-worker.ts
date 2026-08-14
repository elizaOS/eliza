/**
 * Runs the production Shared turn adapter inside Workerd while an external
 * deterministic OpenAI-compatible endpoint supplies the model response.
 */

import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import { runSharedAgentTurn } from "../../../shared/src/lib/services/shared-runtime/run-shared-agent-turn";

type Env = {
  NODE_ENV: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL: string;
};

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    return await runWithCloudBindingsAsync(env, async () => {
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
