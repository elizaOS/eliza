export const Z_DIALOG_OVERLAY = 160;
export const Z_DIALOG = 170;
export const Z_OVERLAY = 200;

// View-owned modals that must cover native/plugin content still stay below the
// shell overlay. Chat is persistent application chrome: views reserve its
// measured clearance and may never dim, blur, or intercept it.
export const Z_VIEW_MODAL_BACKDROP = 8800;
export const Z_VIEW_MODAL = 8810;
export const Z_SHELL_OVERLAY = 9000;

export const Z_SYSTEM_BANNER = 9998;

export const CONFIG_SELECT_FLOATING_LAYER_NAME = "config-select";
export const CONFIG_SELECT_FLOATING_LAYER_Z_INDEX = 12000;

// The build/version diagnostics badge is a ground-truth screenshot marker, so
// app chrome, banners, emotes, and config popovers must never occlude it.
export const Z_BUILD_BADGE = 13000;
