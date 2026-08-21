/**
 * Cloud panel section group definitions.
 *
 * The cloud-only desktop settings panel uses a different grouping from the
 * legacy registry (agent/system/security). Sections are grouped by user mental
 * model: GENERAL, AGENT, SYSTEM, ADVANCED.
 */
export type CloudPanelGroupId = "general" | "agent" | "system" | "advanced";

export interface CloudPanelGroup {
  id: CloudPanelGroupId;
  label: string;
  /** Display order within the sidebar (lower first). */
  order: number;
}

export const CLOUD_PANEL_GROUPS: readonly CloudPanelGroup[] = [
  { id: "general", label: "General", order: 0 },
  { id: "agent", label: "Agent", order: 1 },
  { id: "system", label: "System", order: 2 },
  { id: "advanced", label: "Advanced", order: 3 },
] as const;

export const CLOUD_PANEL_GROUP_ORDER: readonly CloudPanelGroupId[] =
  CLOUD_PANEL_GROUPS.map((g) => g.id);

export const CLOUD_PANEL_GROUP_LABEL: Record<CloudPanelGroupId, string> =
  Object.fromEntries(
    CLOUD_PANEL_GROUPS.map((g) => [g.id, g.label]),
  ) as Record<CloudPanelGroupId, string>;
