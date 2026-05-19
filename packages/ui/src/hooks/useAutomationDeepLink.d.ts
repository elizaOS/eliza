/**
 * useAutomationDeepLink — hash-based deep-link state for the automations
 * feed. Replaces the old `getPathForAutomationSubpage` /
 * `syncAutomationSubpagePath` history-API helpers from AutomationsView.
 *
 * Hash format:
 *   #automations                → list view
 *   #automations/<workflowId>   → open WorkflowEditor for that id
 *   #automations/task/<taskId>  → open TaskEditor for that id
 *
 * Hash is read on mount, written on open/close, and the hashchange event
 * is observed so back/forward navigation works.
 */
export type AutomationDeepLink = {
    kind: "list";
} | {
    kind: "workflow";
    id: string;
} | {
    kind: "task";
    id: string;
};
export declare function parseAutomationHash(hash: string): AutomationDeepLink;
export declare function formatAutomationHash(link: AutomationDeepLink): string;
export declare function useAutomationDeepLink(): {
    link: AutomationDeepLink;
    setLink: (next: AutomationDeepLink) => void;
};
//# sourceMappingURL=useAutomationDeepLink.d.ts.map