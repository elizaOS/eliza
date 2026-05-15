function hasAgentSkillsService(runtime) {
    const service = runtime.getService("AGENT_SKILLS_SERVICE");
    return Boolean(service);
}
export function createAgentSkillsActionValidator(_config) {
    return async (runtime) => {
        try {
            return hasAgentSkillsService(runtime);
        }
        catch {
            return false;
        }
    };
}
//# sourceMappingURL=validators.js.map