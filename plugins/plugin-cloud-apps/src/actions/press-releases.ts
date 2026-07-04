/**
 * Press release agent actions (#11819).
 *
 * DRAFT_PRESS_RELEASE  — create a Cloud-owned press release draft.
 * LIST_PRESS_RELEASES  — list the org's drafts/submissions.
 * SUBMIT_PRESS_RELEASE — two-phase provider-backed submit; currently fails
 *                        closed until a real distribution provider exists.
 */

import type { PressReleaseDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getCloudClient,
  matchByReference,
  resolveCloudApiKey,
} from "../client.js";
import { cloudErrorInfo } from "../domain-intent.js";
import {
  CONFIRM_TTL_MS,
  confirmationRoomId,
  confirmTargetMismatchMessage,
  conflictingConfirmTarget,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  markCloudAppConfirmationRecovery,
  pendingExpired,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";
const MISSING_DRAFT_INPUT = "I need a title and body to draft a press release.";
const NO_PENDING_MESSAGE =
  "I don't have a pending press-release submit confirmation for this room. Tell me which draft to submit first, and I'll ask for confirmation.";
const CANCELED_MESSAGE = "Okay, I won't submit that press release.";

function readOpt(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

function readString(
  rec: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readStringArray(
  rec: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = rec[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  return strings.length > 0 ? strings.map((item) => item.trim()) : undefined;
}

function releaseLine(release: PressReleaseDto): string {
  const date =
    release.updated_at?.slice(0, 10) ?? release.created_at?.slice(0, 10);
  return `• ${release.title} — ${release.status}${date ? ` — updated ${date}` : ""}`;
}

function releaseReference(message: Memory, options: unknown): string {
  const rec = readOpt(options);
  return (
    readString(rec, "releaseId", "pressReleaseId", "title", "name", "query") ??
    (message.content?.text ?? "").trim()
  );
}

async function resolveRelease(
  client: NonNullable<ReturnType<typeof getCloudClient>>,
  reference: string,
): Promise<{
  release: PressReleaseDto | null;
  available: string[];
  ambiguous?: string[];
}> {
  const { releases } = await client.listPressReleases();
  const match = matchByReference(releases, reference, (release) => ({
    id: release.id,
    names: [release.title],
  }));
  return {
    release: match.item,
    available: releases.map((release) => release.title),
    ambiguous:
      match.item === null && match.candidates.length > 1
        ? match.candidates.map((release) => release.title)
        : undefined,
  };
}

export const draftPressReleaseAction: Action = {
  name: "DRAFT_PRESS_RELEASE",
  similes: ["CREATE_PRESS_RELEASE", "DRAFT_PR", "WRITE_PRESS_RELEASE"],
  description:
    "Create a draft press release in Eliza Cloud. Use when the user asks to draft or save a PR/press release for later distribution.",
  descriptionCompressed: "Create a draft press release.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "title",
      description: "Press release headline/title.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "Full press release body.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "summary",
      description: "Optional short summary.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetRegions",
      description: "Optional target regions such as US or EU.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["DRAFT_PRESS_RELEASE"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const rec = readOpt(options);
    const title = readString(rec, "title", "headline");
    const body = readString(rec, "body", "content", "copy");
    if (!title || !body) {
      await callback?.({
        text: MISSING_DRAFT_INPUT,
        actions: ["DRAFT_PRESS_RELEASE"],
      });
      return {
        success: false,
        text: "Missing press release title/body.",
        userFacingText: MISSING_DRAFT_INPUT,
        data: { reason: "missing_input" },
      };
    }

    try {
      const { release } = await client.createPressRelease({
        title,
        body,
        summary: readString(rec, "summary"),
        boilerplate: readString(rec, "boilerplate"),
        targetRegions: readStringArray(rec, "targetRegions"),
        idempotencyKey: readString(rec, "idempotencyKey"),
      });
      const reply = `Drafted press release "${release.title}" (${release.status}).`;
      await callback?.({ text: reply, actions: ["DRAFT_PRESS_RELEASE"] });
      return {
        success: true,
        text: `Drafted press release ${release.title}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { release: { id: release.id, title: release.title } },
      };
    } catch (err) {
      logger.warn(
        `[DRAFT_PRESS_RELEASE] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't draft that press release right now.";
      await callback?.({ text: msg, actions: ["DRAFT_PRESS_RELEASE"] });
      return {
        success: false,
        text: "Failed to draft press release.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "draft a press release for our launch" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Drafted press release "Launch" (draft).',
          actions: ["DRAFT_PRESS_RELEASE"],
        },
      },
    ],
  ],
};

export const listPressReleasesAction: Action = {
  name: "LIST_PRESS_RELEASES",
  similes: ["LIST_PR_DRAFTS", "SHOW_PRESS_RELEASES", "MY_PRESS_RELEASES"],
  description:
    "List the user's Eliza Cloud press releases and statuses. Use before choosing a draft to submit or edit.",
  descriptionCompressed: "List press release drafts/submissions.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["LIST_PRESS_RELEASES"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    try {
      const { releases } = await client.listPressReleases();
      const reply =
        releases.length === 0
          ? "You don't have any press releases yet."
          : `You have ${releases.length} press release(s):\n${releases
              .map(releaseLine)
              .join("\n")}`;
      await callback?.({ text: reply, actions: ["LIST_PRESS_RELEASES"] });
      return {
        success: true,
        text: `Listed ${releases.length} press releases.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { count: releases.length },
      };
    } catch (err) {
      logger.warn(
        `[LIST_PRESS_RELEASES] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't list your press releases right now.";
      await callback?.({ text: msg, actions: ["LIST_PRESS_RELEASES"] });
      return {
        success: false,
        text: "Failed to list press releases.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "show my press releases" } },
      {
        name: "{{agent}}",
        content: {
          text: "You have 1 press release(s):\n• Launch — draft — updated 2026-07-03",
          actions: ["LIST_PRESS_RELEASES"],
        },
      },
    ],
  ],
};

export const submitPressReleaseAction: Action = {
  name: "SUBMIT_PRESS_RELEASE",
  similes: ["SUBMIT_PR", "DISTRIBUTE_PRESS_RELEASE", "SEND_PRESS_RELEASE"],
  description:
    "Submit a press release for paid/provider-backed distribution. Requires explicit confirmation before calling the Cloud submit route.",
  descriptionCompressed:
    "Submit a press release for provider-backed distribution; requires confirm.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "releaseId",
      description: "Press release id to submit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "title",
      description: "Press release title to resolve.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up: true confirms the pending submit, false cancels.",
      required: false,
      schema: { type: "boolean" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["SUBMIT_PRESS_RELEASE"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const roomId = confirmationRoomId(runtime, message);
    const confirmation = readStructuredConfirmation(options);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomId,
      "SUBMIT_PRESS_RELEASE",
    );

    if (confirmation !== null) {
      if (!pending) {
        await callback?.({
          text: NO_PENDING_MESSAGE,
          actions: ["SUBMIT_PRESS_RELEASE"],
        });
        return {
          success: false,
          text: "No pending press release submit.",
          userFacingText: NO_PENDING_MESSAGE,
          data: { reason: "no_pending_confirmation" },
        };
      }

      if (confirmation === false) {
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        await callback?.({
          text: CANCELED_MESSAGE,
          actions: ["SUBMIT_PRESS_RELEASE"],
        });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { submitted: false, canceled: true },
        };
      }

      const conflict = conflictingConfirmTarget(
        options,
        { id: pending.metadata.appId, name: pending.metadata.appName },
        ["releaseId", "pressReleaseId", "title", "name"],
      );
      if (conflict !== null) {
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        const msg = confirmTargetMismatchMessage(
          conflict,
          "press release submission",
          pending.metadata.appName,
        );
        await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
        return {
          success: false,
          text: `Confirm named "${conflict}" but pending submit was ${pending.metadata.appName}; refused.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            reason: "confirm_target_mismatch",
            submitted: false,
            requested: conflict,
            pendingTarget: {
              id: pending.metadata.appId,
              name: pending.metadata.appName,
            },
          },
        };
      }

      if (pendingExpired(pending)) {
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        const msg =
          `That submit request for ${pending.metadata.appName} is more than ${Math.round(CONFIRM_TTL_MS / 60000)} minutes old, so I didn't submit anything. ` +
          `Ask me to submit it again and I'll re-confirm the details.`;
        await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
        return {
          success: false,
          text: `Pending submit for ${pending.metadata.appName} expired.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: { reason: "confirmation_expired", submitted: false },
        };
      }

      try {
        const result = await client.submitPressRelease(pending.metadata.appId, {
          idempotencyKey: `press-release-submit-${pending.taskId}`,
        });
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        const reply = `Submitted press release "${result.release?.title ?? pending.metadata.appName}" for distribution.`;
        await callback?.({ text: reply, actions: ["SUBMIT_PRESS_RELEASE"] });
        return {
          success: true,
          text: `Submitted press release ${pending.metadata.appName}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            submitted: true,
            release: result.release,
            distribution: result.distribution,
          },
        };
      } catch (err) {
        const info = cloudErrorInfo(err);
        logger.warn(
          `[SUBMIT_PRESS_RELEASE] submit failed (${info.status ?? "transport"}/${info.code ?? "-"}): ${info.message}`,
        );
        if (info.code === "PR_PROVIDER_NOT_CONFIGURED") {
          await deleteCloudAppConfirmation(runtime, pending.taskId);
          const msg =
            "Cloud can't submit press releases yet because no press distribution provider is configured. Nothing was submitted or billed.";
          await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
          return {
            success: false,
            text: "Press distribution provider is not configured.",
            userFacingText: msg,
            verifiedUserFacing: true,
            error: err instanceof Error ? err : new Error(String(err)),
            data: {
              reason: "provider_not_configured",
              submitted: false,
            },
          };
        }
        if (info.status !== null && info.status < 500) {
          await deleteCloudAppConfirmation(runtime, pending.taskId);
          const msg = `I couldn't submit that press release: ${info.message}. Nothing was submitted.`;
          await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
          return {
            success: false,
            text: `Press release submit rejected: ${info.message}`,
            userFacingText: msg,
            error: err instanceof Error ? err : new Error(String(err)),
            data: { reason: "rejected", submitted: false },
          };
        }
        await markCloudAppConfirmationRecovery(runtime, pending);
        const msg = `I couldn't confirm whether Cloud accepted the submit for "${pending.metadata.appName}". I kept the same confirmation pending so a retry uses the same idempotency key.`;
        await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
        return {
          success: false,
          text: "Press release submit outcome is unknown.",
          userFacingText: msg,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { reason: "unknown_submit_state", submitted: false },
        };
      }
    }

    if (pending) {
      const msg = `I already have a pending submit confirmation for "${pending.metadata.appName}". Reply confirm to submit it, or cancel.`;
      await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: false,
        text: "Pending press release submit already exists.",
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          reason: "pending_confirmation_exists",
          confirmationRequired: true,
        },
      };
    }

    const reference = releaseReference(message, options);
    const resolved = await resolveRelease(client, reference);
    if (!resolved.release) {
      const msg =
        resolved.ambiguous && resolved.ambiguous.length > 0
          ? `Which press release? I found multiple matches: ${resolved.ambiguous.join(", ")}.`
          : resolved.available.length === 0
            ? "You don't have any press releases yet. Draft one first, then I can submit it."
            : `Which press release? Your drafts are: ${resolved.available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: false,
        text: "Press release not found.",
        userFacingText: msg,
        data: {
          reason: resolved.ambiguous ? "ambiguous" : "not_found",
          available: resolved.available,
        },
      };
    }

    await persistCloudAppConfirmation(runtime, {
      roomId,
      action: "SUBMIT_PRESS_RELEASE",
      appId: resolved.release.id,
      appName: resolved.release.title,
      intentCreatedAt: new Date().toISOString(),
    });
    const msg =
      `Submitting "${resolved.release.title}" may use a paid press distribution provider. ` +
      "Reply confirm to submit it, or cancel.";
    await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
    return {
      success: false,
      text: `Confirmation required to submit press release ${resolved.release.title}.`,
      userFacingText: msg,
      verifiedUserFacing: true,
      data: {
        confirmationRequired: true,
        submitted: false,
        release: { id: resolved.release.id, title: resolved.release.title },
      },
    };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "submit the Launch PR" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Submitting "Launch" may use a paid press distribution provider. Reply confirm to submit it, or cancel.',
          actions: ["SUBMIT_PRESS_RELEASE"],
        },
      },
    ],
  ],
};
