/**
 * Builds the one shared, familiar Settings taxonomy used by compact and wide
 * layouts. Everyday destinations stay visible; specialist/developer sections
 * remain addressable by deep link and by the agent without crowding the hub.
 * A directly-opened specialist section is retained in the wide rail so its
 * current location never becomes ambiguous.
 */
import { partitionSettingsSections } from "./settings-section-registry";
import type { GroupedSettingsSections } from "./settings-sections";

export function buildSettingsNavigationGroups(
  grouped: GroupedSettingsSections,
  activeId: string | null,
): GroupedSettingsSections {
  return grouped.flatMap((entry) => {
    const { primary, secondary } = partitionSettingsSections(entry.items);
    const activeSecondary = secondary.find(
      (section) => section.id === activeId,
    );
    const items = activeSecondary ? [...primary, activeSecondary] : primary;
    return items.length > 0 ? [{ ...entry, items }] : [];
  });
}
