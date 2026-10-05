/**
 * TEE admission, confidential runtime and protected-profile authority come
 * only from the measured process environment, never from config or API
 * writes that could relax or clear them after entry — including boot-time
 * hydration of `config.env`.
 */
export const PROCESS_ONLY_ENV_KEY_PREFIXES: readonly string[] = [
	"ELIZA_TEE_",
	"ELIZA_DSTACK_",
	"ELIZA_CONFIDENTIAL_",
	"ELIZA_PROTECTED_",
];

/** Keys that config may never supply, even at boot when unset in the process. */
export function isProcessOnlyEnvKey(key: string): boolean {
	const upper = key.trim().toUpperCase();
	return PROCESS_ONLY_ENV_KEY_PREFIXES.some((prefix) =>
		upper.startsWith(prefix),
	);
}
