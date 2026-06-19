/**
 * SendPolicy hook — lets a host runtime gate outbound sends behind owner
 * approval (or any other policy). Triage's MESSAGE consults the registered
 * policy before invoking the adapter.
 *
 * Registration uses a module-scoped WeakMap keyed by runtime instance so the
 * hook lifetime tracks the runtime and we don't leak across tests. We do not
 * use runtime.registerService here because SendPolicy is not a long-lived
 * background Service — it's a per-runtime hook with two methods.
 */

import type { IAgentRuntime } from "../../../types/index.ts";
import type { DraftRequest } from "./types.ts";

export interface SendPolicy {
	/** Decide whether this draft requires explicit owner approval before sending. */
	shouldRequireApproval(
		runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<boolean>;
	/** Enqueue an approval request that will execute `executor` once approved. */
	enqueueApproval(
		runtime: IAgentRuntime,
		draft: DraftRequest,
		executor: () => Promise<{ externalId: string }>,
	): Promise<{ requestId: string; preview: string }>;
}

const policies = new WeakMap<IAgentRuntime, SendPolicy>();

export function registerSendPolicy(
	runtime: IAgentRuntime,
	policy: SendPolicy,
): void {
	policies.set(runtime, policy);
}

export function getSendPolicy(runtime: IAgentRuntime): SendPolicy | null {
	return policies.get(runtime) ?? null;
}

export function __resetSendPolicyForTests(runtime: IAgentRuntime): void {
	policies.delete(runtime);
}
