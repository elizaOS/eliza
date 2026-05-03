import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import type { z } from "zod";
import type {
  CanonicalHandlerResult,
  ValidateOutcome,
} from "../wallet/pending.js";

function mergeParameters(
  message: Memory,
  state?: State,
  options?: HandlerOptions,
): Record<string, unknown> | undefined {
  if (options?.parameters && typeof options.parameters === "object") {
    return options.parameters as Record<string, unknown>;
  }
  const st = state as Record<string, unknown> | undefined;
  if (
    st?.walletCanonicalParams &&
    typeof st.walletCanonicalParams === "object"
  ) {
    return st.walletCanonicalParams as Record<string, unknown>;
  }
  const c = message.content;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    return c as Record<string, unknown>;
  }
  return undefined;
}

function toActionResult<T>(result: CanonicalHandlerResult<T>): ActionResult {
  if (result.ok) {
    return {
      success: true,
      text:
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data),
      data: result.data as ProviderDataRecord,
    };
  }
  if (result.error === "PENDING_APPROVAL") {
    return {
      success: false,
      text: `Pending approval: ${result.pending.summary.title} (${result.pending.approvalId})`,
      data: {
        pendingApproval: result.pending.approvalId,
        scope: result.pending.scope,
      } as ProviderDataRecord,
    };
  }
  return {
    success: false,
    text: `${result.error}: ${result.detail}`,
  };
}

/**
 * Bridges zod-validated canonical actions into elizaOS {@link Action}.
 *
 * **Note:** core {@link Action.validate} does not receive `HandlerOptions`, so
 * structured params may only exist at handler time. This wrapper keeps the full
 * validate gate inside the handler while exposing a best-effort `validate`
 * preflight from message/state. Phase 3 may tighten this once parameters are
 * present pre-handler consistently.
 */
export function defineCanonicalAction<
  Schema extends z.ZodType,
  TData = unknown,
>(def: {
  readonly name: string;
  readonly description: string;
  readonly similes: ReadonlyArray<string>;
  readonly schema: Schema;
  readonly validate: (
    runtime: IAgentRuntime,
    message: Memory,
    params: z.infer<Schema>,
  ) => Promise<ValidateOutcome>;
  readonly handler: (
    runtime: IAgentRuntime,
    message: Memory,
    params: z.infer<Schema>,
  ) => Promise<CanonicalHandlerResult<TData>>;
  readonly examples: ReadonlyArray<ActionExample>;
}): Action {
  return {
    name: def.name,
    description: def.description,
    similes: [...def.similes],
    examples: def.examples.map((ex) => [ex]),
    validate: async (runtime, message, state) => {
      const raw = mergeParameters(message, state);
      if (!raw) {
        runtime.logger.warn(`[${def.name}] Missing structured parameters`);
        return false;
      }
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) {
        runtime.logger.warn(
          `[${def.name}] Parameter parse failed: ${JSON.stringify(parsed.error.issues)}`,
        );
        return false;
      }
      const outcome = await def.validate(runtime, message, parsed.data);
      if (!outcome.ok) {
        runtime.logger.warn(
          `[${def.name}] Validate gate failed: ${outcome.reason} — ${outcome.detail}`,
        );
        return false;
      }
      return true;
    },
    handler: async (
      runtime,
      message,
      state,
      options,
      callback?: HandlerCallback,
    ): Promise<ActionResult | undefined> => {
      void callback;
      const raw = mergeParameters(message, state, options);
      const parsed = def.schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return {
          success: false,
          text: `Invalid parameters: ${parsed.error.message}`,
        };
      }
      const pre = await def.validate(runtime, message, parsed.data);
      if (!pre.ok) {
        return {
          success: false,
          text: `${pre.reason}: ${pre.detail}`,
        };
      }
      const result = await def.handler(runtime, message, parsed.data);
      return toActionResult(result);
    },
  };
}
