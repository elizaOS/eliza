/**
 * TEE admission, confidential runtime, protected-profile and private Google
 * host authority come
 * only from the measured process environment, never from config or API
 * writes that could relax or clear them after entry — including boot-time
 * hydration of `config.env`.
 */
export const PROCESS_ONLY_ENV_KEY_PREFIXES: readonly string[] = [
	"ELIZA_TEE_",
	"ELIZA_DSTACK_",
	"ELIZA_CONFIDENTIAL_",
	"ELIZA_PROTECTED_",
	// Private owner Google host endpoints and their enablement flags. A config
	// write must not redirect the bearer-authenticated broker or turn on Gmail
	// send, mailbox changes or Calendar deletion.
	"ELIZA_MANAGED_GMAIL_",
	"ELIZA_MANAGED_CALENDAR_",
	"ELIZA_NATIVE_GOOGLE_",
];

/** Keys that config may never supply, even at boot when unset in the process. */
export function isProcessOnlyEnvKey(key: string): boolean {
	const upper = key.trim().toUpperCase();
	return PROCESS_ONLY_ENV_KEY_PREFIXES.some((prefix) =>
		upper.startsWith(prefix),
	);
}
