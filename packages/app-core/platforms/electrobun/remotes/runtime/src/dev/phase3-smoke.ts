/** Implements Electrobun runtime remote phase3 smoke ts boundaries for desktop app-core. */
import {
  readPhase3SmokeTestEnv,
  TEST_ENV_NAMES,
} from "../../../../../../../shared/src/test-env-config.ts";
import { ElizaRuntimeApiClient } from "../bun/api-client.ts";
import { serializeError } from "../bun/errors.ts";
import { RuntimeLogBuffer } from "../bun/log-buffer.ts";
import type { AgentMessageStreamEvent } from "../bun/protocol.ts";
import { ElizaRuntimeManager } from "../bun/runtime-manager.ts";
import { AgentStreamManager } from "../bun/stream-manager.ts";

function writeJson(label: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ label, value }, null, 2)}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function capture(
  label: string,
  task: () => Promise<unknown>,
): Promise<unknown> {
  try {
    const value = await task();
    writeJson(label, { ok: true, value });
    return value;
  } catch (error) {
    const serialized = serializeError(error);
    writeJson(label, { ok: false, error: serialized });
    return serialized;
  }
}

const logBuffer = new RuntimeLogBuffer();
const manager = new ElizaRuntimeManager({ logBuffer });
const apiClient = new ElizaRuntimeApiClient({
  getApiBase: () => manager.status().apiBase,
  getAuthToken: () =>
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
});
const streamEvents: AgentMessageStreamEvent[] = [];
const streamManager = new AgentStreamManager({
  getApiBase: () => manager.status().apiBase,
  getAuthToken: () =>
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
  emit: (name, payload) => {
    writeJson(`event:${name}`, payload);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "streamId" in payload &&
      "kind" in payload
    ) {
      streamEvents.push(payload as AgentMessageStreamEvent);
    }
  },
  log: (line) => logBuffer.push("system", line),
});
const phase3Env = readPhase3SmokeTestEnv(process.env);

writeJson("initialStatus", manager.status());

const initialHealth = await manager.health();
if (!initialHealth.ok && manager.status().mode !== "running") {
  await capture("runtimeStart", () => manager.start());
  await wait(2500);
} else {
  writeJson("runtimeStart", {
    ok: true,
    value: {
      mode: manager.status().mode,
      apiAlreadyReachable: initialHealth.ok,
    },
  });
}

const discovery = await capture("api.discover", () => apiClient.discover(true));
if (
  typeof discovery === "object" &&
  discovery !== null &&
  "streamingRoutes" in discovery
) {
  writeJson("streamingRoutes", discovery.streamingRoutes);
}

if (phase3Env.sendStreamMessage) {
  const startResult = await capture("agent.message.stream", () =>
    streamManager.startMessageStream({
      text: "Phase 3 ElizaLaunch streaming bridge smoke test. Reply briefly.",
    }),
  );
  if (
    typeof startResult === "object" &&
    startResult !== null &&
    "streamId" in startResult &&
    typeof startResult.streamId === "string"
  ) {
    const streamId = startResult.streamId;
    const cancelAfterMs = phase3Env.cancelAfterMs;
    if (cancelAfterMs !== null) {
      setTimeout(() => {
        void capture("agent.message.stream.cancel", () =>
          streamManager.cancelStream({ streamId }),
        );
      }, cancelAfterMs);
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
      const status = streamManager.getStreamStatus(streamId);
      if (status !== null && !status.active) {
        writeJson("agent.message.stream.status", status);
        break;
      }
      await wait(250);
    }
    writeJson("agent.message.stream.events", streamEvents);
  }
} else {
  writeJson("agent.message.stream", {
    ok: true,
    skipped: `Set ${TEST_ENV_NAMES.phase3.sendStreamMessage}=1 to send a real streaming message.`,
  });
}

writeJson("logsTail", manager.logsTail(20));

if (phase3Env.stopAfter) {
  await capture("runtimeStop", () => manager.stop());
} else {
  writeJson("runtimeStop", {
    ok: true,
    skipped: `Set ${TEST_ENV_NAMES.phase3.stopAfter}=1 to stop after the smoke run.`,
  });
}

writeJson("finalStatus", manager.status());
