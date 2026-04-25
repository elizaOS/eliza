import type http from "node:http";
import {
  type ElizaConfig,
  loadElizaConfig,
} from "@elizaos/agent/config/config";
import type { AgentRuntime } from "@elizaos/core";
import {
  normalizeOnboardingProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared/contracts/onboarding";
import { sendJsonError as sendJsonErrorResponse } from "./response";

const MAX_BODY_BYTES = 1_048_576;

export interface CompatRuntimeState {
  current: AgentRuntime | null;
  pendingAgentName: string | null;
  pendingRestartReasons: string[];
}

export function clearCompatRuntimeRestart(state: CompatRuntimeState): void {
  state.pendingRestartReasons = [];
}

export function scheduleCompatRuntimeRestart(
  state: CompatRuntimeState,
  reason: string,
): void {
  if (state.pendingRestartReasons.includes(reason)) {
    return;
  }

  if (state.pendingRestartReasons.length >= 50) {
    state.pendingRestartReasons.splice(
      1,
      state.pendingRestartReasons.length - 1,
    );
  }

  state.pendingRestartReasons.push(reason);
}

export const DATABASE_UNAVAILABLE_MESSAGE =
  "Database not available. The agent may not be running or the database adapter is not initialized.";

export function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}

export async function readCompatJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        sendJsonErrorResponse(res, 413, "Request body too large");
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid request body");
    return null;
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJsonErrorResponse(res, 400, "Invalid JSON body");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid JSON body");
    return null;
  }
}

export function hasCompatPersistedOnboardingState(
  config: ElizaConfig,
): boolean {
  if ((config.meta as Record<string, unknown>)?.onboardingComplete === true) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeOnboardingProviderId(llmText?.backend);
  const remoteApiBase =
    llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
  const hasCompleteCanonicalRouting =
    (llmText?.transport === "direct" &&
      Boolean(backend && backend !== "elizacloud")) ||
    (llmText?.transport === "remote" && Boolean(remoteApiBase)) ||
    (llmText?.transport === "cloud-proxy" &&
      backend === "elizacloud" &&
      Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim())) ||
    (deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase?.trim()));

  if (hasCompleteCanonicalRouting) {
    return true;
  }

  if (Array.isArray(config.agents?.list) && config.agents.list.length > 0) {
    return true;
  }

  return Boolean(
    config.agents?.defaults?.workspace?.trim() ||
      config.agents?.defaults?.adminEntityId?.trim(),
  );
}

export function getConfiguredCompatAgentName(): string | null {
  const config = loadElizaConfig();
  const listAgent = config.agents?.list?.[0];
  const listAgentName =
    typeof listAgent?.name === "string" ? listAgent.name.trim() : "";
  if (listAgentName) {
    return listAgentName;
  }

  const assistantName =
    typeof config.ui?.assistant?.name === "string"
      ? config.ui.assistant.name.trim()
      : "";
  return assistantName || null;
}
