import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { PhalaRemoteAttestationProvider } from "../providers/remoteAttestation";
import type { RemoteAttestationMessage } from "../types";
import { hexToUint8Array, uploadAttestationQuote } from "../utils";

export const remoteAttestationAction: Action = {
  name: "REMOTE_ATTESTATION",
  contexts: ["admin", "secrets", "agent_internal"],
  contextGate: { anyOf: ["admin", "secrets", "agent_internal"] },

  similes: [
    "REMOTE_ATTESTATION",
    "TEE_REMOTE_ATTESTATION",
    "TEE_ATTESTATION",
    "TEE_QUOTE",
    "ATTESTATION",
    "TEE_ATTESTATION_QUOTE",
    "PROVE_TEE",
    "VERIFY_TEE",
  ],

  description:
    "Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)",
  descriptionCompressed:
    "generate remote attestation prove agent run TEE (Trusted Execution Environment)",
  parameters: [],

  validate: async (
    runtime: any,
    message: any,
    state?: any,
    options?: any,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["remote", "attestation"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = new RegExp("\\b(?:remote|attestation)\\b", "i");
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
    ): Promise<boolean> => {
      const teeMode = runtime.getSetting("TEE_MODE");
      if (!teeMode) {
        logger.warn("REMOTE_ATTESTATION: TEE_MODE not configured");
        return false;
      }
      return true;
    };
    try {
      return Boolean(
        await (__avLegacyValidate as any)(runtime, message, state, options),
      );
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const teeMode = runtime.getSetting("TEE_MODE");
      if (!teeMode) {
        logger.error("TEE_MODE is not configured");
        callback?.({
          text: "TEE_MODE is not configured. Cannot generate attestation.",
          actions: ["NONE"],
        });
        return { success: false, error: "TEE_MODE is not configured" };
      }

      const attestationMessage: RemoteAttestationMessage = {
        agentId: runtime.agentId,
        timestamp: Date.now(),
        message: {
          entityId: message.entityId,
          roomId: message.roomId,
          content: message.content.text ?? "",
        },
      };

      logger.debug(
        `Generating attestation for: ${JSON.stringify(attestationMessage)}`,
      );

      const provider = new PhalaRemoteAttestationProvider(String(teeMode));
      const attestation = await provider.generateAttestation(
        JSON.stringify(attestationMessage),
      );

      const attestationData = hexToUint8Array(attestation.quote);
      const uploadResult = await uploadAttestationQuote(attestationData);

      const proofUrl = `https://proof.t16z.com/reports/${uploadResult.checksum}`;

      logger.info(`Attestation uploaded: ${proofUrl}`);

      callback?.({
        text: `Remote attestation quote: ${proofUrl}`,
        actions: ["NONE"],
      });

      return { success: true, text: `Attestation generated: ${proofUrl}` };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`Failed to generate remote attestation: ${errorMessage}`);

      callback?.({
        text: `Failed to generate attestation: ${errorMessage}`,
        actions: ["NONE"],
      });

      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "If you are running in a TEE, generate a remote attestation",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Of course, one second...",
          actions: ["REMOTE_ATTESTATION"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you prove you're running in a trusted execution environment?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Absolutely! Let me generate a TEE attestation quote for you.",
          actions: ["REMOTE_ATTESTATION"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I need verification that this conversation is happening in a secure enclave",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll generate a remote attestation to prove I'm running in a TEE.",
          actions: ["REMOTE_ATTESTATION"],
        },
      },
    ],
  ],
};
