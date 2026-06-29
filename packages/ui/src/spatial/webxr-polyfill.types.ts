// Ambient types for the untyped `webxr-polyfill` package (no @types package
// exists). A plain `.ts` rather than `.d.ts` because `packages/ui/src/**/*.d.ts`
// is gitignored for generated declarations. Only the default export's
// constructor is used: `ensureWebXR()` instantiates the polyfill once to install
// `navigator.xr` where the API is missing, then discards it (see webxr-runtime.ts).
declare module "webxr-polyfill" {
  export default class WebXRPolyfill {
    constructor(config?: { allowCardboardOnDesktop?: boolean });
  }
}
