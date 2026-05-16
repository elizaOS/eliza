import { da as resolveAppAssetUrl } from "./state-BC9WO-N8.js";
import { autoLabel } from "./index.js";
import { Binary, Bird, BookOpen, Bot, Brain, BrickWall, Briefcase, Calendar, Circle, CircleDashed, CircleDot, ClipboardList, Clock, Cloud, Command, Construction, CreditCard, Diamond, Dna, Eye, Feather, FileKey, FileText, Fingerprint, Gamepad, Gamepad2, GitBranch, Globe, Handshake, Hash, Layers, Leaf, Link, Lock, LockKeyhole, Mail, MessageCircle, MessageSquare, MessagesSquare, Mic, Monitor, MousePointer2, Package, PenTool, Phone, Pickaxe, Puzzle, RefreshCw, Rss, ScrollText, Send, Server, Settings, Shell, Shuffle, Smartphone, Sparkle, Sparkles, Square, Star, StickyNote, Target, Tornado, TrendingDown, Triangle, Video, Volume2, Wallet, Webhook, Wrench, Zap } from "lucide-react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/plugins/showcase-data.js
/** Synthetic showcase plugin that demonstrates all 23 field renderers. */
const SHOWCASE_PLUGIN = {
	id: "__ui-showcase__",
	name: "UI Field Showcase",
	description: "Interactive reference of all 23 field renderers. Not a real plugin — expand to see every UI component in action.",
	enabled: false,
	configured: true,
	envKey: null,
	category: "feature",
	source: "bundled",
	validationErrors: [],
	validationWarnings: [],
	version: "1.0.0",
	icon: "🧩",
	parameters: [
		{
			key: "DISPLAY_NAME",
			type: "string",
			description: "A simple single-line text input for names or short values.",
			required: true,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "SECRET_TOKEN",
			type: "string",
			description: "Masked password input with show/hide toggle and server-backed reveal.",
			required: true,
			sensitive: true,
			currentValue: null,
			isSet: false
		},
		{
			key: "SERVER_PORT",
			type: "number",
			description: "Numeric input with min/max range and step control.",
			required: false,
			sensitive: false,
			default: "3000",
			currentValue: null,
			isSet: false
		},
		{
			key: "ENABLE_LOGGING",
			type: "boolean",
			description: "Toggle switch — on/off. Auto-detected from ENABLE_ prefix.",
			required: false,
			sensitive: false,
			default: "true",
			currentValue: null,
			isSet: false
		},
		{
			key: "WEBHOOK_URL",
			type: "string",
			description: "URL input with format validation. Auto-detected from _URL suffix.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "DEPLOY_REGION",
			type: "string",
			description: "Dropdown selector populated from hint.options. Auto-detected for region/zone keys.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "SYSTEM_PROMPT",
			type: "string",
			description: "Multi-line text input for long values like prompts or templates. Auto-detected from _PROMPT suffix.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "CONTACT_EMAIL",
			type: "string",
			description: "Email input with format validation. Renders type=email.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "THEME_COLOR",
			type: "string",
			description: "Color picker with hex value text input side-by-side.",
			required: false,
			sensitive: false,
			default: "#4a90d9",
			currentValue: null,
			isSet: false
		},
		{
			key: "AUTH_MODE",
			type: "string",
			description: "Radio button group — best for 2-3 mutually exclusive options. Uses 'basic' or 'oauth'.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "ENABLED_FEATURES",
			type: "string",
			description: "Checkbox group for selecting multiple values from a fixed set.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "START_DATE",
			type: "string",
			description: "Date picker input. Auto-detected from _DATE suffix.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "SCHEDULED_AT",
			type: "string",
			description: "Combined date and time picker for scheduling.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "METADATA_CONFIG",
			type: "string",
			description: "JSON editor with syntax validation. Shows parse errors inline.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "RESPONSE_TEMPLATE",
			type: "string",
			description: "Code editor with monospaced font for templates and snippets.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "ALLOWED_ORIGINS",
			type: "string",
			description: "Comma-separated list of origins with add/remove UI for each item.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "CUSTOM_HEADERS",
			type: "string",
			description: "Key-value pair editor with add/remove rows.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "CERT_FILE",
			type: "string",
			description: "File path input for certificates, configs, or data files.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "CUSTOM_COMPONENT",
			type: "string",
			description: "Placeholder for plugin-provided custom React components.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "RELEASE_NOTES",
			type: "string",
			description: "Markdown editor with Edit/Preview toggle for rich text content.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "NOTIFICATION_CHANNELS",
			type: "string",
			description: "Checkbox group with per-option descriptions — similar to multiselect but with checkbox UX.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "CONNECTION_GROUP",
			type: "string",
			description: "Fieldset container for visually grouping related configuration fields.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		},
		{
			key: "ROUTE_TABLE",
			type: "string",
			description: "Tabular data editor with add/remove rows and column headers.",
			required: false,
			sensitive: false,
			currentValue: null,
			isSet: false
		}
	],
	configUiHints: {
		DISPLAY_NAME: {
			label: "Display Name",
			group: "Basic Fields",
			width: "half",
			help: "Renderer: text — single-line text input"
		},
		SECRET_TOKEN: {
			label: "Secret Token",
			group: "Basic Fields",
			width: "half",
			help: "Renderer: password — masked with show/hide toggle"
		},
		SERVER_PORT: {
			label: "Server Port",
			group: "Basic Fields",
			width: "third",
			min: 1,
			max: 65535,
			unit: "port",
			help: "Renderer: number — with min/max range and unit label"
		},
		ENABLE_LOGGING: {
			label: "Enable Logging",
			group: "Basic Fields",
			width: "third",
			help: "Renderer: boolean — pill-shaped toggle switch"
		},
		WEBHOOK_URL: {
			label: "Webhook URL",
			group: "Basic Fields",
			width: "full",
			placeholder: "https://example.com/webhook",
			help: "Renderer: url — URL input with format validation"
		},
		DEPLOY_REGION: {
			label: "Deploy Region",
			group: "Selection Fields",
			width: "half",
			type: "select",
			options: [
				{
					value: "us-east-1",
					label: "US East (Virginia)"
				},
				{
					value: "us-west-2",
					label: "US West (Oregon)"
				},
				{
					value: "eu-west-1",
					label: "EU (Ireland)"
				},
				{
					value: "ap-southeast-1",
					label: "Asia Pacific (Singapore)"
				}
			],
			help: "Renderer: select — dropdown with enhanced option labels"
		},
		SYSTEM_PROMPT: {
			label: "System Prompt",
			group: "Text Fields",
			width: "full",
			help: "Renderer: textarea — multi-line text input for long content"
		},
		CONTACT_EMAIL: {
			label: "Contact Email",
			group: "Text Fields",
			width: "half",
			type: "email",
			placeholder: "admin@example.com",
			help: "Renderer: email — email input with format validation"
		},
		THEME_COLOR: {
			label: "Theme Color",
			group: "Selection Fields",
			width: "third",
			type: "color",
			help: "Renderer: color — color picker swatch + hex input"
		},
		AUTH_MODE: {
			label: "Auth Mode",
			group: "Selection Fields",
			width: "half",
			type: "radio",
			options: [
				{
					value: "basic",
					label: "Basic Auth",
					description: "Username and password"
				},
				{
					value: "oauth",
					label: "OAuth 2.0",
					description: "Token-based authentication"
				},
				{
					value: "apikey",
					label: "API Key",
					description: "Header-based API key"
				}
			],
			help: "Renderer: radio — radio button group with descriptions"
		},
		ENABLED_FEATURES: {
			label: "Enabled Features",
			group: "Selection Fields",
			width: "full",
			type: "multiselect",
			options: [
				{
					value: "auth",
					label: "Authentication"
				},
				{
					value: "logging",
					label: "Logging"
				},
				{
					value: "caching",
					label: "Caching"
				},
				{
					value: "webhooks",
					label: "Webhooks"
				},
				{
					value: "ratelimit",
					label: "Rate Limiting"
				}
			],
			help: "Renderer: multiselect — checkbox group for multiple selections"
		},
		START_DATE: {
			label: "Start Date",
			group: "Date & Time",
			width: "half",
			type: "date",
			help: "Renderer: date — native date picker"
		},
		SCHEDULED_AT: {
			label: "Scheduled At",
			group: "Date & Time",
			width: "half",
			type: "datetime",
			help: "Renderer: datetime — date + time picker"
		},
		METADATA_CONFIG: {
			label: "Metadata Config",
			group: "Structured Data",
			width: "full",
			type: "json",
			help: "Renderer: json — JSON editor with inline validation"
		},
		RESPONSE_TEMPLATE: {
			label: "Response Template",
			group: "Structured Data",
			width: "full",
			type: "code",
			help: "Renderer: code — monospaced code editor"
		},
		ALLOWED_ORIGINS: {
			label: "Allowed Origins",
			group: "Structured Data",
			width: "full",
			type: "array",
			help: "Renderer: array — add/remove items list"
		},
		CUSTOM_HEADERS: {
			label: "Custom Headers",
			group: "Structured Data",
			width: "full",
			type: "keyvalue",
			help: "Renderer: keyvalue — key-value pair editor"
		},
		CERT_FILE: {
			label: "Certificate File",
			group: "File Paths",
			width: "full",
			type: "file",
			help: "Renderer: file — file path input"
		},
		CUSTOM_COMPONENT: {
			label: "Custom Component",
			group: "File Paths",
			width: "full",
			type: "custom",
			help: "Renderer: custom — placeholder for plugin-provided React components",
			advanced: true
		},
		RELEASE_NOTES: {
			label: "Release Notes",
			group: "Text Fields",
			width: "full",
			type: "markdown",
			help: "Renderer: markdown — textarea with Edit/Preview toggle"
		},
		NOTIFICATION_CHANNELS: {
			label: "Notification Channels",
			group: "Selection Fields",
			width: "full",
			type: "checkbox-group",
			options: [
				{
					value: "email",
					label: "Email",
					description: "Send notifications via email"
				},
				{
					value: "slack",
					label: "Slack",
					description: "Post to Slack channels"
				},
				{
					value: "webhook",
					label: "Webhook",
					description: "HTTP POST to configured URL"
				},
				{
					value: "sms",
					label: "SMS",
					description: "Text message alerts"
				}
			],
			help: "Renderer: checkbox-group — vertical checkbox list with descriptions"
		},
		CONNECTION_GROUP: {
			label: "Connection Settings",
			group: "Structured Data",
			width: "full",
			type: "group",
			help: "Renderer: group — fieldset container with legend"
		},
		ROUTE_TABLE: {
			label: "Route Table",
			group: "Structured Data",
			width: "full",
			type: "table",
			help: "Renderer: table — tabular data editor with add/remove rows"
		}
	}
};

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/plugin-list-utils.js
/**
* Plugin list utilities — pure functions, constants, and type aliases
* shared across the plugin management UI.
*/
const DISCORD_DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";
const DISCORD_INVITE_PERMISSIONS = "67193856";
const DISCORD_INVITE_SCOPES = "bot applications.commands";
/**
* Plugin IDs hidden from Features/Connectors views.
* Core plugins are visible in Admin > Plugins instead.
*/
const ALWAYS_ON_PLUGIN_IDS = new Set([
	"sql",
	"local-embedding",
	"knowledge",
	"agent-skills",
	"directives",
	"commands",
	"personality",
	"experience",
	"agent-orchestrator",
	"shell",
	"plugin-manager",
	"cli",
	"code",
	"edge-tts",
	"pdf",
	"clipboard",
	"todo",
	"trust",
	"form",
	"goals",
	"scheduling",
	"elizacloud",
	"evm",
	"memory",
	"relationships",
	"tts",
	"elevenlabs",
	"cron",
	"webhooks",
	"browser",
	"vision",
	"computeruse"
]);
/** Keys to hide when Telegram "Allow all chats" mode is active. */
const TELEGRAM_ALLOW_ALL_HIDDEN = new Set(["TELEGRAM_ALLOWED_CHATS"]);
/** Detect advanced / debug parameters that should be collapsed by default. */
function isAdvancedParam(param) {
	const k = param.key.toUpperCase();
	const d = (param.description ?? "").toLowerCase();
	return k.includes("EXPERIMENTAL") || k.includes("DEBUG") || k.includes("VERBOSE") || k.includes("TELEMETRY") || k.includes("BROWSER_BASE") || d.includes("experimental") || d.includes("advanced") || d.includes("debug");
}
/** Convert PluginParamDef[] to a JSON Schema + ConfigUiHints for ConfigRenderer. */
function paramsToSchema(params, pluginId) {
	const properties = {};
	const required = [];
	const hints = {};
	for (const p of params) {
		const prop = {};
		if (p.type === "boolean") prop.type = "boolean";
		else if (p.type === "number") prop.type = "number";
		else prop.type = "string";
		if (p.description) prop.description = p.description;
		if (p.default != null) prop.default = p.default;
		if (p.options?.length) prop.enum = p.options;
		const keyUpper = p.key.toUpperCase();
		if (keyUpper.includes("URL") || keyUpper.includes("ENDPOINT") || keyUpper.includes("BASE_URL")) prop.format = "uri";
		else if (keyUpper.includes("EMAIL")) prop.format = "email";
		else if (keyUpper.includes("_DATE") || keyUpper.includes("_SINCE") || keyUpper.includes("_UNTIL")) prop.format = "date";
		if (keyUpper.includes("PORT") && prop.type === "string") prop.type = "number";
		else if ((keyUpper.includes("TIMEOUT") || keyUpper.includes("INTERVAL") || keyUpper.includes("_MS")) && prop.type === "string") prop.type = "number";
		else if ((keyUpper.includes("COUNT") || keyUpper.includes("LIMIT") || keyUpper.startsWith("MAX_")) && prop.type === "string") prop.type = "number";
		else if ((keyUpper.includes("RETRY") || keyUpper.includes("RETRIES")) && prop.type === "string") prop.type = "number";
		if (prop.type === "string" && (keyUpper.includes("SHOULD_") || keyUpper.endsWith("_ENABLED") || keyUpper.endsWith("_DISABLED") || keyUpper.startsWith("USE_") || keyUpper.startsWith("ALLOW_") || keyUpper.startsWith("IS_") || keyUpper.startsWith("ENABLE_") || keyUpper.startsWith("DISABLE_") || keyUpper.startsWith("FORCE_") || keyUpper.endsWith("_AUTONOMOUS_MODE"))) prop.type = "boolean";
		if (prop.type === "string" && (keyUpper.includes("_RATE") || keyUpper.includes("DELAY") || keyUpper.includes("THRESHOLD") || keyUpper.includes("_SIZE") || keyUpper.includes("TEMPERATURE") || keyUpper.includes("_DEPTH") || keyUpper.includes("_PERCENT") || keyUpper.includes("_RATIO"))) prop.type = "number";
		if (prop.type === "string" && !prop.enum) {
			const descLower = (p.description || "").toLowerCase();
			const isCommaSep = descLower.includes("comma-separated") || descLower.includes("comma separated");
			const isListSuffix = keyUpper.endsWith("_IDS") || keyUpper.endsWith("_CHANNELS") || keyUpper.endsWith("_ROOMS") || keyUpper.endsWith("_RELAYS") || keyUpper.endsWith("_FEEDS") || keyUpper.endsWith("_DEXES") || keyUpper.endsWith("_WHITELIST") || keyUpper.endsWith("_BLACKLIST") || keyUpper.endsWith("_ALLOWLIST") || keyUpper.endsWith("_SPACES") || keyUpper.endsWith("_THREADS") || keyUpper.endsWith("_ROLES") || keyUpper.endsWith("_TENANTS") || keyUpper.endsWith("_DIRS");
			if (isCommaSep || isListSuffix) {
				prop.type = "array";
				prop.items = { type: "string" };
			}
		}
		if (prop.type === "string" && !prop.enum && !keyUpper.includes("MODEL")) {
			if (keyUpper.includes("INSTRUCTIONS") || keyUpper.includes("_GREETING") || keyUpper.endsWith("_PROMPT") || keyUpper.endsWith("_TEMPLATE") || keyUpper.includes("SYSTEM_MESSAGE")) prop.maxLength = 999;
		}
		if (prop.type === "string" && !p.sensitive) {
			const descLower = (p.description || "").toLowerCase();
			if (descLower.includes("json-encoded") || descLower.includes("json array") || descLower.includes("serialized") || descLower.includes("json format")) prop.__jsonHint = true;
		}
		if (prop.type === "string") {
			if (keyUpper.endsWith("_PATH") && !keyUpper.includes("WEBHOOK") || keyUpper.endsWith("_DIR") || keyUpper.endsWith("_DIRECTORY") || keyUpper.endsWith("_FOLDER") || keyUpper.endsWith("_FILE")) prop.__fileHint = true;
		}
		if (p.description && p.description.length > 200) prop.maxLength = 999;
		properties[p.key] = prop;
		if (p.required) required.push(p.key);
		const hint = {
			label: autoLabel(p.key, pluginId),
			sensitive: p.sensitive ?? false,
			advanced: isAdvancedParam(p)
		};
		if (keyUpper.includes("PORT")) {
			hint.min = 1;
			hint.max = 65535;
			prop.minimum = 1;
			prop.maximum = 65535;
		}
		if (keyUpper.includes("TIMEOUT") || keyUpper.includes("INTERVAL") || keyUpper.includes("_MS")) {
			hint.unit = "ms";
			prop.minimum = 0;
			hint.min = 0;
		}
		if (keyUpper.includes("COUNT") || keyUpper.includes("LIMIT") || keyUpper.startsWith("MAX_")) {
			hint.min = 0;
			prop.minimum = 0;
		}
		if (keyUpper.includes("RETRY") || keyUpper.includes("RETRIES")) {
			hint.min = 0;
			hint.max = 100;
			prop.minimum = 0;
			prop.maximum = 100;
		}
		if (keyUpper.includes("DEBUG") || keyUpper.includes("VERBOSE") || keyUpper.includes("ENABLED")) hint.advanced = true;
		if (keyUpper.includes("MODEL") && p.options?.length) hint.advanced = false;
		if ((keyUpper.includes("REGION") || keyUpper.includes("ZONE")) && !p.options?.length) {
			hint.type = "select";
			hint.options = [
				{
					value: "us-east-1",
					label: "US East (N. Virginia)"
				},
				{
					value: "us-west-2",
					label: "US West (Oregon)"
				},
				{
					value: "eu-west-1",
					label: "EU (Ireland)"
				},
				{
					value: "eu-central-1",
					label: "EU (Frankfurt)"
				},
				{
					value: "ap-southeast-1",
					label: "Asia Pacific (Singapore)"
				},
				{
					value: "ap-northeast-1",
					label: "Asia Pacific (Tokyo)"
				}
			];
		}
		if (prop.__fileHint) {
			hint.type = "file";
			delete prop.__fileHint;
		}
		if (prop.__jsonHint) {
			hint.type = "json";
			delete prop.__jsonHint;
		}
		if (keyUpper.includes("MODEL") && prop.type === "string" && !p.options?.length) {
			if (!hint.placeholder) if (keyUpper.includes("EMBEDDING")) hint.placeholder = "e.g., text-embedding-3-small";
			else if (keyUpper.includes("TTS")) hint.placeholder = "e.g., tts-1, eleven_multilingual_v2";
			else if (keyUpper.includes("STT")) hint.placeholder = "e.g., whisper-1";
			else if (keyUpper.includes("IMAGE")) hint.placeholder = "e.g., dall-e-3, gpt-4o";
			else hint.placeholder = "e.g., gpt-4o, claude-sonnet-4-6";
		}
		if (prop.type === "string" && !prop.enum && !p.sensitive && (keyUpper.endsWith("_MODE") || keyUpper.endsWith("_STRATEGY"))) {
			const desc = p.description ?? "";
			const pipeMatch = desc.match(/:\s*([a-z0-9_-]+(?:\s*[|/]\s*[a-z0-9_-]+)+)/i) ?? desc.match(/\(([a-z0-9_-]+(?:\s*[|/,]\s*[a-z0-9_-]+)+)\)/i);
			if (pipeMatch) {
				const safeOpts = pipeMatch[1].split(/[|/,]/).map((s) => s.trim()).filter(Boolean).filter((v) => /^[a-z0-9_-]+$/i.test(v));
				if (safeOpts.length >= 2 && safeOpts.length <= 10) {
					hint.type = "select";
					hint.options = safeOpts.map((v) => ({
						value: v,
						label: v
					}));
				}
			} else {
				const safeQuoted = [...desc.matchAll(/'([a-z0-9_-]+)'/gi)].map((m) => m[1]).filter((v) => /^[a-z0-9_-]+$/i.test(v));
				if (safeQuoted.length >= 2 && safeQuoted.length <= 10) {
					hint.type = safeQuoted.length === 2 ? "radio" : "select";
					hint.options = safeQuoted.map((v) => ({
						value: v,
						label: v
					}));
				}
			}
		}
		if (p.description) {
			hint.help = p.description;
			if (p.default != null) hint.help += ` (default: ${String(p.default)})`;
		}
		if (p.sensitive) hint.placeholder = p.isSet ? "********  (already set)" : "Enter value...";
		else if (p.default) hint.placeholder = `Default: ${String(p.default)}`;
		hints[p.key] = hint;
	}
	return {
		schema: {
			type: "object",
			properties,
			required
		},
		hints
	};
}
/**
* Lucide name → component map. Entries declare their icon by Lucide
* component name in `render.icon` (PluginInfo.iconName); this map resolves
* that name to the actual React component at render time.
*/
const ICON_BY_LUCIDE_NAME = {
	Binary,
	Bird,
	BookOpen,
	Bot,
	Brain,
	BrickWall,
	Briefcase,
	Calendar,
	Chrome: Globe,
	Circle,
	CircleDashed,
	CircleDot,
	ClipboardList,
	Clock,
	Cloud,
	Command,
	Construction,
	CreditCard,
	Diamond,
	Dna,
	Eye,
	Feather,
	FileKey,
	FileText,
	Fingerprint,
	Gamepad,
	Gamepad2,
	GitBranch,
	Github: GitBranch,
	Globe,
	Handshake,
	Hash,
	Layers,
	Leaf,
	Link,
	Lock,
	LockKeyhole,
	Mail,
	MessageCircle,
	MessageSquare,
	MessagesSquare,
	Mic,
	Monitor,
	MousePointer2,
	Package,
	PenTool,
	Phone,
	Pickaxe,
	Puzzle,
	RefreshCw,
	Rss,
	ScrollText,
	Send,
	Server,
	Settings,
	Shell,
	Shuffle,
	Smartphone,
	Sparkle,
	Sparkles,
	Square,
	Star,
	StickyNote,
	Target,
	Tornado,
	TrendingDown,
	Triangle,
	Twitter: MessageCircle,
	Video,
	Volume2,
	Wallet,
	Webhook,
	Wrench,
	Zap
};
/** Resolve display icon. Order: explicit URL/emoji on PluginInfo.icon →
*  registry-provided Lucide name (PluginInfo.iconName) → null. */
function resolveIcon(p) {
	if (p.icon) return p.icon;
	if (p.iconName) return ICON_BY_LUCIDE_NAME[p.iconName] ?? null;
	return null;
}
function iconImageSource(icon) {
	const value = icon.trim();
	if (!value) return null;
	if (/^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i.test(value)) return resolveAppAssetUrl(value);
	return null;
}
function resolvePluginParamValue(plugin, key, draftConfig) {
	const draftValue = draftConfig?.[key]?.trim();
	if (draftValue) return draftValue;
	const param = plugin.parameters?.find((candidate) => candidate.key === key);
	if (!param || param.sensitive || !param.isSet) return null;
	const persistedValue = param.currentValue?.trim();
	return persistedValue ? persistedValue : null;
}
function buildDiscordInviteUrl(applicationId) {
	return `https://discord.com/oauth2/authorize?${new URLSearchParams({
		client_id: applicationId,
		permissions: DISCORD_INVITE_PERMISSIONS,
		scope: DISCORD_INVITE_SCOPES
	}).toString()}`;
}
function getPluginResourceLinks(plugin, options) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	if (plugin.id === "discord") {
		ordered.push({
			key: "discord-developer-portal",
			url: DISCORD_DEVELOPER_PORTAL_URL
		});
		const applicationId = resolvePluginParamValue(plugin, "DISCORD_APPLICATION_ID", options?.draftConfig);
		if (applicationId && /^\d+$/.test(applicationId)) ordered.push({
			key: "discord-invite",
			url: buildDiscordInviteUrl(applicationId)
		});
	}
	ordered.push({
		key: "guide",
		url: plugin.setupGuideUrl
	}, {
		key: "official",
		url: plugin.homepage
	}, {
		key: "source",
		url: plugin.repository
	});
	return ordered.flatMap((item) => {
		const url = item.url?.trim();
		if (!url || seen.has(url)) return [];
		seen.add(url);
		return [{
			key: item.key,
			url
		}];
	});
}
function pluginResourceLinkLabel(t, key) {
	if (key === "discord-developer-portal") return t("pluginsview.DiscordDeveloperPortal", { defaultValue: "Get your API token here" });
	if (key === "discord-invite") return t("pluginsview.DiscordInviteBot", { defaultValue: "Invite your agent" });
	if (key === "guide") return t("pluginsview.SetupGuide", { defaultValue: "Setup guide" });
	if (key === "official") return t("pluginsview.Official", { defaultValue: "Official" });
	return t("logsview.Source", { defaultValue: "Source" });
}
const SUBGROUP_DISPLAY_ORDER = [
	"ai-provider",
	"connector",
	"streaming",
	"voice",
	"blockchain",
	"devtools",
	"knowledge",
	"agents",
	"media",
	"automation",
	"storage",
	"gaming",
	"feature-other",
	"showcase"
];
const SUBGROUP_LABELS = {
	"ai-provider": "AI Providers",
	connector: "Connectors",
	voice: "Voice & Audio",
	blockchain: "Blockchain & Finance",
	devtools: "Dev Tools & Infrastructure",
	knowledge: "Knowledge & Memory",
	agents: "Agents & Orchestration",
	media: "Media & Content",
	automation: "Scheduling & Automation",
	storage: "Storage & Logging",
	gaming: "Gaming & Creative",
	"feature-other": "Other Features",
	streaming: "Streaming Destinations",
	showcase: "Showcase"
};
const SUBGROUP_NAV_ICONS = {
	all: Package,
	"ai-provider": Brain,
	connector: MessageCircle,
	streaming: Video,
	voice: Mic,
	blockchain: Wallet,
	devtools: Shell,
	knowledge: BookOpen,
	agents: Target,
	media: Eye,
	automation: Calendar,
	storage: Server,
	gaming: Gamepad2,
	"feature-other": Puzzle,
	showcase: Sparkles
};
function subgroupForPlugin(plugin) {
	if (plugin.id === "__ui-showcase__") return "showcase";
	if (plugin.group) return plugin.group;
	if (plugin.category === "ai-provider") return "ai-provider";
	if (plugin.category === "connector") return "connector";
	if (plugin.category === "streaming") return "streaming";
	return "feature-other";
}
function isPluginReady(plugin) {
	if (!plugin.enabled) return false;
	return !(plugin.parameters?.some((param) => param.required && !param.isSet) ?? false);
}
function comparePlugins(left, right) {
	const leftReady = isPluginReady(left);
	if (leftReady !== isPluginReady(right)) return leftReady ? -1 : 1;
	if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
	return (left.name ?? "").localeCompare(right.name ?? "");
}
function matchesPluginFilters(plugin, searchLower, statusFilter) {
	const matchesStatus = statusFilter === "all" || statusFilter === "enabled" && plugin.enabled || statusFilter === "disabled" && !plugin.enabled;
	const matchesSearch = !searchLower || (plugin.name ?? "").toLowerCase().includes(searchLower) || (plugin.description ?? "").toLowerCase().includes(searchLower) || (plugin.tags ?? []).some((tag) => (tag ?? "").toLowerCase().includes(searchLower)) || plugin.id.toLowerCase().includes(searchLower);
	return matchesStatus && matchesSearch;
}
function sortPlugins(filteredPlugins, pluginOrder, allowCustomOrder) {
	if (!allowCustomOrder || pluginOrder.length === 0) return [...filteredPlugins].sort(comparePlugins);
	const orderMap = new Map(pluginOrder.map((id, index) => [id, index]));
	return [...filteredPlugins].sort((left, right) => {
		const leftIndex = orderMap.get(left.id);
		const rightIndex = orderMap.get(right.id);
		if (leftIndex != null && rightIndex != null) return leftIndex - rightIndex;
		if (leftIndex != null) return -1;
		if (rightIndex != null) return 1;
		return comparePlugins(left, right);
	});
}
function buildPluginListState(options) {
	const { allowCustomOrder, effectiveSearch, effectiveStatusFilter, isConnectorLikeMode, mode, pluginOrder, plugins, showSubgroupFilters, subgroupFilter } = options;
	const categoryPlugins = plugins.filter((plugin) => plugin.category !== "database" && !ALWAYS_ON_PLUGIN_IDS.has(plugin.id) && (!isConnectorLikeMode || plugin.category === "connector" && plugin.visible !== false) && (mode !== "streaming" || plugin.category === "streaming"));
	const nonDbPlugins = [SHOWCASE_PLUGIN, ...categoryPlugins];
	const searchLower = typeof effectiveSearch === "string" ? effectiveSearch.toLowerCase() : "";
	const sorted = sortPlugins(categoryPlugins.filter((plugin) => matchesPluginFilters(plugin, searchLower, effectiveStatusFilter)), pluginOrder, allowCustomOrder);
	const subgroupCounts = {};
	const visiblePlugins = [];
	for (const plugin of sorted) {
		const subgroup = subgroupForPlugin(plugin);
		subgroupCounts[subgroup] = (subgroupCounts[subgroup] ?? 0) + 1;
		if (!showSubgroupFilters || subgroupFilter === "all" || subgroup === subgroupFilter) visiblePlugins.push(plugin);
	}
	return {
		nonDbPlugins,
		sorted,
		subgroupTags: [{
			id: "all",
			label: "All",
			count: sorted.length
		}, ...SUBGROUP_DISPLAY_ORDER.filter((subgroupId) => (subgroupCounts[subgroupId] ?? 0) > 0).map((subgroupId) => ({
			id: subgroupId,
			label: SUBGROUP_LABELS[subgroupId],
			count: subgroupCounts[subgroupId] ?? 0
		}))],
		visiblePlugins
	};
}

//#endregion
export { buildPluginListState as a, paramsToSchema as c, subgroupForPlugin as d, TELEGRAM_ALLOW_ALL_HIDDEN as i, pluginResourceLinkLabel as l, SUBGROUP_LABELS as n, getPluginResourceLinks as o, SUBGROUP_NAV_ICONS as r, iconImageSource as s, ALWAYS_ON_PLUGIN_IDS as t, resolveIcon as u };