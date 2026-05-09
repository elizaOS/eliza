// ── Z-index scale ──────────────────────────────────────────────
// Every z-index in the app must come from this file.
// Values are intentionally sparse so new layers can be inserted.

export const Z_BASE = 0;
export const Z_DROPDOWN = 10;
export const Z_STICKY = 20;
export const Z_MODAL_BACKDROP = 50;
export const Z_MODAL = 100;
export const Z_DIALOG_OVERLAY = 160;
export const Z_DIALOG = 170;
export const Z_OVERLAY = 200;
export const Z_TOOLTIP = 300;
export const Z_SYSTEM_BANNER = 9998;
export const Z_SYSTEM_CRITICAL = 9999;
export const Z_SHELL_OVERLAY = 10000;
export const Z_GLOBAL_EMOTE = 11000;
export const Z_SELECT_FLOAT = 12000;

export const CONFIG_SELECT_FLOATING_LAYER_NAME = "config-select";
export const CONFIG_SELECT_FLOATING_LAYER_Z_INDEX = Z_SELECT_FLOAT;
