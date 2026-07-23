/**
 * Shared TTFA-budget knob for the real Kokoro gates. The default is the
 * mobile product budget (`KOKORO_MOBILE_TTFA_BUDGET_MS`);
 * `KOKORO_SMOKE_TTFA_BUDGET_MS` overrides it where the perf class under test
 * is different — the desktop-CPU CI runners prove loadability +
 * intelligibility, not the mobile latency contract, and a generous explicit
 * ceiling there still catches loader hangs. Both the kokoro-real-smoke script
 * and the real engine-bridge suite gate through this single function.
 */

import { KOKORO_MOBILE_TTFA_BUDGET_MS } from "./kokoro-backend";

/**
 * Resolve the TTFA gate for the current host. Throws on a
 * present-but-invalid value: a typo'd budget must fail the lane loudly,
 * never silently gate against the wrong number.
 */
export function resolveKokoroTtfaBudgetMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env.KOKORO_SMOKE_TTFA_BUDGET_MS?.trim();
	if (!raw) return KOKORO_MOBILE_TTFA_BUDGET_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(
			`[voice/kokoro] KOKORO_SMOKE_TTFA_BUDGET_MS must be a positive integer, got "${raw}"`,
		);
	}
	return parsed;
}
