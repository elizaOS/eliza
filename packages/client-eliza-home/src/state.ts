import { IAgentRuntime, Provider } from "@elizaos/core";
import { Entity } from "./entities.ts";

export class StateManager {
    private runtime: IAgentRuntime;
    private states: Map<string, any>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.states = new Map();
    }

    async updateState(entityId: string, state: any): Promise<void> {
        this.states.set(entityId, state);
    }

    getState(entityId: string): any {
        return this.states.get(entityId);
    }

    getAllStates(): Map<string, any> {
        return this.states;
    }

    getProvider(): Provider {
        return {
            name: "home-assistant-state",
            get: async () => {
                const states = Array.from(this.states.entries())
                    .map(([entityId, state]) => `${entityId}: ${JSON.stringify(state)}`)
                    .join('\n');
                return `Current Home Assistant States:\n${states}`;
            }
        };
    }
}