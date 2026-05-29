// Linux WebKitGTK startup hardening — imported for its side effect BEFORE any
// `electrobun/bun` (native WebKitGTK) code runs, so the setting is in place
// before the web process spawns.
//
// On common Linux stacks (notably XWayland + several Mesa/GLX driver combos)
// WebKitGTK's dmabuf renderer emits a non-fatal but noisy
//   `X11 Error: GLXBadWindow (code 168)`
// at webview creation. Disabling the dmabuf renderer is the documented
// WebKitGTK workaround and removes the error with no functional change to
// rendering (WebKitGTK still hardware-accelerates via the standard path).
//
// Only applied on Linux, and only when the variable is unset — so any explicit
// `WEBKIT_DISABLE_DMABUF_RENDERER` from the environment (e.g. a user who wants
// dmabuf re-enabled for their stack) always wins.
if (
  typeof process !== "undefined" &&
  process.platform === "linux" &&
  process.env.WEBKIT_DISABLE_DMABUF_RENDERER === undefined
) {
  process.env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
}

export {};
