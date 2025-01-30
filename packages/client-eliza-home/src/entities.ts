import { IAgentRuntime } from "@elizaos/core";
import { SmartThingsApi } from "./services/smart_things_api";
import { CAPABILITY_MAPPINGS } from "./config";

export interface Entity {
    entityId: string;
    name: string;
    type: string;
    capabilities: string[];
    state: any;
}

export class EntityManager {
    private runtime: IAgentRuntime;
    private api: SmartThingsApi;
    private entities: Map<string, Entity>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.api = new SmartThingsApi(runtime);
        this.entities = new Map();
    }

    async discoverEntities(): Promise<void> {
        try {
            const devices = await this.api.devices.list();

            for (const device of devices) {
                const entity: Entity = {
                    entityId: device.deviceId,
                    name: device.label || device.name,
                    type: this.determineDeviceType(device.capabilities),
                    capabilities: device.capabilities.map(cap => cap.id),
                    state: device.status,
                };

                this.entities.set(entity.entityId, entity);
            }
        } catch (error) {
            throw new Error(`Entity discovery failed: ${error.message}`);
        }
    }

    private determineDeviceType(capabilities: any[]): string {
        // Map capabilities to device type
        for (const [type, requiredCaps] of Object.entries(CAPABILITY_MAPPINGS)) {
            if (requiredCaps.every(cap =>
                capabilities.some(c => c.id === cap)
            )) {
                return type;
            }
        }
        return 'unknown';
    }

    getEntity(entityId: string): Entity | undefined {
        return this.entities.get(entityId);
    }

    getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    async updateEntityState(entityId: string, state: any): Promise<void> {
        const entity = this.entities.get(entityId);
        if (entity) {
            entity.state = state;
            this.entities.set(entityId, entity);
        }
    }
}