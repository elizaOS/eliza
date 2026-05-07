"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@elizaos/cloud-ui";
import { Flame, Loader2, RefreshCw, Snowflake } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Warm-pool admin panel: surfaces current pool size, forecast, and policy.
 * Read-only — operators tune via env vars (`WARM_POOL_ENABLED`,
 * `WARM_POOL_MAX_SIZE`, `WARM_POOL_MIN_SIZE`).
 */

interface WarmPoolState {
  enabled: boolean;
  minPoolSize: number;
  maxPoolSize: number;
  image: string;
  size: {
    ready: number;
    provisioning: number;
    onCurrentImage: number;
    stale: number;
  };
  forecast: {
    bucketsHourly: number[];
    predictedRate: number;
    targetPoolSize: number;
  };
  policy: {
    forecastWindowHours: number;
    emaAlpha: number;
    idleScaleDownMs: number;
    replenishBurstLimit: number;
  };
}

export function WarmPoolPanel() {
  const [state, setState] = useState<WarmPoolState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/admin/warm-pool", { credentials: "include" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { success: boolean; data?: WarmPoolState; error?: string };
      if (!body.success || !body.data) {
        throw new Error(body.error ?? "Failed to load warm pool state");
      }
      setState(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const ready = state?.size.ready ?? 0;
  const provisioning = state?.size.provisioning ?? 0;
  const target = state?.forecast.targetPoolSize ?? 0;
  const max = state?.maxPoolSize ?? 10;
  const min = state?.minPoolSize ?? 1;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {state?.enabled ? (
              <Flame className="h-4 w-4 text-orange-500" />
            ) : (
              <Snowflake className="h-4 w-4 text-muted-foreground" />
            )}
            Warm Pool
          </CardTitle>
          <CardDescription className="text-xs">
            Pre-warmed agent containers for instant claim
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchState} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !state ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{ready}</span>
              <span className="text-sm text-muted-foreground">
                ready / target {target} / max {max}
              </span>
              {!state.enabled && (
                <Badge variant="secondary" className="ml-auto">
                  disabled
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {provisioning > 0 && <Badge variant="outline">{provisioning} provisioning</Badge>}
              {state.size.stale > 0 && (
                <Badge variant="destructive">{state.size.stale} stale image</Badge>
              )}
              <Badge variant="outline">floor {min}</Badge>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                Image: <code className="font-mono">{state.image}</code>
              </div>
              <div>
                Recent demand (last {state.policy.forecastWindowHours}h, oldest → newest):{" "}
                {state.forecast.bucketsHourly.join(" / ")}
              </div>
              <div>Predicted rate: {state.forecast.predictedRate.toFixed(2)} per hour</div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
