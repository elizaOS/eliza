import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";
import { SmartHomeManager } from "../smart_home.ts";
import { smartThingsApi } from "../services/smart_things_api.ts";
import { deviceStateProvider } from "../providers/device_state.ts";

export const controlDeviceAction = {
    name: "CONTROL_DEVICE",
    similes: ["DEVICE_CONTROL", "SMART_HOME_CONTROL", "HOME_CONTROL"],
    description: "Controls smart home devices with specific commands",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const keywords = [
            "turn on",
            "turn off",
            "switch",
            "toggle",
            "set",
            "change",
            "adjust",
            "dim",
            "brighten",
            "lock",
            "unlock",
        ];
        return keywords.some(keyword =>
            message.content.text.toLowerCase().includes(keyword)
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        const smartHomeManager = new SmartHomeManager(runtime);
        const result = await smartHomeManager.handleCommand(message.content.text, message.userId);

        const response: Content = {
            text: `Command executed: ${result.message || "Success"}`,
            action: "DEVICE_CONTROL_RESPONSE",
            source: "home-assistant"
        };

        await callback(response);
        return response;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Turn on the living room lights",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll turn on the living room lights for you",
                    action: "CONTROL_DEVICE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

export async function controlDevice(deviceId: string, command: string, args: any = {}) {
  try {
    // Map internal commands to SmartThings commands
    const smartThingsCommand = mapCommand(command, args);

    await smartThingsApi.devices.executeCommand(deviceId, smartThingsCommand);

    // Update local device state
    await deviceStateProvider.updateDeviceState(deviceId, command, args);

  } catch (error) {
    console.error(`Failed to control device ${deviceId}:`, error);
    throw error;
  }
}

function mapCommand(command: string, args: any) {
  // Map our internal commands to SmartThings command format
  switch (command) {
    case 'turnOn':
      return { capability: 'switch', command: 'on' };
    case 'turnOff':
      return { capability: 'switch', command: 'off' };
    case 'setLevel':
      return {
        capability: 'switchLevel',
        command: 'setLevel',
        arguments: [args.level]
      };
    // ... map other commands
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export default controlDeviceAction;