import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  TemplateType,
  composePromptFromState,
  logger,
  ModelType,
  parseJSONObjectFromText,
} from '@elizaos/core';
// import { captureError } from "@elizaos/sentry";
import { RoflService } from '../services/rofl.ts';
import { getAgentPublicAddressTemplate } from '../templates.ts';

interface RoflParams {
  // TODO: add params here
}

const roflService = new RoflService();

export const getAgentPublicAddressAction: Action = {
  name: 'GET_AGENT_PUBLIC_ADDRESS',
  similes: [
    'SHOW_AGENT_WALLET',
    'AGENT_WALLET_ADDRESS',
    'AGENT_PUBLIC_ADDRESS',
    'GET_AGENT_WALLET',
    'SHOW_AGENT_ADDRESS',
    'AGENT_FUNDING_ADDRESS',
  ],
  description: "Display the agent's wallet public address for funding DeFi interactions",
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    try {
      await roflService.getAgentWallet(runtime.agentId);
      return true;
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
    _rs: Memory[] | undefined
  ) => {
    const prompt = composePromptFromState({
      state: state as State,
      template: getAgentPublicAddressTemplate as unknown as TemplateType,
    });
    const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    // const paramsJson = parseJSONObjectFromText(modelResponse) as RoflParams | { error: string };

    // logger.debug("Parsed rofl params", paramsJson);
    // if ('error' in paramsJson) {
    // 	logger.warn(`Rofl: Model responded with error: ${paramsJson.error}`);
    // 	throw new Error(paramsJson.error);
    // }

    try {
      const wallet = await roflService.getAgentWallet(runtime.agentId);

      const publicAddress = wallet.address;

      const responseContent: Content = {
        text: `Here is your agent's wallet public address: **${publicAddress}**

To enable this agent to interact with DeFi protocols (Neby, BitProtocol, Thorn, Accumulated Finance), please fund this wallet address with the required tokens. The agent will use these funds to execute trades, swaps, and other DeFi operations on your behalf.

**Important:** Only send funds to this address that you're comfortable with the agent using for automated DeFi activities.`,
        attachments: [],
      };

      if (callback) {
        callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error(`Error generating agent public address: ${(error as Error).message}`);
      // captureError(error as Error, {
      // 	action: "getAgentPublicAddress",
      // 	agent_id: runtime.agentId,
      // });

      const errorContent: Content = {
        text: `Error generating agent public address: ${(error as Error).message}`,
        attachments: [],
      };

      if (callback) {
        callback(errorContent);
      }

      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: "Show me the agent's wallet address",
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: "Here is your agent's wallet public address: **0x...**\n\nTo enable this agent to interact with DeFi protocols (Neby, BitProtocol, Thorn, Accumulated Finance), please fund this wallet address with the required tokens.",
          action: 'GET_AGENT_PUBLIC_ADDRESS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "What's the agent's funding address?",
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: "Here is your agent's wallet public address: **0x...**\n\nTo enable this agent to interact with DeFi protocols (Neby, BitProtocol, Thorn, Accumulated Finance), please fund this wallet address with the required tokens.",
          action: 'GET_AGENT_PUBLIC_ADDRESS',
        },
      },
    ],
  ],
};
