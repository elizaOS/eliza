import {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "../../../../packages/app-core/test/helpers/real-runtime.ts";

export type { RealTestRuntimeOptions, RealTestRuntimeResult };

export async function createLifeOpsTestRuntime(
  options?: RealTestRuntimeOptions,
): Promise<RealTestRuntimeResult> {
  const previousDisableProactiveAgent =
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT =
    previousDisableProactiveAgent?.trim() || "1";

  try {
    const { personalAssistantPlugin } = await import("../../src/plugin.js");
    // The ScheduledTaskRunnerService + the generic scheduled-task route now
    // live in the always-loaded @elizaos/plugin-scheduling. Load it alongside
    // PA (as the real runtime does) so PA's injected deps have a runner host.
    const { schedulingPlugin } = await import("@elizaos/plugin-scheduling");
    return await createRealTestRuntime({
      ...options,
      plugins: [
        schedulingPlugin,
        personalAssistantPlugin,
        ...(options?.plugins ?? []),
      ],
    });
  } finally {
    if (previousDisableProactiveAgent === undefined) {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    } else {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT = previousDisableProactiveAgent;
    }
  }
}
