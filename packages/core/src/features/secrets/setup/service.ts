/**
 * Setup Service
 *
 * Manages the secrets first-run setup across platforms (Discord, Telegram, etc.)
 * Supports both conversational and form-based collection modes.
 *
 * Integrates with the SetupStateMachine for
 * consistent state management across CLI and conversational interfaces.
 */

import { logger } from "../../../logger.ts";
import {
	isSetupComplete as isStateMachineComplete,
	SetupStateMachine,
	type SetupStateMachineConfig,
} from "../../../services/setup-state.ts";
import type {
	IAgentRuntime,
	Memory,
	SerializedSetupState,
	ServiceTypeName,
	SetupContext,
	SetupStep,
	UUID,
	World,
	WorldMetadata,
} from "../../../types/index.ts";
import { Service } from "../../../types/index.ts";
import type { SecretsService } from "../services/secrets.ts";
import type { SecretContext } from "../types.ts";
import {
	DEFAULT_SETUP_MESSAGES,
	getNextSetting,
	getUnconfiguredRequired,
	isSetupComplete,
	type SetupConfig,
	type SetupSetting,
} from "./config.ts";

export const SETUP_SERVICE_TYPE = "SECRETS_SETUP" as ServiceTypeName;

interface TelegramDeepLinkService {
	messageManager: {
		sendMessage(chatId: string | number, msg: { text: string }): Promise<void>;
	};
}

function isTelegramDeepLinkService(
	service: unknown,
): service is TelegramDeepLinkService {
	return (
		typeof service === "object" &&
		service !== null &&
		"messageManager" in service &&
		typeof service.messageManager === "object" &&
		service.messageManager !== null &&
		"sendMessage" in service.messageManager &&
		typeof service.messageManager.sendMessage === "function"
	);
}

/**
 * Extended WorldMetadata for setup
 */
interface SetupWorldMetadata extends WorldMetadata {
	setupConfig?: SetupConfig;
	/** Serialized state machine state for persistence */
	setupStateMachine?: SerializedSetupState;
}

/**
 * Setup session state.
 */
interface SetupSession {
	worldId: UUID;
	userId: UUID;
	roomId: UUID;
	config: SetupConfig;
	currentSettingKey: string | null;
	startedAt: number;
	lastActivityAt: number;
	platform: "discord" | "telegram" | "other";
	mode: "conversational" | "form" | "hybrid";
	/** state machine instance */
	stateMachine?: SetupStateMachine;
}

/**
 * Setup Service for secrets collection.
 */
export class SetupService extends Service {
	static serviceType: ServiceTypeName = SETUP_SERVICE_TYPE;
	capabilityDescription = "Manage secrets setup across chat platforms";

	private secretsService: SecretsService | null = null;
	private sessions: Map<UUID, SetupSession> = new Map();
	/** State machine instances keyed by worldId */
	private stateMachines: Map<UUID, SetupStateMachine> = new Map();

	/**
	 * Start the service
	 */
	static async start(runtime: IAgentRuntime): Promise<SetupService> {
		const service = new SetupService(runtime);
		await service.initialize();
		return service;
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		logger.info("[SetupService] Starting");

		// Get secrets service
		this.secretsService = this.runtime.getService("SECRETS") as SecretsService;

		// Register platform events
		this.registerEvents();

		logger.info("[SetupService] Started");
	}

	async stop(): Promise<void> {
		logger.info("[SetupService] Stopping");
		this.sessions.clear();
		this.stateMachines.clear();
		logger.info("[SetupService] Stopped");
	}

	/**
	 * Get or create a state machine for a specific world.
	 * This ensures state is persisted per world and can resume across restarts.
	 */
	async getOrCreateStateMachine(
		worldId: UUID,
		userId?: UUID,
		platform: "discord" | "telegram" | "other" = "other",
	): Promise<SetupStateMachine> {
		// Check if we already have a state machine for this world
		const existing = this.stateMachines.get(worldId);
		if (existing) {
			return existing;
		}

		// Try to restore from world metadata
		const world = await this.runtime.getWorld(worldId);
		const metadata = world?.metadata as SetupWorldMetadata | undefined;
		const savedState = metadata?.setupStateMachine;

		const config: SetupStateMachineConfig = {
			platform,
			mode: "conversational",
			worldId,
			userId,
			onStepChange: async (oldStep, newStep, _context) => {
				logger.info(
					`[SetupService] Step changed: ${oldStep} -> ${newStep} for world ${worldId}`,
				);
				// Persist state on each step change
				await this.persistStateMachine(worldId);
			},
			onComplete: async (_context) => {
				logger.info(`[SetupService] Setup complete for world ${worldId}`);
				// Final persistence
				await this.persistStateMachine(worldId);
			},
			onError: (error, _context) => {
				logger.error(
					{ error, worldId },
					`[SetupService] Setup error: ${error.message}`,
				);
			},
		};

		let stateMachine: SetupStateMachine;

		if (savedState) {
			// Restore from saved state
			logger.info(
				`[SetupService] Restoring state machine for world ${worldId}`,
			);
			stateMachine = SetupStateMachine.fromJSON(savedState, config);
		} else {
			// Create new state machine
			logger.info(
				`[SetupService] Creating new state machine for world ${worldId}`,
			);
			stateMachine = new SetupStateMachine(config);
		}

		this.stateMachines.set(worldId, stateMachine);
		return stateMachine;
	}

	/**
	 * Persist the state machine state to world metadata.
	 */
	private async persistStateMachine(worldId: UUID): Promise<void> {
		const stateMachine = this.stateMachines.get(worldId);
		if (!stateMachine) {
			return;
		}

		const world = await this.runtime.getWorld(worldId);
		if (!world) {
			logger.warn(
				`[SetupService] Cannot persist state machine - world ${worldId} not found`,
			);
			return;
		}

		const metadata = (world.metadata || {}) as SetupWorldMetadata;
		metadata.setupStateMachine = stateMachine.toJSON();
		world.metadata = metadata;

		await this.runtime.updateWorld(world);
		logger.debug(`[SetupService] Persisted state machine for world ${worldId}`);
	}

	/**
	 * Get the current setup step from the state machine.
	 */
	getSetupStep(worldId: UUID): SetupStep | null {
		const stateMachine = this.stateMachines.get(worldId);
		return stateMachine?.getCurrentStep() ?? null;
	}

	/**
	 * Get the full setup context from the state machine.
	 */
	getSetupContext(worldId: UUID): SetupContext | null {
		const stateMachine = this.stateMachines.get(worldId);
		return stateMachine?.getContext() ?? null;
	}

	/**
	 * Check if setup is complete via the state machine.
	 */
	isStateMachineComplete(worldId: UUID): boolean {
		const stateMachine = this.stateMachines.get(worldId);
		if (!stateMachine) {
			return false;
		}
		return isStateMachineComplete(stateMachine.getContext());
	}

	/**
	 * Register platform-specific event handlers.
	 */
	private registerEvents(): void {
		// Discord: Bot joins a server
		this.runtime.registerEvent("DISCORD_WORLD_JOINED", async (params) => {
			const server = (params as { server?: { id: string } }).server;
			if (server) {
				logger.info(`[SetupService] Discord world joined: ${server.id}`);
			}
			// Setup will be triggered when owner sends DM
		});

		// Discord: Server connected (bot already in server)
		this.runtime.registerEvent("DISCORD_SERVER_CONNECTED", async (params) => {
			const server = (params as { server?: { id: string } }).server;
			if (server) {
				logger.info(`[SetupService] Discord server connected: ${server.id}`);
			}
		});

		// Telegram: Bot joins a group
		this.runtime.registerEvent("TELEGRAM_WORLD_JOINED", async (params) => {
			const typedParams = params as {
				world?: World;
				entities?: Array<{
					metadata?: {
						telegram?: { id: string; username: string; adminTitle?: string };
					};
				}>;
				chat?: { id: string | number };
				botUsername?: string;
			};
			if (
				typedParams.world &&
				typedParams.chat &&
				typedParams.entities &&
				typedParams.botUsername
			) {
				logger.info(
					`[SetupService] Telegram world joined: ${typedParams.world.id}`,
				);
				await this.startTelegramSetup(
					typedParams.world,
					typedParams.chat,
					typedParams.entities,
					typedParams.botUsername,
				);
			}
		});
	}

	/**
	 * Initialize setup for a world with the given config.
	 */
	async initializeSetup(world: World, config: SetupConfig): Promise<void> {
		logger.info(`[SetupService] Initializing setup for world: ${world.id}`);

		// Store config in world metadata
		if (!world.metadata) {
			world.metadata = {} as SetupWorldMetadata;
		}

		// Initialize settings state from config
		const settingsState: Record<string, SetupSetting> = {};
		for (const [key, setting] of Object.entries(config.settings)) {
			settingsState[key] = {
				...setting,
				value: null,
			};
		}

		// Store settings using dynamic property access
		const metadata = world.metadata as SetupWorldMetadata;
		(metadata as Record<string, unknown>).settings = settingsState;
		metadata.setupConfig = config;

		await this.runtime.updateWorld(world);
		logger.info(`[SetupService] Setup initialized for world: ${world.id}`);
	}

	/**
	 * Start setup via DM (Discord).
	 */
	async startDiscordSetupDM(
		serverId: string,
		ownerId: string,
		worldId: UUID,
		config: SetupConfig,
	): Promise<void> {
		const messages = config.messages?.welcome || DEFAULT_SETUP_MESSAGES.welcome;
		const _randomMessage =
			messages[Math.floor(Math.random() * messages.length)];

		// This would be called by the Discord plugin after it sends the DM
		// The actual DM sending is done by the Discord plugin
		logger.info(
			`[SetupService] Discord DM setup started - server: ${serverId}, owner: ${ownerId}, world: ${worldId}`,
		);
	}

	/**
	 * Start setup via deep link (Telegram).
	 */
	async startTelegramSetup(
		_world: World,
		chat: { id: string | number },
		entities: Array<{
			metadata?: {
				telegram?: { id: string; username: string; adminTitle?: string };
			};
		}>,
		botUsername: string,
	): Promise<void> {
		// Find the owner
		let ownerId: string | null = null;
		let ownerUsername: string | null = null;

		for (const entity of entities) {
			if (entity.metadata?.telegram?.adminTitle === "Owner") {
				ownerId = entity.metadata.telegram.id;
				ownerUsername = entity.metadata.telegram.username;
				break;
			}
		}

		if (!ownerId) {
			logger.warn("[SetupService] No owner found for Telegram group");
			return;
		}

		// Send deep link message to group
		const telegramService = this.runtime.getService("telegram");

		if (isTelegramDeepLinkService(telegramService)) {
			const deepLinkMessage = [
				`Hello @${ownerUsername}! Could we take a few minutes to get everything set up?`,
				`Please click this link to start chatting with me: https://t.me/${botUsername}?start=setup`,
			].join(" ");

			await telegramService.messageManager.sendMessage(chat.id, {
				text: deepLinkMessage,
			});
			logger.info(
				`[SetupService] Sent Telegram deep link - chatId: ${chat.id}, ownerId: ${ownerId}`,
			);
		}
	}

	/**
	 * Start a new setup session.
	 */
	async startSession(
		worldId: UUID,
		userId: UUID,
		roomId: UUID,
		config: SetupConfig,
		platform: "discord" | "telegram" | "other" = "other",
		mode: "conversational" | "form" | "hybrid" = "conversational",
	): Promise<SetupSession> {
		// Get or create state machine for this world
		const stateMachine = await this.getOrCreateStateMachine(
			worldId,
			userId,
			platform,
		);

		const session: SetupSession = {
			worldId,
			userId,
			roomId,
			config,
			currentSettingKey: null,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			platform,
			mode,
			stateMachine,
		};

		this.sessions.set(roomId, session);
		logger.info(
			`[SetupService] Session started - roomId: ${roomId}, worldId: ${worldId}, userId: ${userId}, step: ${stateMachine.getCurrentStep()}`,
		);

		return session;
	}

	/**
	 * Get an active session by room ID.
	 */
	getSession(roomId: UUID): SetupSession | null {
		return this.sessions.get(roomId) || null;
	}

	/**
	 * Process a user message during setup.
	 */
	async processMessage(
		roomId: UUID,
		message: Memory,
	): Promise<{
		shouldRespond: boolean;
		response?: string;
		updatedKey?: string;
		complete?: boolean;
	}> {
		const session = this.sessions.get(roomId);
		if (!session) {
			return { shouldRespond: false };
		}

		session.lastActivityAt = Date.now();

		// Get current state
		const unconfigured = getUnconfiguredRequired(session.config);

		if (unconfigured.length === 0) {
			// All required settings configured
			return {
				shouldRespond: true,
				response:
					session.config.messages?.allComplete ||
					DEFAULT_SETUP_MESSAGES.allComplete,
				complete: true,
			};
		}

		// Try to extract a setting value from the message
		const text = message.content.text || "";
		const currentSetting = session.currentSettingKey
			? session.config.settings[session.currentSettingKey]
			: null;

		// If we have a current setting being asked, try to match the response
		if (currentSetting && text.trim()) {
			const value = text.trim();
			const currentSettingKey = session.currentSettingKey;
			if (!currentSettingKey) {
				return {
					shouldRespond: true,
					response:
						"I lost track of which setting I was collecting. Let's try that again.",
				};
			}

			// Validate if validation exists
			if (currentSetting.validation && !currentSetting.validation(value)) {
				return {
					shouldRespond: true,
					response: `That doesn't look like a valid ${currentSetting.name}. ${currentSetting.usageDescription || "Please try again."}`,
				};
			}

			// Store the value
			if (this.secretsService) {
				const context: SecretContext = {
					level: "world",
					agentId: this.runtime.agentId,
					worldId: session.worldId,
					userId: session.userId,
					requesterId: session.userId,
				};

				await this.secretsService.set(currentSettingKey, value, context, {
					description: currentSetting.description,
					type: currentSetting.type,
					encrypted: currentSetting.secret,
				});
			}

			// Update local state
			session.config.settings[currentSettingKey].value = value;

			// Check if complete
			if (isSetupComplete(session.config)) {
				this.sessions.delete(roomId);
				return {
					shouldRespond: true,
					response:
						session.config.messages?.allComplete ||
						DEFAULT_SETUP_MESSAGES.allComplete,
					updatedKey: currentSettingKey,
					complete: true,
				};
			}

			// Get next setting
			const next = getNextSetting(session.config);
			if (next) {
				const [nextKey, nextSetting] = next;
				session.currentSettingKey = nextKey;

				const askMessage = (
					session.config.messages?.askSetting ||
					DEFAULT_SETUP_MESSAGES.askSetting
				)
					.replace("{{settingName}}", nextSetting.name)
					.replace(
						"{{usageDescription}}",
						nextSetting.usageDescription || nextSetting.description,
					);

				// Parenthesize like askMessage above: without this the `.replace`
				// binds only to the DEFAULT, so a custom `messages.settingUpdated`
				// containing {{settingName}} shipped the raw placeholder.
				const settingUpdatedMessage = (
					session.config.messages?.settingUpdated ||
					DEFAULT_SETUP_MESSAGES.settingUpdated
				).replace("{{settingName}}", currentSetting.name);

				return {
					shouldRespond: true,
					response: `${settingUpdatedMessage}\n\n${askMessage}`,
					// The key just answered — session.currentSettingKey was reassigned
					// to nextKey above, so report the local captured before the ask
					// (matches the completion branch, which returns currentSettingKey).
					updatedKey: currentSettingKey,
				};
			}
		}

		// Start asking for the first/next setting
		const next = getNextSetting(session.config);
		if (next) {
			const [nextKey, nextSetting] = next;
			session.currentSettingKey = nextKey;

			const askMessage = (
				session.config.messages?.askSetting || DEFAULT_SETUP_MESSAGES.askSetting
			)
				.replace("{{settingName}}", nextSetting.name)
				.replace(
					"{{usageDescription}}",
					nextSetting.usageDescription || nextSetting.description,
				);

			return {
				shouldRespond: true,
				response: askMessage,
			};
		}

		return { shouldRespond: false };
	}

	/**
	 * End an setup session.
	 */
	endSession(roomId: UUID): void {
		this.sessions.delete(roomId);
		logger.info(`[SetupService] Session ended - roomId: ${roomId}`);
	}

	/**
	 * Get the first-run status for a world.
	 */
	async getFirstRunStatus(worldId: UUID): Promise<{
		initialized: boolean;
		complete: boolean;
		configuredCount: number;
		requiredCount: number;
		missingRequired: string[];
	}> {
		const world = await this.runtime.getWorld(worldId);

		if (!world?.metadata?.settings) {
			return {
				initialized: false,
				complete: false,
				configuredCount: 0,
				requiredCount: 0,
				missingRequired: [],
			};
		}

		const settings = world.metadata.settings as Record<string, SetupSetting>;
		const entries = Object.entries(settings);

		const required = entries.filter(([_, s]) => s.required);
		const configured = required.filter(([_, s]) => s.value !== null);
		const missing = required
			.filter(([_, s]) => s.value === null)
			.map(([k, _]) => k);

		return {
			initialized: true,
			complete: missing.length === 0,
			configuredCount: configured.length,
			requiredCount: required.length,
			missingRequired: missing,
		};
	}

	/**
	 * Generate the SETTINGS provider context for LLM.
	 */
	generateSettingsContext(
		config: SetupConfig,
		isSetup: boolean,
		agentName: string,
	): string {
		const entries = Object.entries(config.settings);
		const unconfigured = getUnconfiguredRequired(config);

		const settingsList = entries
			.map(([key, setting]) => {
				const _status = setting.value !== null ? "Configured" : "Not set";
				const required = setting.required ? "(Required)" : "(Optional)";
				const value =
					setting.secret && setting.value
						? "****************"
						: setting.value || "Not set";

				return `${key}: ${value} ${required}\n(${setting.name}) ${setting.usageDescription || setting.description}`;
			})
			.join("\n\n");

		const validKeys = `Valid setting keys: ${entries.map(([k, _]) => k).join(", ")}`;

		if (isSetup && unconfigured.length > 0) {
			return `# PRIORITY TASK: Setup

${agentName} needs to help the user configure ${unconfigured.length} required settings:

${settingsList}

${validKeys}

Instructions for ${agentName}:
- Only update settings if the user is clearly responding to a setting you are currently asking about.
- If the user's reply clearly maps to a secrets setup setting and a valid value, you **must** call the SECRETS_UPDATE_SETTINGS action.
- Never hallucinate settings or respond with values not listed above.
- Prioritize configuring required settings before optional ones.`;
		}

		return `## Current Configuration
${unconfigured.length > 0 ? `IMPORTANT: ${unconfigured.length} required settings still need configuration.\n\n` : "All required settings are configured.\n\n"}${settingsList}`;
	}
}
