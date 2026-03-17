import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import listContacts from "./actions/listContacts";
import listGroups from "./actions/listGroups";
// Actions
import sendMessage from "./actions/sendMessage";
import sendReaction from "./actions/sendReaction";

// Providers
import { conversationStateProvider } from "./providers/conversationState";

// Service
import { SignalService } from "./service";

// Types
import { normalizeE164 } from "./types";

const signalPlugin: Plugin = {
  name: "signal",
  description:
    "Signal messaging integration plugin for elizaOS with end-to-end encryption",
  services: [SignalService],
  actions: [sendMessage, sendReaction, listContacts, listGroups],
  providers: [conversationStateProvider],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const accountNumber = runtime.getSetting("SIGNAL_ACCOUNT_NUMBER") as string;
    const httpUrl = runtime.getSetting("SIGNAL_HTTP_URL") as string;
    const cliPath = runtime.getSetting("SIGNAL_CLI_PATH") as string;
    const ignoreGroups = runtime.getSetting(
      "SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES",
    ) as string;

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
          cliPath: cliPath || "[not set]",
          ignoreGroups: ignoreGroups || "false",
        },
      },
      "Signal plugin initializing",
    );

    if (!accountNumber || accountNumber.trim() === "") {
      logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_ACCOUNT_NUMBER not provided - Signal plugin is loaded but will not be functional",
      );
      return;
    }

    const normalizedNumber = normalizeE164(accountNumber);
    if (!normalizedNumber) {
      logger.error(
        { src: "plugin:signal", agentId: runtime.agentId, accountNumber },
        "SIGNAL_ACCOUNT_NUMBER is not a valid E.164 phone number",
      );
      return;
    }

    if (!httpUrl && !cliPath) {
      logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "Neither SIGNAL_HTTP_URL nor SIGNAL_CLI_PATH provided - Signal plugin will not be able to communicate",
      );
      return;
    }

    logger.info(
      { src: "plugin:signal", agentId: runtime.agentId },
      "Signal plugin configuration validated successfully",
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
  type SignalDmConfig,
  type SignalGroupConfig,
  type SignalMultiAccountConfig,
} from "./accounts";
export { listContacts } from "./actions/listContacts";
export { listGroups } from "./actions/listGroups";
// Export actions
export { sendMessage } from "./actions/sendMessage";
export { sendReaction } from "./actions/sendReaction";
// Channel configuration types
export type {
  SignalAccountConfig,
  SignalActionConfig,
  SignalConfig,
  SignalReactionLevel,
  SignalReactionNotificationMode,
} from "./config";
// Export providers
export { conversationStateProvider } from "./providers/conversationState";
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
