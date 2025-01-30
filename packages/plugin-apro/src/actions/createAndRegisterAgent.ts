import { Action, composeContext, elizaLogger, generateObject, HandlerCallback, IAgentRuntime, Memory, ModelClass, State } from "@elizaos/core";
import { AgentSDK, AgentSettings, parseNewAgentAddress } from "ai-agent-sdk-js";
import { createAgentTemplate } from "../templates";
import { AgentSettingsSchema, isAgentSettings } from "../types";
import { ContractTransactionResponse } from "ethers";

export const createAndRegisterAgent: Action = {
  name: "CREATE_AND_REGISTER_AGENT",
  similes: [
    'CREATE_AGENT',
    'REGISTER_AGENT',
  ],
  description: "Create and register an agent with APRO. User must provide agent settings.",
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    if (!state) {
        state = (await runtime.composeState(message)) as State;
    } else {
        state = await runtime.updateRecentMessageState(state);
    }

    // Generate agent settings
    let agentSettings: AgentSettings
    try {
        const agentSettingsDetail = await generateObject({
            runtime,
            context: composeContext({
                state,
                template: createAgentTemplate,
            }),
            modelClass: ModelClass.LARGE,
            schema: AgentSettingsSchema,
        });
        agentSettings = agentSettingsDetail.object as AgentSettings;
        elizaLogger.info('The Agent settings received:', agentSettings);
    } catch (error: any) {
        elizaLogger.error('Failed to generate Agent settings:', error);
        callback({
            text: 'Failed to generate Agent settings. Please provide valid input.',
        });
        return;
    }

    // Validate agent settings
    if (!isAgentSettings(agentSettings)) {
        elizaLogger.error('Invalid Agent settings:', agentSettings);
        callback({
            text: 'Invalid Agent settings. Please provide valid input.',
        });
        return;
    }

    // Create SDK agent
    let agent: AgentSDK
    try {
        agent = new AgentSDK({
            proxyAddress: runtime.getSetting('APRO_PROXY_ADDRESS') ?? process.env.APRO_PROXY_ADDRESS,
            rpcUrl: runtime.getSetting('APRO_RPC_URL') ?? process.env.APRO_RPC_URL,
            privateKey: runtime.getSetting('APRO_PRIVATE_KEY') ?? process.env.APRO_PRIVATE_KEY,
        });
    } catch (error: any) {
        elizaLogger.error('Failed to create Agent SDK:', error);
        callback({
            text: 'Failed to create Agent SDK. Please check the apro plugin configuration.',
        });
        return;
    }

    // Create and register agent
    let tx: ContractTransactionResponse
    try {
        tx = await agent.createAndRegisterAgent({agentSettings})
        elizaLogger.info('Successfully send create and register agent transaction:', tx.hash);

        const receipt = await tx.wait()
        const agentAddress = parseNewAgentAddress(receipt)

        elizaLogger.info(`Created agent at address: ${agentAddress}`)
        callback({ text: 'Agent created and registered successfully: ' + agentAddress })
    } catch (error: any) {
        elizaLogger.error(`Error creating agent: ${error.message}`);
        let message = 'Error creating agent: ' + error.message
        if (tx?.hash) {
            message += ` Transaction hash: ${tx.hash}`
        }
        await callback({ text: message });
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: `I want to Create and register apro ai-agent with the following settings:
            {
                signers: [
                    '0x003CD3bD8Ac5b045be8E49d4dfd9928E1765E471',
                    '0xdE3701195b9823E41b3fc2c98922A94399E2a01C',
                    '0xB54E5D4faa950e8B6a01ed5a790Ac260c81Ad224',
                    '0x48eE063a6c67144E09684ac8AD9a0044836f348B',
                    '0xbBbCc052F1277dd94e88e8E5BD6D7FF9a29BaC98'
                ],
                threshold: 3,
                converterAddress: "0x24c36e9996eb84138Ed7cAa483B4c59FF7640E5C",
                agentHeader: {
                    sourceAgentName: 'ElizaOS Test Agent',
                    targetAgentId: '1105302c-7556-49b2-b6fe-3aedba9c0682',
                    messageType: 0,
                    priority: 1,
                    ttl: 3600,
                },
            }`
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll help you create and register the agent.",
          action: "CREATE_AND_REGISTER_AGENT",
        },
      },
    ]
  ],
}