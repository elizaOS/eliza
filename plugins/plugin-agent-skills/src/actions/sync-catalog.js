/**
 * Sync Catalog Action
 *
 * Manually trigger a sync of the skill catalog from the registry.
 */
import { createAgentSkillsActionValidator } from "./validators";
const SYNC_CATALOG_TIMEOUT_MS = 30_000;
export const syncCatalogAction = {
    name: "SKILL",
    contexts: ["automation", "settings", "connectors"],
    contextGate: { anyOf: ["automation", "settings", "connectors"] },
    roleGate: { minRole: "USER" },
    similes: [
        "SYNC_SKILL_CATALOG",
        "REFRESH_SKILL_CATALOG",
        "UPDATE_SKILL_CATALOG",
        "RELOAD_SKILL_CATALOG",
        "REFRESH_SKILLS",
    ],
    description: "Sync the skill catalog from the registry to discover new skills.",
    descriptionCompressed: "Sync skill catalog from registry.",
    parameters: [],
    validate: createAgentSkillsActionValidator({
        keywords: ["sync", "refresh", "update", "catalog", "skill"],
        regex: /\b(?:sync|refresh|update)\b.*\b(?:catalog|skills?)\b|\b(?:catalog|skills?)\b.*\b(?:sync|refresh|update)\b/i,
    }),
    handler: async (runtime, _message, _state, _options, callback) => {
        try {
            const service = runtime.getService("AGENT_SKILLS_SERVICE");
            if (!service) {
                throw new Error("AgentSkillsService not available");
            }
            runtime.logger.info("AgentSkills: Manual catalog sync triggered");
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Skill catalog sync timeout")), SYNC_CATALOG_TIMEOUT_MS));
            const result = await Promise.race([service.syncCatalog(), timeout]);
            const text = `Skill catalog synced successfully.
- Total skills: ${result.updated}
- New skills: ${result.added}`;
            if (callback)
                await callback({ text });
            return {
                success: true,
                text,
                data: result,
            };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (callback) {
                await callback({ text: `Error syncing catalog: ${errorMsg}` });
            }
            return {
                success: false,
                error: error instanceof Error ? error : new Error(errorMsg),
            };
        }
    },
    examples: [
        [
            { name: "{{userName}}", content: { text: "Refresh the skill catalog" } },
            {
                name: "{{agentName}}",
                content: {
                    text: "Skill catalog synced successfully.\n- Total skills: 150\n- New skills: 5",
                    actions: ["SKILL"],
                },
            },
        ],
    ],
};
export default syncCatalogAction;
//# sourceMappingURL=sync-catalog.js.map