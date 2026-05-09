import { client, useApp } from "@elizaos/ui";
import { Button, Switch } from "@elizaos/ui";
import { Cloud, DollarSign, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LifeOpsFeatureFlagRowDto,
  LifeOpsFeatureFlagsResponse,
  LifeOpsFeatureFlagsSyncResponse,
  LifeOpsFeatureToggleResponse,
} from "../lifeops/feature-flags.types";

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
        <Button
          variant="outline"
          size="sm"
          className="!mt-0 h-9 rounded-lg"
          onClick={() => void handleSignIn()}
          disabled={signInBusy}
          title="Sign in to Cloud"
        >
          {signInBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <LogIn className="h-3.5 w-3.5" aria-hidden />
          )}
          <span>{signInBusy ? "Opening" : "Sign in"}</span>
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        className="!mt-0 h-9 rounded-lg"
        onClick={() => void handleSync()}
        disabled={syncing}
        title="Sync from Cloud"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
          aria-hidden
        />
        <span>{syncing ? "Syncing" : "Sync"}</span>
      </Button>
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
        <div className="mb-3 rounded-lg border border-ok/30 bg-ok/5 px-2.5 py-2 text-xs leading-relaxed text-ok">
          {syncedNote}
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
                  <p className="text-xs leading-relaxed text-muted">
                    {feature.description}
                  </p>
                  {showCloudHint && (
                    <p className="text-xs-tight text-muted">
                      Cloud sign-in enables managed billing; local toggle uses
                      your credentials.
                    </p>
                  )}
                </div>
                <Switch
                  checked={feature.enabled}
                  disabled={isCloudManaged || isBusy}
                  onCheckedChange={(value: boolean) =>
                    void handleToggle(feature, value)
                  }
                  aria-label={`Toggle ${feature.label}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
