import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import { redirect } from "next/navigation";
import { ContainerDeploymentHistory } from "@/components/containers/container-deployment-history";
import { ContainerLogsViewer } from "@/components/containers/container-logs-viewer";
import { ContainerMetrics } from "@/components/containers/container-metrics";
import { BrandCard, BrandButton, CornerBrackets } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink,
  ArrowLeft,
  Server,
  Cpu,
  HardDrive,
  Clock,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { generateContainerMetadata } from "@/lib/seo";

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Generates metadata for the container details page.
 *
 * @param params - Route parameters containing the container ID.
 * @returns Metadata object with title and description for the container details page.
 */
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const user = await requireAuthWithOrg();
  const { id } = await params;
  const container = await getContainer(id, user.organization_id);

  if (!container) {
    return {
      title: "Container Not Found",
      robots: { index: false, follow: false },
    };
  }

  return generateContainerMetadata(
    id,
    container.name,
    container.description,
    null,
  );
}

/**
 * Container details page displaying comprehensive information for a specific container.
 * Shows container status, metrics, deployment history, logs, and configuration.
 * Redirects to containers list if the container doesn't exist or doesn't belong to the user's organization.
 *
 * @param params - Route parameters containing the container ID.
 * @returns The rendered container details page with metrics, history, and logs.
 */
export default async function ContainerDetailsPage({ params }: PageProps) {
  const user = await requireAuthWithOrg();
  const { id } = await params;

  const container = await getContainer(id, user.organization_id);

  if (!container) {
    redirect("/dashboard/containers");
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "running":
        return "bg-green-500";
      case "pending":
      case "building":
      case "deploying":
        return "bg-yellow-500";
      case "failed":
        return "bg-red-500";
      case "stopped":
        return "bg-gray-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Back Navigation */}
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <Link
          href="/dashboard/containers"
          className="group flex items-center gap-2 text-sm text-white/70 hover:text-white transition-all duration-200"
          style={{ fontFamily: "var(--font-roboto-mono)" }}
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-none border border-white/10 bg-black/40 group-hover:bg-white/5 group-hover:border-[#FF5800]/50 transition-all duration-200">
            <ArrowLeft className="h-4 w-4" />
          </div>
          <span className="font-medium">Back to Containers</span>
        </Link>

        {container.load_balancer_url && (
          <BrandButton asChild variant="primary" size="sm">
            <a
              href={container.load_balancer_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
              Open Container
            </a>
          </BrandButton>
        )}
      </div>

      {/* Container Header */}
      <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
        <div className="relative z-10">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-none border border-[#FF5800]/30 bg-[#FF5800]/10">
              <Server className="h-7 w-7 text-[#FF5800]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: "#FF5800" }}
                />
                <h1
                  className="text-3xl font-normal tracking-tight text-white truncate"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {container.name}
                </h1>
              </div>
              {container.description && (
                <p className="text-sm text-white/60 mt-1 line-clamp-2">
                  {container.description}
                </p>
              )}
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Container Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <BrandCard
          className="relative shadow-md shadow-black/30"
          corners={false}
        >
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 rounded-none bg-blue-500/10 border border-blue-500/20">
                <Server className="h-5 w-5 text-blue-500" />
              </div>
              <Badge
                className={`${getStatusColor(container.status)} text-white rounded-none`}
              >
                {container.status}
              </Badge>
            </div>
            <div>
              <p
                className="text-sm font-medium text-white/60 uppercase tracking-wider"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Status
              </p>
              <p
                className="text-2xl font-medium mt-1 capitalize text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {container.status}
              </p>
            </div>
          </div>
        </BrandCard>

        <BrandCard
          className="relative shadow-md shadow-black/30"
          corners={false}
        >
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 rounded-none bg-purple-500/10 border border-purple-500/20">
                <Cpu className="h-5 w-5 text-purple-500" />
              </div>
            </div>
            <div>
              <p
                className="text-sm font-medium text-white/60 uppercase tracking-wider"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                CPU
              </p>
              <p
                className="text-2xl font-medium mt-1 text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {container.cpu}
              </p>
              <p className="text-xs text-white/50 mt-1">vCPU units</p>
            </div>
          </div>
        </BrandCard>

        <BrandCard
          className="relative shadow-md shadow-black/30"
          corners={false}
        >
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 rounded-none bg-emerald-500/10 border border-emerald-500/20">
                <HardDrive className="h-5 w-5 text-emerald-500" />
              </div>
            </div>
            <div>
              <p
                className="text-sm font-medium text-white/60 uppercase tracking-wider"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Memory
              </p>
              <p
                className="text-2xl font-medium mt-1 text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {container.memory} MB
              </p>
              <p className="text-xs text-white/50 mt-1">RAM allocated</p>
            </div>
          </div>
        </BrandCard>

        <BrandCard
          className="relative shadow-md shadow-black/30"
          corners={false}
        >
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 rounded-none bg-amber-500/10 border border-amber-500/20">
                <Clock className="h-5 w-5 text-amber-500" />
              </div>
            </div>
            <div>
              <p
                className="text-sm font-medium text-white/60 uppercase tracking-wider"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Last Deployed
              </p>
              <p
                className="text-lg font-medium mt-1 text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {container.last_deployed_at
                  ? new Date(container.last_deployed_at).toLocaleDateString()
                  : "Never"}
              </p>
              {container.last_deployed_at && (
                <p className="text-xs text-white/50 mt-1">
                  {new Date(container.last_deployed_at).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        </BrandCard>
      </div>

      {/* Deployment Configuration */}
      <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="md">
        <div className="relative z-10 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-2 pb-4 border-b border-white/10">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: "#FF5800" }}
            />
            <h2
              className="text-xl font-normal text-white"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              Deployment Configuration
            </h2>
          </div>

          {/* Configuration Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-4 rounded-none border border-white/10 bg-black/20">
              <Server className="h-5 w-5 text-white/60" />
              <div>
                <p
                  className="text-sm text-white/60 uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Port
                </p>
                <p
                  className="text-lg font-medium text-white"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {container.port}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-none border border-white/10 bg-black/20">
              <Server className="h-5 w-5 text-white/60" />
              <div>
                <p
                  className="text-sm text-white/60 uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Instances
                </p>
                <p
                  className="text-lg font-medium text-white"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {container.desired_count}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-none border border-white/10 bg-black/20">
              <Clock className="h-5 w-5 text-white/60" />
              <div>
                <p
                  className="text-sm text-white/60 uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Created
                </p>
                <p
                  className="text-sm font-medium text-white"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {new Date(container.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {container.error_message && (
            <div className="p-4 bg-red-950/30 border border-red-500/30 rounded-none">
              <div className="flex items-start gap-3">
                <div className="p-1 bg-red-500/10 rounded-none border border-red-500/20">
                  <AlertCircle className="h-5 w-5 text-red-500" />
                </div>
                <div className="flex-1">
                  <p
                    className="font-medium text-red-400 mb-1"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Deployment Error
                  </p>
                  <p className="text-sm text-red-400/80">
                    {container.error_message}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Service Details */}
          {container.ecs_service_arn && (
            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-3">
                <p
                  className="text-sm font-medium text-white/60 min-w-[140px] uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  ECS Service ARN
                </p>
                <code className="text-xs bg-black/60 border border-white/10 px-3 py-1.5 rounded-none font-mono flex-1 text-white/80">
                  {container.ecs_service_arn}
                </code>
              </div>
              {container.load_balancer_url && (
                <div className="flex items-start gap-3">
                  <p
                    className="text-sm font-medium text-white/60 min-w-[140px] uppercase tracking-wider"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    Load Balancer
                  </p>
                  <a
                    href={container.load_balancer_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[#FF5800] hover:text-[#FF5800]/80 flex items-center gap-1 flex-1 transition-colors"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    {container.load_balancer_url}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </BrandCard>

      {/* Container Metrics */}
      {container.status === "running" && container.ecs_service_arn && (
        <ContainerMetrics
          containerId={container.id}
          containerName={container.name}
        />
      )}

      {/* Deployment History */}
      <ContainerDeploymentHistory
        containerId={container.id}
        containerName={container.name}
      />

      {/* Container Logs */}
      <ContainerLogsViewer
        containerId={container.id}
        containerName={container.name}
      />
    </div>
  );
}
