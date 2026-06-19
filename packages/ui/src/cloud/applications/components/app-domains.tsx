/**
 * Application detail — Domains tab (subdomain + custom domain + DNS verify).
 * Ported from
 * `@elizaos/cloud-frontend/src/dashboard/apps/_components/app-domains.tsx`. The
 * domain list/add/remove/status `fetch` calls are routed through the typed `api`
 * client.
 */

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

interface DomainInfo {
  id: string;
  subdomain: string;
  subdomainUrl: string;
  customDomain: string | null;
  customDomainUrl: string | null;
  customDomainVerified: boolean;
  sslStatus: "pending" | "provisioning" | "active" | "error";
  isPrimary: boolean;
  verificationRecords: Array<{ type: string; name: string; value: string }>;
  createdAt: string;
  verifiedAt: string | null;
}

interface DnsInstruction {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
}

interface DomainStatus {
  domain: string;
  status: "pending" | "valid" | "invalid" | "unknown";
  configured: boolean;
  verified: boolean;
  sslStatus: "pending" | "provisioning" | "active" | "error";
  configuredBy: "CNAME" | "A" | "http" | null;
  records: Array<{ type: string; name: string; value: string }>;
  isApexDomain: boolean;
  dnsInstructions: DnsInstruction[];
}

interface DomainsListResponse {
  success?: boolean;
  domains?: DomainInfo[];
  sandboxUrl?: string | null;
}

interface DomainStatusResponse extends Partial<DomainStatus> {
  success?: boolean;
}

interface DomainMutationResponse {
  success?: boolean;
  error?: string;
  domain?: string;
  verified?: boolean;
  isApexDomain?: boolean;
  verificationRecords?: Array<{ type: string; name: string; value: string }>;
  dnsInstructions?: DnsInstruction[];
}

interface AppDomainsProps {
  appId: string;
}

export function AppDomains({ appId }: AppDomainsProps) {
  const t = useCloudT();
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [domainStatus, setDomainStatus] = useState<DomainStatus | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchDomains = useCallback(async () => {
    try {
      const data = await api<DomainsListResponse>(
        `/api/v1/apps/${appId}/domains`,
      );
      if (data.success && data.domains) {
        setDomains(data.domains);
        setSandboxUrl(data.sandboxUrl || null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [appId]);

  const checkDomainStatus = useCallback(
    async (domain: string, silent = false) => {
      if (!silent) setIsChecking(true);
      try {
        const data = await api<DomainStatusResponse>(
          `/api/v1/apps/${appId}/domains/status`,
          { method: "POST", json: { domain } },
        );

        if (data.success) {
          setDomainStatus(data as DomainStatus);
          setLastChecked(new Date());
          if (data.verified) {
            if (!silent) {
              toast.success(
                t("cloud.appDomains.domainVerified", {
                  defaultValue: "Domain verified!",
                }),
                {
                  description: t("cloud.appDomains.sslProvisioningNow", {
                    defaultValue: "SSL certificate is now being provisioned",
                  }),
                  icon: <CheckCircle2 className="h-4 w-4 text-green-400" />,
                },
              );
            }
            await fetchDomains();
          }
        }
      } finally {
        if (!silent) setIsChecking(false);
      }
    },
    [appId, fetchDomains, t],
  );

  useEffect(() => {
    void fetchDomains();
  }, [fetchDomains]);

  useEffect(() => {
    const primaryDomain = domains.find((d) => d.isPrimary);
    if (primaryDomain?.customDomain && !primaryDomain.customDomainVerified) {
      pollIntervalRef.current = setInterval(() => {
        checkDomainStatus(primaryDomain.customDomain ?? "", true);
      }, 15000);

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
      };
    }
  }, [domains, checkDomainStatus]);

  useEffect(() => {
    if (showAddForm && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showAddForm]);

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedValue(text);
    toast.success(
      t("cloud.appDomains.copiedToClipboard", {
        label,
        defaultValue: "{{label}} copied to clipboard",
      }),
    );
    setTimeout(() => setCopiedValue(null), 2000);
  };

  const handleAddDomain = async () => {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;

    const domainRegex = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
    if (!domainRegex.test(domain)) {
      toast.error(
        t("cloud.appDomains.invalidDomain", {
          defaultValue: "Invalid domain",
        }),
        {
          description: t("cloud.appDomains.invalidDomainHint", {
            defaultValue:
              "Please enter a valid domain like example.com or app.example.com",
          }),
        },
      );
      return;
    }

    setIsAdding(true);
    try {
      const data = await api<DomainMutationResponse>(
        `/api/v1/apps/${appId}/domains`,
        { method: "POST", json: { domain } },
      );

      if (data.success) {
        toast.success(
          data.verified
            ? t("cloud.appDomains.domainVerified", {
                defaultValue: "Domain verified!",
              })
            : t("cloud.appDomains.domainAdded", {
                defaultValue: "Domain added successfully",
              }),
          {
            description: data.verified
              ? t("cloud.appDomains.sslProvisioningAuto", {
                  defaultValue:
                    "SSL certificate is being provisioned automatically",
                })
              : t("cloud.appDomains.configureDnsToComplete", {
                  defaultValue: "Configure your DNS records to complete setup",
                }),
          },
        );
        setDomainStatus({
          domain: data.domain ?? domain,
          status: data.verified ? "valid" : "pending",
          configured: Boolean(data.verified),
          verified: Boolean(data.verified),
          sslStatus: data.verified ? "active" : "pending",
          configuredBy: null,
          records: data.verificationRecords ?? [],
          isApexDomain: Boolean(data.isApexDomain),
          dnsInstructions: data.dnsInstructions ?? [],
        });
        setNewDomain("");
        setShowAddForm(false);
        await fetchDomains();
      } else {
        toast.error(
          t("cloud.appDomains.failedToAdd", {
            defaultValue: "Failed to add domain",
          }),
          { description: data.error },
        );
      }
    } catch (error) {
      toast.error(
        t("cloud.appDomains.failedToAdd", {
          defaultValue: "Failed to add domain",
        }),
        {
          description: error instanceof Error ? error.message : undefined,
        },
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveDomain = async (domain: string) => {
    setIsRemoving(true);
    try {
      const data = await api<DomainMutationResponse>(
        `/api/v1/apps/${appId}/domains`,
        { method: "DELETE", json: { domain } },
      );

      if (data.success) {
        toast.success(
          t("cloud.appDomains.domainRemoved", {
            defaultValue: "Domain removed successfully",
          }),
        );
        setDomainStatus(null);
        await fetchDomains();
      } else {
        toast.error(
          t("cloud.appDomains.failedToRemove", {
            defaultValue: "Failed to remove domain",
          }),
          { description: data.error },
        );
      }
    } catch (error) {
      toast.error(
        t("cloud.appDomains.failedToRemove", {
          defaultValue: "Failed to remove domain",
        }),
        {
          description: error instanceof Error ? error.message : undefined,
        },
      );
    } finally {
      setIsRemoving(false);
    }
  };

  const primaryDomain = domains.find((d) => d.isPrimary);
  const hasCustomDomain = !!primaryDomain?.customDomain;
  const needsVerification =
    hasCustomDomain && !primaryDomain?.customDomainVerified;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Main Domains Card */}
        <div className="bg-neutral-900 rounded-sm p-4">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-medium text-white flex items-center gap-2">
                <Globe className="h-4 w-4 text-[#FF5800]" />
                {t("cloud.appDomains.title", { defaultValue: "Domains" })}
              </h3>
              <p className="text-xs text-neutral-500 mt-1">
                {t("cloud.appDomains.subtitle", {
                  defaultValue: "Connect custom domains to your app",
                })}
              </p>
            </div>
            {primaryDomain &&
              !hasCustomDomain &&
              !showAddForm &&
              !isLoading && (
                <Button
                  onClick={() => setShowAddForm(true)}
                  size="sm"
                  className="bg-[#FF5800] hover:bg-[#e54f00] text-white rounded-sm"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  {t("cloud.appDomains.addDomain", {
                    defaultValue: "Add Domain",
                  })}
                </Button>
              )}
          </div>

          {/* Loading State */}
          {isLoading ? (
            <div className="space-y-3">
              <div className="h-16 bg-black/30 rounded-sm animate-pulse" />
              <div className="h-16 bg-black/30 rounded-sm animate-pulse opacity-50" />
            </div>
          ) : !primaryDomain && sandboxUrl ? (
            /* Sandbox URL */
            <div className="space-y-3">
              <DomainCard
                domain={new URL(sandboxUrl).hostname}
                url={sandboxUrl}
                type="subdomain"
                status="verified"
                copyToClipboard={copyToClipboard}
                copiedValue={copiedValue}
              />
              <div className="p-3 rounded-sm bg-white/5 border border-white/10">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-white/70 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-white/90 font-medium">
                      {t("cloud.appDomains.developmentUrl", {
                        defaultValue: "Development URL",
                      })}
                    </p>
                    <p className="text-xs text-white/60 mt-0.5">
                      {t("cloud.appDomains.developmentUrlHint", {
                        defaultValue:
                          "Deploy your app to get a permanent subdomain and add custom domains.",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : !primaryDomain ? (
            /* No App Deployed */
            <div className="p-6 rounded-sm bg-orange-500/5 border border-orange-500/20 text-center">
              <div className="w-12 h-12 rounded-full bg-orange-500/10 flex items-center justify-center mx-auto mb-3">
                <AlertTriangle className="h-6 w-6 text-orange-400" />
              </div>
              <h4 className="text-sm font-medium text-white mb-1">
                {t("cloud.appDomains.noAppDeployed", {
                  defaultValue: "No App Deployed",
                })}
              </h4>
              <p className="text-xs text-neutral-500 max-w-sm mx-auto">
                {t("cloud.appDomains.noAppDeployedHint", {
                  defaultValue:
                    "Deploy your app first to get a subdomain. Once deployed, you can add custom domains here.",
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Subdomain */}
              {primaryDomain && (
                <DomainCard
                  domain={primaryDomain.subdomain}
                  url={primaryDomain.subdomainUrl}
                  type="subdomain"
                  status="verified"
                  copyToClipboard={copyToClipboard}
                  copiedValue={copiedValue}
                />
              )}

              {/* Custom Domain */}
              {hasCustomDomain && primaryDomain?.customDomain && (
                <DomainCard
                  domain={primaryDomain.customDomain}
                  url={primaryDomain.customDomainUrl}
                  type="custom"
                  status={
                    primaryDomain.customDomainVerified ? "verified" : "pending"
                  }
                  sslStatus={primaryDomain.sslStatus}
                  onRefresh={() =>
                    checkDomainStatus(primaryDomain.customDomain ?? "")
                  }
                  onRemove={() =>
                    handleRemoveDomain(primaryDomain.customDomain ?? "")
                  }
                  isChecking={isChecking}
                  isRemoving={isRemoving}
                  copyToClipboard={copyToClipboard}
                  copiedValue={copiedValue}
                />
              )}

              {/* Add Domain Form */}
              <AnimatePresence mode="wait">
                {showAddForm && primaryDomain && !hasCustomDomain && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="p-6 rounded-sm border border-white/5 bg-black/20">
                      <h4 className="text-sm font-medium text-white mb-1">
                        {t("cloud.appDomains.addCustomDomain", {
                          defaultValue: "Add Custom Domain",
                        })}
                      </h4>
                      <p className="text-xs text-neutral-500 mb-4">
                        {t("cloud.appDomains.enterDomainName", {
                          defaultValue: "Enter your domain name below",
                        })}
                      </p>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <Input
                          ref={inputRef}
                          placeholder="yourdomain.com"
                          value={newDomain}
                          onChange={(e) => setNewDomain(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newDomain.trim()) {
                              e.preventDefault();
                              handleAddDomain();
                            }
                            if (e.key === "Escape") {
                              setShowAddForm(false);
                              setNewDomain("");
                            }
                          }}
                          className="flex-1 bg-black/30 border-white/10 focus:border-[#FF5800]/50 rounded-sm placeholder:text-neutral-600"
                        />
                        <div className="flex gap-2">
                          <Button
                            onClick={handleAddDomain}
                            disabled={isAdding || !newDomain.trim()}
                            className={`h-9 px-4 ${
                              isAdding || !newDomain.trim()
                                ? "bg-neutral-700 text-neutral-400"
                                : "bg-[#FF5800] hover:bg-[#e54f00] text-white"
                            }`}
                          >
                            {isAdding ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              t("cloud.appDomains.addDomain", {
                                defaultValue: "Add Domain",
                              })
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setShowAddForm(false);
                              setNewDomain("");
                            }}
                            className="h-9 px-4 border-white/20 text-white hover:bg-white/10"
                          >
                            {t("cloud.appDomains.cancel", {
                              defaultValue: "Cancel",
                            })}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Empty Custom Domain State */}
              {primaryDomain && !hasCustomDomain && !showAddForm && (
                <div className="p-6 rounded-sm border border-white/5 bg-black/20 text-center">
                  <h4 className="text-sm font-medium text-white">
                    {t("cloud.appDomains.useYourOwnDomain", {
                      defaultValue: "Use Your Own Domain",
                    })}
                  </h4>
                  <p className="text-xs text-neutral-500 max-w-xs mx-auto mt-2">
                    {t("cloud.appDomains.useYourOwnDomainHint", {
                      defaultValue:
                        "Connect a custom domain to make your app accessible at your own branded URL",
                    })}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* DNS Configuration Panel */}
        <AnimatePresence>
          {needsVerification && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
            >
              <DnsConfigPanel
                domain={primaryDomain?.customDomain || ""}
                domainStatus={domainStatus}
                onRefresh={() =>
                  checkDomainStatus(primaryDomain?.customDomain || "")
                }
                isChecking={isChecking}
                lastChecked={lastChecked}
                copyToClipboard={copyToClipboard}
                copiedValue={copiedValue}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Quick Reference */}
        <div className="bg-neutral-900 rounded-sm p-4">
          <h3 className="text-sm font-medium text-white mb-4">
            {t("cloud.appDomains.quickDnsReference", {
              defaultValue: "Quick DNS Reference",
            })}
          </h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-4 rounded-sm bg-black/40">
              <div>
                <p className="text-sm font-medium text-white">
                  {t("cloud.appDomains.subdomains", {
                    defaultValue: "Subdomains",
                  })}
                </p>
                <p className="text-xs text-neutral-500 font-mono mt-1">
                  app.example.com
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white font-mono">CNAME</p>
                <p className="text-xs text-white font-mono mt-1">
                  {"<your-cloudflare-cname>"}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between p-4 rounded-sm bg-black/40">
              <div>
                <p className="text-sm font-medium text-white">
                  {t("cloud.appDomains.rootDomains", {
                    defaultValue: "Root Domains",
                  })}
                </p>
                <p className="text-xs text-neutral-500 font-mono mt-1">
                  example.com
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white font-mono">A</p>
                <p className="text-xs text-white font-mono mt-1">76.76.21.21</p>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {t("cloud.appDomains.dnsPropagationNote", {
              defaultValue:
                "DNS changes typically propagate within 5 minutes to 48 hours",
            })}
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}

function DomainCard({
  domain,
  url,
  type,
  status,
  sslStatus = "active",
  onRefresh,
  onRemove,
  isChecking,
  isRemoving,
  copyToClipboard,
  copiedValue,
}: {
  domain: string;
  url: string | null;
  type: "subdomain" | "custom";
  status: "verified" | "pending" | "error";
  sslStatus?: string;
  onRefresh?: () => void;
  onRemove?: () => void;
  isChecking?: boolean;
  isRemoving?: boolean;
  copyToClipboard: (text: string, label: string) => void;
  copiedValue: string | null;
}) {
  const t = useCloudT();
  const fullUrl = url || `https://${domain}`;
  const isVerified = status === "verified";

  return (
    <div
      className={`
        rounded-sm border p-3
        ${isVerified ? "bg-black/30 border-white/10" : "bg-orange-500/5 border-orange-500/20"}
      `}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-white truncate">
              {domain}
            </span>
            <DomainStatusBadge status={status} sslStatus={sslStatus} />
            {type === "subdomain" && (
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider">
                {t("cloud.appDomains.default", { defaultValue: "Default" })}
              </span>
            )}
          </div>
          {isVerified && (
            <div className="flex items-center gap-1 text-green-400/80 mt-2">
              <Lock className="h-3 w-3" />
              <span className="text-xs">
                {t("cloud.appDomains.sslTlsSecured", {
                  defaultValue: "SSL/TLS Secured",
                })}
              </span>
            </div>
          )}
          {!isVerified && type === "custom" && (
            <div className="flex items-center gap-1 text-orange-400/80 mt-2">
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs">
                {t("cloud.appDomains.dnsVerificationPending", {
                  defaultValue: "DNS verification pending",
                })}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  copyToClipboard(
                    fullUrl,
                    t("cloud.appDomains.urlLabel", { defaultValue: "URL" }),
                  )
                }
                className="h-8 w-8 p-0 text-neutral-400 hover:text-white hover:bg-white/10"
              >
                {copiedValue === fullUrl ? (
                  <Check className="h-4 w-4 text-green-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="bg-neutral-800 text-white border-white/10"
            >
              {t("cloud.appDomains.copyUrl", { defaultValue: "Copy URL" })}
            </TooltipContent>
          </Tooltip>

          {isVerified && url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 w-8 text-neutral-400 hover:text-white hover:bg-white/10 rounded-sm transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="bg-neutral-800 text-white border-white/10"
              >
                {t("cloud.appDomains.openInNewTab", {
                  defaultValue: "Open in new tab",
                })}
              </TooltipContent>
            </Tooltip>
          )}

          {type === "custom" && onRefresh && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRefresh}
                  disabled={isChecking}
                  className="h-8 w-8 p-0 text-neutral-400 hover:text-white hover:bg-white/10"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isChecking ? "animate-spin" : ""}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="bg-neutral-800 text-white border-white/10"
              >
                {t("cloud.appDomains.checkDnsStatus", {
                  defaultValue: "Check DNS status",
                })}
              </TooltipContent>
            </Tooltip>
          )}

          {type === "custom" && onRemove && (
            <AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isRemoving}
                      className="h-8 w-8 p-0 text-neutral-400 hover:text-red-400 hover:bg-red-500/10"
                    >
                      {isRemoving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="bg-neutral-800 text-white border-white/10"
                >
                  {t("cloud.appDomains.removeDomainTooltip", {
                    defaultValue: "Remove domain",
                  })}
                </TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("cloud.appDomains.removeDomainTitle", {
                      defaultValue: "Remove Domain",
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("cloud.appDomains.removeDomainConfirmPre", {
                      defaultValue: "Are you sure you want to remove",
                    })}{" "}
                    <code className="px-1.5 py-0.5 bg-white/10 rounded-sm font-mono text-white">
                      {domain}
                    </code>
                    {t("cloud.appDomains.removeDomainConfirmPost", {
                      defaultValue:
                        "? Users will no longer be able to access your app via this domain.",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t("cloud.appDomains.cancel", { defaultValue: "Cancel" })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onRemove}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {t("cloud.appDomains.removeDomainTitle", {
                      defaultValue: "Remove Domain",
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </div>
  );
}

function DomainStatusBadge({
  status,
  sslStatus,
}: {
  status: string;
  sslStatus: string;
}) {
  const t = useCloudT();
  if (status === "verified" && sslStatus === "active") {
    return (
      <Badge className="bg-green-500/10 text-green-400 border-green-500/30 gap-1 text-[10px]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-50" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
        </span>
        {t("cloud.appDomains.statusActive", { defaultValue: "Active" })}
      </Badge>
    );
  }

  if (sslStatus === "provisioning") {
    return (
      <Badge className="bg-white/10 text-white/80 border-white/20 gap-1 text-[10px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("cloud.appDomains.statusSslProvisioning", {
          defaultValue: "SSL Provisioning",
        })}
      </Badge>
    );
  }

  return (
    <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/30 gap-1 text-[10px]">
      <Clock className="h-3 w-3" />
      {t("cloud.appDomains.statusPending", { defaultValue: "Pending" })}
    </Badge>
  );
}

function DnsConfigPanel({
  domain,
  domainStatus,
  onRefresh,
  isChecking,
  lastChecked,
  copyToClipboard,
  copiedValue,
}: {
  domain: string;
  domainStatus: DomainStatus | null;
  onRefresh: () => void;
  isChecking: boolean;
  lastChecked: Date | null;
  copyToClipboard: (text: string, label: string) => void;
  copiedValue: string | null;
}) {
  const t = useCloudT();
  const isApex = domain.split(".").length === 2;
  const currentStatus = domainStatus?.status || "pending";

  const dnsRecords: DnsInstruction[] = domainStatus?.dnsInstructions || [
    isApex
      ? { type: "A", name: "@", value: "76.76.21.21" }
      : {
          type: "CNAME",
          name: domain.split(".")[0],
          value: "<your-cloudflare-cname>",
        },
  ];

  const txtRecords =
    domainStatus?.records?.filter((r) => r.type === "TXT") || [];

  return (
    <div className="bg-neutral-900 rounded-sm p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-orange-400" />
          <div>
            <h3 className="text-sm font-medium text-white">
              {t("cloud.appDomains.configureDns", {
                defaultValue: "Configure DNS",
              })}
            </h3>
            <p className="text-xs text-neutral-500">
              {t("cloud.appDomains.addRecordsHint", {
                defaultValue: "Add these records at your DNS provider",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastChecked && (
            <span className="text-xs text-neutral-500 hidden sm:block">
              {t("cloud.appDomains.lastChecked", {
                time: lastChecked.toLocaleTimeString(),
                defaultValue: "Last checked: {{time}}",
              })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isChecking}
            className="border-white/10 hover:bg-white/10 rounded-sm"
          >
            {isChecking ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            {t("cloud.appDomains.verify", { defaultValue: "Verify" })}
          </Button>
        </div>
      </div>

      {/* Status Banner */}
      <div
        className={`p-3 rounded-sm border flex items-start gap-2 ${
          currentStatus === "valid"
            ? "bg-green-500/10 border-green-500/20"
            : currentStatus === "invalid"
              ? "bg-red-500/10 border-red-500/20"
              : "bg-orange-500/10 border-orange-500/20"
        }`}
      >
        {currentStatus === "valid" ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-green-300 font-medium">
                {t("cloud.appDomains.dnsVerified", {
                  defaultValue: "DNS Verified",
                })}
              </p>
              <p className="text-xs text-green-300/70">
                {t("cloud.appDomains.sslProvisioning", {
                  defaultValue: "SSL certificate is being provisioned",
                })}
              </p>
            </div>
          </>
        ) : currentStatus === "invalid" ? (
          <>
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-red-300 font-medium">
                {t("cloud.appDomains.dnsConfigIssue", {
                  defaultValue: "DNS Configuration Issue",
                })}
              </p>
              <p className="text-xs text-red-300/70">
                {t("cloud.appDomains.dnsConfigIssueHint", {
                  defaultValue: "Please check your records match exactly",
                })}
              </p>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 text-orange-400 animate-spin shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-orange-300 font-medium">
                {t("cloud.appDomains.waitingForPropagation", {
                  defaultValue: "Waiting for DNS Propagation",
                })}
              </p>
              <p className="text-xs text-orange-300/70">
                {t("cloud.appDomains.waitingFewMinutes", {
                  defaultValue: "This may take a few minutes",
                })}
              </p>
            </div>
          </>
        )}
      </div>

      {/* DNS Records */}
      <div className="space-y-3">
        {txtRecords.length > 0 && (
          <div>
            <h4 className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-2">
              {t("cloud.appDomains.verificationRecord", {
                defaultValue: "Verification Record",
              })}
            </h4>
            <div className="space-y-2">
              {txtRecords.map((record) => (
                <DnsRecordRow
                  key={record.name}
                  type="TXT"
                  name={record.name}
                  value={record.value}
                  copyToClipboard={copyToClipboard}
                  copiedValue={copiedValue}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <h4 className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-2">
            {isApex
              ? t("cloud.appDomains.aRecord", { defaultValue: "A Record" })
              : t("cloud.appDomains.cnameRecord", {
                  defaultValue: "CNAME Record",
                })}
          </h4>
          <div className="space-y-2">
            {dnsRecords.map((record) => (
              <DnsRecordRow
                key={record.name}
                type={record.type}
                name={record.name}
                value={record.value}
                copyToClipboard={copyToClipboard}
                copiedValue={copiedValue}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DnsRecordRow({
  type,
  name,
  value,
  copyToClipboard,
  copiedValue,
}: {
  type: string;
  name: string;
  value: string;
  copyToClipboard: (text: string, label: string) => void;
  copiedValue: string | null;
}) {
  const t = useCloudT();
  const valueLabel = t("cloud.appDomains.recordValueLabel", {
    type,
    defaultValue: "{{type}} value",
  });
  return (
    <div className="group bg-black/30 rounded-sm border border-white/5 p-3">
      {/* Desktop */}
      <div className="hidden sm:flex items-center gap-3">
        <Badge
          variant="outline"
          className="font-mono text-[10px] border-white/20 text-neutral-400 bg-white/5"
        >
          {type}
        </Badge>
        <span className="font-mono text-xs text-white flex-1 truncate">
          {name}
        </span>
        <span className="font-mono text-xs text-neutral-500 flex-1 truncate">
          {value}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(value, valueLabel)}
          className="h-7 w-7 p-0 text-neutral-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copiedValue === value ? (
            <Check className="h-3.5 w-3.5 text-green-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Mobile */}
      <div className="sm:hidden space-y-2">
        <div className="flex items-center justify-between">
          <Badge
            variant="outline"
            className="font-mono text-[10px] border-white/20 text-neutral-400 bg-white/5"
          >
            {type}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard(value, valueLabel)}
            className="h-7 px-2 text-neutral-500 hover:text-white"
          >
            {copiedValue === value ? (
              <Check className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5 text-[10px]">
              {t("cloud.appDomains.copy", { defaultValue: "Copy" })}
            </span>
          </Button>
        </div>
        <div className="space-y-1.5">
          <div>
            <p className="text-[10px] text-neutral-500 mb-0.5">
              {t("cloud.appDomains.nameHost", {
                defaultValue: "Name / Host",
              })}
            </p>
            <p className="font-mono text-xs text-white break-all">{name}</p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 mb-0.5">
              {t("cloud.appDomains.valueTarget", {
                defaultValue: "Value / Target",
              })}
            </p>
            <p className="font-mono text-xs text-neutral-400 break-all">
              {value}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
