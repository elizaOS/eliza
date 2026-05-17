/**
 * Routing tab — full-width per-context routing rules table plus the
 * "Default profile" setting. One source of truth: `GET/PUT
 * /api/secrets/routing`.
 *
 * Replaces the cramped per-row routing editor that used to live inside
 * `VaultInventoryPanel`. This tab shows every rule in the system and
 * supports wildcard key patterns (e.g. `OPENROUTER_*`).
 */
import type {
  AgentSummary,
  InstalledApp,
  RoutingConfig,
  VaultEntryMeta,
  VaultTabNavigate,
} from "./types";
export interface RoutingTabProps {
  config: RoutingConfig;
  agents: AgentSummary[];
  apps: InstalledApp[];
  entries: VaultEntryMeta[];
  onConfigChange: (next: RoutingConfig) => void;
  navigate: VaultTabNavigate;
  focusKey: string | null;
  onFocusApplied: () => void;
}
export declare function RoutingTab(
  props: RoutingTabProps,
): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=RoutingTab.d.ts.map
