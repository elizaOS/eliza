/**
 * Test-runtime helpers for LifeOps: wraps createRealTestRuntime and provides an in-memory
 * notification sink standing in for the production NotificationService, so in-app
 * scheduled-task dispatches report honest DispatchResults and tests can assert what was
 * delivered.
 */
import {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "../../../../packages/app-core/test/helpers/real-runtime.ts";

export type { RealTestRuntimeOptions, RealTestRuntimeResult };

export interface RecordedTestNotification {
  title?: string;
  body?: string;
  category?: string;
  priority?: string;
  source?: string;
  groupKey?: string;
  deepLink?: string;
  data?: Record<string, unknown>;
}

interface TestNotificationSink {
  serviceType: "notification";
  capabilityDescription: string;
  recorded: RecordedTestNotification[];
  notify(input: RecordedTestNotification): Promise<{ id: string }>;
  stop(): Promise<void>;
}

/**
 * In-memory notification sink standing in for the production
 * NotificationService (durable inbox). The in_app scheduled-task dispatcher
 * reports honest DispatchResults — with NO surface registered every fire
 * would (correctly) come back `ok:false` and park in the retry path, which
 * is not what production hosts look like. The sink also lets tests assert
 * what was actually delivered via {@link getRecordedTestNotifications}.
 */
function injectNotificationSink(
  runtime: RealTestRuntimeResult["runtime"],
): void {
  if (runtime.getService("notification")) return;
  const sink: TestNotificationSink = {
    serviceType: "notification",
    capabilityDescription: "In-memory notification sink (test helper)",
    recorded: [],
    async notify(input) {
      sink.recorded.push(input);
      return { id: `test-notification-${sink.recorded.length}` };
    },
    async stop() {},
  };
  const services = (
    runtime as unknown as { services: Map<string, unknown[]> }
  ).services;
  const list = services.get("notification") ?? [];
  list.push(sink);
  services.set("notification", list);
}

/** Read back what the in-memory sink accepted during a test run. */
export function getRecordedTestNotifications(
  runtime: RealTestRuntimeResult["runtime"],
): RecordedTestNotification[] {
  const sink = runtime.getService("notification") as {
    recorded?: RecordedTestNotification[];
  } | null;
  return sink?.recorded ?? [];
}

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
    const result = await createRealTestRuntime({
      ...options,
      plugins: [
        schedulingPlugin,
        personalAssistantPlugin,
        ...(options?.plugins ?? []),
      ],
    });
    injectNotificationSink(result.runtime);
    return result;
  } finally {
    if (previousDisableProactiveAgent === undefined) {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    } else {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT = previousDisableProactiveAgent;
    }
  }
}
