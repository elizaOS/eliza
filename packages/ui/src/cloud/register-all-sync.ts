/**
 * @deprecated Use `@elizaos/ui/cloud/register-all` instead.
 *
 * Temporary re-export so earlier PR heads / local fixture paths that imported
 * `./register-all-sync` keep working. The canonical synchronous full-table
 * contract is again `registerAllCloudSurfaces(): void` on `./register-all`.
 */

export { registerAllCloudSurfaces } from "./register-all";
