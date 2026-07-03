/**
 * Press release actions (#11819).
 *
 * The submit action never calls the provider-backed route unless the planner
 * passes a structured confirmation. The route also enforces that guard, so the
 * connector and API layers both fail closed before any paid distribution path.
 */

import type {
  CreatePressReleaseInput,
  ElizaCloudClient,
  JsonObject,
  PressReleaseDto,
  PressReleaseTargetAudience,
  SubmitPressReleaseInput,
} from "@elizaos/cloud-sdk";
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
  resolveCloudSiteBaseUrl,
} from "../client.js";
import { actionParams, cloudErrorInfo } from "../domain-intent.js";
import { readStructuredConfirmation } from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet - no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";

const RELEASE_ID_KEYS = ["releaseId", "pressReleaseId", "id"] as const;
const RELEASE_REFERENCE_KEYS = [
  "release",
  "releaseTitle",
  "title",
  "name",
  "query",
] as const;

function readString(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readStringList(
  params: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      const list = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (list.length > 0) return list;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const list = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (list.length > 0) return list;
    }
  }
  return undefined;
}

function readJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function readTargetAudience(
  value: unknown,
): PressReleaseTargetAudience | undefined {
  const rec = readJsonObject(value);
  if (!rec) return undefined;
  return {
    niches: readStringList(rec, ["niches"]),
    regions: readStringList(rec, ["regions"]),
    languages: readStringList(rec, ["languages"]),
    outletTypes: readStringList(rec, ["outletTypes"]),
  };
}

function readDraftInput(options: unknown): {
  input: CreatePressReleaseInput | null;
  missing: string[];
} {
  const params = actionParams(options);
  const title = readString(params, ["title", "releaseTitle", "headline"]);
  const body = readString(params, ["body", "content", "copy"]);
  const missing = [...(title ? [] : ["title"]), ...(body ? [] : ["body"])];
  if (!title || !body) return { input: null, missing };

  const input: CreatePressReleaseInput = {
    title,
    body,
    summary: readString(params, ["summary"]),
    boilerplate: readString(params, ["boilerplate"]),
    targetAudience: readTargetAudience(params.targetAudience),
    targetRegions: readStringList(params, ["targetRegions", "regions"]),
    embargoAt:
      typeof params.embargoAt === "string" || params.embargoAt === null
        ? params.embargoAt
        : undefined,
    idempotencyKey: readString(params, ["idempotencyKey"]),
    metadata: readJsonObject(params.metadata),
  };
  if (Array.isArray(params.assets)) {
    input.assets = params.assets
      .map(readJsonObject)
      .filter((asset): asset is JsonObject => Boolean(asset))
      .map((asset) => ({
        url: typeof asset.url === "string" ? asset.url : "",
        mimeType:
          typeof asset.mimeType === "string" ? asset.mimeType : undefined,
        label: typeof asset.label === "string" ? asset.label : undefined,
      }));
  }
  return { input, missing: [] };
}

function formatReleaseLine(release: PressReleaseDto): string {
  const day = release.created_at?.slice(0, 10);
  return `- ${release.title} (${release.status}${day ? `, ${day}` : ""})`;
}

function pressDashboardUrl(runtime: IAgentRuntime, releaseId?: string): string {
  const base = `${resolveCloudSiteBaseUrl(runtime)}/dashboard/marketing/pr`;
  return releaseId ? `${base}/${encodeURIComponent(releaseId)}` : base;
}

interface ReleaseResolution {
  release: PressReleaseDto | null;
  releases: PressReleaseDto[];
  ambiguous?: string[];
}

async function resolvePressRelease(
  client: ElizaCloudClient,
  message: Memory,
  options: unknown,
): Promise<ReleaseResolution> {
  const params = actionParams(options);
  const id = readString(params, RELEASE_ID_KEYS);
  if (id) {
    try {
      const { release } = await client.getPressRelease(id);
      return { release, releases: [release] };
    } catch {
      const { releases } = await client.listPressReleases();
      return { release: null, releases };
    }
  }

  const { releases } = await client.listPressReleases();
  const reference =
    readString(params, RELEASE_REFERENCE_KEYS) ??
    (message.content?.text ?? "").trim();
  const match = matchByReference(releases, reference, (release) => ({
    id: release.id,
    names: [release.title],
  }));
  return {
    release: match.item,
    releases,
    ambiguous:
      match.item === null && match.candidates.length > 1
        ? match.candidates.map((release) => release.title)
        : undefined,
  };
}

function notFoundReply(resolution: ReleaseResolution): string {
  if (resolution.ambiguous?.length) {
    return `Which press release? I found several matches: ${resolution.ambiguous.join(", ")}.`;
  }
  if (resolution.releases.length === 0) {
    return "You don't have any press release drafts yet.";
  }
  return `Which press release? Your releases are: ${resolution.releases
    .map((release) => release.title)
    .join(", ")}.`;
}

function providerGateMessage(err: unknown): {
  text: string;
  reason: string;
  noChargeAttempted: boolean;
} {
  const info = cloudErrorInfo(err);
  const noChargeAttempted =
    info.code === "no_provider_configured" ||
    info.code === "provider_not_implemented" ||
    info.code === "confirmation_required";
  return {
    text: noChargeAttempted
      ? `${info.message} No charge was made.`
      : info.message,
    reason: info.code ?? "error",
    noChargeAttempted,
  };
}

export const createPressReleaseDraftAction: Action = {
  name: "CREATE_PRESS_RELEASE_DRAFT",
  similes: ["DRAFT_PRESS_RELEASE", "CREATE_PR_DRAFT", "WRITE_PRESS_RELEASE"],
  description:
    "Create a draft press release in Eliza Cloud. Use when the user wants to write or save a press release draft before distribution.",
  descriptionCompressed: "Create a draft press release.",
  contexts: ["settings", "apps", "marketing"],
  contextGate: { anyOf: ["settings", "apps", "marketing"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "title",
      description: "Press release title.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "Press release body copy.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "summary",
      description: "Optional short summary.",
      required: false,
      schema: { type: "string" },
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
        actions: ["CREATE_PRESS_RELEASE_DRAFT"],
      });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const { input, missing } = readDraftInput(options);
    if (!input) {
      const msg = `I need a press release ${missing.join(" and ")} before I can create the draft.`;
      await callback?.({
        text: msg,
        actions: ["CREATE_PRESS_RELEASE_DRAFT"],
      });
      return {
        success: false,
        text: "Missing press release fields.",
        userFacingText: msg,
        data: { reason: "missing_fields", missing },
      };
    }

    try {
      const { release } = await client.createPressRelease(input);
      const reply = `Created press release draft "${release.title}" (${release.status}). Review it here: ${pressDashboardUrl(runtime, release.id)}`;
      await callback?.({
        text: reply,
        actions: ["CREATE_PRESS_RELEASE_DRAFT"],
      });
      return {
        success: true,
        text: `Created press release draft ${release.title}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { release, dashboardUrl: pressDashboardUrl(runtime, release.id) },
      };
    } catch (err) {
      logger.warn(
        `[CREATE_PRESS_RELEASE_DRAFT] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't create that press release draft right now.";
      await callback?.({
        text: msg,
        actions: ["CREATE_PRESS_RELEASE_DRAFT"],
      });
      return {
        success: false,
        text: "Failed to create press release draft.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};

export const listPressReleasesAction: Action = {
  name: "LIST_PRESS_RELEASES",
  similes: ["SHOW_PRESS_RELEASES", "LIST_PR_DRAFTS", "PRESS_RELEASE_STATUS"],
  description:
    "List the user's Eliza Cloud press releases and statuses. Use when the user asks for press release drafts or distribution status.",
  descriptionCompressed: "List press releases and statuses.",
  contexts: ["settings", "apps", "marketing"],
  contextGate: { anyOf: ["settings", "apps", "marketing"] },
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
          ? "You don't have any press release drafts yet."
          : `You have ${releases.length} press release(s):\n${releases
              .map(formatReleaseLine)
              .join("\n")}`;
      await callback?.({ text: reply, actions: ["LIST_PRESS_RELEASES"] });
      return {
        success: true,
        text: `Listed ${releases.length} press releases.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { count: releases.length, releases },
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
};

export const submitPressReleaseAction: Action = {
  name: "SUBMIT_PRESS_RELEASE",
  similes: [
    "DISTRIBUTE_PRESS_RELEASE",
    "SEND_PRESS_RELEASE",
    "SUBMIT_PR",
    "PUBLISH_PRESS_RELEASE",
  ],
  description:
    "Submit an existing press release through the configured PR distribution provider. PAID/PROVIDER-BACKED: requires explicit structured confirmation before any submit call.",
  descriptionCompressed:
    "Submit a press release through the PR provider after confirmation.",
  contexts: ["settings", "apps", "marketing"],
  contextGate: { anyOf: ["settings", "apps", "marketing"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "releaseId",
      description: "Press release id to submit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "release",
      description: "Press release title/reference to resolve.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up: true confirms provider-backed distribution, false cancels.",
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

    const confirmation = readStructuredConfirmation(options);
    if (confirmation === false) {
      const msg = "Okay, I won't submit that press release.";
      await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: true,
        text: "Press release submission cancelled.",
        userFacingText: msg,
        verifiedUserFacing: true,
        data: { cancelled: true },
      };
    }

    const resolution = await resolvePressRelease(client, message, options);
    if (!resolution.release) {
      const msg = notFoundReply(resolution);
      await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: false,
        text: "Press release not found.",
        userFacingText: msg,
        data: {
          reason: resolution.ambiguous?.length ? "ambiguous" : "not_found",
        },
      };
    }

    if (confirmation !== true) {
      const msg =
        `Submitting "${resolution.release.title}" may incur provider distribution charges. ` +
        "Reply that you confirm submitting this press release to continue.";
      await callback?.({ text: msg, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: true,
        text: "Press release submission requires confirmation.",
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          confirmationRequired: true,
          submitted: false,
          release: {
            id: resolution.release.id,
            title: resolution.release.title,
            status: resolution.release.status,
          },
        },
      };
    }

    try {
      let release = resolution.release;
      if (release.status === "draft") {
        const ready = await client.markPressReleaseReady(release.id);
        release = ready.release;
      }
      const params = actionParams(options);
      const idempotencyKey = readString(params, ["idempotencyKey"]);
      const input: SubmitPressReleaseInput = {
        confirmPaidDistribution: true,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const submitted = await client.submitPressRelease(release.id, input);
      const reply = `Submitted press release "${submitted.release.title}" (${submitted.release.status}).`;
      await callback?.({ text: reply, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: true,
        text: `Submitted press release ${submitted.release.title}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          success: submitted.success,
          release: submitted.release,
          distribution: submitted.distribution ?? null,
        },
      };
    } catch (err) {
      const gate = providerGateMessage(err);
      logger.warn(
        `[SUBMIT_PRESS_RELEASE] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await callback?.({ text: gate.text, actions: ["SUBMIT_PRESS_RELEASE"] });
      return {
        success: false,
        text: "Failed to submit press release.",
        userFacingText: gate.text,
        error: err instanceof Error ? err : new Error(String(err)),
        data: {
          reason: gate.reason,
          noChargeAttempted: gate.noChargeAttempted,
        },
      };
    }
  },
};
