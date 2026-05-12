"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  DashboardStatCard,
  StatusBadge,
} from "@elizaos/cloud-ui";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronRight,
  Coins,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileEdit,
  Globe,
  Hammer,
  Key,
  Loader2,
  Mail,
  RefreshCw,
  Rocket,
  Shield,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { App } from "../../../lib/data/apps";

interface AppOverviewProps {
  app: App;
  showApiKey?: string;
}

type DeploymentStatus = "deployed" | "deploying" | "building" | "failed" | "draft";

function DeploymentStatusBadge({ status }: { status: DeploymentStatus }): JSX.Element {
  switch (status) {
    case "deployed":
      return <StatusBadge status="success" label="Deployed" icon={<CheckCircle2 />} />;
    case "deploying":
      return <StatusBadge status="processing" label="Deploying" icon={<Rocket />} />;
    case "building":
      return <StatusBadge status="processing" label="Building" icon={<Hammer />} />;
    case "failed":
      return <StatusBadge status="error" label="Failed" icon={<XCircle />} />;
    case "draft":
    default:
      return <StatusBadge status="neutral" label="Draft" icon={<FileEdit />} />;
  }
}

export function AppOverview({ app, showApiKey }: AppOverviewProps) {
  const navigate = useNavigate();
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [displayApiKey, setDisplayApiKey] = useState(showApiKey || "");
  const [showKey, setShowKey] = useState(!!showApiKey);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [monetizationEnabled, setMonetizationEnabled] = useState<boolean | null>(null);
  const [totalEarnings, setTotalEarnings] = useState<number | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedItem(label);
    toast.success(`${label} copied to clipboard`);
    setTimeout(() => setCopiedItem(null), 2000);
  };

  useEffect(() => {
    if (showApiKey) {
      setDisplayApiKey(showApiKey);
      setShowKey(true);
      const timer = setTimeout(() => {
        setDisplayApiKey("");
        setShowKey(false);
      }, 60000);
      return () => clearTimeout(timer);
    }
  }, [showApiKey]);

  useEffect(() => {
    const fetchMonetization = async () => {
      try {
        const response = await fetch(`/api/v1/apps/${app.id}/monetization`);
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.monetization) {
            setMonetizationEnabled(data.monetization.monetizationEnabled);
            setTotalEarnings(data.monetization.totalCreatorEarnings);
          }
        }
      } catch {
        // Silently fail
      }
    };
    fetchMonetization();
  }, [app.id]);

  async function handleRegenerateApiKey(): Promise<void> {
    setIsRegenerating(true);
    try {
      const response = await fetch(`/api/v1/apps/${app.id}/regenerate-api-key`, {
        method: "POST",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to regenerate API key");
      }

      const data = await response.json();
      if (typeof data.apiKey !== "string" || data.apiKey.length === 0) {
        throw new Error("Regeneration response did not include an API key");
      }
      setDisplayApiKey(data.apiKey);
      setShowKey(true);
      toast.success("API key regenerated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to regenerate");
    } finally {
      setIsRegenerating(false);
    }
  }

  const allowedOrigins: string[] = Array.isArray(app.allowed_origins)
    ? app.allowed_origins.filter((origin): origin is string => typeof origin === "string")
    : [];
  const maskedApiKey = "eliza_" + "•".repeat(32);

  const _getDeploymentBadge = () => {
    const status = app.deployment_status || "draft";
    return <DeploymentStatusBadge status={status as DeploymentStatus} />;
  };

  return (
    <div className="space-y-4">
      {/* New API Key Alert */}
      {showKey && displayApiKey && (
        <div className="p-4 rounded-xl bg-[#FF5800]/10 border border-[#FF5800]/20">
          <div className="flex items-start gap-3">
            <Key className="h-5 w-5 text-[#FF5800] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white mb-2">Your API Key (shown once)</p>
              <div className="flex items-center gap-2 mb-2">
                <code className="flex-1 bg-black/30 px-3 py-2 rounded-lg text-xs text-white/80 font-mono overflow-x-auto">
                  {displayApiKey}
                </code>
                <button
                  onClick={() => copyToClipboard(displayApiKey, "API Key")}
                  className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors shrink-0"
                >
                  {copiedItem === "API Key" ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4 text-white/60" />
                  )}
                </button>
              </div>
              <p className="text-xs text-white/50">
                Save this key securely. You won&apos;t see it again. This message disappears in 60
                seconds.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <DashboardStatCard
          label="Status"
          value={app.is_active ? "Active" : "Inactive"}
          icon={<Activity className="h-5 w-5" />}
          accent={app.is_active ? "emerald" : "red"}
        />
        <DashboardStatCard
          label="Deployment"
          value={
            (app.deployment_status || "draft").charAt(0).toUpperCase() +
            (app.deployment_status || "draft").slice(1)
          }
          icon={<Rocket className="h-5 w-5" />}
          accent="blue"
        />
        <DashboardStatCard
          label="Total Users"
          value={app.total_users?.toLocaleString() || "0"}
          icon={<Shield className="h-5 w-5" />}
          accent="violet"
        />
        <DashboardStatCard
          label="Total Requests"
          value={app.total_requests?.toLocaleString() || "0"}
          icon={<TrendingUp className="h-5 w-5" />}
          accent="orange"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* API Key Card */}
        <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white flex items-center gap-2">
              <Key className="h-4 w-4 text-[#FF5800]" />
              API Key
            </h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  disabled={isRegenerating}
                  className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition-colors"
                >
                  {isRegenerating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Regenerate
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Regenerate API Key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will immediately invalidate your current API key. Your app will stop
                    working until you update it with the new key.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRegenerateApiKey}
                    className="bg-[#FF5800] hover:bg-[#FF5800]/80"
                  >
                    Regenerate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="bg-black/40 rounded-lg p-3 border border-white/10">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-white/70 font-mono overflow-x-auto">
                {showKey && displayApiKey ? displayApiKey : maskedApiKey}
              </code>
              {displayApiKey && (
                <>
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="p-1.5 hover:bg-white/10 rounded transition-colors"
                  >
                    {showKey ? (
                      <EyeOff className="h-3.5 w-3.5 text-white/50" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 text-white/50" />
                    )}
                  </button>
                  <button
                    onClick={() => copyToClipboard(displayApiKey, "API Key")}
                    className="p-1.5 hover:bg-white/10 rounded transition-colors"
                  >
                    {copiedItem === "API Key" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 text-white/50" />
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Use this key to authenticate API requests from your app.
          </p>
        </div>

        {/* Basic Info Card */}
        <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Globe className="h-4 w-4 text-[#FF5800]" />
            App Information
          </h3>

          <div className="space-y-3">
            {app.description && <InfoRow label="Description" value={app.description} />}
            {app.production_url && app.deployment_status === "deployed" && (
              <InfoRow
                label="Production URL"
                value={app.production_url}
                href={app.production_url}
              />
            )}
            {app.website_url && (
              <InfoRow label="Website" value={app.website_url} href={app.website_url} />
            )}
            {app.contact_email && (
              <InfoRow
                label="Contact"
                value={app.contact_email}
                href={`mailto:${app.contact_email}`}
                icon={<Mail className="h-3 w-3" />}
              />
            )}
            {app.last_deployed_at && (
              <InfoRow
                label="Last Deployed"
                value={new Date(app.last_deployed_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              />
            )}
          </div>
        </div>
      </div>

      {/* Monetization Card */}
      {monetizationEnabled !== null && (
        <div className="bg-neutral-900 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Coins className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-white">Monetization</h3>
                <p className="text-xs text-neutral-500">
                  {monetizationEnabled
                    ? totalEarnings && totalEarnings > 0
                      ? `$${totalEarnings.toFixed(2)} earned`
                      : "Enabled, no earnings yet"
                    : "Enable to earn from app usage"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge
                className={cn(
                  monetizationEnabled
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                    : "bg-white/10 text-white/50 border-white/20",
                )}
              >
                {monetizationEnabled ? "Enabled" : "Disabled"}
              </Badge>
              <button
                onClick={() => navigate(`/dashboard/apps/${app.id}?tab=monetization`)}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              >
                <ChevronRight className="h-4 w-4 text-neutral-400" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Allowed Origins */}
      <div className="bg-neutral-900 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-400" />
            Allowed Origins
          </h3>
          <button
            onClick={() => navigate(`/dashboard/apps/${app.id}?tab=settings`)}
            className="text-xs text-neutral-400 hover:text-white transition-colors"
          >
            Edit
          </button>
        </div>
        <p className="text-xs text-neutral-500">
          API requests are only accepted from these domains
        </p>
        <div className="flex flex-wrap gap-2">
          {allowedOrigins.length > 0 ? (
            allowedOrigins.map((origin) => (
              <Badge key={origin} className="bg-white/5 text-white/70 border-white/10">
                {origin}
              </Badge>
            ))
          ) : (
            <p className="text-xs text-neutral-500">No origins configured</p>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  href,
  icon,
}: {
  label: string;
  value: string;
  href?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-neutral-500">{label}</p>
      {href ? (
        <a
          href={href}
          target={href.startsWith("mailto:") ? undefined : "_blank"}
          rel={href.startsWith("mailto:") ? undefined : "noopener noreferrer"}
          className="text-sm text-white hover:text-[#FF5800] transition-colors flex items-center gap-1 mt-0.5"
        >
          {icon}
          <span className="truncate">{value}</span>
          {!href.startsWith("mailto:") && <ExternalLink className="h-3 w-3 shrink-0" />}
        </a>
      ) : (
        <p className="text-sm text-white mt-0.5 line-clamp-2">{value}</p>
      )}
    </div>
  );
}
