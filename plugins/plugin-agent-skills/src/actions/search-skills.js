/**
 * Search Skills Action
 *
 * Searches the skill registry and returns results enriched with structured
 * action chips so the UI can render Enable/Disable/Use/Copy/Install buttons
 * per result, and the LLM can suggest the right follow-up action by name.
 */
import { createAgentSkillsActionValidator } from "./validators";
function buildResultActions(slug, state) {
    const detailsAction = {
        kind: "details",
        label: "View details",
        target: slug,
    };
    const copyAction = {
        kind: "copy",
        label: "Copy SKILL.md",
        target: slug,
    };
    switch (state) {
        case "enabled":
            return [
                { kind: "use", label: "Use", target: slug },
                { kind: "disable", label: "Disable", target: slug },
                copyAction,
                detailsAction,
            ];
        case "disabled":
            return [
                { kind: "enable", label: "Enable", target: slug },
                copyAction,
                detailsAction,
                { kind: "uninstall", label: "Uninstall", target: slug },
            ];
        case "not-installed":
            return [
                { kind: "install", label: "Install", target: slug },
                detailsAction,
            ];
    }
}
function describeChips(actions) {
    // Mention the action verbs so an LLM rendering this output can pick the
    // right parent action + op for the follow-up.
    const map = {
        use: "USE_SKILL",
        enable: "SKILL op=toggle enabled=true",
        disable: "SKILL op=toggle enabled=false",
        install: "SKILL op=install",
        uninstall: "SKILL op=uninstall",
        copy: "Copy SKILL.md",
        details: "SKILL op=details",
    };
    return actions.map((a) => map[a.kind]).join(" · ");
}
export async function runSkillSearch(service, query, limit = 10, options = {}) {
    const normalizedQuery = query.trim();
    const results = await service.search(normalizedQuery, limit, options);
    if (results.length === 0) {
        const text = [
            "skills_search:",
            `  query: ${normalizedQuery}`,
            "  resultCount: 0",
            "results[0]:",
        ].join("\n");
        return {
            success: true,
            text,
            values: { resultCount: 0, category: "skills" },
            data: {
                actionName: "SEARCH",
                category: "skills",
                query: normalizedQuery,
                results: [],
            },
        };
    }
    const enriched = results.map((r) => {
        const loaded = service.getLoadedSkill(r.slug);
        const installed = Boolean(loaded);
        const enabled = installed && service.isSkillEnabled(r.slug);
        const state = !installed
            ? "not-installed"
            : enabled
                ? "enabled"
                : "disabled";
        return {
            ...r,
            installed,
            enabled,
            state,
            actions: buildResultActions(r.slug, state),
        };
    });
    const lines = [
        "skills_search:",
        `  query: ${normalizedQuery}`,
        `  resultCount: ${enriched.length}`,
        `results[${enriched.length}]{slug,displayName,state,summary,actions}:`,
        ...enriched.map((result) => [
            `  ${result.slug}`,
            result.displayName,
            result.state,
            result.summary.replace(/\s+/g, " ").trim(),
            describeChips(result.actions),
        ].join(",")),
        "next_actions:",
        "  use: USE_SKILL for enabled skills",
        "  toggle: SKILL op=toggle for installed skills",
        "  install: SKILL op=install for not-installed skills",
        "  details: SKILL op=details for a selected slug",
    ];
    return {
        success: true,
        text: lines.join("\n"),
        values: { resultCount: enriched.length, category: "skills" },
        data: {
            actionName: "SEARCH",
            category: "skills",
            query: normalizedQuery,
            results: enriched,
        },
    };
}
export const searchSkillsAction = {
    name: "SKILL",
    contexts: ["knowledge", "automation", "settings"],
    contextGate: { anyOf: ["knowledge", "automation", "settings"] },
    roleGate: { minRole: "USER" },
    similes: [
        "BROWSE_SKILLS",
        "LIST_SKILLS",
        "FIND_SKILLS",
        "SEARCH_SKILL",
        "DISCOVER_SKILLS",
        "SKILL_CATALOG_SEARCH",
    ],
    description: "Search skill registry by keyword/category. Returns action chips: use/enable/disable/install/copy/details.",
    descriptionCompressed: "Search skill registry by keyword/category; returns action chips.",
    validate: createAgentSkillsActionValidator({
        keywords: ["search", "find", "browse", "list", "skill"],
        regex: /\b(?:search|find|browse|list)\b.*\bskills?\b|\bskills?\b.*\b(?:search|find|browse|list)\b/i,
    }),
    handler: async (runtime, message, _state, options, callback) => {
        const service = runtime.getService("AGENT_SKILLS_SERVICE");
        if (!service) {
            const errorText = "AgentSkillsService not available.";
            if (callback)
                await callback({ text: errorText });
            return { success: false, error: new Error(errorText) };
        }
        const opts = options;
        const query = typeof opts?.parameters?.query === "string"
            ? opts.parameters.query
            : message.content?.text || "";
        const limit = typeof opts?.parameters?.limit === "number" &&
            Number.isFinite(opts.parameters.limit)
            ? Math.max(1, Math.floor(opts.parameters.limit))
            : 10;
        const result = await runSkillSearch(service, query, limit);
        const text = result.text ?? "";
        if (callback)
            await callback({ text });
        return result;
    },
    parameters: [
        {
            name: "query",
            description: "Search query or skill category.",
            required: false,
            schema: { type: "string" },
        },
        {
            name: "limit",
            description: "Max skill results.",
            required: false,
            schema: { type: "number" },
        },
    ],
    examples: [
        [
            {
                name: "{{userName}}",
                content: { text: "Search for skills about data analysis" },
            },
            {
                name: "{{agentName}}",
                content: {
                    text: '## Skills matching "data analysis"\n\n1. **Data Analysis** (`data-analysis`) [not installed]\n   Analyze datasets and generate insights\n   → SKILL op=install · SKILL op=details',
                    actions: ["SKILL"],
                },
            },
        ],
    ],
};
export default searchSkillsAction;
//# sourceMappingURL=search-skills.js.map