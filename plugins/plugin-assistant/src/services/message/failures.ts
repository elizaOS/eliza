/** Builds user-visible failure responses while preserving complete dialogue context and explicit missing-provider failures. */

import type {
  Content,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import {
  addHeader,
  buildCharacterStyleDirections,
  buildFailureReplyPrompt,
  conversationMessagesHeader,
  getRecentMessagesData,
  INSUFFICIENT_CREDITS_REPLY,
  isAuthError,
  isInsufficientCreditsError,
  isModelProviderRetryBudgetExhaustedError,
  isProviderSchemaRejection,
  isRateLimitError,
  ModelType,
  type StructuredFailureCause,
  sanitizeUserVisibleModelOutput,
  stripReasoningBlocks,
} from "@elizaos/core";
import type { FailureReplyAttempt, StrategyResult } from "./contracts.js";
import { labelHistorySources } from "./history-wire.ts";
import { reportRejectedUserVisibleModelOutput } from "./stage1-output.ts";
import { hasTextGenerationHandler } from "./trajectory-stages.ts";

// Permanent causes never fall back to the retry-inviting transient line.
const CHARACTER_FAILURE_TEMPLATES: Record<
  StructuredFailureCause,
  readonly string[]
> = {
  missing_capability: ["missingCapabilityFailureReply"],
  planner_exhaustion: [
    "plannerExhaustionFailureReply",
    "transientFailureReply",
  ],
  context_overflow: ["contextOverflowFailureReply"],
  handler_error: ["transientFailureReply"],
  persistence_error: ["transientFailureReply"],
  transient: ["transientFailureReply"],
};

// Voice-neutral lines for a character that defines no template for the cause.
const GENERIC_FAILURE_REPLY =
  "Something went wrong on my end. Please try again.";
const DEFAULT_FAILURE_REPLY: Record<StructuredFailureCause, string> = {
  missing_capability:
    "I can't do that here right now - it needs a capability that isn't available in this setup.",
  planner_exhaustion: "I ran out of attempts before I could finish that.",
  // Retrying the identical request cannot succeed, so ask for a smaller one.
  context_overflow:
    "That needed more context than my model can take in one call - try a smaller range or a narrower request.",
  handler_error: GENERIC_FAILURE_REPLY,
  persistence_error: GENERIC_FAILURE_REPLY,
  transient: GENERIC_FAILURE_REPLY,
};

/** A character template, authored as a string or as a function of state. */
export function characterTemplate(
  runtime: IAgentRuntime,
  state: State,
  name: string,
): string | undefined {
  const tmpl = runtime.character.templates?.[name];
  return typeof tmpl === "function" ? tmpl({ state }) : tmpl;
}

/** The character's own line for a failure cause; undefined leaves the caller's built-in default. */
export function characterFailureTemplate(
  runtime: IAgentRuntime,
  state: State,
  cause: StructuredFailureCause,
): string | undefined {
  for (const name of CHARACTER_FAILURE_TEMPLATES[cause]) {
    const text = characterTemplate(runtime, state, name);
    if (text) return text;
  }
  return undefined;
}

/** An apology cannot repair provider rejection or an exhausted rate-limit window. */
function terminalProviderFailure(
  error: unknown,
): FailureReplyAttempt | undefined {
  if (isInsufficientCreditsError(error)) return { kind: "creditsExhausted" };
  if (isAuthError(error)) return { kind: "authFailed" };
  if (isRateLimitError(error)) return { kind: "rateLimited" };
  if (isProviderSchemaRejection(error)) return { kind: "schemaRejected" };
  return undefined;
}

export class MessageFailures {
  resolveRecentMessagesForFailureReply(state: State, message: Memory): string {
    if (
      typeof state.values?.recentMessages === "string" &&
      state.values.recentMessages.trim().length > 0
    ) {
      const recentMessages = state.values.recentMessages;
      const entries =
        state.data?.providers?.RECENT_MESSAGES?.data?.formattedMessageSegments;
      if (
        Array.isArray(entries) &&
        entries.every((entry) => typeof entry === "string")
      ) {
        const header = conversationMessagesHeader(
          getRecentMessagesData(state).length,
        );
        // Only the exact provider rendering may use entry references. Custom,
        // stale or incomplete formatting retains the full legacy string.
        if (addHeader(header, entries.join("\n")) === recentMessages) {
          const segments = entries.map((content, index) => ({
            id: `failure-history:${index}`,
            content,
            stable: false,
          }));
          const encoded = labelHistorySources(
            segments,
            new Map(
              segments.map((segment, index) => [segment.id, `h${index + 1}`]),
            ),
            "referenced",
          );
          const referenced = addHeader(
            header,
            encoded.map((segment) => segment.content).join("\n"),
          );
          if (referenced.length < recentMessages.length) return referenced;
        }
      }
      return recentMessages;
    }
    if (typeof state.text === "string" && state.text.trim().length > 0) {
      return state.text;
    }
    if (typeof message.content.text === "string") {
      return message.content.text;
    }
    return "(unavailable)";
  }

  async generateFailureReplyText(
    runtime: IAgentRuntime,
    prompt: string,
    stage: string,
  ): Promise<FailureReplyAttempt> {
    let sawRateLimit = false;
    for (const modelType of [
      ModelType.TEXT_LARGE,
      ModelType.RESPONSE_HANDLER,
      ModelType.TEXT_SMALL,
      ModelType.TEXT_NANO,
    ] as const) {
      try {
        // Bound reasoning on reasoning models (#16394): the failure-reply
        // path is a plain-text fallback that must stay low-latency, so every
        // slot carries thinking="off" like Stage-1, the evaluator, and every
        // planner iteration. Without it a drained/failed turn can still spend
        // hundreds of hidden reasoning tokens before producing visible text.
        const response = await runtime.useModel(modelType, {
          prompt,
          providerOptions: { eliza: { thinking: "off" } },
        });
        if (typeof response !== "string") {
          continue;
        }

        const cleaned = stripReasoningBlocks(response);
        const visible = sanitizeUserVisibleModelOutput(cleaned);
        if (visible.kind === "text" && visible.format === "plain") {
          return { kind: "text", value: visible.text };
        }
        if (visible.kind === "empty") {
          continue;
        }

        // error-policy:J3 the fallback prompt requires plain text. A
        // typed invalid/control result advances to the next model slot
        // and is reported instead of masquerading as a valid reply.
        reportRejectedUserVisibleModelOutput({
          runtime,
          scope: "MessageService.generateFailureReplyText",
          code: "FAILURE_REPLY_INVALID_MODEL_OUTPUT",
          message:
            "Failure-reply model violated the plain-text output contract",
          stage,
          output: visible,
          context: { modelType },
        });
      } catch (error) {
        // error-policy:J1 this model-fallback boundary translates
        // provider failures into the typed outcome the caller renders.
        // If the runtime reports no LLM provider is configured at all,
        // no further model attempts will succeed. Surface the actionable
        // hint instead of the generic transient-failure message. See
        // elizaOS/eliza#7203.
        if (
          error instanceof Error &&
          error.name === "NoModelProviderConfiguredError"
        ) {
          return { kind: "noProvider" };
        }
        // Eliza Cloud already spent its complete in-handler warming
        // budget. Starting the next failure-reply model slot would create a
        // fresh useModel dispatch and repay that same provider budget (up to
        // four times) before falling back to the canned reply. Treat the
        // typed exhaustion as terminal for this fallback loop while
        // preserving any more actionable sticky failure seen earlier.
        if (isModelProviderRetryBudgetExhaustedError(error)) {
          runtime.logger.warn(
            {
              src: "service:message",
              stage,
              modelType,
              error: error instanceof Error ? error.message : String(error),
            },
            "Structured failure reply stopped after Cloud warming exhaustion",
          );
          if (sawRateLimit) return { kind: "rateLimited" };
          return { kind: "text", value: "" };
        }
        // The rate-limit flag tracks the most recent slot's cause:
        // reporting "rate-limited" only when the LAST attempted slot was
        // a 429 avoids misleading the user in a mixed-failure run.
        // Credits are classified before rate limits below: a 429 *with*
        // billing context is a drained balance ("top up"), not a
        // transient throttle ("try again in a few seconds").
        sawRateLimit = isRateLimitError(error);
        runtime.logger.warn(
          {
            src: "service:message",
            stage,
            modelType,
            error: error instanceof Error ? error.message : String(error),
          },
          "Structured failure reply generation failed for model",
        );
        const terminal = terminalProviderFailure(error);
        if (terminal) return terminal;
      }
    }
    // When the final cause was provider rate-limiting (429), tell the user
    // that plainly instead of the opaque generic message — the honest
    // signal is "try again shortly", not "something broke".
    if (sawRateLimit) {
      return { kind: "rateLimited" };
    }
    return { kind: "text", value: "" };
  }

  async buildStructuredFailureReply(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    responseId: UUID,
    stage: string,
    cause: StructuredFailureCause = "transient",
    initialError?: unknown,
  ): Promise<StrategyResult> {
    // Short-circuit when no LLM provider is configured at all. The fallback
    // model loop below would just throw `NoModelProviderConfiguredError` for
    // every model type and surface a misleading generic failure to the user.
    // Instead, render an actionable hint directly. See elizaOS/eliza#7203.
    if (!hasTextGenerationHandler(runtime)) {
      return this.buildNoModelProviderReply(
        runtime,
        message,
        state,
        responseId,
        stage,
      );
    }

    // Preserve explicit action/persistence failures: their authorization errors
    // do not establish that the model provider is unavailable. For a provider
    // rejection, render the existing typed/template reply without another call
    // or rebuilding complete failure history merely to ask for an apology.
    // A terminal planner budget has already stopped execution. Another LLM
    // call cannot resume it and may exceed the very token budget that ended
    // the turn. Settled effects are handled by the caller before this path.
    const attempt: FailureReplyAttempt =
      (cause === "planner_exhaustion"
        ? { kind: "text", value: "" }
        : undefined) ??
      (cause === "transient"
        ? terminalProviderFailure(initialError)
        : undefined) ??
      (await this.generateFailureReplyText(
        runtime,
        // The bare prompt gets only the character's system and bio. Carry the
        // same chat directions every message-pipeline call has, so "stay in
        // character" names a concrete voice instead of a default one.
        [
          buildCharacterStyleDirections({ character: runtime.character }),
          buildFailureReplyPrompt(
            this.resolveRecentMessagesForFailureReply(state, message),
            cause,
          ),
        ]
          .filter(Boolean)
          .join("\n\n"),
        stage,
      ));
    if (attempt.kind === "noProvider") {
      return this.buildNoModelProviderReply(
        runtime,
        message,
        state,
        responseId,
        stage,
      );
    }

    let replyText = attempt.kind === "text" ? attempt.value : "";
    if (!replyText) {
      // Last-ditch fallback when every model call above also failed.
      // Voice-neutral so any character can ship this default; characters
      // can override with their own phrasing via
      // character.templates.transientFailureReply (or
      // rateLimitedReply / insufficientCreditsReply for the specific
      // cases).
      if (attempt.kind === "creditsExhausted") {
        replyText =
          characterTemplate(runtime, state, "insufficientCreditsReply") ||
          INSUFFICIENT_CREDITS_REPLY;
      } else if (attempt.kind === "rateLimited") {
        replyText =
          characterTemplate(runtime, state, "rateLimitedReply") ||
          "My model provider is rate-limiting me right now — give it a few seconds and try again.";
      } else if (attempt.kind === "authFailed") {
        replyText =
          characterTemplate(runtime, state, "authFailedReply") ||
          "The configured AI provider rejected access. Check its API key and account permissions, then try again.";
      } else if (attempt.kind === "schemaRejected") {
        replyText =
          "The AI provider rejected the request format, so I couldn’t finish. This needs a configuration or code fix before retrying.";
      } else {
        replyText =
          characterFailureTemplate(runtime, state, cause) ||
          DEFAULT_FAILURE_REPLY[cause];
      }
    }

    replyText = replyText.trim();

    // Preserve the terminal cause at the delivery boundary. Provider failures
    // encountered while generating the apology take precedence because the
    // canned reply describes that condition. Capability, action, persistence,
    // auth, and credit failures remain stable until their cause changes;
    // throttling, planner exhaustion, and generic infrastructure failures can
    // be retried without presenting a durable success record.
    const failureKind =
      attempt.kind === "creditsExhausted"
        ? "insufficient_credits"
        : attempt.kind === "rateLimited"
          ? "rate_limited"
          : attempt.kind === "authFailed" || attempt.kind === "schemaRejected"
            ? "provider_issue"
            : cause === "transient"
              ? "transient_failure"
              : cause;
    const responseContent: Content = {
      thought: `Handle a ${cause} reply failure during ${stage}.`,
      actions: ["REPLY"],
      failureKind,
      elizaSyntheticFailure: true,
      transient:
        failureKind === "transient_failure" || failureKind === "rate_limited",
      doNotPersist: true,
      text: replyText,
      responseId,
    };

    const responseMessages: Memory[] = [
      {
        id: responseId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: responseContent,
        roomId: message.roomId,
        createdAt: Date.now(),
      },
    ];

    return {
      responseContent,
      responseMessages,
      state,
      mode: "simple",
      terminalFailure: {
        kind: failureKind,
        transient: responseContent.transient === true,
        message: replyText,
      },
    };
  }

  /**
   * Render the no-LLM-provider hint as a chat reply. Used when `useModel`
   * throws `NoModelProviderConfiguredError`, which means no provider plugin
   * is registered and no fallback model call will ever succeed. The user
   * sees an actionable message instead of a generic transient-failure
   * template. See elizaOS/eliza#7203.
   */
  buildNoModelProviderReply(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    responseId: UUID,
    stage: string,
  ): StrategyResult {
    const replyText =
      characterTemplate(runtime, state, "noModelProviderReply") ||
      "This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).";

    runtime.logger.warn(
      { src: "service:message", stage },
      "No LLM provider configured; rendering setup hint reply",
    );

    const responseContent: Content = {
      thought: `No LLM provider configured during ${stage}.`,
      actions: ["REPLY"],
      failureKind: "no_provider",
      text: replyText,
      responseId,
    };

    const responseMessages: Memory[] = [
      {
        id: responseId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: responseContent,
        roomId: message.roomId,
        createdAt: Date.now(),
      },
    ];

    return {
      responseContent,
      responseMessages,
      state,
      mode: "simple",
      terminalFailure: {
        kind: "no_provider",
        transient: false,
        message: replyText,
      },
    };
  }
}
