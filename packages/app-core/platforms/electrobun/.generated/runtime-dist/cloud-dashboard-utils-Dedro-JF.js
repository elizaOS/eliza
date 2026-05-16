import { Ta as pathForTab, sa as isCloudStatusReasonApiKeyOnly } from "./state-BC9WO-N8.js";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/cloud-dashboard-utils.js
/** Marketing / docs site — "Learn more" when not connected (in-app browser on desktop). */
const ELIZA_CLOUD_WEB_URL = "https://elizacloud.ai";
const BILLING_PRESET_AMOUNTS = [
	10,
	25,
	100
];
const MANAGED_DISCORD_GATEWAY_AGENT_NAME = "Discord Gateway";
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function resolveCloudAccountIdDisplay(userId, statusReason, t) {
	if (userId) return {
		mono: true,
		text: userId
	};
	if (isCloudStatusReasonApiKeyOnly(statusReason)) return {
		mono: false,
		text: t("elizaclouddashboard.AccountIdApiKeyOnly")
	};
	return {
		mono: false,
		text: t("elizaclouddashboard.AccountIdSessionNoUserId")
	};
}
function unwrapBillingData(value) {
	if (isRecord(value.data)) return value.data;
	return value;
}
function readString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function readNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
function readBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
const MANAGED_DISCORD_CALLBACK_QUERY_KEYS = [
	"discord",
	"managed",
	"agentId",
	"guildId",
	"guildName",
	"restarted",
	"message"
];
function consumeManagedDiscordCallbackUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return {
			callback: null,
			cleanedUrl: null
		};
	}
	const status = url.searchParams.get("discord");
	const managed = url.searchParams.get("managed") === "1";
	if (status !== "connected" && status !== "error" || !managed) return {
		callback: null,
		cleanedUrl: null
	};
	const callback = {
		status,
		managed,
		agentId: readString(url.searchParams.get("agentId")) ?? null,
		guildId: readString(url.searchParams.get("guildId")) ?? null,
		guildName: readString(url.searchParams.get("guildName")) ?? null,
		message: readString(url.searchParams.get("message")) ?? null,
		restarted: url.searchParams.get("restarted") === "1"
	};
	for (const key of MANAGED_DISCORD_CALLBACK_QUERY_KEYS) url.searchParams.delete(key);
	return {
		callback,
		cleanedUrl: url.toString()
	};
}
function buildManagedDiscordSettingsReturnUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	const settingsPath = pathForTab("settings");
	if (url.protocol === "file:") {
		url.hash = settingsPath;
		url.search = "";
		return url.toString();
	}
	const settingsPathname = (url.pathname.replace(/\/+$/, "") || "/").replace(/\/[^/]*$/, settingsPath);
	url.pathname = settingsPathname === "" ? settingsPath : settingsPathname;
	url.search = "";
	url.hash = "";
	return url.toString();
}
function resolveManagedDiscordAgentChoice(agents) {
	const gatewayAgents = agents.filter(isManagedDiscordGatewayAgent);
	if (agents.length === 0) return {
		mode: "none",
		agent: null,
		selectedAgentId: null
	};
	if (gatewayAgents.length === 0) return {
		mode: "bootstrap",
		agent: null,
		selectedAgentId: null
	};
	if (gatewayAgents.length === 1) return {
		mode: "direct",
		agent: gatewayAgents[0],
		selectedAgentId: gatewayAgents[0].agent_id
	};
	return {
		mode: "picker",
		agent: null,
		selectedAgentId: (gatewayAgents[0] ?? agents[0]).agent_id
	};
}
function isManagedDiscordGatewayAgent(agent) {
	const config = isRecord(agent.agent_config) ? agent.agent_config : null;
	const gatewayConfig = config ? config.__managedDiscordGateway : void 0;
	if (isRecord(gatewayConfig) && gatewayConfig.mode === "shared-gateway") return true;
	return agent.agent_name.trim().toLowerCase() === MANAGED_DISCORD_GATEWAY_AGENT_NAME.toLowerCase();
}
const MANAGED_GITHUB_CALLBACK_QUERY_KEYS = [
	"github_connected",
	"connection_id",
	"platform",
	"managed_github_agent",
	"github_error"
];
function consumeManagedGithubCallbackUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return {
			callback: null,
			cleanedUrl: null
		};
	}
	const connected = url.searchParams.get("github_connected") === "true";
	const error = url.searchParams.get("github_error");
	const agentId = readString(url.searchParams.get("managed_github_agent")) ?? null;
	if (!connected && !error) return {
		callback: null,
		cleanedUrl: null
	};
	const callback = {
		status: connected ? "connected" : "error",
		connectionId: readString(url.searchParams.get("connection_id")) ?? null,
		agentId,
		message: error ? decodeURIComponent(error) : null
	};
	for (const key of MANAGED_GITHUB_CALLBACK_QUERY_KEYS) url.searchParams.delete(key);
	return {
		callback,
		cleanedUrl: url.toString()
	};
}
function normalizeBillingSummary(raw) {
	const source = unwrapBillingData(raw);
	return {
		...raw,
		...source,
		balance: readNumber(source.balance) ?? readNumber(source.creditBalance) ?? null,
		currency: readString(source.currency) ?? readString(source.balanceCurrency),
		topUpUrl: readString(source.topUpUrl) ?? readString(source.billingUrl),
		embeddedCheckoutEnabled: readBoolean(source.embeddedCheckoutEnabled) ?? readBoolean(source.embedded),
		hostedCheckoutEnabled: readBoolean(source.hostedCheckoutEnabled) ?? readBoolean(source.hosted),
		cryptoEnabled: readBoolean(source.cryptoEnabled) ?? readBoolean(source.crypto),
		low: readBoolean(source.low),
		critical: readBoolean(source.critical)
	};
}
function normalizeBillingSettings(raw) {
	const source = unwrapBillingData(raw);
	return {
		...raw,
		...source,
		settings: isRecord(source.settings) ? source.settings : raw.settings
	};
}
function getBillingAutoTopUp(settings) {
	const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
	return isRecord(rawSettings?.autoTopUp) ? rawSettings.autoTopUp : {};
}
function getBillingLimits(settings) {
	const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
	return isRecord(rawSettings?.limits) ? rawSettings.limits : {};
}
function resolveCheckoutUrl(response) {
	return readString(response.checkoutUrl) ?? readString(response.url) ?? readString(response.hostedUrl) ?? null;
}
function buildAutoTopUpFormState(billingSummary, billingSettings) {
	const autoTopUp = getBillingAutoTopUp(billingSettings);
	const minimumTopUp = readNumber(billingSummary?.minimumTopUp) ?? 1;
	const enabled = readBoolean(autoTopUp.enabled) ?? false;
	const amount = String(readNumber(autoTopUp.amount) ?? minimumTopUp);
	const threshold = String(readNumber(autoTopUp.threshold) ?? 5);
	return {
		amount,
		dirty: false,
		enabled,
		sourceKey: JSON.stringify([
			enabled,
			amount,
			threshold
		]),
		threshold
	};
}
function autoTopUpFormReducer(state, action) {
	switch (action.type) {
		case "hydrate":
			if (!action.force && state.dirty) return state;
			if (state.sourceKey === action.next.sourceKey && !state.dirty) return state;
			return action.next;
		case "setAmount": return {
			...state,
			amount: action.value,
			dirty: true
		};
		case "setEnabled": return {
			...state,
			enabled: action.value,
			dirty: true
		};
		case "setThreshold": return {
			...state,
			threshold: action.value,
			dirty: true
		};
		default: return state;
	}
}

//#endregion
export { resolveCloudAccountIdDisplay as _, buildManagedDiscordSettingsReturnUrl as a, getBillingAutoTopUp as c, normalizeBillingSettings as d, normalizeBillingSummary as f, resolveCheckoutUrl as g, readString as h, buildAutoTopUpFormState as i, getBillingLimits as l, readNumber as m, ELIZA_CLOUD_WEB_URL as n, consumeManagedDiscordCallbackUrl as o, readBoolean as p, autoTopUpFormReducer as r, consumeManagedGithubCallbackUrl as s, BILLING_PRESET_AMOUNTS as t, isRecord as u, resolveManagedDiscordAgentChoice as v };