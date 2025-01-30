import { EventEmitter } from "events";
import {
    IAgentRuntime,
    Client as ElizaClient,
    elizaLogger,
    stringToUuid,
    getEmbeddingZeroVector,
    Memory,
    Content,
} from "@elizaos/core";
import { validateHomeConfig } from "./environment.ts";
import { CapabilityManager } from "./capabilities.ts";
import { EntityManager } from "./entities.ts";
import { StateManager } from "./state.ts";
import { SmartHomeManager } from "./smart_home.ts";
import controlDeviceAction from "./actions/control_device.ts";
import discoverDevicesAction from "./actions/discover_devices.ts";
import deviceStateProvider from "./providers/device_state.ts";
import automationStateProvider from "./providers/automation_state.ts";


export class HomeClient extends EventEmitter {
    private runtime: IAgentRuntime;
    private capabilityManager: CapabilityManager;
    private entityManager: EntityManager;
    private stateManager: StateManager;
    private smartHomeManager: SmartHomeManager;

    constructor(runtime: IAgentRuntime) {
        super();
        this.runtime = runtime;
        this.initialize();
    }

    private async initialize() {
        try {
            const config = await validateHomeConfig(this.runtime);

            this.capabilityManager = new CapabilityManager(this.runtime);
            this.entityManager = new EntityManager(this.runtime);
            this.stateManager = new StateManager(this.runtime);
            this.smartHomeManager = new SmartHomeManager(this.runtime);

            // Register providers
            this.runtime.providers.push(this.stateManager.getProvider());
            this.runtime.providers.push(deviceStateProvider);
            this.runtime.providers.push(automationStateProvider);

            // Register actions
            this.registerActions();

            // Start state monitoring
            this.startStateMonitoring();

            elizaLogger.success("Home Assistant client initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize Home Assistant client:", error);
            throw error;
        }
    }

    private registerActions() {
        this.runtime.registerAction(controlDeviceAction);
        this.runtime.registerAction(discoverDevicesAction);
    }

    private startStateMonitoring() {
        setInterval(async () => {
            try {
                await this.entityManager.discoverEntities();
                elizaLogger.debug("Updated device states");
            } catch (error) {
                elizaLogger.error("Failed to update device states:", error);
            }
        }, 60000); // Update every minute
    }

    async handleCommand(command: string, userId: string) {
        const roomId = stringToUuid(`home-${userId}`);
        const userIdUUID = stringToUuid(userId);

        const memory: Memory = {
            id: stringToUuid(`command-${Date.now()}`),
            userId: userIdUUID,
            agentId: this.runtime.agentId,
            roomId,
            content: {
                text: command,
                source: "home-assistant"
            },
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now()
        };

        await this.runtime.messageManager.createMemory(memory);
        return this.smartHomeManager.handleCommand(command, userId);
    }
}

export const HomeClientInterface: ElizaClient = {
    start: async (runtime: IAgentRuntime) => new HomeClient(runtime),
    stop: async (runtime: IAgentRuntime) => {
        elizaLogger.warn("Home Assistant client does not support stopping yet");
    }
};

export function startHome(runtime: IAgentRuntime) {
    return new HomeClient(runtime);
}

export {
    homeShouldRespondTemplate,
    homeMessageHandlerTemplate
} from "./templates";