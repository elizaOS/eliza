/**
 * DEPLOY_APP — "ship / go live with app X".
 *
 * Resolves the app, kicks off the deploy (`client.deployApp(id)` → 202), then
 * runs the COMPLETION GATE (deploy-gate.ts): poll `getAppDeployStatus` until
 * READY, then probe the authoritative `production_url` + `/health` for a 2xx.
 * Only when both pass do we report the app live. Building/timeout/error/
 * unreachable each produce a clear, honest failure — we never claim "live"
 * without the reachability proof.
 *
 * On a verified-live deploy we also write the idempotent facts cache so the
 * agent recalls the app later (convenience, not the gate).
 *
 * The completion gate is injectable, so tests pin the status progression and
 * reachability decisions here while live staging deploy coverage remains owned
 * by the cloud API e2e lane.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { recordAppDeployFact } from "../app-facts.js";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";
import {
  DEFAULT_DEPLOY_GATE_CONFIG,
  type DeployGateConfig,
  runDeployGate,
} from "../deploy-gate.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";
import { probeReachable } from "../reachability.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can deploy your apps.";
const NO_REFERENCE_MESSAGE =
  "Which app would you like to deploy? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't start that deploy right now — the Cloud API returned an error. Try again in a moment.";

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet — ask me to create one first.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

async function reportLive(
  runtime: IAgentRuntime,
  message: Memory,
  app: AppDto,
  url: string,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const reply = `"${app.name}" is live at ${url} 🎉`;
  // Best-effort, idempotent facts cache — never fails the deploy.
  const fact = await recordAppDeployFact(runtime, message, app, url);
  // The app's deployment status just changed — refresh the provider cache so it
  // reflects the new live URL/status within the same conversation.
  invalidateAppsCache(runtime);
  await callback?.({ text: reply, actions: ["DEPLOY_APP"] });
  return {
    success: true,
    text: `Deployed ${app.name} — live at ${url}.`,
    userFacingText: reply,
    verifiedUserFacing: true,
    data: {
      app: { id: app.id, name: app.name, slug: app.slug },
      url,
      phase: "ready",
      factWritten: fact.written,
      factUpdated: fact.updated,
    },
  };
}

export const deployAppAction: Action = {
  name: "DEPLOY_APP",
  similes: ["SHIP_APP", "GO_LIVE", "DEPLOY_CLOUD_APP", "LAUNCH_APP"],
  description:
    "Deploy an existing Eliza Cloud app and confirm it is live (waits for the build to finish and verifies the public URL responds). Use when the user asks to deploy, ship, launch, or go live with an app.",
  descriptionCompressed: "Deploy a Cloud app and verify it is live.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["DEPLOY_APP"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({ text: NO_REFERENCE_MESSAGE, actions: ["DEPLOY_APP"] });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    let app: AppDto | null;
    let available: string[];
    try {
      ({ app, available } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[DEPLOY_APP] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["DEPLOY_APP"] });
      return {
        success: false,
        text: "Failed to resolve Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!app) {
      const msg = notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["DEPLOY_APP"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;

    try {
      await client.deployApp(target.id);
    } catch (err) {
      logger.warn(
        `[DEPLOY_APP] deployApp(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["DEPLOY_APP"] });
      return {
        success: false,
        text: "Failed to start deploy.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    // Acknowledge the long-running build before the gate blocks.
    await callback?.({
      text: `Deploying "${target.name}"… this can take a minute. I'll confirm once it's live.`,
      actions: ["DEPLOY_APP"],
    });

    const config: DeployGateConfig = DEFAULT_DEPLOY_GATE_CONFIG;
    const result = await runDeployGate(
      {
        // Thread the gate's per-poll abort signal into the HTTP request so a
        // stalled connection is torn down at the requestTimeoutMs budget.
        getStatus: (signal) => client.getAppDeployStatus(target.id, { signal }),
        getApp: (signal) => client.getApp(target.id, { signal }),
        probe: (url) =>
          probeReachable(url, { timeoutMs: config.probeTimeoutMs }),
        // A transient poll failure never aborts the gate — log and keep polling.
        onPollError: (err, attempt) =>
          logger.warn(
            `[DEPLOY_APP] status poll ${attempt}/${config.maxAttempts} for ${
              target.id
            } failed (deploy continues server-side; will keep polling): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      },
      config,
    );

    if (result.phase === "ready" && result.url) {
      return reportLive(runtime, message, target, result.url, callback);
    }

    // Honest failure — never claim "live" without the reachability proof.
    let reply: string;
    if (result.phase === "error") {
      reply = `"${target.name}"'s deploy failed${
        result.error ? `: ${result.error}` : ""
      }. Nothing is live yet — want me to retry?`;
    } else if (result.phase === "timeout") {
      reply = `"${target.name}" is still building after a while (last status: ${result.status}). It may finish shortly — ask me "is ${target.name} live?" in a bit.`;
    } else {
      // unreachable
      reply = result.url
        ? `"${target.name}" finished building, but ${result.url} isn't answering yet, so I won't call it live. Give it a moment and ask me to check the deploy status.`
        : `"${target.name}" finished building, but it has no public URL yet, so I can't confirm it's live.`;
    }

    await callback?.({ text: reply, actions: ["DEPLOY_APP"] });
    return {
      success: false,
      text: `Deploy of ${target.name} not confirmed live (${result.phase}).`,
      userFacingText: reply,
      verifiedUserFacing: true,
      data: {
        app: { id: target.id, name: target.name, slug: target.slug },
        phase: result.phase,
        status: result.status,
        url: result.url,
        attempts: result.attempts,
        reason: result.phase,
      },
    };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "deploy my Acme Bot app" } },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" is live at https://acme.elizacloud.ai 🎉',
          actions: ["DEPLOY_APP"],
        },
      },
    ],
  ],
};

export default deployAppAction;
