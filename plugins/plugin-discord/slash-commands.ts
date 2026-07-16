/**
 * Slash-command registry and dispatcher — `addCommand` registers a
 * `SlashCommand`, and the dispatcher routes an incoming interaction to the
 * matching command's `execute` handler after role-access checks.
 */
import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type HandlerCallback,
	hasRoleAccess,
	type IAgentRuntime,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type {
	AutocompleteInteraction,
	ChatInputCommandInteraction,
} from "discord.js";
import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";
import { getPreset, listPresets } from "./actions/setup-credentials";
import { checkDiscordDmAccess } from "./dm-access";
import { getDiscordSettings } from "./environment";
import { chunkDiscordText } from "./messaging";
import type { DiscordSlashCommand } from "./types";
import { getMessageService } from "./utils";
import type { VoiceManager } from "./voice";

export type SlashCommandRole = "OWNER" | "ADMIN" | "USER" | "GUEST";

export interface SlashCommand {
	name: string;
	description: string;
	options?: SlashCommandOption[];
	ephemeral?: boolean;
	cooldown?: number;
	ownerOnly?: boolean;
	/** Minimum elizaOS role required to execute this command. */
	requiredRole?: SlashCommandRole;
	/** Discord permission bitfield for `default_member_permissions` —
	 * hides the command from pickers of members lacking it. Execute-time
	 * `requiredRole` (the eliza role model) remains the actual gate. */
	requiredPermissions?: bigint | string | null;
	execute: (
		interaction: ChatInputCommandInteraction,
		runtime: IAgentRuntime,
	) => Promise<void>;
	autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/** Context resolved by the Discord service before dispatching built-in commands. */
export interface SlashCommandContext {
	entityId: string;
	roomId: string;
}

async function replyEphemeral(
	interaction: ChatInputCommandInteraction,
	content: string,
): Promise<void> {
	if (interaction.deferred) {
		await interaction.editReply({ content });
		return;
	}
	if (!interaction.replied) {
		await interaction.reply({ content, ephemeral: true });
	}
}

export interface SlashCommandOption {
	name: string;
	description: string;
	type: "string" | "number" | "boolean" | "user" | "channel" | "role";
	required?: boolean;
	choices?: Array<{ name: string; value: string }>;
	autocomplete?: boolean;
}

const OPTION_TYPE_MAP: Record<string, number> = {
	string: ApplicationCommandOptionType.String,
	number: ApplicationCommandOptionType.Number,
	boolean: ApplicationCommandOptionType.Boolean,
	user: ApplicationCommandOptionType.User,
	channel: ApplicationCommandOptionType.Channel,
	role: ApplicationCommandOptionType.Role,
};

const commands = new Map<string, SlashCommand>();
const cooldowns = new Map<string, Map<string, number>>();

const helpCommand: SlashCommand = {
	name: "help",
	description: "Show available commands and usage information",
	ephemeral: true,
	async execute(interaction) {
		const lines: string[] = ["**Available Commands**\n"];
		for (const [name, command] of commands) {
			const options = command.options
				? command.options
						.map((option) =>
							option.required ? `<${option.name}>` : `[${option.name}]`,
						)
						.join(" ")
				: "";
			lines.push(
				`/${name}${options ? ` ${options}` : ""} - ${command.description}`,
			);
		}
		await interaction.reply({ content: lines.join("\n"), ephemeral: true });
	},
};

const statusCommand: SlashCommand = {
	name: "status",
	description: "Show the bot's current status and uptime",
	ephemeral: true,
	requiredRole: "USER",
	async execute(interaction, runtime) {
		const uptimeMs = process.uptime() * 1000;
		const hours = Math.floor(uptimeMs / 3_600_000);
		const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
		const seconds = Math.floor((uptimeMs % 60_000) / 1000);
		const memoryUsage = process.memoryUsage();
		const heapMb = (memoryUsage.heapUsed / 1024 / 1024).toFixed(1);
		const rssMb = (memoryUsage.rss / 1024 / 1024).toFixed(1);

		await interaction.reply({
			content: [
				"**Bot Status**",
				`- Agent: **${runtime.character?.name ?? "Unknown"}**`,
				`- Uptime: **${hours}h ${minutes}m ${seconds}s**`,
				`- Memory: **${heapMb} MB** heap / **${rssMb} MB** RSS`,
				`- Guilds: **${interaction.client.guilds.cache.size}**`,
				`- Node: **${process.version}**`,
				`- Platform: **${process.platform}**`,
			].join("\n"),
			ephemeral: true,
		});
	},
};

const searchCommand: SlashCommand = {
	name: "search",
	description: "Search conversation history in this channel",
	requiredRole: "USER",
	options: [
		{
			name: "query",
			description: "The search term or phrase",
			type: "string",
			required: true,
		},
		{
			name: "limit",
			description: "Maximum results to return (default: 5)",
			type: "number",
		},
	],
	ephemeral: true,
	cooldown: 10,
	async execute(interaction, runtime) {
		const query = interaction.options.getString("query", true);
		const limit = interaction.options.getNumber("limit") || 5;
		await interaction.deferReply({ ephemeral: true });

		try {
			const roomId = createUniqueUuid(runtime, interaction.channelId);
			const memories = await runtime.getMemories({
				tableName: "messages",
				roomId,
				count: 100,
			});
			const normalizedQuery = query.trim().toLowerCase();
			const filteredMemories = memories.filter((memory) =>
				(memory.content?.text ?? "").toLowerCase().includes(normalizedQuery),
			);

			if (filteredMemories.length === 0) {
				await interaction.editReply({
					content: `No results found for **"${query}"**`,
				});
				return;
			}

			const results = filteredMemories.slice(0, limit).map((memory, index) => {
				const text = memory.content?.text || "(no text)";
				const truncated = text.length > 120 ? `${text.slice(0, 120)}...` : text;
				const date = memory.createdAt
					? new Date(memory.createdAt).toLocaleDateString()
					: "unknown date";
				return `**${index + 1}.** ${truncated}\n_${date}_`;
			});

			await interaction.editReply({
				content: `**Search results for "${query}"**\n\n${results.join("\n\n")}`,
			});
		} catch (error) {
			await interaction.editReply({
				content: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	},
};

const settingsCommand: SlashCommand = {
	name: "settings",
	description: "View the current Discord bot settings",
	requiredRole: "ADMIN",
	// Hide from the pickers of members who lack the Discord permission —
	// execute-time `hasRoleAccess` (the eliza role model) stays the actual
	// gate; this only sets default_member_permissions so privileged plumbing
	// doesn't clutter every member's command list. Server admins can re-grant
	// visibility per-role under Server Settings → Integrations as usual.
	requiredPermissions: PermissionFlagsBits.ManageGuild,
	options: [
		{
			name: "action",
			description: "What to do",
			type: "string",
			required: true,
			choices: [
				{ name: "View current settings", value: "view" },
				{ name: "Toggle response-only-on-mention", value: "toggle-mention" },
				{ name: "Toggle ignore-bots", value: "toggle-ignore-bots" },
			],
		},
	],
	ephemeral: true,
	async execute(interaction, runtime) {
		const action = interaction.options.getString("action", true);
		if (action === "view") {
			await interaction.reply({
				content: [
					"**Current Settings**",
					`- Respond only to mentions: **${runtime.getSetting("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS") ?? "false"}**`,
					`- Ignore bot messages: **${runtime.getSetting("DISCORD_SHOULD_IGNORE_BOT_MESSAGES") ?? "true"}**`,
					`- Allowed channels: **${runtime.getSetting("CHANNEL_IDS") ?? "(all channels)"}**`,
					`- Agent name: **${runtime.character?.name ?? "Unknown"}**`,
				].join("\n"),
				ephemeral: true,
			});
			return;
		}

		const content =
			action === "toggle-mention"
				? "Respond-only-on-mention is controlled by `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS`. Update the setting and restart to change it."
				: "Ignore-bots is controlled by `DISCORD_SHOULD_IGNORE_BOT_MESSAGES`. Update the setting and restart to change it.";
		await interaction.reply({ content, ephemeral: true });
	},
};

const setupCommand: SlashCommand = {
	name: "setup",
	description: "Set up API credentials for third-party services",
	requiredRole: "OWNER",
	// Owner-level credential plumbing — visible only to Administrator members.
	requiredPermissions: PermissionFlagsBits.Administrator,
	options: [
		{
			name: "service",
			description:
				"Service to configure (github, vercel, cloudflare, anthropic, openai, fal, custom)",
			type: "string",
			choices: [
				{ name: "GitHub", value: "github" },
				{ name: "Vercel", value: "vercel" },
				{ name: "Cloudflare", value: "cloudflare" },
				{ name: "Anthropic", value: "anthropic" },
				{ name: "OpenAI", value: "openai" },
				{ name: "fal.ai", value: "fal" },
				{ name: "Custom", value: "custom" },
			],
		},
	],
	ephemeral: true,
	async execute(interaction) {
		const service = interaction.options.getString("service");
		if (!service) {
			const services = listPresets()
				.filter((presetName) => presetName !== "generic")
				.map((presetName) => {
					const preset = getPreset(presetName);
					return `- **${preset?.displayName ?? presetName}** - \`/setup service:${presetName}\``;
				});
			await interaction.reply({
				content: [
					"**Credential Setup**",
					"Choose a service to configure:",
					"",
					...services,
					"- **Custom** - `/setup service:custom`",
					"",
					"I'll walk you through it in DMs to keep your keys safe.",
				].join("\n"),
				ephemeral: true,
			});
			return;
		}

		await interaction.reply({
			content: `Starting **${service}** setup. Check your DMs - I'll walk you through it there to keep your keys private.`,
			ephemeral: true,
		});

		try {
			const dmChannel = await interaction.user.createDM();
			const presetKey = service === "custom" ? "generic" : service;
			const preset = getPreset(presetKey);
			if (!preset) {
				await dmChannel.send(
					`I don't have a preset for "${service}". Try \`/setup\` to see available services.`,
				);
				return;
			}

			const field = preset.fields[0];
			const helpLine = preset.helpUrl
				? `Here's where to get one: ${preset.helpUrl}`
				: "";
			await dmChannel.send(
				[
					`Setting up **${preset.displayName}** credentials.`,
					preset.helpText,
					helpLine,
					"",
					`Please paste your **${field.label}** here. ${field.secret ? "I'll delete your message right after reading it." : ""}`,
					"",
					"(Type `cancel` to abort setup)",
				]
					.filter(Boolean)
					.join("\n"),
			);
		} catch {
			try {
				await interaction.followUp({
					content:
						"I couldn't send you a DM. Make sure your DMs are open and try again.",
					ephemeral: true,
				});
			} catch {
				// Ignore expired follow-ups.
			}
		}
	},
};

/** Label on the embedded-app launch link. */
const APP_LAUNCH_LABEL = "Open Eliza App";

/**
 * Resolve the embedded-app `/embed` launch URL (#9947). Reads the explicit
 * `ELIZA_EMBED_URL` if set, otherwise derives `<web base>/embed` from
 * `ELIZA_APP_URL` / `ELIZA_CLOUD_URL`. Returns `undefined` when nothing is
 * configured or the resolved URL is not absolute `https`.
 */
function resolveEmbedLaunchUrl(runtime: IAgentRuntime): string | undefined {
	const direct = runtime.getSetting("ELIZA_EMBED_URL");
	if (typeof direct === "string" && direct.trim().length > 0) {
		return toHttpsUrl(direct.trim(), "discord");
	}
	const base =
		runtime.getSetting("ELIZA_APP_URL") ||
		runtime.getSetting("ELIZA_CLOUD_URL");
	if (typeof base === "string" && base.trim().length > 0) {
		return toHttpsUrl(`${base.trim().replace(/\/+$/, "")}/embed`, "discord");
	}
	return undefined;
}

/** Return the URL only when it parses as absolute `https`, else `undefined`. */
function toHttpsUrl(url: string, platform: "discord"): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:") return undefined;
	if (parsed.pathname === "/" || parsed.pathname === "") {
		parsed.pathname = "/embed";
	}
	parsed.searchParams.set("platform", platform);
	return parsed.toString();
}

/**
 * `/app` — role-gated embedded-app (Discord Activity) launch. The handler maps
 * the Discord user to the runtime entity the rest of the pipeline uses and
 * gates on the core role model: only an ADMIN-or-above member receives the
 * `/embed` launch link; everyone else gets an ephemeral denial. The launch
 * itself (minting a scoped session via `verifyEmbedLaunch`) needs live creds
 * and happens after the user opens the link — this command only emits it.
 */
const appCommand: SlashCommand = {
	name: "app",
	description: "Launch the embedded Eliza app (admins only)",
	ephemeral: true,
	requiredRole: "ADMIN",
	requiredPermissions: PermissionFlagsBits.ManageGuild,
	async execute(interaction, runtime) {
		const memory: Memory = {
			id: createUniqueUuid(runtime, `${interaction.id}-app`) as UUID,
			entityId: createUniqueUuid(runtime, interaction.user.id) as UUID,
			agentId: runtime.agentId,
			roomId: createUniqueUuid(
				runtime,
				interaction.channelId || interaction.user.id,
			) as UUID,
			content: { text: "/app", source: "discord" },
			createdAt: Date.now(),
		};

		const elevated = await hasRoleAccess(runtime, memory, "ADMIN");
		if (!elevated) {
			await interaction.reply({
				content:
					"You need at least **ADMIN** role to launch the embedded Eliza app.",
				ephemeral: true,
			});
			return;
		}

		const url = resolveEmbedLaunchUrl(runtime);
		if (!url) {
			await interaction.reply({
				content:
					"The embedded app is not configured. Set `ELIZA_EMBED_URL` (or `ELIZA_APP_URL`).",
				ephemeral: true,
			});
			return;
		}

		await interaction.reply({
			content: `[${APP_LAUNCH_LABEL}](${url})`,
			ephemeral: true,
		});
	},
};

/** Resolve the dashboard Transcripts view URL when a public base is set. */
function resolveTranscriptsViewUrl(runtime: IAgentRuntime): string | undefined {
	const base =
		runtime.getSetting("ELIZA_APP_URL") ||
		runtime.getSetting("ELIZA_CLOUD_URL");
	if (typeof base === "string" && base.trim().length > 0) {
		return toHttpsUrl(
			`${base.trim().replace(/\/+$/, "")}/transcripts`,
			"discord",
		);
	}
	return undefined;
}

/**
 * `/transcribe start|stop` — live diarized meeting transcription for the
 * voice channel the bot is currently connected to in this server. Start sets
 * a per-channel override (so it works regardless of the global
 * DISCORD_VOICE_TRANSCRIPTS setting) and begins a meeting session; stop
 * finalizes the transcript record.
 */
const transcribeCommand: SlashCommand = {
	name: "transcribe",
	description:
		"Start or stop live meeting transcription for the current voice channel",
	// Recording a voice channel is a consent-sensitive mutation — gate it to
	// ADMIN, matching the other mutating commands (settings/app).
	requiredRole: "ADMIN",
	requiredPermissions: PermissionFlagsBits.ManageGuild,
	options: [
		{
			name: "mode",
			description: "start or stop transcription",
			type: "string",
			required: true,
			choices: [
				{ name: "start", value: "start" },
				{ name: "stop", value: "stop" },
			],
		},
	],
	async execute(interaction, runtime) {
		const guild = interaction.guild;
		if (!guild || !interaction.guildId) {
			await interaction.reply({
				content: "This command can only be used in a server.",
				ephemeral: true,
			});
			return;
		}

		const service = runtime.getService("discord") as {
			voiceManager?: VoiceManager;
		} | null;
		const voiceManager = service?.voiceManager;
		if (!voiceManager) {
			await interaction.reply({
				content: "Voice support is not available right now.",
				ephemeral: true,
			});
			return;
		}

		const connection = voiceManager.getVoiceConnection(interaction.guildId);
		const channelId = connection?.joinConfig.channelId;
		if (!channelId) {
			await interaction.reply({
				content:
					"I'm not in a voice channel in this server — invite me to one first.",
				ephemeral: true,
			});
			return;
		}

		const mode = interaction.options.get("mode")?.value;
		if (mode === "start") {
			await interaction.deferReply();
			const channel = guild.channels.cache.get(channelId);
			if (!channel?.isVoiceBased?.()) {
				await interaction.editReply("Voice channel not found.");
				return;
			}
			voiceManager.setVoiceTranscriptionOverride(channelId, true);
			try {
				const session = await voiceManager.startVoiceTranscription(channel);
				const url = resolveTranscriptsViewUrl(runtime);
				const where = url
					? `[Transcripts view](${url})`
					: "dashboard **Transcripts** view";
				await interaction.editReply(
					`🔴 Live transcription started for **${channel.name}** — follow it in the ${where} (transcript \`${session.transcriptId}\`).`,
				);
			} catch (error) {
				voiceManager.setVoiceTranscriptionOverride(channelId, false);
				runtime.logger.error(
					{
						src: "plugin:discord:voice:meetings",
						agentId: runtime.agentId,
						channelId,
						error: error instanceof Error ? error.message : String(error),
					},
					"[DiscordVoiceMeetings] /transcribe start failed",
				);
				await interaction.editReply("Failed to start transcription.");
			}
			return;
		}

		if (mode === "stop") {
			await interaction.deferReply();
			const session = voiceManager.getMeetingSession(channelId);
			voiceManager.setVoiceTranscriptionOverride(channelId, false);
			if (!session) {
				await interaction.editReply(
					"No live transcription is running in this channel.",
				);
				return;
			}
			await voiceManager.stopVoiceTranscription(channelId, "requested_stop");
			const url = resolveTranscriptsViewUrl(runtime);
			const where = url
				? `[Transcripts view](${url})`
				: "dashboard **Transcripts** view";
			await interaction.editReply(
				`⏹️ Transcription stopped — the finished transcript \`${session.transcriptId}\` is in the ${where}.`,
			);
			return;
		}

		await interaction.reply({
			content: "Use `/transcribe mode:start` or `/transcribe mode:stop`.",
			ephemeral: true,
		});
	},
};

/**
 * `/ask <message>` — route free text to the agent and return its reply as the
 * interaction response. This is the ONLY way to talk to the agent where the
 * connector cannot read the message stream: group DMs and DMs-with-others,
 * which a user-installed app receives as interactions but never as messages.
 * It also works in servers and bot DMs, giving a command handle to the agent
 * everywhere. Not guild-only, so it inherits group-DM availability when
 * `DISCORD_USER_INSTALL` is on.
 */
const askCommand: SlashCommand = {
	name: "ask",
	description: "Ask the agent a question and get a reply",
	cooldown: 10,
	options: [
		{
			name: "message",
			description: "What you want to ask or say",
			type: "string",
			required: true,
		},
	],
	async execute(interaction, runtime) {
		const text = interaction.options.getString("message", true).trim();
		if (!text) {
			await interaction.reply({
				content: "Ask me something — the message can't be empty.",
				ephemeral: true,
			});
			return;
		}
		if (!interaction.inGuild()) {
			const access = await checkDiscordDmAccess(
				runtime,
				getDiscordSettings(runtime),
				interaction.user,
			);
			if (!access.allowed) {
				await interaction.reply({
					content:
						access.replyMessage ??
						"Direct messages are not available for this account.",
					ephemeral: true,
				});
				return;
			}
		}

		const messageService = getMessageService(runtime);
		if (!messageService) {
			await interaction.reply({
				content: "The agent runtime isn't ready to answer right now.",
				ephemeral: true,
			});
			return;
		}

		// The agent turn takes seconds; acknowledge within Discord's 3s window
		// and edit the deferred reply once the answer is composed.
		await interaction.deferReply();

		const channelId = interaction.channelId ?? interaction.user.id;
		const entityId = createUniqueUuid(runtime, interaction.user.id);
		const roomId = createUniqueUuid(runtime, channelId);
		// core's ChannelType has no guild-text variant; DiscordService.getChannelType
		// (service.ts) maps every guild text/news/thread/forum channel to GROUP, so
		// this matches that convention rather than inventing a guild-only value.
		const channelType = interaction.inGuild()
			? ChannelType.GROUP
			: ChannelType.DM;

		await runtime.ensureConnection({
			entityId,
			roomId,
			userName: interaction.user.username,
			name: interaction.user.displayName ?? interaction.user.username,
			source: "discord",
			channelId,
			type: channelType,
			worldId: createUniqueUuid(runtime, interaction.guildId ?? channelId),
			worldName: interaction.guild?.name,
			// Preserve the raw Discord user id in source metadata for role and
			// allowlist checks (see the "Discord ID Handling" note in service.ts and
			// the matching cast in messages.ts's ensureConnection call).
			userId: interaction.user.id as UUID,
		});

		const message: Memory = {
			id: createUniqueUuid(runtime, `${interaction.id}-ask`),
			entityId,
			agentId: runtime.agentId,
			roomId,
			content: {
				text,
				source: "discord",
				channelType,
			},
			createdAt: Date.now(),
		};

		const replies: string[] = [];
		const callback: HandlerCallback = async (response: Content) => {
			if (typeof response.text === "string" && response.text.trim()) {
				replies.push(response.text);
			}
			return [];
		};

		await messageService.handleMessage(runtime, message, callback);

		const answer = replies.join("\n\n").trim();
		if (!answer) {
			await interaction.editReply(
				"I processed that but didn't have anything to say back.",
			);
			return;
		}

		// Discord caps a message at 2000 chars; the first chunk edits the
		// deferred reply, the rest follow up in the same thread.
		const chunks = chunkDiscordText(answer);
		await interaction.editReply(chunks[0] ?? answer.slice(0, 2000));
		for (const chunk of chunks.slice(1)) {
			await interaction.followUp(chunk);
		}
	},
};

function registerBuiltins(): void {
	for (const command of [
		askCommand,
		helpCommand,
		statusCommand,
		searchCommand,
		settingsCommand,
		setupCommand,
		appCommand,
		transcribeCommand,
	]) {
		commands.set(command.name, command);
	}
}

registerBuiltins();

function toDiscordSlashCommand(command: SlashCommand): DiscordSlashCommand {
	const options = command.options?.map((option) => ({
		name: option.name,
		description: option.description,
		type: OPTION_TYPE_MAP[option.type] ?? ApplicationCommandOptionType.String,
		required: option.required ?? false,
		...(option.choices ? { choices: option.choices } : {}),
		...(option.autocomplete ? { autocomplete: option.autocomplete } : {}),
	}));

	return {
		name: command.name,
		description: command.description,
		options,
		// Without this the admin gate (default_member_permissions) configured on
		// a built-in never reaches transformCommandToDiscordApi — every gated
		// command registered as usable by everyone.
		...(command.requiredPermissions != null
			? { requiredPermissions: command.requiredPermissions }
			: {}),
	};
}

export async function registerSlashCommands(
	runtime: IAgentRuntime,
): Promise<void> {
	const registered = [...commands.values()].map(toDiscordSlashCommand);
	runtime.logger.info(
		{
			src: "slash-commands",
			count: registered.length,
			names: [...commands.keys()],
		},
		"Registering built-in slash commands",
	);

	await runtime.emitEvent(
		["DISCORD_REGISTER_COMMANDS"] as string[],
		{
			runtime,
			source: "discord",
			commands: registered,
		} as never,
	);
}

export async function handleSlashCommand(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
	context?: SlashCommandContext,
): Promise<void> {
	const command = commands.get(interaction.commandName);
	if (!command) {
		return;
	}

	if (command.cooldown && command.cooldown > 0) {
		const userId = interaction.user.id;
		let commandCooldowns = cooldowns.get(command.name);
		if (!commandCooldowns) {
			commandCooldowns = new Map<string, number>();
			cooldowns.set(command.name, commandCooldowns);
		}

		const lastUsed = commandCooldowns.get(userId);
		const now = Date.now();
		if (lastUsed && now - lastUsed < command.cooldown * 1000) {
			const remaining = Math.ceil(
				(command.cooldown * 1000 - (now - lastUsed)) / 1000,
			);
			await interaction.reply({
				content: `Please wait **${remaining}s** before using \`/${command.name}\` again.`,
				ephemeral: true,
			});
			return;
		}

		commandCooldowns.set(userId, now);
		setTimeout(() => {
			if (commandCooldowns?.get(userId) === now) {
				commandCooldowns.delete(userId);
			}
		}, command.cooldown * 1000);
	}

	// One canonical role gate through hasRoleAccess for both `requiredRole` and
	// `ownerOnly` — ownerOnly means the elizaOS OWNER role, and OWNER outranks
	// every other role, so the single highest requirement covers commands that
	// set both. Slash commands are a privileged surface: missing dispatch
	// context or a throwing role backend denies, and the denial reply stays
	// outside the try so a failed reply can never convert a deny into an
	// execute (it propagates to the interaction boundary in discord-events.ts).
	const requiredRole: SlashCommandRole | undefined = command.ownerOnly
		? "OWNER"
		: command.requiredRole && command.requiredRole !== "GUEST"
			? command.requiredRole
			: undefined;
	if (requiredRole) {
		if (!context) {
			runtime.logger.warn(
				{
					src: "slash-commands",
					commandName: command.name,
					requiredRole,
				},
				"Role-gated slash command missing dispatch context",
			);
			await replyEphemeral(
				interaction,
				`Unable to verify your **${requiredRole}** role for \`/${command.name}\`.`,
			);
			return;
		}

		let allowed = false;
		// error-policy:J1 role-backend failure translates to an explicit deny at
		// the slash-command gate; it never falls through to execution.
		try {
			const memory = {
				entityId: context.entityId,
				roomId: context.roomId,
				content: { text: `/${command.name}`, source: "discord" },
			} satisfies Pick<Memory, "entityId" | "roomId" | "content">;
			allowed = await hasRoleAccess(runtime, memory as Memory, requiredRole);
		} catch (error) {
			runtime.logger.warn(
				{
					src: "slash-commands",
					commandName: command.name,
					requiredRole,
					error: error instanceof Error ? error.message : String(error),
				},
				"Role check failed; denying slash command",
			);
		}
		if (!allowed) {
			await replyEphemeral(
				interaction,
				`You need at least **${requiredRole}** role to use \`/${command.name}\`.`,
			);
			return;
		}
	}

	try {
		await command.execute(interaction, runtime);
	} catch (error) {
		const content = `An error occurred while running \`/${command.name}\`: ${error instanceof Error ? error.message : String(error)}`;
		runtime.logger.error(
			{
				src: "slash-commands",
				commandName: command.name,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error executing slash command",
		);
		try {
			if (interaction.deferred) {
				await interaction.editReply({ content });
			} else if (!interaction.replied) {
				await interaction.reply({ content, ephemeral: true });
			}
		} catch {
			// Interaction may already be closed.
		}
	}
}

export async function handleAutocomplete(
	interaction: AutocompleteInteraction,
): Promise<void> {
	const command = commands.get(interaction.commandName);
	if (!command?.autocomplete) {
		await interaction.respond([]);
		return;
	}

	try {
		await command.autocomplete(interaction);
	} catch {
		try {
			await interaction.respond([]);
		} catch {
			// Ignore expired autocomplete interactions.
		}
	}
}

export function getRegisteredCommands(): ReadonlyMap<string, SlashCommand> {
	return commands;
}

export function addCommand(command: SlashCommand): void {
	commands.set(command.name, command);
}

export function removeCommand(name: string): boolean {
	return commands.delete(name);
}
