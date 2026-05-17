/**
 * Helper for the Settings ▸ Runtime panel "Switch runtime" action.
 *
 * Clears the persisted runtime selection (mobile-runtime-mode + active-server
 * in localStorage / native Preferences), then navigates to the current URL with
 * `?runtime=picker` appended. The query flag is consumed by
 * `RuntimeGate.hasPickerOverride()` so the ElizaOS auto-local branch is
 * bypassed and the chooser tiles render — the user can then pick Cloud /
 * Remote / Local without the picker auto-completing back to local.
 *
 * This file is deliberately a leaf module with zero React
 * dependencies so its contract can be tested without booting the
 * SettingsView dependency graph (which transitively imports the API
 * client and reads localStorage at module init).
 */
export declare const RUNTIME_PICKER_QUERY_NAME = "runtime";
export declare const RUNTIME_PICKER_QUERY_VALUE = "picker";
export declare const RUNTIME_PICKER_TARGET_QUERY_NAME = "runtimeTarget";
export type RuntimePickerTarget = "cloud" | "local" | "remote";
export declare function reloadIntoRuntimePicker(target?: RuntimePickerTarget): void;
export declare const __TEST_ONLY__: {
    ACTIVE_SERVER_STORAGE_KEY: string;
    MOBILE_RUNTIME_MODE_STORAGE_KEY: string;
};
//# sourceMappingURL=reload-into-runtime-picker.d.ts.map