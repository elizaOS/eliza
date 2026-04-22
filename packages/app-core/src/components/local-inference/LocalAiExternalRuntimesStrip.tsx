import { useApp } from "../../state";
import { ExternalRuntimesSection } from "./ExternalRuntimesSection";
import { useLocalInferenceHub } from "./local-inference-hub-context";

/**
 * Local AI engine probe cards — **shared** between AI Models and Embeddings so
 * URLs and engine preference stay in one place.
 */
export function LocalAiExternalRuntimesStrip() {
  const { t } = useApp();
  const { backends, busy, refresh, bumpRoutingRefresh } =
    useLocalInferenceHub();

  return (
    <section
      className="rounded-xl border border-border/70 bg-card/85 px-3 py-3 shadow-sm space-y-2"
      aria-label={t("settings.sharedLocalAiRuntimes.regionLabel", {
        defaultValue: "Local AI HTTP stacks",
      })}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted">
        {t("settings.sharedLocalAiRuntimes.title", {
          defaultValue: "Local AI engines",
        })}
      </p>
      <ExternalRuntimesSection
        backends={backends}
        onRefresh={() => void refresh({ forceExternalProbe: true })}
        onExternalLlmAutodetectFocusChange={bumpRoutingRefresh}
        busy={busy}
      />
    </section>
  );
}
