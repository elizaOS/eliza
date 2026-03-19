import { useMemo, useState } from "react";
import { getOnboardingProviderOption, getProviderLogo } from "../providers";
import { useApp } from "../state";
import { CloudCreditsChip } from "./milady-bar/CloudCreditsChip";
import { ProviderDropdown } from "./milady-bar/ProviderDropdown";
import { WalletSummary } from "./milady-bar/WalletSummary";

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

export function MiladyBar() {
  const { plugins, uiTheme, onboardingDetectedProviders } = useApp();
  const isDark = uiTheme !== "light";

  const [activeDropdownId, setActiveDropdownId] = useState<string | null>(null);

  const enabledAiProviders = useMemo(() => {
    return plugins
      .filter((p) => p.category === "ai-provider" && p.enabled)
      .sort((a, b) => {
        const aCatalog = getOnboardingProviderOption(
          normalizeAiProviderPluginId(a.id),
        );
        const bCatalog = getOnboardingProviderOption(
          normalizeAiProviderPluginId(b.id),
        );
        if (aCatalog && bCatalog) return aCatalog.order - bCatalog.order;
        if (aCatalog) return -1;
        if (bCatalog) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [plugins]);

  const detectedMap = useMemo(() => {
    const map = new Map<string, { source: string }>();
    if (onboardingDetectedProviders) {
      for (const p of onboardingDetectedProviders) {
        map.set(p.id, { source: p.source });
      }
    }
    return map;
  }, [onboardingDetectedProviders]);

  return (
    <div
      data-testid="milady-bar"
      className="flex items-center gap-2 px-3 h-10 border-b border-line/30 bg-bg/80 backdrop-blur-sm"
    >
      {/* Provider icons */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        {enabledAiProviders.map((provider) => {
          const normalizedId = normalizeAiProviderPluginId(provider.id);
          const logo = getProviderLogo(normalizedId, isDark);
          const isActive = activeDropdownId === provider.id;

          return (
            <div key={provider.id} className="relative">
              <button
                type="button"
                data-testid={`milady-bar-provider-${normalizedId}`}
                className={`w-7 h-7 rounded-md flex items-center justify-center transition-all cursor-pointer ${
                  isActive
                    ? "ring-2 ring-accent bg-accent/15"
                    : "hover:bg-bg-hover"
                }`}
                title={provider.name}
                onClick={() =>
                  setActiveDropdownId(isActive ? null : provider.id)
                }
              >
                <img
                  src={logo}
                  alt={provider.name}
                  className="w-5 h-5 rounded"
                />
              </button>
              {isActive && (
                <ProviderDropdown
                  pluginId={provider.id}
                  pluginName={provider.name}
                  enabled={provider.enabled}
                  configured={provider.configured}
                  detected={detectedMap.get(normalizedId) ?? null}
                  onClose={() => setActiveDropdownId(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-2 shrink-0">
        <CloudCreditsChip />
        <WalletSummary />
      </div>
    </div>
  );
}
