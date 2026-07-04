/**
 * Fallback action parsing + execution helpers.
 *
 * When a response text carries bracketed action tags the planner didn't already
 * execute, these helpers parse the tags and run the matching runtime actions,
 * rewriting their callback output in the character's voice via TEXT_SMALL.
 */

import {
  type Action,
  type ActionParameters,
  type AgentRuntime,
  type Content,
  type createMessageMemory,
  ModelType,
} from "@elizaos/core";
import { extractCompatTextContent } from "./compat-utils.ts";

export type FallbackParsedAction = {
  name: string;
  parameters?: ActionParameters;
};

type RuntimeActionLike = Pick<
  Action,
  "name" | "similes" | "validate" | "handler"
>;

async function rewriteFallbackActionText(args: {
  runtime: AgentRuntime;
  actionName: string;
  text: string;
  content?: Content;
}): Promise<string> {
  const text = args.text.trim();
  if (!text) return args.text;
  const fallback = () => {
    const error =
      typeof args.content?.error === "string" && args.content.error.trim()
        ? ` It reported: ${args.content.error.trim()}`
        : "";
    return `I ran ${args.actionName} and got a result, but I couldn't format the details cleanly here.${error}`;
  };
  if (typeof args.runtime.useModel !== "function") return fallback();

  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: [
        "Rewrite this fallback action output in the assistant character's user-facing voice.",
        'Return strict JSON only: {"response":"..."}.',
        "",
        "Rules:",
        "- Preserve status, IDs, names, URLs, counts, errors, warnings, and next steps.",
        "- Do not expose raw JSON, shell output, schema names, stack traces, or internal action plumbing unless an exact value is necessary.",
        "- Do not claim success if the payload says failed or pending.",
        "- Keep it brief and natural.",
        "",
        `Character: ${JSON.stringify({
          name: args.runtime.character?.name,
          system: args.runtime.character?.system,
          bio: args.runtime.character?.bio,
          style: args.runtime.character?.style,
        })}`,
        `Action: ${JSON.stringify(args.actionName)}`,
        `Payload: ${JSON.stringify(text)}`,
        `Metadata: ${JSON.stringify({
          source: args.content?.source,
          actions: args.content?.actions,
          actionStatus: args.content?.actionStatus,
          error: args.content?.error,
        })}`,
      ].join("\n"),
      maxTokens: 260,
      providerOptions: { eliza: { thinking: "off" } },
    });
    const parsed = JSON.parse(String(raw).trim()) as { response?: unknown };
    return typeof parsed.response === "string" && parsed.response.trim()
      ? parsed.response.trim()
      : fallback();
  } catch (err) {
    args.runtime.logger.debug(
      {
        src: "eliza-api",
        action: args.actionName,
        err: err instanceof Error ? err.message : String(err),
      },
      "[eliza-api] Fallback action voice rewrite failed",
    );
    return fallback();
  }
}

const LIFEOPS_PUBLIC_MODULE: string = "@elizaos/plugin-personal-assistant";

let ownerBlockFallbackPromise: Promise<RuntimeActionLike | null> | null = null;

async function resolveBuiltInFallbackAction(
  actionName: string,
): Promise<RuntimeActionLike | null> {
  if (actionName !== "BLOCK") {
    return null;
  }

  if (!ownerBlockFallbackPromise) {
    ownerBlockFallbackPromise = import(/* @vite-ignore */ LIFEOPS_PUBLIC_MODULE)
      .then((mod) => mod as Record<string, RuntimeActionLike | undefined>)
      .then((mod) => mod.websiteBlockAction ?? null)
      .catch(() => null);
  }

  return ownerBlockFallbackPromise;
}

export function parseFallbackActionBlocks(
  value: unknown,
  _responseText?: string,
): FallbackParsedAction[] {
  const rawValues: string[] = [];
  if (typeof value === "string") {
    rawValues.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        rawValues.push(entry);
      }
    }
  }

  const parsed: FallbackParsedAction[] = [];
  for (const raw of rawValues) {
    const normalized = raw.trim().toUpperCase();
    if (/^[A-Z0-9_]+$/.test(normalized)) {
      parsed.push({ name: normalized, parameters: {} });
    }
  }

  return parsed;
}

export async function executeFallbackParsedActions(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  parsedActions: FallbackParsedAction[],
  appendIncomingText: (incoming: string) => void,
  onActionCallback: (actionTag: string, hasText: boolean) => void,
  options?: {
    getCurrentText?: () => string;
    onCallbackText?: (incoming: string) => void;
  },
): Promise<void> {
  const runtimeActions = Array.isArray(
    (runtime as { actions?: unknown[] }).actions,
  )
    ? ((runtime as { actions: unknown[] }).actions as RuntimeActionLike[])
    : [];

  const lookup = new Map<string, RuntimeActionLike>();
  for (const action of runtimeActions) {
    if (typeof action.name === "string")
      lookup.set(action.name.toUpperCase(), action);
    if (!Array.isArray(action.similes)) continue;
    for (const alias of action.similes) {
      if (typeof alias === "string") lookup.set(alias.toUpperCase(), action);
    }
  }

  for (const parsed of parsedActions) {
    if (
      parsed.name === "REPLY" ||
      parsed.name === "NONE" ||
      parsed.name === "IGNORE"
    ) {
      continue;
    }
    // Prefer the built-in self-control actions for fallback execution.
    // The runtime-registered wrappers can gate these too aggressively during
    // early web-chat ownership bootstrap, while the built-in actions still
    // enforce the actual self-control OWNER/ADMIN check.
    const action =
      (await resolveBuiltInFallbackAction(parsed.name)) ??
      lookup.get(parsed.name);
    if (!action || typeof action.handler !== "function") continue;

    if (typeof action.validate === "function") {
      const valid = await Promise.resolve(
        action.validate(runtime, message, undefined),
      );
      if (!valid) continue;
    }

    let callbackSeen = false;
    const actionResult = await Promise.resolve(
      action.handler(
        runtime,
        message,
        undefined,
        { parameters: parsed.parameters ?? {} },
        async (content: unknown) => {
          const contentRecord =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const actionTag =
            typeof contentRecord.action === "string"
              ? contentRecord.action
              : parsed.name;
          const chunk =
            contentRecord && typeof contentRecord === "object"
              ? extractCompatTextContent(contentRecord as Content)
              : "";
          callbackSeen = true;
          onActionCallback(actionTag, Boolean(chunk));
          if (chunk) {
            const voicedChunk = await rewriteFallbackActionText({
              runtime,
              actionName: actionTag,
              text: chunk,
              content: contentRecord as Content,
            });
            (options?.onCallbackText ?? appendIncomingText)(voicedChunk);
          }
          return [];
        },
        [],
      ),
    );
    if (!callbackSeen) {
      const currentText = options?.getCurrentText?.() ?? "";
      const actionSucceeded =
        actionResult &&
        typeof actionResult === "object" &&
        "success" in actionResult
          ? actionResult.success === true
          : undefined;
      const fallbackText =
        actionResult && typeof actionResult === "object"
          ? typeof actionResult.text === "string"
            ? actionResult.text
            : ""
          : "";
      const currentTextLooksLikeCompletedWebsiteBlock =
        /\b(started|starting|blocked|blocking now|website block is active|block is active)\b/i.test(
          currentText,
        );
      const shouldSuppressSuccessFallbackText =
        parsed.name === "BLOCK" &&
        actionSucceeded === true &&
        currentTextLooksLikeCompletedWebsiteBlock;
      if (fallbackText) {
        onActionCallback(parsed.name, !shouldSuppressSuccessFallbackText);
        if (!shouldSuppressSuccessFallbackText) {
          const voicedFallbackText = await rewriteFallbackActionText({
            runtime,
            actionName: parsed.name,
            text: fallbackText,
          });
          appendIncomingText(
            currentText.trim().length > 0
              ? `\n\n${voicedFallbackText}`
              : voicedFallbackText,
          );
        }
      }
    }
  }
}
