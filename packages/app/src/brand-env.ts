/**
 * Brand env-var alias table. `buildBrandEnvAliases(prefix)` maps a white-label
 * distribution's `<PREFIX>_*` environment variables (API/auth, cloud-service
 * toggles, ports) onto their canonical `ELIZA_*` names, so a rebranded app can
 * be configured under its own prefix while the runtime still reads `ELIZA_*`.
 * `APP_ENV_ALIASES` is the concrete table resolved for this app's configured
 * prefix (`APP_ENV_PREFIX`).
 */
import { buildBrandEnvAliases } from "@elizaos/shared/config/brand-env-aliases";
import { APP_CONFIG } from "./app-config";
import { normalizeEnvPrefix } from "./env-prefix.js";

export { buildBrandEnvAliases };

export const APP_ENV_PREFIX = normalizeEnvPrefix(
  APP_CONFIG.envPrefix ?? APP_CONFIG.cliName,
);

export const APP_ENV_ALIASES = buildBrandEnvAliases(APP_ENV_PREFIX);
