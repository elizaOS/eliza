/**
 * Renders the loaded content packs as toggleable settings rows (in the
 * Appearance section), marking the active pack and calling back on toggle. Each
 * row is agent-addressable via `useAgentElement`.
 */

import type { ResolvedContentPack } from "@elizaos/shared";
import { Check } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { useAppSelector } from "../../state";
import { SettingsGroup, SettingsRow } from "./settings-layout";

interface LoadedPacksListProps {
  loadedPacks: ResolvedContentPack[];
  activePackId: string | null;
  onToggle: (pack: ResolvedContentPack) => void;
}

function LoadedPackRow({
  pack,
  isActive,
  activeLabel,
  onToggle,
}: {
  pack: ResolvedContentPack;
  isActive: boolean;
  activeLabel: string;
  onToggle: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `packs-toggle-${pack.manifest.id}`,
    role: "card",
    label: pack.manifest.name,
    description: pack.manifest.description ?? undefined,
    group: "appearance-packs",
    status: isActive ? "active" : "inactive",
    onActivate: onToggle,
  });
  return (
    <SettingsRow
      label={pack.manifest.name}
      description={pack.manifest.description ?? undefined}
      active={isActive}
      onClick={onToggle}
      buttonRef={ref}
      buttonProps={agentProps}
      trailing={
        isActive ? (
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-accent"
            title={activeLabel}
            role="img"
            aria-label={activeLabel}
          >
            <Check className="h-4 w-4" aria-hidden />
          </span>
        ) : null
      }
    />
  );
}

export function LoadedPacksList({
  loadedPacks,
  activePackId,
  onToggle,
}: LoadedPacksListProps) {
  const t = useAppSelector((s) => s.t);
  if (loadedPacks.length === 0) return null;
  const activeLabel = t("settings.appearance.active", {
    defaultValue: "Active",
  });
  return (
    <SettingsGroup
      title={t("settings.appearance.loadedPacks", {
        defaultValue: "Loaded content packs",
      })}
    >
      {loadedPacks.map((pack) => (
        <LoadedPackRow
          key={pack.manifest.id}
          pack={pack}
          isActive={activePackId === pack.manifest.id}
          activeLabel={activeLabel}
          onToggle={() => onToggle(pack)}
        />
      ))}
    </SettingsGroup>
  );
}
