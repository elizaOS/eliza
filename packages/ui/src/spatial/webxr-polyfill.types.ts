/**
 * Ambient types for the untyped `webxr-polyfill` package (no @types package
 * exists). A plain `.ts` rather than `.d.ts` because generated `.d.ts`
 * declarations under `packages/ui/src` are gitignored. Only the default export's
 * constructor is used: `ensureWebXR()` instantiates the polyfill once to install
 * `navigator.xr` where the API is missing, then discards it (see webxr-runtime.ts).
 */
declare module "webxr-polyfill" {
  export default class WebXRPolyfill {
    constructor(config?: { allowCardboardOnDesktop?: boolean });
  }
}
