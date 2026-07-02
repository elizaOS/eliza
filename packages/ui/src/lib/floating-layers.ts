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
export const Z_SHELL_OVERLAY = 9000;
export const Z_FIRST_RUN_CHOOSER = 9400;
// The interactive tutorial spotlight: sits above the chat/shell overlay so its
// glow + card always read over an expanded chat, but stays BELOW the
// system-critical band so a fatal banner can never be painted over by the tour.
export const Z_TUTORIAL = 9500;
// The notification center's controlled shells (pull-down sheet + desktop panel)
// and their dismiss backdrop. They sit ABOVE the tutorial spotlight (which is
// pointer-events:none and purely visual) so an opened notification center reads
// over an active tour, and BELOW the system-critical banner band so a fatal
// banner is never painted over. Backdrop just under the overlay so the shell
// always wins the tie.
export const Z_NOTIFICATION_BACKDROP = 9550;
export const Z_NOTIFICATION_OVERLAY = 9560;
export const Z_SYSTEM_BANNER = 9998;
export const Z_SYSTEM_CRITICAL = 9999;
export const Z_GLOBAL_EMOTE = 11000;

export const CONFIG_SELECT_FLOATING_LAYER_NAME = "config-select";
export const CONFIG_SELECT_FLOATING_LAYER_Z_INDEX = 12000;
