import type { ResolvedContentPack } from "@elizaos/shared";
import { Check } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { useApp } from "../../state";
import { SettingsGroup } from "./settings-layout";

interface LoadedPacksListProps {
  loadedPacks: ResolvedContentPack[];
  activePackId: string | null;
  onToggle: (pack: ResolvedContentPack) => void;
}

function LoadedPackCard({
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
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-current={isActive ? "true" : undefined}
      className={`flex items-center gap-3 rounded-sm border px-3 py-2 text-left transition-colors ${
        isActive
          ? "border-accent bg-accent/8"
          : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
      }`}
      {...agentProps}
    >
      {pack.vrmPreviewUrl && (
        <img
          src={pack.vrmPreviewUrl}
          alt=""
          className="h-9 w-9 shrink-0 rounded-sm object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-txt">
          {pack.manifest.name}
        </p>
        {pack.manifest.description && (
          <p className="truncate text-xs text-muted">
            {pack.manifest.description}
          </p>
        )}
      </div>
      {isActive && (
        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent"
          title={activeLabel}
          role="img"
          aria-label={activeLabel}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </span>
      )}
    </button>
  );
}

export function LoadedPacksList({
  loadedPacks,
  activePackId,
  onToggle,
}: LoadedPacksListProps) {
  const { t } = useApp();
  if (loadedPacks.length === 0) return null;
  const activeLabel = t("settings.appearance.active", {
    defaultValue: "Active",
  });
  return (
    <SettingsGroup
      bare
      title={t("settings.appearance.loadedPacks", {
        defaultValue: "Loaded content packs",
      })}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {loadedPacks.map((pack) => (
          <LoadedPackCard
            key={pack.manifest.id}
            pack={pack}
            isActive={activePackId === pack.manifest.id}
            activeLabel={activeLabel}
            onToggle={() => onToggle(pack)}
          />
        ))}
      </div>
    </SettingsGroup>
  );
}
