/**
 * FeatureTogglesSection — opt-in registry for LifeOps capabilities.
 *
 * Reads `/api/cloud/features` for the canonical list (defaults +
 * local/cloud overrides) and toggles via `/api/cloud/features/sync` and the
 * `TOGGLE_LIFEOPS_FEATURE` chat action's underlying upsert. Cloud-managed
 * rows are read-only locally — the user has to remove the Cloud package to
 * deactivate them, which preserves the contract that Cloud is the source
 * of truth for managed entitlements (Commandment 4).
 */

import { Button, Switch } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";

type FeatureSource = "default" | "local" | "cloud";

interface FeatureRowDto {
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly source: FeatureSource;
  readonly description: string;
  readonly costsMoney: boolean;
  readonly enabledAt: string | null;
  readonly enabledBy: string | null;
  readonly packageId: string | null;
}

interface FeaturesResponse {
  readonly features: ReadonlyArray<FeatureRowDto>;
}

interface SyncResponse extends FeaturesResponse {
  readonly synced: number;
}

interface ToggleResponse {
  readonly feature: FeatureRowDto;
}

function sourceBadge(source: FeatureSource): {
  label: string;
  className: string;
} {
  switch (source) {
    case "cloud":
      return {
        label: "Cloud",
        className: "border-accent/40 bg-accent/10 text-accent",
      };
    case "local":
      return {
        label: "Local",
        className: "border-ok/40 bg-ok/10 text-ok",
      };
    case "default":
    default:
      return {
        label: "Default",
        className: "border-border/40 bg-card/40 text-muted",
      };
  }
}

export function FeatureTogglesSection() {
  const [features, setFeatures] = useState<FeatureRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedNote, setSyncedNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetch<FeaturesResponse>("/api/cloud/features");
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
    async (feature: FeatureRowDto, next: boolean) => {
      if (feature.source === "cloud") return;
      setBusyKey(feature.featureKey);
      setError(null);
      try {
        const res = await client.fetch<ToggleResponse>(
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
      const res = await client.fetch<SyncResponse>(
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

  return (
    <div className="border-t border-border/40 pt-4">
      <div className="flex items-center justify-between gap-3 pb-3">
        <div>
          <h3 className="text-xs font-semibold">Feature opt-ins</h3>
          <p className="text-xs-tight text-muted">
            Turn LifeOps capabilities on or off. Anything that can spend money
            or call out to a paid third party is off until you opt in.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="!mt-0 h-9 rounded-lg"
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          {syncing ? "Syncing…" : "Sync from Cloud"}
        </Button>
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
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {features.map((feature) => {
            const badge = sourceBadge(feature.source);
            const isCloudManaged = feature.source === "cloud";
            const isBusy = busyKey === feature.featureKey;
            return (
              <li
                key={feature.featureKey}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/40 bg-card/40 px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">
                      {feature.featureKey}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.className}`}
                      title={
                        feature.packageId
                          ? `Cloud package ${feature.packageId}`
                          : undefined
                      }
                    >
                      {badge.label}
                    </span>
                    {feature.costsMoney && (
                      <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
                        Costs money
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted">
                    {feature.description}
                  </p>
                  {isCloudManaged && (
                    <p className="text-xs-tight text-muted">
                      Managed by your Eliza Cloud package — disable it from
                      the Cloud dashboard.
                    </p>
                  )}
                </div>
                <Switch
                  checked={feature.enabled}
                  disabled={isCloudManaged || isBusy}
                  onCheckedChange={(value: boolean) =>
                    void handleToggle(feature, value)
                  }
                  aria-label={`Toggle ${feature.featureKey}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
