import {
	getConnectorAccountManager,
	type IAgentRuntime,
	logger,
	type Plugin,
} from "@elizaos/core";
import setupCredentials from "./actions/setup-credentials";
import { printBanner } from "./banner";
import { createDiscordConnectorAccountProvider } from "./connector-account-provider";
import { DiscordOwnerPairingServiceImpl } from "./owner-pairing-service";
import { getPermissionValues } from "./permissions";
import { DiscordService } from "./service";
import { discordSetupRoutes } from "./setup-routes";
import { DiscordTestSuite } from "./tests";
import { DiscordUserAccountScraperImpl } from "./user-account-scraper/service";

const discordPlugin: Plugin = {
	name: "discord",
	description:
		"Discord service plugin for integration with Discord servers and channels",
	services: [
		DiscordService,
		DiscordOwnerPairingServiceImpl,
		DiscordUserAccountScraperImpl,
	],
	routes: discordSetupRoutes,
	actions: [setupCredentials],
	providers: [],
	tests: [new DiscordTestSuite()],
	init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
		// Register the Discord provider with the ConnectorAccountManager so the
		// HTTP CRUD surface (packages/agent/src/api/connector-account-routes.ts)
		// can list, create, patch, delete, and start OAuth on Discord accounts.
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
					defaultValue: "false",
				},
				{
					name: "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
					value: ignoreDirectMessages,
					defaultValue: "false",
				},
				{
					name: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
					value: respondOnlyToMentions,
					defaultValue: "false",
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
// ConnectorAccountManager provider exports
export {
	createDiscordConnectorAccountProvider,
	DISCORD_PROVIDER_ID,
} from "./connector-account-provider";
export { DISCORD_SERVICE_NAME } from "./constants";
// Discord local IPC service + setup routes
export {
	DISCORD_LOCAL_PLUGIN_NAME,
	DISCORD_LOCAL_SERVICE_NAME,
	DiscordLocalService,
	default as discordLocalPlugin,
} from "./discord-local-service";
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
// Discord user-account scraper (browser-workspace driven; per-account
// partitions). Used by lifeops and any other consumer that needs to read
// state from a logged-in Discord user account.
export {
	captureDiscordDeliveryStatus,
	closeDiscordTab,
	DISCORD_APP_URL,
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
