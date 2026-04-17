import { appLifeOpsPlugin } from "../../src/plugin.js";
import {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "../../../../packages/app-core/test/helpers/real-runtime.js";

export type { RealTestRuntimeOptions, RealTestRuntimeResult };

export async function createLifeOpsTestRuntime(
  options?: RealTestRuntimeOptions,
): Promise<RealTestRuntimeResult> {
  const previousDisableProactiveAgent = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT =
    previousDisableProactiveAgent?.trim() || "1";

  try {
    return await createRealTestRuntime({
      ...options,
      plugins: [appLifeOpsPlugin, ...(options?.plugins ?? [])],
    });
  } finally {
    if (previousDisableProactiveAgent === undefined) {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    } else {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT = previousDisableProactiveAgent;
    }
  }
}
