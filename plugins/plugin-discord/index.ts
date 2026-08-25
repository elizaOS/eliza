/**
 * Plugin definition and public barrel for `@elizaos/plugin-discord`. `init`
 * registers the connector account provider, reads the Discord env vars, and
 * prints the startup banner; the exported `Plugin` wires the `services` and
 * `routes` arrays that make up this connector's surface. No actions or
 * providers are registered — all behavior flows through services and
 * `DiscordEventTypes` events.
 */
import {
	ElizaError,
	getConnectorAccountManager,
	type IAgentRuntime,
	logger,
	type Plugin,
	ServiceType,
} from "@elizaos/core";
import { printBanner } from "./banner";
import { createDiscordConnectorAccountProvider } from "./connector-account-provider";
import { DISCORD_SERVICE_NAME } from "./constants";
import * as discordCoordinationSchema from "./coordination-schema";
import { discordDataRoutes } from "./data-routes";
import { DiscordLocalService } from "./discord-local-service";
import { registerDiscordTargetSource } from "./discord-target-source";
import {
	type InstallationLifecycleService,
	registerDiscordInstallationContribution,
} from "./installation-adapter";
import { DiscordOwnerPairingServiceImpl } from "./owner-pairing-service";
import { getPermissionValues } from "./permissions";
import { registerDiscordDmSensitiveRequestAdapter } from "./sensitive-request-adapter";
import { DiscordService } from "./service";
import { discordSetupRoutes } from "./setup-routes";
import { DiscordTestSuite } from "./tests";
import { registerDiscordTriageAdapter } from "./triage-adapter";
import { DiscordUserAccountScraperImpl } from "./user-account-scraper/service";

const discordPlugin: Plugin = {
	name: "discord",
	description:
		"Discord service plugin for integration with Discord servers and channels",
	connectorSources: [
		{
			source: "discord",
			aliases: ["discord", "discord-local"],
			sourceKind: "passive",
			isPassive: true,
		},
	],
	// DiscordLocalService is the desktop IPC mode: it self-gates on
	// DISCORD_LOCAL_CLIENT_ID / DISCORD_LOCAL_CLIENT_SECRET and stays dormant
	// otherwise, so bot-API mode and local mode coexist in one plugin.
	services: [
		DiscordService,
		DiscordLocalService,
		DiscordOwnerPairingServiceImpl,
		DiscordUserAccountScraperImpl,
	],
	routes: [...discordSetupRoutes, ...discordDataRoutes],
	actions: [],
	providers: [],
	schema: discordCoordinationSchema,
	tests: [new DiscordTestSuite()],
	autoEnable: {
		connectorKeys: ["discord"],
	},
	init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
		try {
			const manager = getConnectorAccountManager(runtime);
			manager.registerProvider(createDiscordConnectorAccountProvider(runtime));
		} catch (err) {
			logger.warn(
				{
					src: "plugin:discord",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register Discord provider with ConnectorAccountManager",
			);
		}

		registerDiscordDmSensitiveRequestAdapter(runtime);

		// Register the cross-connector triage adapter for the "discord" source.
		registerDiscordTriageAdapter();

		// Register the Discord target-source enumerator so the host's
		// connector-target-catalog can surface guild/channel quick-picks.
		registerDiscordTargetSource(runtime);

		const token = runtime.getSetting("DISCORD_API_TOKEN") as string;
		const botTokens = runtime.getSetting("DISCORD_BOT_TOKENS") as string;
		const applicationId = runtime.getSetting(
			"DISCORD_APPLICATION_ID",
		) as string;
		const voiceChannelId = runtime.getSetting(
			"DISCORD_VOICE_CHANNEL_ID",
		) as string;
		const channelIds = runtime.getSetting("CHANNEL_IDS") as string;
		const listenChannelIds = runtime.getSetting(
			"DISCORD_LISTEN_CHANNEL_IDS",
		) as string;
		const ignoreBotMessages = runtime.getSetting(
			"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
		) as string;
		const ignoreDirectMessages = runtime.getSetting(
			"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
		) as string;
		const respondOnlyToMentions = runtime.getSetting(
			"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
		) as string;

		// Canonical installation lifecycle (#23107): register the Discord
		// contribution so the core lifecycle service can answer scope and
		// activation queries for Discord groups. Runs after the settings reads
		// so the tiered invite-URL activation is built from
		// DISCORD_APPLICATION_ID. Service startup only completes after the
		// runtime's init barrier resolves, and plugin init runs INSIDE that
		// barrier — awaiting the load promise here would deadlock the boot, so
		// the registration is fire-and-forget: a sync getService attempt now
		// (covers an already-started service), then a load-promise callback
		// for the normal asynchronous start. Never throws into plugin init.
		try {
			registerDiscordInstallationContribution(
				runtime,
				typeof applicationId === "string" ? applicationId : null,
			);
		} catch (err) {
			// error-policy:J4 user-facing degrade — the ONLY degraded shape is
			// a malformed-contribution ElizaError carrying
			// INSTALLATION_INVALID_CONTRIBUTION from registration-time
			// validation; it degrades Discord install diagnostics to the
			// manual-activation path and surfaces as a missing contribution on
			// diagnostic reads. Any other error (including other ElizaErrors)
			// is a bug and rethrows to fail fast.
			if (
				!(
					err instanceof ElizaError &&
					err.code === "INSTALLATION_INVALID_CONTRIBUTION"
				)
			) {
				throw err;
			}
			logger.warn(
				{
					src: "plugin:discord",
					err: err instanceof Error ? err.message : String(err),
				},
				"Installation contribution sync registration failed; deferring to service load",
			);
		}
		runtime
			.getServiceLoadPromise(ServiceType.INSTALLATION)
			.then((service) => {
				registerDiscordInstallationContribution(
					runtime,
					typeof applicationId === "string" ? applicationId : null,
					service as InstallationLifecycleService,
				);
			})
			.catch((err) => {
				// error-policy:J4 user-facing degrade — the degraded shape is
				// the service-load failure itself (service never starts; the
				// promise rejects): Discord install diagnostics fall back to
				// truthful manual steps and the connector keeps running. A
				// registration-time ElizaError from inside the .then is NOT
				// this shape, so it is re-reported (not absorbed) via
				// reportError for diagnostics while boot continues.
				if (err instanceof ElizaError) {
					// error-policy:J7 diagnostics must not kill the loop —
					// surfaced through the runtime error channel, observed
					// nowhere else.
					runtime.reportError("plugin:discord:installation-contribution", err);
					return;
				}
				logger.warn(
					{
						src: "plugin:discord",
						err: err instanceof Error ? err.message : String(err),
					},
					"Installation lifecycle service unavailable; contribution not registered",
				);
			});

		printBanner({
			pluginName: "plugin-discord",
			description: "Discord bot integration for servers and channels",
			applicationId: applicationId || undefined,
			discordPermissions: applicationId ? getPermissionValues() : undefined,
			settings: [
				{
					name: "DISCORD_API_TOKEN",
					value: token,
					sensitive: true,
					required: true,
				},
				{
					name: "DISCORD_APPLICATION_ID",
					value: applicationId,
				},
				{
					name: "DISCORD_BOT_TOKENS",
					value: botTokens,
					sensitive: true,
				},
				{
					name: "DISCORD_VOICE_CHANNEL_ID",
					value: voiceChannelId,
				},
				{
					name: "CHANNEL_IDS",
					value: channelIds,
				},
				{
					name: "DISCORD_LISTEN_CHANNEL_IDS",
					value: listenChannelIds,
				},
				{
					name: "DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
					value: ignoreBotMessages,
					defaultValue: "true",
				},
				{
					name: "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
					value: ignoreDirectMessages,
					defaultValue: "true",
				},
				{
					name: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
					value: respondOnlyToMentions,
					defaultValue: "true",
				},
			],
			runtime,
		});

		if (
			(!token || token.trim() === "") &&
			(!botTokens || botTokens.trim() === "")
		) {
			logger.warn(
				"Discord bot token not provided - Discord plugin is loaded but will not be functional",
			);
			logger.warn(
				"To enable Discord functionality, provide DISCORD_API_TOKEN or DISCORD_BOT_TOKENS in your .env file",
			);
		}
	},
	async dispose(runtime: IAgentRuntime) {
		const svc = runtime.getService<DiscordService>(DISCORD_SERVICE_NAME);
		await svc?.stop();
	},
};

export default discordPlugin;

// Account management exports (runtime utilities)
export {
	DEFAULT_ACCOUNT_ID,
	type DiscordMultiAccountConfig,
	type DiscordTokenResolution,
	type DiscordTokenSource,
	isMultiAccountEnabled,
	listDiscordAccountIds,
	listEnabledDiscordAccounts,
	normalizeAccountId,
	normalizeDiscordToken,
	type ResolvedDiscordAccount,
	resolveDefaultDiscordAccountId,
	resolveDiscordAccount,
	resolveDiscordToken,
} from "./accounts";
// Allowlist exports
export {
	type AllowListMatchSource,
	allowListMatches,
	type ChannelMatchSource,
	type DiscordAllowList,
	type DiscordAllowListMatch,
	type DiscordChannelConfigResolved,
	formatDiscordUserTag,
	isDiscordAutoThreadOwnedByBot,
	isDiscordGroupAllowedByPolicy,
	normalizeDiscordAllowList,
	normalizeDiscordSlug,
	resolveDiscordAllowListMatch,
	resolveDiscordChannelConfig,
	resolveDiscordChannelConfigWithFallback,
	resolveDiscordCommandAuthorized,
	resolveDiscordGuildEntry,
	resolveDiscordShouldRequireMention,
	resolveDiscordUserAllowed,
	resolveGroupDmAllow,
	shouldEmitDiscordReactionNotification,
	validateMessageAllowed,
} from "./allowlist";
export {
	DEFAULT_DISCORD_AUDIO_LANES,
	DISCORD_AUDIO_LANE_AMBIENT,
	DISCORD_AUDIO_LANE_MUSIC,
	DISCORD_AUDIO_LANE_SFX,
	DISCORD_AUDIO_LANE_TTS,
	type DiscordAudioLane,
	type DiscordAudioLaneConfig,
	getDiscordAudioLaneConfig,
	normalizeDiscordAudioLane,
} from "./audio-lanes";
export type {
	DiscordAudioPlaybackHandle,
	DiscordAudioSinkPlayOptions,
	DiscordAudioSinkStatus,
	IDiscordAudioSink,
} from "./audio-sink";
// Channel configuration types (comprehensive config schema)
// Re-export config types that were in accounts.ts for backward compatibility
export type {
	DiscordAccountConfig,
	DiscordActionConfig,
	DiscordChannelConfig,
	DiscordConfig,
	DiscordDmConfig,
	DiscordExecApprovalConfig,
	DiscordGuildChannelConfig,
	DiscordGuildEntry,
	DiscordIntentsConfig,
	DiscordPluralKitConfig,
	DiscordReactionNotificationMode,
} from "./config";
export { DISCORD_SERVICE_NAME } from "./constants";
export { discordDataRoutes } from "./data-routes";
export {
	buildDiscordAvatarCacheFileName,
	cacheDiscordAvatarUrl,
	getDiscordAvatarCacheDir,
	getDiscordAvatarCachePath,
	getDiscordAvatarPublicPath,
	isDiscordAvatarUrl,
} from "./discord-avatar-cache";
// Discord local IPC service (desktop / local mode)
export {
	DISCORD_LOCAL_SERVICE_NAME,
	DiscordLocalService,
} from "./discord-local-service";
export {
	cacheDiscordAvatarForRuntime,
	isCanonicalDiscordSource,
	resolveDiscordMessageAuthorProfile,
	resolveDiscordRoomProfile,
	resolveDiscordUserProfile,
	resolveStoredDiscordEntityProfile,
} from "./discord-profiles";
export {
	GUILD_MANAGEMENT_OPERATIONS,
	GuildManagementError,
	type GuildManagementGates,
	type GuildManagementOperation,
	type GuildManagementReceipt,
	type GuildManagementRequest,
	normalizeGuildManagementOperation,
	resolveGuildManagementGates,
} from "./guild-management";
export {
	BUILT_IN_GUILD_TEMPLATES,
	type GuildTemplate,
	type GuildTemplateChannel,
	type GuildTemplateRole,
	validateGuildTemplate,
} from "./guild-templates";
// Messaging utilities exports
export {
	buildChannelLink,
	buildMessageLink,
	type ChunkDiscordTextOpts,
	chunkDiscordText,
	chunkDiscordTextWithMode,
	escapeDiscordMarkdown,
	extractAllChannelMentions,
	extractAllRoleMentions,
	extractAllUserMentions,
	extractChannelIdFromMention,
	extractRoleIdFromMention,
	extractUserIdFromMention,
	formatDiscordChannelMention,
	formatDiscordReactionEmoji,
	formatDiscordRoleMention,
	formatDiscordTimestamp,
	formatDiscordUserMention,
	formatMessageReactionEmoji,
	messageContainsMention,
	parseMessageLink,
	resolveDiscordSystemLocation,
	resolveTimestampMs,
	sanitizeThreadName,
	stripDiscordFormatting,
	truncateText,
	truncateUtf16Safe,
} from "./messaging";
// Native commands utilities exports
export {
	type BuiltCommandOption,
	buildCommandArgCustomId,
	buildCommandArgMenu,
	buildCommandText,
	buildDiscordCommandOptions,
	buildDiscordSlashCommand,
	COMMAND_ARG_CUSTOM_ID_KEY,
	type CommandArgButton,
	type CommandArgButtonRow,
	type CommandArgDefinition,
	type CommandArgMenu,
	type CommandArgs,
	type CommandArgValues,
	createCommandArgs,
	decodeCommandArgValue,
	encodeCommandArgValue,
	isUnknownInteractionError,
	type NativeCommandSpec,
	parseCommandArgCustomId,
	safeInteractionCall,
	serializeCommandArgs,
} from "./native-commands";
export {
	DISCORD_OWNER_PAIRING_SERVICE_TYPE,
	type DiscordOwnerPairingService,
	DiscordOwnerPairingServiceImpl,
} from "./owner-pairing-service";
export {
	ELEVATED_PERMISSIONS,
	hasElevatedPermissions,
	isElevatedRole,
} from "./permissionEvents";
export {
	type DiscordPermissionTier,
	DiscordPermissionTiers,
	type DiscordPermissionValues,
	generateAllInviteUrls,
	generateInviteUrl,
	getPermissionValues,
} from "./permissions";
export type { DiscordService as IDiscordService } from "./service";
export { DiscordService } from "./service";
export { discordSetupRoutes } from "./setup-routes";
// Message-triage adapter (registered at init; exported for tests/consumers)
export { DiscordTriageAdapter, mapDiscordMemoryToRef } from "./triage-adapter";
export type {
	AuditInfo,
	ChannelPermissionsChangedPayload,
	MemberRolesChangedPayload,
	PermissionDiff,
	PermissionState,
	RoleLifecyclePayload,
	RolePermissionsChangedPayload,
} from "./types";
export { DiscordEventTypes } from "./types";
export {
	buildDiscordProbeScript,
	captureDiscordDeliveryStatus,
	closeDiscordTab,
	DISCORD_APP_URL,
	DISCORD_PROVIDER_ID,
	DISCORD_USER_ACCOUNT_SCRAPER_SERVICE_TYPE,
	type DiscordDesktopCdpStatus,
	type DiscordDmInboxProbe,
	type DiscordMessageSearchResult,
	type DiscordTabIdentity,
	type DiscordTabProbe,
	type DiscordUserAccountScraper,
	DiscordUserAccountScraperImpl,
	type DiscordVisibleDmPreview,
	discordBrowserWorkspaceAvailable,
	discordUserAccountPartitionFor,
	emptyDiscordDmInboxProbe,
	ensureDiscordTab,
	getDiscordDesktopCdpStatus,
	navigateDiscordTabToHome,
	probeDiscordCapturedPage,
	probeDiscordDocumentState,
	probeDiscordTab,
	relaunchDiscordDesktopForCdp,
	searchDiscordMessages,
	sendDiscordViaDesktopCdp,
} from "./user-account-scraper";
export type {
	DiscordVoicePlaybackOptions,
	DiscordVoiceTarget,
	DiscordVoiceTargetRegistration,
} from "./voice-target-registry";
