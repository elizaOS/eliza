import { getSkillDetailsAction } from "./get-skill-details";
import { installSkillAction } from "./install-skill";
import { searchSkillsAction } from "./search-skills";
import { syncCatalogAction } from "./sync-catalog";
import { toggleSkillAction } from "./toggle-skill";
import { uninstallSkillAction } from "./uninstall-skill";

const ALL_OPS = [
    "search",
    "details",
    "sync",
    "toggle",
    "install",
    "uninstall",
];
const ROUTES = [
    {
        op: "uninstall",
        action: uninstallSkillAction,
        match: /\b(uninstall|remove|delete)\b.*\bskill\b/i,
    },
    {
        op: "install",
        action: installSkillAction,
        match: /\b(install|add)\b.*\bskill\b/i,
    },
    {
        op: "toggle",
        action: toggleSkillAction,
        match: /\b(enable|disable|activate|deactivate|toggle|turn on|turn off)\b.*\bskill\b/i,
    },
    {
        op: "sync",
        action: syncCatalogAction,
        match: /\b(sync|refresh|reload|update)\b.*\b(catalog|registry|skills?)\b/i,
    },
    {
        op: "details",
        action: getSkillDetailsAction,
        match: /\b(detail|info|describe|show|what is)\b.*\bskill\b/i,
    },
    {
        op: "search",
        action: searchSkillsAction,
        match: /\b(search|find|browse|list|available|catalog)\b.*\bskill\b|\bskills?\b.*\b(search|find|browse|list|available)\b/i,
    },
];
function readOptions(options) {
    const direct = (options ?? {});
    const parameters = direct.parameters && typeof direct.parameters === "object"
        ? direct.parameters
        : {};
    return { ...direct, ...parameters };
}
function normalizeOp(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim().toLowerCase();
    if (ALL_OPS.includes(trimmed)) {
        return trimmed;
    }
    // Common aliases
    if (trimmed === "get" || trimmed === "info" || trimmed === "describe") {
        return "details";
    }
    if (trimmed === "enable" || trimmed === "disable") {
        return "toggle";
    }
    if (trimmed === "refresh" || trimmed === "update") {
        return "sync";
    }
    if (trimmed === "list" || trimmed === "browse") {
        return "search";
    }
    return null;
}
function selectRoute(message, options) {
    const opts = readOptions(options);
    const requested = normalizeOp(opts.action);
    if (requested) {
        const route = ROUTES.find((candidate) => candidate.op === requested);
        if (route)
            return route;
    }
    const text = typeof message.content?.text === "string" ? message.content.text : "";
    return ROUTES.find((route) => route.match.test(text)) ?? null;
}
export const skillAction = {
    name: "SKILL",
    description: "Manage skill catalog. Ops: search, details, sync, toggle, install, uninstall. Use USE_SKILL to invoke enabled skill.",
    descriptionCompressed: "Skill catalog: search, details, sync, toggle, install, uninstall.",
    contexts: ["automation", "knowledge", "settings", "connectors"],
    contextGate: { anyOf: ["automation", "knowledge", "settings", "connectors"] },
    similes: [
        "MANAGE_SKILL",
        "MANAGE_SKILLS",
        "SKILL_CATALOG",
        "SKILLS",
        "AGENT_SKILL",
        "AGENT_SKILLS",
        "INSTALL_SKILL",
        "UNINSTALL_SKILL",
        "SEARCH_SKILLS",
        "SYNC_SKILL_CATALOG",
        "TOGGLE_SKILL",
    ],
    roleGate: { minRole: "USER" },
    parameters: [
        {
            name: "action",
            description: "Operation: search, details, sync, toggle, install, uninstall. Infer if omitted.",
            required: false,
            schema: { type: "string", enum: [...ALL_OPS] },
        },
    ],
    validate: async (runtime) => {
        return Boolean(runtime.getService("AGENT_SKILLS_SERVICE"));
    },
    handler: async (runtime, message, state, options, callback) => {
        const route = selectRoute(message, options);
        if (!route) {
            const ops = ALL_OPS.join(", ");
            const text = `SKILL could not determine the operation. Specify one of: ${ops}.`;
            await callback?.({ text, source: message.content?.source });
            return {
                success: false,
                text,
                values: { error: "MISSING" },
                data: { actionName: "SKILL", availableOps: ops },
            };
        }
        const result = (await route.action.handler(runtime, message, state, options, callback)) ??
            { success: true };
        return {
            ...result,
            data: {
                ...(typeof result.data === "object" && result.data ? result.data : {}),
                actionName: "SKILL",
                routedActionName: route.action.name,
                op: route.op,
            },
        };
    },
    examples: [
        [
            { name: "{{user1}}", content: { text: "Search skills for image generation" } },
            {
                name: "{{agentName}}",
                content: { text: "Searching the skill catalog.", actions: ["SKILL"] },
            },
        ],
        [
            { name: "{{user1}}", content: { text: "Install the github skill" } },
            {
                name: "{{agentName}}",
                content: { text: "Installing that skill.", actions: ["SKILL"] },
            },
        ],
        [
            { name: "{{user1}}", content: { text: "Disable the apple-notes skill" } },
            {
                name: "{{agentName}}",
                content: { text: "Disabling that skill.", actions: ["SKILL"] },
            },
        ],
        [
            { name: "{{user1}}", content: { text: "Refresh the skill catalog" } },
            {
                name: "{{agentName}}",
                content: { text: "Refreshing.", actions: ["SKILL"] },
            },
        ],
    ],
};
//# sourceMappingURL=skill.js.map