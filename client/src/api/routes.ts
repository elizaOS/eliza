export const ROUTES = {
    sendMessage: (agentId: string): string => `/api/${agentId}/message`,
    getAgents: (): string => `/api/agents`,
};
