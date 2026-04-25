import { useCallback, useEffect, useState } from "react";
import {
  type ProviderStatus,
  snapshotProviders,
} from "../../services/local-inference/providers";

const KIND_LABEL: Record<ProviderStatus["kind"], string> = {
  "cloud-api": "Cloud API",
  "cloud-subscription": "Subscription",
  local: "Local",
  "device-bridge": "Device bridge",
};

/**
 * Single pane listing every provider Milady knows about, cloud + local.
 * Each card shows:
 *   - current enable state (green/grey dot + short reason)
 *   - supported model slots
 *   - which slots it has registered handlers for right now
 *   - a "Configure" link back to wherever the actual enable happens
 *
 * The key insight: we don't centralise enable/disable here. Each provider
 * points at the surface that controls it (ProviderSwitcher for cloud,
 * download hub for local, etc). This turns the fragmented multi-provider
 * enable story into a single observable list without forcing a migration.
 */
export function ProvidersList() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const ps = await snapshotProviders();
      setProviders(ps);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load providers");
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll every 10s so provider state follows env-var / config-file
    // changes without the user having to reload.
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error && !providers) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm">
        {error}
      </div>
    );
  }
  if (!providers) {
    return <p className="text-sm text-muted-foreground">Loading providers…</p>;
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          All providers
        </h3>
        <p className="text-xs text-muted-foreground">
          Every inference source Milady knows about — cloud subscription, cloud
          API, local llama.cpp, paired device, on-device Capacitor. Enable as
          many as you want.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {providers.map((p) => {
          const dot = p.enableState.enabled
            ? "bg-emerald-500"
            : "bg-muted-foreground/40";
          return (
            <div
              key={p.id}
              className="rounded-xl border border-border bg-card p-3 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex h-2 w-2 rounded-full ${dot}`}
                  aria-hidden
                />
                <span className="font-medium truncate">{p.label}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                  {KIND_LABEL[p.kind]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {p.description}
              </p>
              <div className="flex flex-wrap gap-1">
                {p.supportedSlots.map((slot) => {
                  const active = p.registeredSlots.includes(slot);
                  return (
                    <span
                      key={slot}
                      className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                        active
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground"
                      }`}
                      title={
                        active
                          ? "Handler currently registered"
                          : "Supported but not currently registered"
                      }
                    >
                      {slot}
                    </span>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground truncate">
                  {p.enableState.reason}
                </span>
                {p.configureHref && (
                  <a
                    href={p.configureHref}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Configure
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
