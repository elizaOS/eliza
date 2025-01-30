import { IAgentRuntime } from "@elizaos/core";
import { Provider } from "@elizaos/core";
import { EntityManager } from "../entities.ts";
import { SmartThingsCapability } from '../capabilities';

export interface DeviceState {
  id: string;
  name: string;
  capabilities: SmartThingsCapability[];
  room?: string;
  status: {
    switch?: 'on' | 'off';
    level?: number;
    temperature?: number;
    motion?: 'active' | 'inactive';
    contact?: 'open' | 'closed';
    // ... other status fields
  };
}

export const deviceStateProvider: Provider = {
    get: async (runtime: IAgentRuntime) => {
        const entityManager = new EntityManager(runtime);
        await entityManager.discoverEntities();
        const entities = entityManager.getAllEntities();

        const deviceStates = entities
            .map(entity => `${entity.name}: ${entity.state}`)
            .join('\n');

        return `Current Device States:\n${deviceStates}`;
    }
};

export default deviceStateProvider;

export class DeviceStateProvider {
  private devices: Map<string, DeviceState> = new Map();

  async updateDeviceState(deviceId: string, capability: string, value: any) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Update device status based on capability
    switch (capability) {
      case 'switch':
        device.status.switch = value;
        break;
      case 'level':
        device.status.level = value;
        break;
      // ... handle other capabilities
    }

    this.devices.set(deviceId, device);

  }
}