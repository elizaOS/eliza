/**
 * Pure data inspection helpers shared between plugin auto-enable predicates,
 * host-app config sync code, and the agent runtime.
 *
 * These live in @elizaos/core (not @elizaos/shared) so plugin packages can
 * import them without dragging the app/shared layer into their dep graph —
 * external plugins published to npm only need @elizaos/core.
 */

/** Builds the secret-setting key for one account-scoped connector credential. */
export function connectorAccountCredentialSettingKey(
	provider: string,
	accountId: string,
	field: string,
): string {
	return [
		"CONNECTOR",
		encodeConnectorKeySegment(provider),
		"ACCOUNT",
		encodeConnectorKeySegment(accountId),
		encodeConnectorKeySegment(field),
	].join("|");
}

/** Builds the secret-setting key for an inherited connector credential. */
export function connectorBaseCredentialSettingKey(
	provider: string,
	field: string,
): string {
	return [
		"CONNECTOR",
		encodeConnectorKeySegment(provider),
		"BASE",
		encodeConnectorKeySegment(field),
	].join("|");
}

function encodeConnectorKeySegment(value: string): string {
	// Length-prefixing preserves arbitrary account identifiers without the
	// collisions caused by slug normalization (for example `support-east` and
	// `support_east` must never resolve to the same credential).
	return `${value.length}:${value}`;
}

/**
 * True when a connector configuration block is present and "configured
 * enough" for the connector plugin to do real work. The exact criteria are
 * connector-specific (e.g. bluebubbles needs both serverUrl and password,
 * imessage just needs cliPath OR dbPath OR enabled:true) but the broad
 * pattern is:
 *   - block exists, is an object, and isn't `enabled: false`
 *   - has at least one of { botToken, token, apiKey } — the universal case
 *   - OR matches the connector-specific shape (per-case branches below)
 *
 * Used by per-plugin `auto-enable.ts` predicates that just want to delegate
 * "is this connector wired?" to a single source of truth, and by app-side
 * config-routing code that needs to mirror the same check.
 */
export function isConnectorConfigured(
	connectorName: string,
	connectorConfig: unknown,
): boolean {
	if (!connectorConfig || typeof connectorConfig !== "object") {
		return false;
	}
	const config = connectorConfig as Record<string, unknown>;
	if (config.enabled === false) {
		return false;
	}
	if (config.botToken || config.token || config.apiKey) {
		return true;
	}

	switch (connectorName) {
		case "bluebubbles":
			return Boolean(config.serverUrl && config.password);
		case "discordLocal":
			return Boolean(config.clientId && config.clientSecret);
		case "imessage":
			return Boolean(
				config.enabled === true || config.cliPath || config.dbPath,
			);
		case "whatsapp":
			// authState/sessionPath: legacy field names
			// authDir: Baileys multi-file auth state directory (WhatsAppAccountSchema)
			// accounts: at least one account with authDir set and not explicitly disabled
			return Boolean(
				config.authState ||
					config.sessionPath ||
					config.authDir ||
					(config.accounts &&
						typeof config.accounts === "object" &&
						Object.values(config.accounts as Record<string, unknown>).some(
							(account) => {
								if (!account || typeof account !== "object") return false;
								const acc = account as Record<string, unknown>;
								if (acc.enabled === false) return false;
								return Boolean(acc.authDir);
							},
						)),
			);
		case "twitch":
			return Boolean(
				config.accessToken || config.clientId || config.enabled === true,
			);
		case "wechat":
			return isWechatConfigured(config);
		case "googlechat":
			return isGoogleChatConfigured(config);
		default:
			return false;
	}
}

/**
 * WeChat connector detection. Top-level `apiKey` is caught by the universal
 * check in `isConnectorConfigured`; this helper handles the multi-account
 * variant where each account in `config.accounts.*.apiKey` is checked.
 */
function isNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/** Object (record) form of a service-account credential — never an array. */
function isRecordObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a Google Chat account row (top-level block or `accounts.*` record
 * entry) carries usable service-account credential material. Mirrors
 * GoogleChatAccountSchema: `serviceAccount` is a string OR a parsed key
 * object, `serviceAccountFile` is a path string. `serviceAccountKey` is not a
 * schema field but is accepted because the GOOGLE_CHAT_SERVICE_ACCOUNT_KEY
 * env alias historically mapped there.
 */
function hasGoogleChatCredential(row: Record<string, unknown>): boolean {
	return (
		isNonEmptyString(row.serviceAccount) ||
		isRecordObject(row.serviceAccount) ||
		isNonEmptyString(row.serviceAccountFile) ||
		isNonEmptyString(row.serviceAccountKey)
	);
}

/**
 * Google Chat connector detection. The connector authenticates with a service
 * account, so `projectId` or webhook settings alone are not enough. Credential
 * material may live at the top level or on any enabled entry of the
 * `accounts` record (GoogleChatConfigSchema keys accounts by id, not array).
 */
export function isGoogleChatConfigured(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const config = value as Record<string, unknown>;
	if (config.enabled === false) {
		return false;
	}
	if (hasGoogleChatCredential(config)) {
		return true;
	}
	const accounts = config.accounts;
	if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
		return Object.values(accounts as Record<string, unknown>).some(
			(account) => {
				if (!account || typeof account !== "object" || Array.isArray(account)) {
					return false;
				}
				const row = account as Record<string, unknown>;
				if (row.enabled === false) {
					return false;
				}
				return hasGoogleChatCredential(row);
			},
		);
	}
	return false;
}

export function isWechatConfigured(
	config: Record<string, unknown> | null | undefined,
): boolean {
	if (!config || config.enabled === false) {
		return false;
	}
	if (config.apiKey) {
		return true;
	}
	const accounts = config.accounts;
	if (accounts && typeof accounts === "object") {
		return Object.values(
			accounts as Record<string, Record<string, unknown>>,
		).some((account) => {
			if (
				!account ||
				typeof account !== "object" ||
				account.enabled === false
			) {
				return false;
			}
			return Boolean(account.apiKey);
		});
	}
	return false;
}
