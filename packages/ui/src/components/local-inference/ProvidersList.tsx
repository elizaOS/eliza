import { Cloud, Cpu, KeyRound, Settings, Smartphone } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import type { ProviderStatus } from "../../api/client-local-inference";

const KIND_ICON: Record<
  ProviderStatus["kind"],
  {
    Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    label: string;
  }
> = {
  "cloud-api": { Icon: KeyRound, label: "Cloud API" },
  "cloud-subscription": { Icon: Cloud, label: "Subscription" },
  local: { Icon: Cpu, label: "Local" },
  "device-bridge": { Icon: Smartphone, label: "Device bridge" },
};

export function ProvidersList() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { providers: nextProviders } =
        await client.getLocalInferenceProviders();
      setProviders(nextProviders);
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
      <header>
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted">
          Providers
        </h3>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {providers.map((p) => {
          const dot = p.enableState.enabled
            ? "bg-emerald-500"
            : "bg-muted-foreground/40";
          const { Icon, label } = KIND_ICON[p.kind];
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
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="font-medium truncate">{p.label}</span>
                <span className="sr-only">{label}</span>
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
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted transition-colors hover:bg-bg hover:text-txt"
                    title="Configure"
                    aria-label={`Configure ${p.label}`}
                  >
                    <Settings className="h-3.5 w-3.5" aria-hidden />
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
