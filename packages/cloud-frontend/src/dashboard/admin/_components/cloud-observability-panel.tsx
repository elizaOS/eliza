"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui";
import { Database, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface TelemetryRequest {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  dbCalls: number;
  duplicateDbReadCalls: number;
  createdAt: string;
}

interface TelemetrySnapshot {
  generatedAt: string;
  thresholds: {
    slowRequestMs: number;
    slowDbMs: number;
    dbBurstCount: number;
  };
  requests: TelemetryRequest[];
  slowRequests: TelemetryRequest[];
  slowDb: Array<{ label: string; durationMs: number; operation: string }>;
  burstyRequests: TelemetryRequest[];
  duplicateReadRequests: TelemetryRequest[];
}

export function CloudObservabilityPanel() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/cloud-observability?limit=100", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: TelemetrySnapshot;
      };
      setSnapshot(body.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = snapshot?.requests.slice(0, 8) ?? [];

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-mono text-sm font-semibold text-white">
              Cloud Backend Observability
            </h2>
            <p className="mt-1 text-xs font-mono text-[#858585]">
              Slow requests, slow DB calls, duplicate reads, and DB bursts.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-2 border border-[#303030] px-3 text-xs font-mono text-white/70 hover:bg-white/5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {loading ? "Loading" : "Refresh"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <Metric label="Requests" value={snapshot?.requests.length ?? 0} />
          <Metric
            label="Slow Requests"
            value={snapshot?.slowRequests.length ?? 0}
          />
          <Metric label="Slow DB" value={snapshot?.slowDb.length ?? 0} />
          <Metric
            label="Duplicate Reads"
            value={snapshot?.duplicateReadRequests.length ?? 0}
          />
        </div>

        <div className="overflow-hidden border border-[#242424]">
          <div className="grid grid-cols-[90px_1fr_80px_80px] gap-2 border-b border-[#242424] bg-[#101010] px-3 py-2 text-xs font-mono text-[#858585]">
            <span>Method</span>
            <span>Path</span>
            <span>Status</span>
            <span>DB</span>
          </div>
          {latest.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs font-mono text-[#858585]">
              No request telemetry captured in this isolate yet.
            </div>
          ) : (
            latest.map((request) => (
              <div
                key={request.id}
                className="grid grid-cols-[90px_1fr_80px_80px] gap-2 border-b border-[#1a1a1a] px-3 py-2 text-xs font-mono text-white/75 last:border-b-0"
              >
                <span>{request.method}</span>
                <span className="truncate">{request.path}</span>
                <span>{request.status}</span>
                <span>{request.dbCalls}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </BrandCard>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-[#242424] bg-[#0d0d0d] p-3">
      <div className="flex items-center gap-2 text-[#858585]">
        {label.includes("DB") ? (
          <Database className="h-3.5 w-3.5" />
        ) : (
          <Zap className="h-3.5 w-3.5" />
        )}
        <span className="text-xs font-mono">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
