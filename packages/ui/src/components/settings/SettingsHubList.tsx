/**
 * The Settings hub follows the familiar iOS/Android grouped-list model: quiet
 * labelled surfaces containing recognizable destination rows. Tapping a row
 * opens that section as a subview (the SettingsView swaps the hub for the
 * section body and the shared ViewHeader's back returns here).
 *
 * Purely presentational: grouping, visibility, and hash routing stay in
 * SettingsView / settings-sections.
 */
import { cn } from "../../lib/utils";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import {
  type GroupedSettingsSections,
  SECTION_HUE_MEDALLION_CLASS,
} from "./settings-sections";

type SettingsHubSection = GroupedSettingsSections[number]["items"][number];

function SettingsHubRow({
  section,
  onSelect,
  label,
}: {
  section: SettingsHubSection;
  onSelect: (id: string) => void;
  label: (labelKey: string, fallback: string) => string;
}) {
  const sectionLabel = label(section.label, section.defaultLabel);

  return (
    <SettingsRow
      icon={section.icon}
      iconClassName="size-4"
      iconContainerClassName={cn(
        "size-7 rounded-lg",
        SECTION_HUE_MEDALLION_CLASS[section.hue],
      )}
      label={sectionLabel}
      onClick={() => onSelect(section.id)}
      buttonProps={{
        "data-testid": `settings-hub-row-${section.id}`,
      }}
    />
  );
}

export function SettingsHubList({
  grouped,
  onSelect,
  label,
}: {
  grouped: GroupedSettingsSections;
  onSelect: (id: string) => void;
  /** i18n resolver for group + section labels (resolved by the caller). */
  label: (labelKey: string, fallback: string) => string;
}): React.JSX.Element {
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-hub-list"
      data-testid="settings-hub-list"
      className="settings-surface flex w-full flex-col gap-5 px-4"
    >
      {grouped.map(({ group, label: groupLabel, items }) => (
        <SettingsGroup
          key={group}
          title={groupLabel}
          headingLevel={2}
          data-testid={`settings-hub-group-${group}`}
        >
          {items.map((section) => (
            <SettingsHubRow
              key={section.id}
              section={section}
              onSelect={onSelect}
              label={label}
            />
          ))}
        </SettingsGroup>
      ))}
    </nav>
  );
}
