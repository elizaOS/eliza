/**
 * Browser build entry point — re-exports the same plugin as `index.ts`. The
 * behavioral difference is enforced downstream: `providers/openrouter.ts` omits
 * the Authorization header when `document` is present, so browser bundles must
 * route through an `OPENROUTER_BROWSER_BASE_URL` proxy that injects the key.
 */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
