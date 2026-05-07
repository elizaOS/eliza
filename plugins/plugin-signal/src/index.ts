import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { messageOp } from "./actions/messageOp";
import readRecentMessages from "./actions/readRecentMessages";
import { signalContactsProvider, signalGroupsProvider } from "./providers";

// Service
import { DEFAULT_SIGNAL_CLI_PATH, SignalService } from "./service";

// Setup routes (QR pairing / disconnect)
import { signalSetupRoutes } from "./setup-routes";

// Types
import { normalizeE164 } from "./types";
import { SignalN8nCredentialProvider } from "./n8n-credential-provider";

const signalPlugin: Plugin = {
  name: "signal",
  description: "Signal messaging integration plugin for ElizaOS with end-to-end encryption",
  services: [SignalService, SignalN8nCredentialProvider],
  actions: [messageOp, readRecentMessages],
  providers: [signalContactsProvider, signalGroupsProvider],
  routes: signalSetupRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const accountNumber = runtime.getSetting("SIGNAL_ACCOUNT_NUMBER") as string;
    const httpUrl = runtime.getSetting("SIGNAL_HTTP_URL") as string;
    const cliPath = runtime.getSetting("SIGNAL_CLI_PATH") as string;
    const effectiveCliPath = (cliPath ?? "").trim() || DEFAULT_SIGNAL_CLI_PATH;
    const ignoreGroups = runtime.getSetting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES") as string;

    // Log configuration status
    const maskNumber = (number: string | undefined): string => {
      if (!number || number.trim() === "") return "[not set]";
      if (number.length <= 6) return "***";
      return `${number.slice(0, 3)}...${number.slice(-2)}`;
    };

    logger.info(
      {
        src: "plugin:signal",
        agentId: runtime.agentId,
        settings: {
          accountNumber: maskNumber(accountNumber),
          httpUrl: httpUrl || "[not set]",
          cliPath: cliPath ? cliPath : `[default: ${DEFAULT_SIGNAL_CLI_PATH}]`,
          ignoreGroups: ignoreGroups || "false",
        },
      },
      "Signal plugin initializing"
    );

    if (!accountNumber || accountNumber.trim() === "") {
      logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_ACCOUNT_NUMBER not provided - Signal plugin is loaded but will not be functional"
      );
      return;
    }

    const normalizedNumber = normalizeE164(accountNumber);
    if (!normalizedNumber) {
      logger.error(
        { src: "plugin:signal", agentId: runtime.agentId, accountNumber },
        "SIGNAL_ACCOUNT_NUMBER is not a valid E.164 phone number"
      );
      return;
    }

    // When neither SIGNAL_HTTP_URL nor SIGNAL_CLI_PATH is set explicitly, we
    // fall back to the default local signal-cli binary (name resolved via
    // PATH + Homebrew/common paths at service start). No warning here — the
    // service will surface a clearer error if signal-cli isn't actually
    // available on the host.
    logger.info(
      {
        src: "plugin:signal",
        agentId: runtime.agentId,
        mode: httpUrl ? "http" : "local-cli",
        cliPath: effectiveCliPath,
      },
      "Signal plugin configuration validated successfully"
    );
  },
};

export default signalPlugin;

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  isMultiAccountEnabled,
  listEnabledSignalAccounts,
  listSignalAccountIds,
  normalizeAccountId,
  type ResolvedSignalAccount,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type SignalAccountConfig,
  type SignalDmConfig,
  type SignalGroupConfig,
  type SignalMultiAccountConfig,
  type SignalReactionNotificationMode,
} from "./accounts";
// Export actions
export { messageOp, SIGNAL_MESSAGE_OP_ACTION } from "./actions/messageOp";
export { readRecentMessages } from "./actions/readRecentMessages";
// Export providers
export { signalContactsProvider, signalGroupsProvider } from "./providers";
// Channel configuration types
export type {
  SignalActionConfig,
  SignalConfig,
  SignalReactionLevel,
} from "./config";
// Pairing service (device linking via QR code / signal-cli)
export {
  type SignalPairingEvent,
  type SignalPairingOptions,
  SignalPairingSession,
  type SignalPairingSnapshot,
  type SignalPairingStatus,
  sanitizeAccountId as sanitizeSignalAccountId,
  signalAuthExists,
  signalLogout,
} from "./pairing-service";
// RPC client exports
export {
  createSignalEventStream,
  normalizeBaseUrl,
  parseSignalEventData,
  type SignalCheckResult,
  type SignalRpcError,
  type SignalRpcOptions,
  type SignalRpcResponse,
  type SignalSseEvent,
  signalCheck,
  signalGetVersion,
  signalListAccounts,
  signalListContacts,
  signalListGroups,
  signalRpcRequest,
  signalSend,
  signalSendReaction,
  signalSendReadReceipt,
  signalSendTyping,
  streamSignalEvents,
} from "./rpc";
// Export service for direct access
export { SignalService } from "./service";
// Setup routes (QR pairing / disconnect)
export { applySignalQrOverride, signalSetupRoutes } from "./setup-routes";
// Export types
export type {
  ISignalService,
  SignalAttachment,
  SignalContact,
  SignalEventPayloadMap,
  SignalGroup,
  SignalGroupMember,
  SignalMessage,
  SignalMessageReceivedPayload,
  SignalMessageSendOptions,
  SignalMessageSentPayload,
  SignalQuote,
  SignalReactionInfo,
  SignalReactionPayload,
  SignalRecentMessage,
  SignalSettings,
} from "./types";
export {
  getSignalContactDisplayName,
  isValidE164,
  isValidGroupId,
  isValidUuid,
  MAX_SIGNAL_ATTACHMENT_SIZE,
  MAX_SIGNAL_MESSAGE_LENGTH,
  normalizeE164,
  SIGNAL_SERVICE_NAME,
  SignalApiError,
  SignalClientNotAvailableError,
  SignalConfigurationError,
  SignalEventTypes,
  SignalPluginError,
  SignalServiceNotInitializedError,
} from "./types";
