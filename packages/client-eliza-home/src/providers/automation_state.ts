import { IAgentRuntime, Provider } from "@elizaos/core";

export const automationStateProvider: Provider = {
    name: "automation-state",
    get: async (runtime: IAgentRuntime) => {
        try {
            const response = await fetch(
                `${runtime.getSetting("HOME_ASSISTANT_URL")}/api/states`,
                {
                    headers: {
                        Authorization: `Bearer ${runtime.getSetting("HOME_ASSISTANT_TOKEN")}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error("Failed to fetch automation states");
            }

            const states = await response.json();
            const automations = states.filter(state => state.entity_id.startsWith('automation.'));

            const automationStates = automations
                .map(automation => `${automation.attributes.friendly_name}: ${automation.state}`)
                .join('\n');

            return `Current Automation States:\n${automationStates}`;
        } catch (error) {
            return "Unable to fetch automation states";
        }
    }
};

export default automationStateProvider;