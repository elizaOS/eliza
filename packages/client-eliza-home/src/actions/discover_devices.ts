import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";
import { EntityManager } from "../entities.ts";
import { CAPABILITIES } from '../capabilities';
import { smartThingsApi } from "../services/smart_things_api.ts";

export const discoverDevicesAction = {
    name: "DISCOVER_DEVICES",
    similes: ["SCAN_DEVICES", "FIND_DEVICES", "LIST_DEVICES"],
    description: "Discovers and lists all available smart home devices",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const keywords = [
            "discover",
            "find",
            "scan",
            "list",
            "show",
            "what",
            "devices",
            "lights",
            "switches",
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
        const entityManager = new EntityManager(runtime);
        await entityManager.discoverEntities();

        const entities = entityManager.getAllEntities();
        const deviceList = entities
            .map(entity => `- ${entity.name} (${entity.entityId}): ${entity.state}`)
            .join('\n');

        const response: Content = {
            text: `Here are all the available devices:\n\n${deviceList}`,
            action: "DEVICE_LIST_RESPONSE",
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
                    text: "What devices do you see?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me check what devices are available...",
                    action: "DISCOVER_DEVICES",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

export default discoverDevicesAction;

export async function discoverDevices() {
  // Implementation to discover SmartThings devices
  try {
    const devices = await smartThingsApi.devices.list();

    return devices.map(device => ({
      id: device.deviceId,
      name: device.label || device.name,
      capabilities: device.capabilities.map(cap => ({
        id: cap.id,
        version: cap.version
      })),
      room: device.roomId,
      status: parseDeviceStatus(device.status)
    }));
  } catch (error) {
    console.error('Failed to discover devices:', error);
    throw error;
  }
}

function parseDeviceStatus(status: any) {
  // Convert SmartThings status format to our internal format
  const deviceStatus: any = {};

  if (status.switch) {
    deviceStatus.switch = status.switch.value;
  }
  if (status.level) {
    deviceStatus.level = status.level.value;
  }
  // ... parse other status values

  return deviceStatus;
}