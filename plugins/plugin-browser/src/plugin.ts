/** Composes the browser workspace, optional Stagehand target, and owner-authorized browser actions. */
import { BrowserService } from "./browser-service.js";
import { browserAction } from "./actions/browser.js";
import { browserBridgeSchema } from "./schema.js";
import { browserWorkspaceProvider } from "./providers/workspace.js";
import { browserWorkspaceRoutes } from "./routes/workspace-setup.js";
import { preflightStagehandServer } from "./targets/stagehand-target.js";
import { promoteSubactionsToActions } from "@elizaos/core";
import { type HttpPlugin as Plugin } from "@elizaos/shared";
import { type ServiceClass } from "@elizaos/core";
export const browserPlugin: Plugin = {
    name: "@elizaos/plugin-browser",
    description: "Browser automation through the embedded desktop workspace, JSDOM, and optional Stagehand targets.",
    // Existing LifeOps history still reads these persisted record tables.
    schema: browserBridgeSchema,
    routes: browserWorkspaceRoutes,
    services: [BrowserService as ServiceClass],
    providers: [browserWorkspaceProvider],
    // Prepare the optional local stagehand-server before services start. Owned
    // here so the resolver no longer special-cases this plugin by name (#12665).
    preflight: () => preflightStagehandServer(),
    actions: [...promoteSubactionsToActions(browserAction)],
    // Self-declared auto-enable: activate when features.browser is enabled.
    autoEnable: {
        shouldEnable: (_env, config) => {
            const f = (config?.features as Record<string, unknown> | undefined)
                ?.browser;
            return (f === true ||
                (typeof f === "object" &&
                    f !== null &&
                    (f as {
                        enabled?: unknown;
                    }).enabled !== false));
        },
    },
    async dispose(runtime) {
        const svc = runtime.getService<BrowserService>(BrowserService.serviceType);
        await svc?.stop();
    },
};
