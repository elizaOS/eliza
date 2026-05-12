/**
 * Custom validator runner — sibling to `task-validation.ts`.
 *
 * The default validator (`validateTaskCompletion`) runs an LLM-based pass
 * over the agent's turn output and workspace evidence. That works for the
 * generic case, but specialized task types (APP.create, PLUGIN.create, etc.)
 * own their own verification surface — disk layout, manifest shape, lint
 * results, test exit codes — and the orchestrator should defer to that
 * verification rather than reasoning over it through an LLM.
 *
 * `runCustomValidator` resolves a runtime service by name, calls the named
 * method with the supplied params (plus the structured-proof claim, if any),
 * and returns a normalized `{ verdict, retryablePromptForChild }` result the
 * decision loop can act on. Every failure path returns `verdict: "fail"`
 * with a concrete `retryablePromptForChild` so the loop never crashes on a
 * misconfigured spec.
 *
 * @module services/custom-validator-runner
 */

import type { IAgentRuntime } from "@elizaos/core";

export interface CustomValidatorSpec {
  /** Runtime service name passed to `runtime.getService(...)`. */
  service: string;
  /** Method name to invoke on the resolved service. */
  method: string;
  /**
   * Free-form params object the orchestrator passes through to the
   * validator. Validators are responsible for typing this on their side.
   */
  params: Record<string, unknown>;
}

export type CustomValidatorVerdict = "pass" | "fail";

export interface CustomValidatorResult {
  verdict: CustomValidatorVerdict;
  /**
   * Concrete next-turn prompt the orchestrator will send back to the child
   * when the verdict is "fail". When the verdict is "pass" this field is
   * still populated for trace/log purposes but the orchestrator ignores it.
   */
  retryablePromptForChild: string;
  /**
   * Pass-through structured details from the validator service. Persisted
   * on the validation report and surfaced on escalation events.
   */
  details?: unknown;
}

/**
 * Resolve `ELIZA_APP_VERIFICATION_MAX_RETRIES`. Per-task `maxRetries`
 * override wins; otherwise the env var; otherwise the documented default
 * of 3. A negative value falls through to the next source.
 */
export function getMaxRetries(taskOverride?: number): number {
  if (typeof taskOverride === "number" && taskOverride >= 0)
    return taskOverride;
  const env = process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES;
  const parsed = env ? Number.parseInt(env, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

interface ServiceMethodMap {
  [method: string]: (params: Record<string, unknown>) => unknown;
}

function isCallableMethod(
  service: unknown,
  method: string,
): service is ServiceMethodMap {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as Record<string, unknown>)[method] === "function"
  );
}

function failResult(
  retryablePromptForChild: string,
  details?: unknown,
): CustomValidatorResult {
  return details === undefined
    ? { verdict: "fail", retryablePromptForChild }
    : { verdict: "fail", retryablePromptForChild, details };
}

function normalizeVerdict(value: unknown): CustomValidatorVerdict | null {
  return value === "pass" || value === "fail" ? value : null;
}

function extractRetryPrompt(payload: Record<string, unknown>): string {
  const candidate = payload.retryablePromptForChild;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }
  // Some validators may use a slightly different field name; tolerate the
  // common alternate "followUpPrompt" so we don't lose a useful prompt.
  const alt = payload.followUpPrompt;
  if (typeof alt === "string" && alt.trim().length > 0) return alt;
  return "Verification failed but no follow-up prompt was supplied.";
}

/**
 * Invoke a custom validator service+method and normalize the result. Never
 * throws — every failure path collapses into `verdict: "fail"` with a
 * descriptive `retryablePromptForChild` so the decision loop can stay on
 * the happy path.
 *
 * @param runtime          Eliza runtime for `getService`.
 * @param spec             `{ service, method, params }` from the task metadata.
 * @param structuredProof  Optional claim recorded by the structured-proof
 *                         bridge. Validators that want to cross-check claims
 *                         against disk receive this under `params.structuredProof`.
 */
export async function runCustomValidator(
  runtime: IAgentRuntime,
  spec: CustomValidatorSpec,
  structuredProof?: unknown,
): Promise<CustomValidatorResult> {
  const service = runtime.getService(spec.service);
  if (!service) {
    return failResult(
      `Validator service '${spec.service}' is not registered on the runtime. ` +
        `Cannot verify completion for method '${spec.method}'. ` +
        `If you are the agent, surface this to the user — the orchestrator cannot self-recover.`,
    );
  }
  if (!isCallableMethod(service, spec.method)) {
    return failResult(
      `Validator service '${spec.service}' has no callable method '${spec.method}'. ` +
        `Cannot verify completion. Surface this to the user.`,
    );
  }

  const callParams: Record<string, unknown> =
    structuredProof === undefined
      ? { ...spec.params }
      : { ...spec.params, structuredProof };

  let raw: unknown;
  try {
    raw = await service[spec.method](callParams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failResult(
      `Verification call to ${spec.service}.${spec.method} threw: ${message}. ` +
        `Re-attempt the work and resolve the underlying error before claiming completion.`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return failResult(
      `Verification call to ${spec.service}.${spec.method} returned a non-object result. ` +
        `Treating as failure.`,
      raw,
    );
  }

  const payload = raw as Record<string, unknown>;
  const verdict = normalizeVerdict(payload.verdict);
  if (verdict === null) {
    return failResult(
      `Verification call to ${spec.service}.${spec.method} returned an invalid verdict ` +
        `(expected "pass" or "fail"). Treating as failure.`,
      raw,
    );
  }

  const retryablePromptForChild = extractRetryPrompt(payload);
  // `details` is whatever the validator chose to attach (checks[], summary,
  // etc.). We pass through the entire payload so callers don't have to chase
  // missing fields one by one.
  const result: CustomValidatorResult = {
    verdict,
    retryablePromptForChild,
    details: raw,
  };
  return result;
}
