import { Button, Input } from "@elizaos/ui";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  useCreateInferenceEndpoint,
  useDeleteInferenceEndpoint,
  useInferenceEndpoints,
  useInferenceStats,
} from "./hooks/useTrainingApi";
import type { InferenceEndpoint } from "./types";

function StatsCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <div className="border border-border rounded p-2 text-center bg-card/50">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="text-sm font-semibold text-txt-strong">
        {value !== null ? `${value.toFixed(2)} ${unit}` : "—"}
      </div>
    </div>
  );
}

function EndpointStats({ label }: { label: string }) {
  const { data: stats, loading, error } = useInferenceStats(label);

  if (error) {
    return <div className="text-xs text-red-500">{error}</div>;
  }

  if (loading || !stats) {
    return <div className="text-xs text-muted">Loading stats...</div>;
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <StatsCard label="p50 TPS" value={stats.p50_tps} unit="tok/s" />
      <StatsCard label="p95 TPS" value={stats.p95_tps} unit="tok/s" />
      <StatsCard label="p50 TPOT" value={stats.p50_tpot_ms} unit="ms" />
      <StatsCard label="p95 TPOT" value={stats.p95_tpot_ms} unit="ms" />
      <StatsCard label="KV Cache" value={stats.kv_usage_pct} unit="%" />
      <StatsCard label="Peak VRAM" value={stats.peak_vram_mb} unit="MB" />
      <StatsCard
        label="Spec Decode"
        value={stats.spec_decode_accept_rate}
        unit="%"
      />
      <StatsCard label="APC Hit" value={stats.apc_hit_rate} unit="%" />
    </div>
  );
}

export function InferenceEndpointPanel() {
  const { data: endpoints, loading, error, refetch } = useInferenceEndpoints();
  const { create, loading: createLoading } = useCreateInferenceEndpoint();
  const { delete: deleteEndpoint, loading: deleteLoading } =
    useDeleteInferenceEndpoint();

  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [createErrorMsg, setCreateErrorMsg] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreateErrorMsg(null);
    if (!label || !baseUrl || !model) {
      setCreateErrorMsg("All fields required");
      return;
    }
    try {
      await create({ label, base_url: baseUrl, model });
      setLabel("");
      setBaseUrl("");
      setModel("");
      setShowCreate(false);
      await refetch();
    } catch (err) {
      setCreateErrorMsg(
        err instanceof Error ? err.message : "Failed to create endpoint",
      );
    }
  }, [label, baseUrl, model, create, refetch]);

  const handleDelete = useCallback(
    async (endpointId: string) => {
      try {
        await deleteEndpoint(endpointId);
        await refetch();
      } catch (err) {
        console.error("Failed to delete endpoint:", err);
      }
    },
    [deleteEndpoint, refetch],
  );

  if (error) {
    return (
      <div className="p-4 border border-border rounded bg-red-500/10">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading endpoints...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showCreate ? (
        <div className="border border-border rounded p-4 bg-card space-y-3">
          <div className="text-sm font-semibold">Add Inference Endpoint</div>
          {createErrorMsg && (
            <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded">
              {createErrorMsg}
            </div>
          )}
          <Input
            type="text"
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="text-sm"
          />
          <Input
            type="text"
            placeholder="Base URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="text-sm"
          />
          <Input
            type="text"
            placeholder="Model ID"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              disabled={createLoading}
              className="flex-1"
            >
              {createLoading && (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              )}
              Create
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreate(false)}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreate(true)}
          className="w-full"
        >
          <Plus className="w-4 h-4" />
          Add Endpoint
        </Button>
      )}

      <div className="space-y-3">
        {endpoints && endpoints.length > 0 ? (
          endpoints.map((endpoint: InferenceEndpoint) => (
            <div
              key={endpoint.id}
              className="border border-border rounded p-3 bg-card space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-txt-strong">
                    {endpoint.label}
                  </div>
                  <div className="text-xs text-muted font-mono">
                    {endpoint.base_url}
                  </div>
                  <div className="text-xs text-muted">
                    Model: {endpoint.model}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(endpoint.id)}
                  disabled={deleteLoading}
                  className="text-red-500 hover:text-red-600"
                >
                  {deleteLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </Button>
              </div>

              <button
                type="button"
                onClick={() =>
                  setExpandedId(expandedId === endpoint.id ? null : endpoint.id)
                }
                className="text-xs text-accent hover:underline"
              >
                {expandedId === endpoint.id ? "Hide stats" : "Show stats"}
              </button>

              {expandedId === endpoint.id && (
                <EndpointStats label={endpoint.label} />
              )}
            </div>
          ))
        ) : (
          <div className="text-xs text-muted p-4 text-center border border-border rounded">
            No inference endpoints configured
          </div>
        )}
      </div>
    </div>
  );
}
