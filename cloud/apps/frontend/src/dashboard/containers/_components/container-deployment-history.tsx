/**
 * Container deployment history component displaying past deployment records.
 * Shows deployment status, cost, duration, and configuration details.
 *
 * @param props - Container deployment history configuration
 * @param props.containerId - Container ID to fetch deployment history for
 * @param props.containerName - Container name for display
 */

"use client";

import { Badge, BrandCard, Skeleton } from "@elizaos/cloud-ui";
import {
  CheckCircle2,
  Clock,
  Cpu,
  HardDrive,
  Loader2,
  Network,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

interface Deployment {
  id: string;
  status: "success" | "failed" | "pending";
  cost: number;
  error?: string;
  metadata: {
    container_id?: string;
    container_name?: string;
    desired_count?: number;
    cpu?: number;
    memory?: number;
    port?: number;
    image_tag?: string;
    node_id?: string;
  };
  deployed_at: Date;
  duration_ms?: number;
}

interface DeploymentHistoryProps {
  containerId: string;
  containerName: string;
}

export function ContainerDeploymentHistory({ containerId, containerName }: DeploymentHistoryProps) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDeployments() {
      setLoading(true);
      const response = await fetch(`/api/v1/containers/${containerId}/deployments`);

      if (!response.ok) {
        setLoading(false);
        throw new Error("Failed to fetch deployment history");
      }

      const data = await response.json();
      if (data.success) {
        setDeployments(data.data.deployments);
      } else {
        setError(data.error || "Failed to load deployments");
      }
      setLoading(false);
    }

    fetchDeployments();
  }, [containerId]);

  if (loading) {
    return (
      <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
        <div className="relative z-10 space-y-4">
          <div className="flex items-center gap-2 pb-4 border-b border-white/10">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: "#FF5800" }}
            />
            <h2
              className="text-xl font-normal text-white"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              Deployment History
            </h2>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-none" />
            <Skeleton className="h-12 w-full rounded-none" />
            <Skeleton className="h-12 w-full rounded-none" />
          </div>
        </div>
      </BrandCard>
    );
  }

  if (error) {
    return (
      <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
        <div className="relative z-10 space-y-4">
          <div className="flex items-center gap-2 pb-4 border-b border-white/10">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: "#FF5800" }}
            />
            <h2
              className="text-xl font-normal text-white"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              Deployment History
            </h2>
          </div>
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      </BrandCard>
    );
  }

  // Calculate success rate only for completed deployments (exclude pending)
  const completedDeployments = deployments.filter(
    (d) => d.status === "success" || d.status === "failed",
  );
  const successRate =
    completedDeployments.length > 0
      ? (completedDeployments.filter((d) => d.status === "success").length /
          completedDeployments.length) *
        100
      : 0;

  const pendingCount = deployments.filter((d) => d.status === "pending").length;

  const _avgDuration =
    deployments.length > 0 && deployments.some((d) => d.duration_ms)
      ? deployments.filter((d) => d.duration_ms).reduce((sum, d) => sum + (d.duration_ms || 0), 0) /
        deployments.filter((d) => d.duration_ms).length
      : null;

  const totalCost = deployments.reduce((sum, d) => sum + (Number(d.cost) || 0), 0);

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: "#FF5800" }}
              />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Deployment History
              </h2>
            </div>
            <p className="text-sm text-white/60">Past deployments for {containerName}</p>
          </div>
          {deployments.length > 0 && (
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-500" />
                <span
                  className="text-white/60 uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Success Rate:
                </span>
                <span
                  className="font-medium text-white"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {successRate.toFixed(0)}%
                </span>
              </div>
            </div>
          )}
        </div>

        <div>
          {deployments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="rounded-none bg-black/60 border border-white/10 p-4 mb-4">
                <Clock className="h-8 w-8 text-white/60" />
              </div>
              <p className="text-white/60">No deployment history available</p>
              <p className="text-sm text-white/50 mt-2">
                Deployment records will appear here after your first deployment
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Stats Overview */}
              <div className="grid grid-cols-4 gap-4 pb-4 border-b border-white/10">
                <div className="text-center p-4 rounded-none border border-white/10 bg-black/20">
                  <p
                    className="text-2xl font-medium text-green-500"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    {deployments.filter((d) => d.status === "success").length}
                  </p>
                  <p
                    className="text-xs text-white/60 mt-1 uppercase tracking-wider"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Successful
                  </p>
                </div>
                <div className="text-center p-4 rounded-none border border-white/10 bg-black/20">
                  <p
                    className="text-2xl font-medium text-red-500"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    {deployments.filter((d) => d.status === "failed").length}
                  </p>
                  <p
                    className="text-xs text-white/60 mt-1 uppercase tracking-wider"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Failed
                  </p>
                </div>
                <div className="text-center p-4 rounded-none border border-white/10 bg-black/20">
                  <p
                    className="text-2xl font-medium text-yellow-500"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    {pendingCount}
                  </p>
                  <p
                    className="text-xs text-white/60 mt-1 uppercase tracking-wider"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Pending
                  </p>
                </div>
                <div className="text-center p-4 rounded-none border border-white/10 bg-black/20">
                  <p
                    className="text-2xl font-medium text-[#FF5800]"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    ${totalCost.toFixed(2)}
                  </p>
                  <p
                    className="text-xs text-white/60 mt-1 uppercase tracking-wider"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Total Cost
                  </p>
                </div>
              </div>

              {/* Timeline */}
              <div className="space-y-3">
                {deployments.map((deployment, index) => (
                  <div
                    key={deployment.id}
                    className="relative pl-8 pb-4 border-l-2 border-white/10 last:border-l-0 last:pb-0"
                  >
                    {/* Timeline dot */}
                    <div className="absolute left-[-9px] top-1">
                      {deployment.status === "success" ? (
                        <div className="p-1 bg-[#0A0A0A] rounded-none border border-white/10">
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        </div>
                      ) : deployment.status === "pending" ? (
                        <div className="p-1 bg-[#0A0A0A] rounded-none border border-yellow-500/30">
                          <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />
                        </div>
                      ) : (
                        <div className="p-1 bg-[#0A0A0A] rounded-none border border-white/10">
                          <XCircle className="h-4 w-4 text-red-500" />
                        </div>
                      )}
                    </div>

                    {/* Deployment card */}
                    <div className="bg-black/30 border border-white/10 rounded-none p-4 hover:bg-black/40 hover:border-white/20 hover:shadow-md hover:shadow-black/40 transition-all shadow-sm shadow-black/20">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <Badge
                            variant={
                              deployment.status === "success"
                                ? "default"
                                : deployment.status === "pending"
                                  ? "secondary"
                                  : "destructive"
                            }
                            className={`font-medium rounded-none ${deployment.status === "pending" ? "bg-yellow-500/20 text-yellow-500 border-yellow-500/30" : ""}`}
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {deployment.status === "pending" ? "deploying..." : deployment.status}
                          </Badge>
                          <span
                            className="text-sm text-white/60"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {new Date(deployment.deployed_at).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-white/60">
                          {deployment.duration_ms && (
                            <div className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              <span
                                style={{
                                  fontFamily: "var(--font-roboto-mono)",
                                }}
                              >
                                {(deployment.duration_ms / 1000).toFixed(1)}s
                              </span>
                            </div>
                          )}
                          <span
                            className="font-medium text-[#FF5800]"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            ${Number(deployment.cost).toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <Network className="h-3 w-3 text-white/60" />
                          <span
                            className="text-white/60"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            Instances:
                          </span>
                          <span
                            className="font-medium text-white"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {deployment.metadata.desired_count || 1}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Cpu className="h-3 w-3 text-white/60" />
                          <span
                            className="text-white/60"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            CPU:
                          </span>
                          <span
                            className="font-medium text-white"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {deployment.metadata.cpu || 256}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <HardDrive className="h-3 w-3 text-white/60" />
                          <span
                            className="text-white/60"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            Memory:
                          </span>
                          <span
                            className="font-medium text-white"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {deployment.metadata.memory || 512}MB
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Network className="h-3 w-3 text-white/60" />
                          <span
                            className="text-white/60"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            Port:
                          </span>
                          <span
                            className="font-medium text-white"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {deployment.metadata.port || 3000}
                          </span>
                        </div>
                      </div>

                      {deployment.error && (
                        <div className="mt-3 p-2 bg-red-950/30 border border-red-500/30 rounded-none text-xs text-red-400">
                          <strong>Error:</strong> {deployment.error}
                        </div>
                      )}

                      {deployment.metadata.image_tag && (
                        <div className="mt-2 text-xs text-white/60">
                          <span
                            className="font-mono"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            Tag: {deployment.metadata.image_tag}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
