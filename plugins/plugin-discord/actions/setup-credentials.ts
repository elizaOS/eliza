import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Action,
	type ActionExample,
	type ActionResult,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
} from "@elizaos/core";
import { ChannelType, type TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";
import {
	terminalActionInteractionSemantics,
	terminalActionResultData,
} from "./actionResultSemantics";

export interface CredentialPreset {
	name: string;
	displayName: string;
	fields: CredentialField[];
	helpUrl: string;
	helpText: string;
	validate: (
		credentials: Record<string, string>,
	) => Promise<{ valid: boolean; identity?: string; error?: string }>;
}

export interface CredentialField {
	key: string;
	label: string;
	secret: boolean;
}

const SAFE_PRESET_NAME_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const presets = new Map<string, CredentialPreset>();
const activeSessions = new Map<string, SetupSession>();

interface SetupSession {
	preset: CredentialPreset;
	currentFieldIndex: number;
	collected: Record<string, string>;
	channelId: string;
	startedAt: number;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCredentialsDir(): string {
	const configured = process.env.CREDENTIALS_DIR?.trim();
	if (configured) {
		return configured;
	}

	const home =
		(typeof os.homedir === "function" ? os.homedir() : "") ||
		process.env.HOME ||
		process.env.USERPROFILE;
	return home
		? path.join(home, ".credentials")
		: path.join(process.cwd(), ".credentials");
}

export function registerPreset(preset: CredentialPreset): void {
	const normalizedName = preset.name.trim().toLowerCase();
	if (!SAFE_PRESET_NAME_RE.test(normalizedName)) {
		throw new Error(
			`Invalid credential preset name "${preset.name}". Only letters, numbers, underscores, and hyphens are allowed.`,
		);
	}
	presets.set(normalizedName, { ...preset, name: normalizedName });
}

export function getPreset(name: string): CredentialPreset | undefined {
	return presets.get(name.toLowerCase());
}

export function listPresets(): string[] {
	return [...presets.keys()];
}

registerPreset({
	name: "github",
	displayName: "GitHub",
	fields: [{ key: "token", label: "Personal Access Token", secret: true }],
	helpUrl: "https://github.com/settings/tokens",
	helpText:
		"Create a fine-grained PAT at the link above. Give it the repository permissions you need.",
	async validate(credentials) {
		try {
			const response = await fetch("https://api.github.com/user", {
				headers: {
					Authorization: `Bearer ${credentials.token}`,
					Accept: "application/vnd.github+json",
				},
			});
			if (!response.ok) {
				return {
					valid: false,
					error: `GitHub returned ${response.status}`,
				};
			}
			const data = (await response.json()) as { login?: string };
			return {
				valid: true,
				identity: data.login ? `@${data.login}` : "verified",
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "vercel",
	displayName: "Vercel",
	fields: [{ key: "token", label: "API Token", secret: true }],
	helpUrl: "https://vercel.com/account/tokens",
	helpText: "Create a token at the link above. Full Account scope works best.",
	async validate(credentials) {
		try {
			const response = await fetch("https://api.vercel.com/v9/projects", {
				headers: { Authorization: `Bearer ${credentials.token}` },
			});
			if (!response.ok) {
				return {
					valid: false,
					error: `Vercel returned ${response.status}`,
				};
			}
			const data = (await response.json()) as {
				projects?: Array<{ name: string }>;
			};
			return {
				valid: true,
				identity: `${data.projects?.length ?? 0} project(s) accessible`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "cloudflare",
	displayName: "Cloudflare",
	fields: [
		{ key: "apiKey", label: "Global API Key", secret: true },
		{ key: "email", label: "Account Email", secret: false },
	],
	helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
	helpText:
		'Go to Cloudflare > Profile > API Tokens > "Global API Key". You will also need your account email.',
	async validate(credentials) {
		try {
			const response = await fetch(
				"https://api.cloudflare.com/client/v4/zones",
				{
					headers: {
						"X-Auth-Key": credentials.apiKey,
						"X-Auth-Email": credentials.email,
					},
				},
			);
			if (!response.ok) {
				return {
					valid: false,
					error: `Cloudflare returned ${response.status}`,
				};
			}
			const data = (await response.json()) as {
				result?: Array<{ name: string }>;
			};
			return {
				valid: true,
				identity:
					data.result && data.result.length > 0
						? `zones: ${data.result.map((zone) => zone.name).join(", ")}`
						: "verified",
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "anthropic",
	displayName: "Anthropic",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://console.anthropic.com/settings/keys",
	helpText: "Create an API key in the Anthropic console.",
	async validate(credentials) {
		try {
			// @duplicate-component-audit-allow: credential probe validates the key; response content is ignored.
			const response = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": credentials.apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-3-5-haiku-20241022",
					max_tokens: 1,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			if (response.ok || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `Anthropic returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "openai",
	displayName: "OpenAI",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://platform.openai.com/api-keys",
	helpText: "Create an API key at the OpenAI platform link above.",
	async validate(credentials) {
		try {
			const response = await fetch("https://api.openai.com/v1/models", {
				headers: { Authorization: `Bearer ${credentials.apiKey}` },
			});
			if (response.ok || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `OpenAI returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "fal",
	displayName: "fal.ai",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://fal.ai/dashboard/keys",
	helpText: "Generate an API key from your fal.ai dashboard.",
	async validate(credentials) {
		try {
			const response = await fetch("https://rest.fal.run/fal-ai/fast-sdxl", {
				method: "POST",
				headers: {
					Authorization: `Key ${credentials.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					prompt: "test",
					image_size: { width: 64, height: 64 },
					num_images: 1,
				}),
			});
			if (response.ok || response.status === 422 || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `fal.ai returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

registerPreset({
	name: "generic",
	displayName: "Custom Credential",
	fields: [
		{
			key: "envName",
			label: "environment variable name (for example MY_API_KEY)",
			secret: false,
		},
		{ key: "value", label: "value", secret: true },
	],
	helpUrl: "",
	helpText:
		"I'll store this as a generic credential. Give me the env var name and value.",
	async validate() {
		return { valid: true, identity: "stored (unvalidated)" };
	},
});

async function ensureCredentialsDir(): Promise<void> {
	await fs.promises.mkdir(getCredentialsDir(), {
		recursive: true,
		mode: 0o700,
	});
}

async function storeCredentials(
	service: string,
	credentials: Record<string, string>,
): Promise<void> {
	await ensureCredentialsDir();
	const filePath = path.join(getCredentialsDir(), `${service}.json`);
	await fs.promises.writeFile(filePath, JSON.stringify(credentials, null, 2), {
		mode: 0o600,
	});
}

export function loadCredentials(
	service: string,
): Record<string, string> | null {
	const filePath = path.join(getCredentialsDir(), `${service}.json`);
	if (!fs.existsSync(filePath)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
			string,
			string
		>;
	} catch {
		return null;
	}
}

function cleanExpiredSessions(): void {
	const now = Date.now();
	for (const [userId, session] of activeSessions) {
		if (now - session.startedAt > SESSION_TIMEOUT_MS) {
			activeSessions.delete(userId);
		}
	}
}

async function tryDeleteMessage(
	discordService: DiscordService,
	channelId: string,
	messageId: string,
	fieldName: string,
): Promise<boolean> {
	try {
		const client = discordService.client;
		if (!client) {
			return false;
		}
		const channel = await client.channels.fetch(channelId);
		if (!channel || !("messages" in channel)) {
			return false;
		}
		const message = await (channel as TextChannel).messages.fetch(messageId);
		await message.delete();
		return true;
	} catch (error) {
		logger.warn(
			{
				src: "setup-credentials",
				channelId,
				messageId,
				fieldName,
				error: error instanceof Error ? error.message : String(error),
			},
			"Could not delete Discord message containing a credential",
		);
		return false;
	}
}

const TRIGGER_PATTERNS = [
	/\bsetup\s+(github|vercel|cloudflare|anthropic|openai|fal|credentials?)\b/i,
	/\badd\s+(my\s+)?(api\s+)?key\b/i,
	/\badd\s+credentials?\b/i,
	/\bconfigure\s+(github|vercel|cloudflare|anthropic|openai|fal)\b/i,
	/\bconnect\s+(github|vercel|cloudflare|anthropic|openai|fal)\b/i,
	/^\/setup\b/i,
];

function detectSetupIntent(text: string): string | null | undefined {
	const lower = text.toLowerCase().trim();

	for (const presetName of presets.keys()) {
		if (presetName === "generic") {
			continue;
		}
		const pattern = new RegExp(
			`\\b(setup|configure|connect|add)\\s+(my\\s+)?${escapeRegex(presetName)}\\b`,
			"i",
		);
		if (pattern.test(lower)) {
			return presetName;
		}
	}

	const slashMatch = lower.match(/^\/setup\s+(\w+)/);
	if (slashMatch) {
		const service = slashMatch[1].toLowerCase();
		if (presets.has(service)) {
			return service;
		}
		if (service === "custom") {
			return "generic";
		}
	}

	for (const pattern of TRIGGER_PATTERNS) {
		if (pattern.test(lower)) {
			return null;
		}
	}

	return undefined;
}

function isSetupTrigger(text: string): boolean {
	return TRIGGER_PATTERNS.some((pattern) =>
		pattern.test(text.toLowerCase().trim()),
	);
}

function buildServiceListMessage(): string {
	const services = listPresets()
		.filter((presetName) => presetName !== "generic")
		.map((presetName) => {
			const preset = getPreset(presetName);
			return `- **${preset?.displayName ?? presetName}** (\`${presetName}\`)`;
		});
	return [
		"Which service do you want to set up? Here's what I support:",
		"",
		...services,
		"- **Custom** (`custom`) - any env var",
		"",
		"Just tell me the name, for example `github` or `custom`.",
	].join("\n");
}

function resolveDeletionTarget(
	message: Memory,
	defaultChannelId: string,
): { channelId: string; messageId?: string } {
	const contentRecord =
		message.content && typeof message.content === "object"
			? (message.content as Record<string, unknown>)
			: null;
	const metadataRecord =
		message.metadata && typeof message.metadata === "object"
			? (message.metadata as Record<string, unknown>)
			: null;

	const channelId =
		(typeof contentRecord?.channelId === "string" && contentRecord.channelId) ||
		(typeof metadataRecord?.discordChannelId === "string" &&
			metadataRecord.discordChannelId) ||
		defaultChannelId;
	const messageId =
		(typeof contentRecord?.messageId === "string" && contentRecord.messageId) ||
		(typeof metadataRecord?.discordMessageId === "string" &&
			metadataRecord.discordMessageId);
	return { channelId, messageId };
}

export const setupCredentials: Action = {
	name: "DISCORD_SETUP_CREDENTIALS",
	similes: [
		"DISCORD_SETUP",
		"DISCORD_PAIR",
		"DISCORD_CONNECT",
		"DISCORD_ADD_CREDENTIALS",
		"DISCORD_CONFIGURE_SERVICE",
		"DISCORD_CONNECT_SERVICE",
		"DISCORD_ADD_API_KEY",
		"DISCORD_SETUP_SERVICE",
	],
	description:
		"Start Discord credential setup or account pairing. Guides the user through setting up API credentials for supported third-party services, validates them when possible, and stores them securely.",
	descriptionCompressed: "Set up Discord credentials.",
	contexts: ["messaging", "connectors", "settings"],
	contextGate: { anyOf: ["messaging", "connectors", "settings"] },
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "service",
			description: "Third-party service to configure from Discord.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "credentials",
			description: "Credential values supplied by the user, when present.",
			required: false,
			schema: { type: "object" },
		},
	],
	...terminalActionInteractionSemantics,
	validate: async (_runtime, message) => {
		if (message.content.source !== "discord") {
			return false;
		}
		const text = message.content.text?.trim() ?? "";
		const userId = message.entityId as string;
		return activeSessions.has(userId) || isSetupTrigger(text);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		const discordService = runtime.getService(
			DISCORD_SERVICE_NAME,
		) as DiscordService | null;
		if (!discordService?.client) {
			if (callback) {
				await callback({
					text: "Discord service isn't available right now.",
					source: "discord",
				});
			}
			return { success: false, error: "Discord service unavailable" };
		}

		const text = message.content.text?.trim() ?? "";
		const userId = message.entityId as string;
		const room = state?.data?.room || (await runtime.getRoom(message.roomId));
		const channelId =
			((room as unknown as Record<string, unknown> | undefined)?.channelId as
				| string
				| undefined) || (message.roomId as string);

		cleanExpiredSessions();

		let isDm = false;
		try {
			const channel = await discordService.client.channels.fetch(channelId);
			isDm =
				channel?.type === ChannelType.DM ||
				channel?.type === ChannelType.GroupDM;
		} catch {
			isDm = false;
		}

		if (!isDm && !activeSessions.has(userId)) {
			if (callback) {
				await callback({
					text: "Let's do this in DMs for security. I'll message you there.",
					source: "discord",
				});
			}

			try {
				const discordUser = await discordService.client.users.fetch(userId);
				const dmChannel = await discordUser.createDM();
				const detectedService = detectSetupIntent(text);
				if (detectedService && presets.has(detectedService)) {
					const preset = presets.get(detectedService);
					if (!preset) {
						await dmChannel.send(buildServiceListMessage());
						return {
							success: false,
							error: `Unsupported credential preset: ${detectedService}`,
						};
					}
					activeSessions.set(userId, {
						preset,
						currentFieldIndex: 0,
						collected: {},
						channelId: dmChannel.id,
						startedAt: Date.now(),
					});
					const firstField = preset.fields[0];
					const helpLine = preset.helpUrl
						? `Here's where to get one: ${preset.helpUrl}`
						: "";
					await dmChannel.send(
						[
							`Setting up **${preset.displayName}** credentials.`,
							preset.helpText,
							helpLine,
							"",
							`Please paste your **${firstField.label}** here. ${firstField.secret ? "I'll delete your message right after reading it." : ""}`,
						]
							.filter(Boolean)
							.join("\n"),
					);
				} else {
					await dmChannel.send(buildServiceListMessage());
				}
			} catch (error) {
				logger.warn(
					{
						src: "setup-credentials",
						error: error instanceof Error ? error.message : String(error),
					},
					"Could not open DM with user",
				);
				if (callback) {
					await callback({
						text: "I couldn't send you a DM. Make sure your DMs are open, then try again.",
						source: "discord",
					});
				}
			}

			return {
				success: true,
				text: "Redirected credential setup to DMs",
				data: terminalActionResultData(),
			};
		}

		if (activeSessions.has(userId)) {
			const session = activeSessions.get(userId);
			if (!session) {
				return { success: false, error: "Credential session not found" };
			}
			const currentField = session.preset.fields[session.currentFieldIndex];

			if (currentField.secret) {
				const deletionTarget = resolveDeletionTarget(message, channelId);
				if (deletionTarget.messageId) {
					const deleted = await tryDeleteMessage(
						discordService,
						deletionTarget.channelId,
						deletionTarget.messageId,
						currentField.label,
					);
					if (!deleted) {
						logger.warn(
							{
								src: "setup-credentials",
								fieldName: currentField.label,
								channelId: deletionTarget.channelId,
								messageId: deletionTarget.messageId,
							},
							"Credential message could not be deleted automatically",
						);
					}
				}
			}

			session.collected[currentField.key] = text;
			session.currentFieldIndex += 1;

			if (session.currentFieldIndex < session.preset.fields.length) {
				const nextField = session.preset.fields[session.currentFieldIndex];
				if (callback) {
					await callback({
						text: `Got it. Now paste your **${nextField.label}**${nextField.secret ? " (I'll delete your message)" : ""}.`,
						source: "discord",
					});
				}
				return {
					success: true,
					text: "Collecting next credential field",
					data: terminalActionResultData(),
				};
			}

			if (callback) {
				await callback({
					text: "Validating your credentials...",
					source: "discord",
				});
			}

			const validation = await session.preset.validate(session.collected);
			if (validation.valid) {
				const storageKey =
					session.preset.name === "generic"
						? (session.collected.envName ?? "custom")
								.toLowerCase()
								.replace(/[^a-z0-9_-]/g, "_")
						: session.preset.name;
				await storeCredentials(storageKey, session.collected);
				activeSessions.delete(userId);
				if (callback) {
					await callback({
						text: `Connected${validation.identity ? ` as ${validation.identity}` : ""}. **${session.preset.displayName}** is ready.`,
						source: "discord",
					});
				}
				return {
					success: true,
					text: "Credentials stored",
					data: terminalActionResultData(),
				};
			}

			activeSessions.delete(userId);
			if (callback) {
				await callback({
					text: `Validation failed: ${validation.error ?? "unknown error"}. Please check your credentials and try again with \`/setup ${session.preset.name}\`.`,
					source: "discord",
				});
			}
			return {
				success: false,
				error: validation.error ?? "Validation failed",
			};
		}

		const detectedService = detectSetupIntent(text);
		if (detectedService && presets.has(detectedService)) {
			const preset = presets.get(detectedService);
			if (!preset) {
				return {
					success: false,
					error: `Unsupported credential preset: ${detectedService}`,
				};
			}
			activeSessions.set(userId, {
				preset,
				currentFieldIndex: 0,
				collected: {},
				channelId,
				startedAt: Date.now(),
			});

			const firstField = preset.fields[0];
			const helpLine = preset.helpUrl
				? `Here's where to get one: ${preset.helpUrl}`
				: "";
			if (callback) {
				await callback({
					text: [
						`Setting up **${preset.displayName}** credentials.`,
						preset.helpText,
						helpLine,
						"",
						`Please paste your **${firstField.label}** here. ${firstField.secret ? "I'll delete your message right after reading it." : ""}`,
					]
						.filter(Boolean)
						.join("\n"),
					source: "discord",
				});
			}
			return {
				success: true,
				text: `Started ${preset.displayName} setup`,
				data: terminalActionResultData(),
			};
		}

		const serviceName = text.toLowerCase().trim();
		if (presets.has(serviceName) || serviceName === "custom") {
			const presetKey = serviceName === "custom" ? "generic" : serviceName;
			const preset = presets.get(presetKey);
			if (!preset) {
				return {
					success: false,
					error: `Unsupported credential preset: ${presetKey}`,
				};
			}
			activeSessions.set(userId, {
				preset,
				currentFieldIndex: 0,
				collected: {},
				channelId,
				startedAt: Date.now(),
			});
			const firstField = preset.fields[0];
			const helpLine = preset.helpUrl
				? `Here's where to get one: ${preset.helpUrl}`
				: "";
			if (callback) {
				await callback({
					text: [
						`Setting up **${preset.displayName}** credentials.`,
						preset.helpText,
						helpLine,
						"",
						`Please paste your **${firstField.label}** here. ${firstField.secret ? "I'll delete your message right after reading it." : ""}`,
					]
						.filter(Boolean)
						.join("\n"),
					source: "discord",
				});
			}
			return {
				success: true,
				text: `Started ${preset.displayName} setup`,
				data: terminalActionResultData(),
			};
		}

		if (callback) {
			await callback({
				text: buildServiceListMessage(),
				source: "discord",
			});
		}
		return {
			success: true,
			text: "Showed credential setup service list",
			data: terminalActionResultData(),
		};
	},
	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "setup github" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Setting up **GitHub** credentials.\nCreate a fine-grained PAT at the link above.\nHere's where to get one: https://github.com/settings/tokens\n\nPlease paste your **Personal Access Token** here. I'll delete your message right after reading it.",
					action: "DISCORD_SETUP_CREDENTIALS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "add my vercel key" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Setting up **Vercel** credentials.\nCreate a token at the link above.\nHere's where to get one: https://vercel.com/account/tokens\n\nPlease paste your **API Token** here. I'll delete your message right after reading it.",
					action: "DISCORD_SETUP_CREDENTIALS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "/setup" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Which service do you want to set up? I support GitHub, Vercel, Cloudflare, Anthropic, OpenAI, fal.ai, or a custom credential.",
					action: "DISCORD_SETUP_CREDENTIALS",
				},
			},
		],
	] as ActionExample[][],
};

export default setupCredentials;
