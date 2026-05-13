// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * `usbeliza` plugin — bundles all usbeliza-specific Actions into one
 * @elizaos/core Plugin. This is the same pattern milady's apps use
 * (`@elizaos/app-companion`, `@elizaos/app-task-coordinator`): a Plugin
 * is just `{ name, description, actions, providers, services }` and the
 * runtime calls `registerPlugin` to wire each member into its registries.
 */

import type { Plugin } from "@elizaos/core";

import { BUILD_APP_ACTION } from "./actions/build-app.ts";
import { OPEN_APP_ACTION } from "./actions/open-app.ts";
import { OPEN_FILES_ACTION } from "./actions/open-files.ts";
import { OPEN_TERMINAL_ACTION } from "./actions/open-terminal.ts";
import { OPEN_URL_ACTION } from "./actions/open-url.ts";
import { DELETE_APP_ACTION, LIST_APPS_ACTION } from "./actions/apps.ts";
import {
    CONNECT_WIFI_ACTION,
    LIST_WIFI_ACTION,
    NETWORK_STATUS_ACTION,
} from "./actions/wifi.ts";
import {
    LOGIN_CLAUDE_ACTION,
    LOGIN_CODEX_ACTION,
} from "./actions/login-claude.ts";
import { DOWNLOAD_MODEL_ACTION } from "./actions/download-model.ts";
import { INSTALL_PACKAGE_ACTION } from "./actions/install-package.ts";
import {
    BATTERY_STATUS_ACTION,
    CURRENT_TIME_ACTION,
} from "./actions/status.ts";
import {
    HELP_ACTION,
    LIST_MODELS_ACTION,
    SETUP_PERSISTENCE_ACTION,
} from "./actions/system.ts";
import { SET_WALLPAPER_ACTION } from "./actions/wallpaper.ts";

export const usbelizaPlugin: Plugin = {
    name: "usbeliza",
    description:
        "usbeliza system actions: build/open/list/delete apps, manage Wi-Fi via " +
        "nmcli, report network status, list local models, enable encrypted " +
        "persistence, answer battery + time questions in chat.",
    actions: [
        BUILD_APP_ACTION,
        OPEN_APP_ACTION,
        OPEN_FILES_ACTION,
        OPEN_TERMINAL_ACTION,
        OPEN_URL_ACTION,
        LIST_APPS_ACTION,
        DELETE_APP_ACTION,
        LIST_WIFI_ACTION,
        CONNECT_WIFI_ACTION,
        NETWORK_STATUS_ACTION,
        LOGIN_CLAUDE_ACTION,
        LOGIN_CODEX_ACTION,
        LIST_MODELS_ACTION,
        DOWNLOAD_MODEL_ACTION,
        INSTALL_PACKAGE_ACTION,
        SETUP_PERSISTENCE_ACTION,
        BATTERY_STATUS_ACTION,
        CURRENT_TIME_ACTION,
        SET_WALLPAPER_ACTION,
        HELP_ACTION,
    ],
};

export const USBELIZA_ACTIONS = usbelizaPlugin.actions ?? [];
