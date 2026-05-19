import type { ResolvedContentPack } from "@elizaos/shared";
import { Check } from "lucide-react";
import { useApp } from "../../state";

interface LoadedPacksListProps {
  loadedPacks: ResolvedContentPack[];
  activePackId: string | null;
  onToggle: (pack: ResolvedContentPack) => void;
}

export function LoadedPacksList({
  loadedPacks,
  activePackId,
  onToggle,
}: LoadedPacksListProps) {
  const { t } = useApp();
  if (loadedPacks.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
        {t("settings.appearance.loadedPacks", {
          defaultValue: "Loaded content packs",
        })}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {loadedPacks.map((pack) => {
          const isActive = activePackId === pack.manifest.id;
          return (
            <button
              key={pack.manifest.id}
              type="button"
              onClick={() => onToggle(pack)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                isActive
                  ? "border-accent bg-accent/8"
                  : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
              }`}
            >
              {pack.vrmPreviewUrl && (
                <img
                  src={pack.vrmPreviewUrl}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-txt">
                  {pack.manifest.name}
                </p>
                {pack.manifest.description && (
                  <p className="truncate text-xs-tight text-muted">
                    {pack.manifest.description}
                  </p>
                )}
              </div>
              {isActive && (
                <span
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent"
                  title={t("settings.appearance.active", {
                    defaultValue: "Active",
                  })}
                  role="img"
                  aria-label={t("settings.appearance.active", {
                    defaultValue: "Active",
                  })}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
