/**
 * Pure data inspection helpers shared between plugin auto-enable predicates,
 * host-app config sync code, and the agent runtime.
 *
 * These live in @elizaos/core (not @elizaos/shared) so plugin packages can
 * import them without dragging the app/shared layer into their dep graph —
 * external plugins published to npm only need @elizaos/core.
 */

/**
 * Builds the character-settings key under which a PER-ACCOUNT connector
 * credential is published.
 *
 * Connector policy (channels, DM rules, mention defaults) is projected onto
 * `character.settings.<connector>` so the plugin can enforce it, but connector
 * CREDENTIALS must never travel that path: `character.settings.secrets` is the
 * only boundary the runtime's redactor scans, so a token in plain settings is a
 * token that can be echoed into model output, logs, and exports.
 *
 * Base-level credentials already have a secret lane through the connector env
 * map (`connectors.slack.botToken` -> `SLACK_BOT_TOKEN`). Per-account
 * credentials (`connectors.slack.accounts.<id>.botToken`) had none, which is
 * what made projecting them as plain settings look necessary. They get this key
 * on the secret path instead.
 *
 * Lives in @elizaos/core so the projection side (packages/agent) and the
 * consuming side (the connector plugin) derive the identical key from one
 * definition rather than two that can silently drift apart.
 */
export function connectorAccountCredentialSettingKey(
	provider: string,
	accountId: string,
	field: string,
): string {
	return [
		normalizeConnectorKeySegment(provider),
		"ACCOUNT",
		normalizeConnectorKeySegment(accountId),
		normalizeConnectorKeySegment(field),
	].join("_");
}

/**
 * Builds the character-settings key under which a BASE-LEVEL connector
 * credential is published.
 *
 * Connector schemas of the `AccountSchema.extend({accounts})` family (Slack,
 * Google Chat, …) treat the top level as an account config that every entry in
 * `accounts` inherits from, so a base-level token is the credential for every
 * account that does not override it. Routing base credentials through the flat
 * ambient env key instead would conflate "the operator wrote this in config,
 * so every account inherits it" with "a token happened to be in the host
 * environment", which only the default account may use. This key keeps that
 * distinction intact while still living on the redactable secret path.
 */
export function connectorBaseCredentialSettingKey(
	provider: string,
	field: string,
): string {
	return [
		normalizeConnectorKeySegment(provider),
		"BASE",
		normalizeConnectorKeySegment(field),
	].join("_");
}

function normalizeConnectorKeySegment(value: string): string {
	return (
		value
			.trim()
			// camelCase -> SNAKE_CASE so `botToken` reads as `BOT_TOKEN`.
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/[^a-zA-Z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.toUpperCase() || "UNKNOWN"
	);
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

	const hasEnabledSignalAccount =
		connectorName === "signal" &&
		typeof config.accounts === "object" &&
		config.accounts !== null &&
		Object.values(config.accounts as Record<string, unknown>).some(
			(account) => {
				if (!account || typeof account !== "object") return false;
				const accountConfig = account as Record<string, unknown>;
				if (accountConfig.enabled === false) return false;
				return Boolean(
					accountConfig.authDir ||
						accountConfig.account ||
						accountConfig.httpUrl ||
						accountConfig.httpHost ||
						accountConfig.httpPort ||
						accountConfig.cliPath,
				);
			},
		);

	if (hasEnabledSignalAccount) {
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
		case "signal":
			return Boolean(
				config.authDir ||
					config.account ||
					config.httpUrl ||
					config.httpHost ||
					config.httpPort ||
					config.cliPath,
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
		default:
			return false;
	}
}

/**
 * Per-destination shape check for streaming plugins (twitch, youtube,
 * customRtmp, pumpfun, x, rtmpSources). Same pattern as `isConnectorConfigured`
 * — pure data inspection, no transitive imports.
 */
export function isStreamingDestinationConfigured(
	destName: string,
	destConfig: unknown,
): boolean {
	if (!destConfig || typeof destConfig !== "object") return false;
	const config = destConfig as Record<string, unknown>;
	if (config.enabled === false) return false;

	switch (destName) {
		case "twitch":
			return Boolean(config.streamKey || config.enabled === true);
		case "youtube":
			return Boolean(config.streamKey || config.enabled === true);
		case "customRtmp":
			return Boolean(config.rtmpUrl && config.rtmpKey);
		case "pumpfun":
			return Boolean(config.streamKey && config.rtmpUrl);
		case "x":
			return Boolean(config.streamKey && config.rtmpUrl);
		case "rtmpSources":
			return (
				Array.isArray(destConfig) &&
				destConfig.some((row) => {
					if (!row || typeof row !== "object") return false;
					const rec = row as Record<string, unknown>;
					const id = String(rec.id ?? "").trim();
					const url = String(rec.rtmpUrl ?? "").trim();
					const key = String(rec.rtmpKey ?? "").trim();
					return Boolean(id && url && key);
				})
			);
		default:
			return false;
	}
}

/**
 * WeChat connector detection. Top-level `apiKey` is caught by the universal
 * check in `isConnectorConfigured`; this helper handles the multi-account
 * variant where each account in `config.accounts.*.apiKey` is checked.
 */
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
