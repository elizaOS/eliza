import { Button, client, Switch, useApp } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Check, Cloud, DollarSign, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LifeOpsFeatureFlagRowDto,
  LifeOpsFeatureFlagsResponse,
  LifeOpsFeatureFlagsSyncResponse,
  LifeOpsFeatureToggleResponse,
} from "../lifeops/feature-flags.types";

function slugifyFeatureKey(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "feature"
  );
}

function FeatureToggleSwitch({
  feature,
  disabled,
  onToggle,
}: {
  feature: LifeOpsFeatureFlagRowDto;
  disabled: boolean;
  onToggle: (feature: LifeOpsFeatureFlagRowDto, next: boolean) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `settings-feature-${slugifyFeatureKey(feature.featureKey)}`,
    role: "toggle",
    label: `Toggle ${feature.label}`,
    group: "lifeops-features",
    status: feature.enabled ? "active" : "inactive",
    description: `Enable or disable the ${feature.label} feature`,
    getValue: () => feature.enabled,
    onActivate: () => {
      if (!disabled) onToggle(feature, !feature.enabled);
    },
    onFill: (value: string) => {
      if (disabled) return;
      const next = value === "true" || value === "1" || value === "on";
      onToggle(feature, next);
    },
  });
  return (
    <Switch
      ref={ref}
      checked={feature.enabled}
      disabled={disabled}
      onCheckedChange={(value: boolean) => onToggle(feature, value)}
      aria-label={`Toggle ${feature.label}`}
      {...agentProps}
    />
  );
}

function FeatureFlagsSignInButton({
  busy,
  onSignIn,
}: {
  busy: boolean;
  onSignIn: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "settings-features-sign-in",
    role: "button",
    label: "Sign in to Cloud",
    group: "lifeops-features",
    description: "Sign in to Eliza Cloud to manage cloud features",
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="!mt-0 h-9 w-9 rounded-lg p-0"
      onClick={onSignIn}
      disabled={busy}
      title="Sign in to Cloud"
      {...agentProps}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <LogIn className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="sr-only">{busy ? "Opening Cloud" : "Sign in"}</span>
    </Button>
  );
}

function FeatureFlagsSyncButton({
  syncing,
  onSync,
}: {
  syncing: boolean;
  onSync: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "settings-features-sync",
    role: "button",
    label: "Sync features from Cloud",
    group: "lifeops-features",
    description: "Sync cloud-managed feature flags from Eliza Cloud",
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="!mt-0 h-9 w-9 rounded-lg p-0"
      onClick={onSync}
      disabled={syncing}
      title="Sync from Cloud"
      {...agentProps}
    >
      <RefreshCw
        className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
        aria-hidden
      />
      <span className="sr-only">
        {syncing ? "Syncing features" : "Sync features"}
      </span>
    </Button>
  );
}

export function LifeOpsFeatureTogglesSection() {
  const { elizaCloudConnected, handleCloudLogin } = useApp();
  const [features, setFeatures] = useState<LifeOpsFeatureFlagRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedNote, setSyncedNote] = useState<string | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetch<LifeOpsFeatureFlagsResponse>(
        "/api/cloud/features",
      );
      setFeatures([...res.features]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (feature: LifeOpsFeatureFlagRowDto, next: boolean) => {
      if (feature.source === "cloud") return;
      setBusyKey(feature.featureKey);
      setError(null);
      try {
        const res = await client.fetch<LifeOpsFeatureToggleResponse>(
          "/api/lifeops/features/toggle",
          {
            method: "POST",
            body: JSON.stringify({
              featureKey: feature.featureKey,
              enabled: next,
            }),
          },
        );
        setFeatures((prev) =>
          prev.map((row) =>
            row.featureKey === feature.featureKey ? res.feature : row,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [],
  );

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncedNote(null);
    setError(null);
    try {
      const res = await client.fetch<LifeOpsFeatureFlagsSyncResponse>(
        "/api/cloud/features/sync",
        { method: "POST" },
      );
      setFeatures([...res.features]);
      setSyncedNote(`Synced ${res.synced} cloud-managed feature(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleSignIn = useCallback(async () => {
    setSignInBusy(true);
    setError(null);
    try {
      await handleCloudLogin();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSignInBusy(false);
    }
  }, [handleCloudLogin, load]);

  const headerCta = useMemo(() => {
    if (!elizaCloudConnected) {
      return (
        <FeatureFlagsSignInButton
          busy={signInBusy}
          onSignIn={() => void handleSignIn()}
        />
      );
    }
    return (
      <FeatureFlagsSyncButton syncing={syncing} onSync={() => void handleSync()} />
    );
  }, [elizaCloudConnected, handleSignIn, handleSync, signInBusy, syncing]);

  return (
    <div>
      <div className="flex items-center justify-end gap-3 pb-3">
        {headerCta}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-xs leading-relaxed text-danger">
          {error}
        </div>
      )}
      {syncedNote && !error && (
        <div
          className="mb-3 inline-flex h-7 w-7 items-center justify-center rounded-full border border-ok/30 bg-ok/5 text-ok"
          role="status"
          aria-label={syncedNote}
          title={syncedNote}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{syncedNote}</span>
        </div>
      )}

      {loading ? (
        <div
          className="inline-flex items-center text-muted"
          role="status"
          aria-label="Loading features"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        </div>
      ) : (
        <ul className="space-y-2">
          {features.map((feature) => {
            const isCloudManaged = feature.source === "cloud";
            const isBusy = busyKey === feature.featureKey;
            const showCloudBillingTag =
              feature.cloudDefaultOn && isCloudManaged;
            const showCloudHint =
              feature.cloudDefaultOn && !elizaCloudConnected && !isCloudManaged;
            return (
              <li
                key={feature.featureKey}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/40 bg-card/40 px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">
                      {feature.label}
                    </span>
                    {isCloudManaged && (
                      <span
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-accent/35 bg-accent/10 text-accent"
                        title={
                          feature.packageId
                            ? `Managed by cloud package ${feature.packageId}`
                            : "Managed by Cloud"
                        }
                      >
                        <Cloud className="h-3 w-3" aria-hidden />
                        <span className="sr-only">Cloud-managed</span>
                      </span>
                    )}
                    {(feature.costsMoney || showCloudBillingTag) && (
                      <span
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-warn/35 bg-warn/10 text-warn"
                        title="May use billable services"
                      >
                        <DollarSign className="h-3 w-3" aria-hidden />
                        <span className="sr-only">May cost money</span>
                      </span>
                    )}
                  </div>
                  <span className="sr-only">{feature.description}</span>
                  {showCloudHint && (
                    <span
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/35 bg-bg/40 text-muted"
                      title="Cloud sign-in enables managed billing; local toggle uses your credentials."
                      aria-label="Cloud sign-in enables managed billing; local toggle uses your credentials."
                    >
                      <Cloud className="h-3 w-3" aria-hidden />
                    </span>
                  )}
                </div>
                <FeatureToggleSwitch
                  feature={feature}
                  disabled={isCloudManaged || isBusy}
                  onToggle={(target, value) =>
                    void handleToggle(target, value)
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
