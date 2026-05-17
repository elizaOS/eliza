/**
 * Shared catalog fetch for views that need to resolve a slug against the
 * union of `client.listApps()` (installed) and `client.listCatalogApps()`
 * (registry). A module-level promise coalesces concurrent callers so two
 * views mounted for the same slug only hit the API once.
 */
import { type RegistryAppInfo } from "../../api";
interface RegistryCatalogState {
    catalog: RegistryAppInfo[] | null;
    error: string | null;
    loading: boolean;
}
export declare function useRegistryCatalog(): RegistryCatalogState;
export {};
//# sourceMappingURL=useRegistryCatalog.d.ts.map