/**
 * Compatibility re-export. The context object + `useBootConfig` hook live in
 * `./boot-config-react.hooks` so importers stay React Fast Refresh-compatible.
 * Kept as a stable subpath so `@elizaos/ui/config/boot-config-react` and the
 * `browser.ts` facade resolve unchanged.
 */
export { AppBootContext, useBootConfig } from "./boot-config-react.hooks";
