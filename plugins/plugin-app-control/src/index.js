/**
 * @module plugin-app-control
 * @description elizaOS plugin that lets the Eliza agent launch, close, list,
 * relaunch, load-from-directory, and create Eliza apps.
 *
 * Surface:
 * - One unified `APP` action (sub-modes: launch / relaunch / list /
 *   load_from_directory / create).
 * - `available_apps` provider — installed + running apps for the planner.
 * - `AppRegistryService` — persists load_from_directory registrations and
 *   re-registers them on boot.
 * - `AppVerificationService` — verifies created apps and plugins.
 */
import { appAction, createAppAction } from "./actions/app.js";
import { viewsAction } from "./actions/views.js";
import { availableAppsProvider } from "./providers/available-apps.js";
import { AppRegistryService } from "./services/app-registry-service.js";
import { AppVerificationService } from "./services/app-verification.js";
import { AppWorkerHostService } from "./services/app-worker-host-service.js";
import { VerificationRoomBridgeService } from "./services/verification-room-bridge.js";
export { createViewsAction, viewsAction } from "./actions/views.js";
export { createAppControlClient } from "./client/api.js";
export { APP_REGISTRY_SERVICE_TYPE, AppRegistryService, } from "./services/app-registry-service.js";
export { APP_WORKER_HOST_SERVICE_TYPE, AppWorkerHostService, } from "./services/app-worker-host-service.js";
export { AppVerificationService, } from "./services/index.js";
export { VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE, VerificationRoomBridgeService, } from "./services/verification-room-bridge.js";
export { appAction, availableAppsProvider, createAppAction };
export const appControlPlugin = {
    name: "app-control",
    description: "Launch, close, list, relaunch, load, and create Eliza apps from agent chat. Backed by the Eliza dashboard /api/apps/* HTTP surface. Also manages UI views via the VIEWS action.",
    actions: [appAction, viewsAction],
    providers: [availableAppsProvider],
    services: [
        AppRegistryService,
        AppVerificationService,
        AppWorkerHostService,
        VerificationRoomBridgeService,
    ],
    async dispose(runtime) {
        await runtime
            .getService(VerificationRoomBridgeService.serviceType)
            ?.stop();
        await runtime
            .getService(AppWorkerHostService.serviceType)
            ?.stop();
        await runtime
            .getService(AppVerificationService.serviceType)
            ?.stop();
        await runtime
            .getService(AppRegistryService.serviceType)
            ?.stop();
    },
    views: [
        {
            id: "views-manager",
            label: "Views",
            description: "Browse and open available views contributed by plugins",
            icon: "LayoutGrid",
            path: "/views",
            bundlePath: "dist/views/bundle.js",
            componentExport: "ViewManagerView",
            visibleInManager: true,
            desktopTabEnabled: true,
        },
        {
            id: "views-manager",
            label: "Views XR",
            description: "Browse and open available views contributed by plugins",
            icon: "LayoutGrid",
            path: "/views",
            viewType: "xr",
            bundlePath: "dist/views/bundle.js",
            componentExport: "ViewManagerView",
            visibleInManager: true,
            desktopTabEnabled: true,
        },
        {
            id: "views-manager",
            label: "Views TUI",
            description: "Terminal view for browsing and opening available plugin views",
            icon: "Terminal",
            path: "/views/tui",
            viewType: "tui",
            bundlePath: "dist/views/bundle.js",
            componentExport: "ViewManagerTuiView",
            visibleInManager: true,
            desktopTabEnabled: true,
            capabilities: [
                {
                    id: "terminal-open-view",
                    description: "Open a listed view from the terminal view manager",
                    params: {
                        viewId: {
                            type: "string",
                            description: "Stable id of the view to open",
                            required: true,
                        },
                    },
                },
                {
                    id: "terminal-list-views",
                    description: "Return the TUI-mode view list as structured data",
                },
            ],
        },
    ],
};
export default appControlPlugin;
//# sourceMappingURL=index.js.map