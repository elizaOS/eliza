/**
 * In-process OAuth callback bus for non-cloud deployments.
 *
 * The cloud deployment registers a durable, cross-process
 * `OAuthCallbackBusClient`; without it `AWAIT_OAUTH_CALLBACK` has nothing to
 * wait on and the five-action OAuth flow dead-ends (the action's `validate`
 * returns false). This local fallback keeps pending intents in memory and
 * resolves them when the local `/api/oauth/callback` route delivers a result
 * for the intent id, making the full flow work for Telegram-/CLI-based agents
 * with no cloud.
 */

import { logger } from "../../logger.ts";
import type { IAgentRuntime } from "../../types/index.ts";
import { Service } from "../../types/service.ts";
import {
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	type OAuthCallbackBusClient,
	type OAuthCallbackResult,
} from "./types.ts";

interface Waiter {
	resolve: (result: OAuthCallbackResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class LocalOAuthCallbackBus
	extends Service
	implements OAuthCallbackBusClient
{
	static serviceType = OAUTH_CALLBACK_BUS_CLIENT_SERVICE;
	capabilityDescription =
		"In-process OAuth callback bus for non-cloud deployments.";

	private readonly waiters = new Map<string, Waiter>();

	static async start(runtime: IAgentRuntime): Promise<LocalOAuthCallbackBus> {
		return new LocalOAuthCallbackBus(runtime);
	}

	waitFor(
		oauthIntentId: string,
		timeoutMs: number,
	): Promise<OAuthCallbackResult> {
		return new Promise<OAuthCallbackResult>((resolve) => {
			// A second wait on the same intent supersedes the first (expire it).
			const prior = this.waiters.get(oauthIntentId);
			if (prior) {
				clearTimeout(prior.timer);
				prior.resolve({
					oauthIntentId,
					status: "expired",
					error: "superseded by a newer wait",
				});
			}
			const timer = setTimeout(() => {
				this.waiters.delete(oauthIntentId);
				resolve({
					oauthIntentId,
					status: "expired",
					error: `timed out after ${timeoutMs}ms`,
				});
			}, timeoutMs);
			// A pending OAuth wait must not, by itself, keep the process alive.
			(timer as { unref?: () => void }).unref?.();
			this.waiters.set(oauthIntentId, { resolve, timer });
		});
	}

	/**
	 * Deliver a callback result, resolving the pending waiter for its intent id.
	 * Returns true when a waiter was resolved, false when none was pending.
	 */
	publish(result: OAuthCallbackResult): boolean {
		const waiter = this.waiters.get(result.oauthIntentId);
		if (!waiter) {
			logger.warn(
				`[LocalOAuthCallbackBus] no waiter for oauthIntentId=${result.oauthIntentId}`,
			);
			return false;
		}
		clearTimeout(waiter.timer);
		this.waiters.delete(result.oauthIntentId);
		waiter.resolve({ receivedAt: Date.now(), ...result });
		return true;
	}

	/** True when an intent is currently being awaited (used by the route). */
	isWaiting(oauthIntentId: string): boolean {
		return this.waiters.has(oauthIntentId);
	}

	async stop(): Promise<void> {
		for (const [oauthIntentId, waiter] of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({
				oauthIntentId,
				status: "expired",
				error: "callback bus stopped",
			});
		}
		this.waiters.clear();
	}
}
