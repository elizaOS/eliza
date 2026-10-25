const DISCORD_INGRESS_READY_TIMEOUT_MS = 30_000;

/**
 * Wait for ready-time identity hydration without allowing ingress to hang
 * forever if a Discord API call inside onReady never settles. Timing out is a
 * fail-closed result: callers report the error and drop the message before any
 * dedupe reservation, persistence, context construction, or send.
 */
export async function waitForDiscordIngressReadiness(
	ready: Promise<void> | null | undefined,
	timeoutMs = DISCORD_INGRESS_READY_TIMEOUT_MS,
): Promise<void> {
	if (!ready) return;

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			ready,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					reject(
						new Error(
							`Discord ready-time identity hydration timed out after ${timeoutMs}ms`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
