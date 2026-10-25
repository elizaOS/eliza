/**
 * Application detail — Domains tab (managed custom domain + DNS TXT verify).
 * The domain list/add/remove/status calls are routed through the typed `api`
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
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../../bridge/toast";
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
import { Card } from "../../../components/ui/card";
import { CopyButton } from "../../../components/ui/copy-button";
import { Input } from "../../../components/ui/input";
import { StatusBadge } from "../../../components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { openExternalUrlOnNative } from "../lib/native-cloud-nav";
import { BuyDomainCard } from "./BuyDomainCard";

type SslStatus = "pending" | "provisioning" | "active" | "error";

/** A managed-domain row as `GET /api/v1/apps/:id/domains` returns it. */
export interface ManagedDomainRow {
  id: string;
  domain: string;
  registrar: "external" | "cloudflare";
  status: string;
  verified: boolean;
  sslStatus: SslStatus;
  expiresAt: string | null;
  cloudflareZoneId: string | null;
  verificationToken: string | null;
}

interface DomainsListResponse {
  success?: boolean;
  error?: string;
  domains?: ManagedDomainRow[];
}

interface VerifyResponse {
  success?: boolean;
  error?: string;
  verified?: boolean;
}

interface DomainMutationResponse {
  success?: boolean;
  error?: string;
  verified?: boolean;
}

type VerificationRecord = { type: "TXT"; name: string; value: string };

/** The TXT record `POST /domains/verify` checks for an unverified external domain. */
function verificationRecordFor(
  row: ManagedDomainRow,
): VerificationRecord | null {
  return row.registrar === "external" && !row.verified && row.verificationToken
    ? {
        type: "TXT",
        name: `_eliza-cloud-verify.${row.domain}`,
        value: row.verificationToken,
      }
    : null;
}

interface AppDomainsProps {
  appId: string;
}

export function AppDomains({ appId }: AppDomainsProps) {
  return <AppDomainsContent key={appId} appId={appId} />;
}

function AppDomainsContent({ appId }: AppDomainsProps) {
  const t = useCloudT();
  const [domains, setDomains] = useState<ManagedDomainRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verificationDomain, setVerificationDomain] = useState<string | null>(
    null,
  );
  const [newDomain, setNewDomain] = useState("");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchDomains = useCallback(async () => {
    try {
      const data = await api<DomainsListResponse>(
        `/api/v1/apps/${appId}/domains`,
      );
      if (data.success && data.domains) {
        setDomains(data.domains);
        setListError(null);
      } else {
        setListError(data.error || "The server did not return a domain list.");
      }
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [appId]);

  // Verification state changes only through `/domains/verify`, so it runs on
  // the user's Verify click; there is no background poll.
  const verifyDomain = useCallback(
    async (domain: string) => {
      setIsChecking(true);
      setVerificationDomain(domain);
      setVerifyError(null);
      try {
        const data = await api<VerifyResponse>(
          `/api/v1/apps/${appId}/domains/verify`,
          { method: "POST", json: { domain } },
        );
        setLastChecked(new Date());
        if (data.success && data.verified) {
          setVerifyError(null);
          toast.success(
            t("cloud.appDomains.domainVerified", {
              defaultValue: "Domain verified!",
            }),
            {
              icon: <CheckCircle2 className="size-4 text-status-success" />,
            },
          );
          await fetchDomains();
        } else {
          setVerifyError(data.error ?? null);
          toast.error(
            t("cloud.appDomains.notVerifiedYet", {
              defaultValue: "Domain not verified yet",
            }),
            { description: data.error },
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setVerifyError(message);
        toast.error(
          t("cloud.appDomains.notVerifiedYet", {
            defaultValue: "Domain not verified yet",
          }),
          { description: message },
        );
      } finally {
        setIsChecking(false);
      }
    },
    [appId, fetchDomains, t],
  );

  useEffect(() => {
    void fetchDomains();
  }, [fetchDomains]);

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
              ? undefined
              : t("cloud.appDomains.configureDnsToComplete", {
                  defaultValue: "Configure your DNS records to complete setup",
                }),
          },
        );
        setVerifyError(null);
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
        setVerifyError(null);
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

  const canAddDomain = !isLoading && listError === null;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Main Domains Card */}
        <Card variant="flatPadded">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-medium text-txt-strong flex items-center gap-2">
                <Globe className="size-4 text-accent" />
                {t("cloud.appDomains.title", { defaultValue: "Domains" })}
              </h3>
              <p className="text-xs text-muted mt-1">
                {t("cloud.appDomains.subtitle", {
                  defaultValue: "Connect custom domains to your app",
                })}
              </p>
            </div>
            {canAddDomain && !showAddForm && (
              <Button onClick={() => setShowAddForm(true)} size="sm">
                <Plus className="size-4 mr-1.5" />
                {t("cloud.appDomains.addDomain", {
                  defaultValue: "Add Domain",
                })}
              </Button>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              <div className="h-16 bg-bg-muted rounded-sm animate-pulse motion-reduce:animate-none" />
              <div className="h-16 bg-bg-muted rounded-sm animate-pulse opacity-50 motion-reduce:animate-none" />
            </div>
          ) : listError !== null ? (
            <div
              role="alert"
              className="p-4 rounded-sm bg-destructive-subtle border border-destructive/20 flex items-start gap-2"
            >
              <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-destructive font-medium">
                  {t("cloud.appDomains.failedToLoad", {
                    defaultValue: "Could not load domains",
                  })}
                </p>
                {listError && (
                  <p className="text-xs text-destructive/80 mt-0.5">
                    {listError}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {domains.map((appDomain) => (
                <DomainCard
                  key={appDomain.id}
                  domain={appDomain.domain}
                  url={`https://${appDomain.domain}`}
                  type="custom"
                  status={appDomain.verified ? "verified" : "pending"}
                  sslStatus={appDomain.sslStatus}
                  onRefresh={() => verifyDomain(appDomain.domain)}
                  onRemove={() => handleRemoveDomain(appDomain.domain)}
                  isChecking={isChecking}
                  isRemoving={isRemoving}
                />
              ))}

              {/* Add Domain Form */}
              <AnimatePresence mode="wait">
                {showAddForm && canAddDomain && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="p-6 rounded-sm border border-border bg-bg-muted">
                      <h4 className="text-sm font-medium text-txt-strong mb-1">
                        {t("cloud.appDomains.addCustomDomain", {
                          defaultValue: "Add Custom Domain",
                        })}
                      </h4>
                      <p className="text-xs text-muted mb-4">
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
                          variant="form"
                          className="flex-1"
                        />
                        <div className="flex gap-2">
                          <Button
                            onClick={handleAddDomain}
                            disabled={isAdding || !newDomain.trim()}
                          >
                            {isAdding ? (
                              <Loader2 className="size-4 animate-spin" />
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

              {/* Empty State */}
              {domains.length === 0 && !showAddForm && (
                <div className="p-6 rounded-sm border border-border bg-bg-muted text-center">
                  <h4 className="text-sm font-medium text-txt-strong">
                    {t("cloud.appDomains.useYourOwnDomain", {
                      defaultValue: "Use Your Own Domain",
                    })}
                  </h4>
                  <p className="text-xs text-muted max-w-xs mx-auto mt-2">
                    {t("cloud.appDomains.useYourOwnDomainHint", {
                      defaultValue:
                        "Connect a custom domain to make your app accessible at your own branded URL",
                    })}
                  </p>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Buy a domain through Cloudflare (#10246) */}
        {canAddDomain && (
          <BuyDomainCard appId={appId} onPurchased={fetchDomains} />
        )}

        {/* DNS verification for an unverified external domain */}
        <AnimatePresence>
          {domains.map((appDomain) => {
            const verificationRecord = verificationRecordFor(appDomain);
            if (!verificationRecord) return null;
            return (
              <motion.div
                key={appDomain.id}
                initial={{ opacity: 0, transform: "translateY(10px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={{ opacity: 0, transform: "translateY(-10px)" }}
              >
                <DnsConfigPanel
                  record={verificationRecord}
                  verifyError={
                    verificationDomain === appDomain.domain ? verifyError : null
                  }
                  onVerify={() => verifyDomain(appDomain.domain)}
                  isChecking={isChecking}
                  lastChecked={
                    verificationDomain === appDomain.domain ? lastChecked : null
                  }
                  copyToClipboard={copyToClipboard}
                  copiedValue={copiedValue}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
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
}) {
  const t = useCloudT();
  const fullUrl = url || `https://${domain}`;
  const isVerified = status === "verified";

  return (
    <div
      className={`
        rounded-sm border p-3
        ${isVerified ? "bg-card border-border" : "bg-accent-subtle border-accent/20"}
      `}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-txt-strong truncate">
              {domain}
            </span>
            <DomainStatusBadge status={status} sslStatus={sslStatus} />
            {type === "subdomain" && (
              <span className="text-2xs text-muted uppercase tracking-wider">
                {t("cloud.appDomains.default", { defaultValue: "Default" })}
              </span>
            )}
          </div>
          {isVerified && sslStatus === "active" && (
            <div className="flex items-center gap-1 text-status-success mt-2">
              <Lock className="size-3" />
              <span className="text-xs">
                {t("cloud.appDomains.sslTlsSecured", {
                  defaultValue: "SSL/TLS Secured",
                })}
              </span>
            </div>
          )}
          {!isVerified && type === "custom" && (
            <div className="flex items-center gap-1 text-accent mt-2">
              <AlertTriangle className="size-3" />
              <span className="text-xs">
                {t("cloud.appDomains.dnsVerificationPending", {
                  defaultValue: "DNS verification pending",
                })}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <CopyButton
            value={fullUrl}
            copyLabel={t("cloud.appDomains.copyUrl", {
              defaultValue: "Copy URL",
            })}
            copiedLabel={t("cloud.appDomains.copied", {
              defaultValue: "Copied",
            })}
            className="size-8 min-h-touch justify-center p-0 hover:text-txt-strong"
          />

          {isVerified && url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    // Native studio: open the verified domain in the system
                    // browser (WebView target="_blank" is unreliable). No-op on
                    // web — the anchor opens a new tab normally.
                    if (openExternalUrlOnNative(url)) {
                      e.preventDefault();
                    }
                  }}
                  className="inline-flex items-center justify-center size-8 min-h-touch text-muted hover:text-txt-strong hover:bg-bg-hover rounded-sm transition-colors"
                >
                  <ExternalLink className="size-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="bg-card text-txt-strong border-border"
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
                  size="icon-sm"
                  onClick={onRefresh}
                  disabled={isChecking}
                >
                  <RefreshCw
                    className={`size-4 ${isChecking ? "animate-spin" : ""}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="bg-card text-txt-strong border-border"
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
                      variant="surfaceDestructive"
                      size="icon-sm"
                      aria-label={t("cloud.appDomains.removeDomainTooltip", {
                        defaultValue: "Remove domain",
                      })}
                      disabled={isRemoving}
                    >
                      {isRemoving ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="bg-card text-txt-strong border-border"
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
                    <code className="px-1.5 py-0.5 bg-bg-muted rounded-sm font-mono text-txt-strong">
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
                    className="bg-destructive-solid hover:bg-destructive-solid-hover text-destructive-fg"
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
      <StatusBadge
        status="success"
        pulse
        label={t("cloud.appDomains.statusActive", { defaultValue: "Active" })}
      />
    );
  }

  if (sslStatus === "provisioning") {
    return (
      <StatusBadge
        status="processing"
        label={t("cloud.appDomains.statusSslProvisioning", {
          defaultValue: "SSL Provisioning",
        })}
      />
    );
  }

  return (
    <StatusBadge
      status="warning"
      icon={<Clock />}
      label={t("cloud.appDomains.statusPending", { defaultValue: "Pending" })}
    />
  );
}

function DnsConfigPanel({
  record,
  verifyError,
  onVerify,
  isChecking,
  lastChecked,
  copyToClipboard,
  copiedValue,
}: {
  record: VerificationRecord;
  verifyError: string | null;
  onVerify: () => void;
  isChecking: boolean;
  lastChecked: Date | null;
  copyToClipboard: (text: string, label: string) => void;
  copiedValue: string | null;
}) {
  const t = useCloudT();

  return (
    <Card stack="default" variant="flatPadded">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-accent" />
          <div>
            <h3 className="text-sm font-medium text-txt-strong">
              {t("cloud.appDomains.configureDns", {
                defaultValue: "Configure DNS",
              })}
            </h3>
            <p className="text-xs text-muted">
              {t("cloud.appDomains.addRecordsHint", {
                defaultValue: "Add these records at your DNS provider",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastChecked && (
            <span className="text-xs text-muted hidden sm:block">
              {t("cloud.appDomains.lastChecked", {
                time: lastChecked.toLocaleTimeString("en-US"),
                defaultValue: "Last checked: {{time}}",
              })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onVerify}
            disabled={isChecking}
          >
            {isChecking ? (
              <Loader2 className="size-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="size-4 mr-1.5" />
            )}
            {t("cloud.appDomains.verify", { defaultValue: "Verify" })}
          </Button>
        </div>
      </div>

      {/* Status Banner */}
      {verifyError ? (
        <div className="p-3 rounded-sm border flex items-start gap-2 bg-destructive-subtle border-destructive/20">
          <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-destructive font-medium">
              {t("cloud.appDomains.dnsConfigIssue", {
                defaultValue: "DNS Configuration Issue",
              })}
            </p>
            <p className="text-xs text-destructive/80">{verifyError}</p>
          </div>
        </div>
      ) : (
        <div className="p-3 rounded-sm border flex items-start gap-2 bg-accent-subtle border-accent/20">
          <Clock className="size-4 text-accent shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-accent font-medium">
              {t("cloud.appDomains.dnsVerificationPending", {
                defaultValue: "DNS verification pending",
              })}
            </p>
            <p className="text-xs text-accent/80">
              {t("cloud.appDomains.dnsPropagationNote", {
                defaultValue:
                  "DNS changes typically propagate within 5 minutes to 48 hours",
              })}
            </p>
          </div>
        </div>
      )}

      {/* The record `POST /domains/verify` checks */}
      <div>
        <h4 className="text-2xs font-medium text-muted uppercase tracking-wider mb-2">
          {t("cloud.appDomains.verificationRecord", {
            defaultValue: "Verification Record",
          })}
        </h4>
        <DnsRecordRow
          type={record.type}
          name={record.name}
          value={record.value}
          copyToClipboard={copyToClipboard}
          copiedValue={copiedValue}
        />
      </div>
    </Card>
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
    <div className="group bg-bg-muted rounded-sm border border-border p-3">
      {/* Desktop */}
      <div className="hidden sm:flex items-center gap-3">
        <Badge variant="outline">{type}</Badge>
        <span className="font-mono text-xs text-txt-strong flex-1 truncate">
          {name}
        </span>
        <span className="font-mono text-xs text-muted flex-1 truncate">
          {value}
        </span>
        <CopyButton
          value={value}
          copyLabel={t("cloud.appDomains.copyRecordValue", {
            type,
            defaultValue: "Copy {{type}} value",
          })}
          copiedLabel={t("cloud.appDomains.copied", {
            defaultValue: "Copied",
          })}
          className="size-7 justify-center p-0 hover:text-txt-strong opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>

      {/* Mobile */}
      <div className="sm:hidden space-y-2">
        <div className="flex items-center justify-between">
          <Badge variant="outline">{type}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard(value, valueLabel)}
          >
            {copiedValue === value ? (
              <Check className="size-3.5 text-status-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
            <span className="ml-1.5 text-2xs">
              {t("cloud.appDomains.copy", { defaultValue: "Copy" })}
            </span>
          </Button>
        </div>
        <div className="space-y-1.5">
          <div>
            <p className="text-2xs text-muted mb-0.5">
              {t("cloud.appDomains.nameHost", {
                defaultValue: "Name / Host",
              })}
            </p>
            <p className="font-mono text-xs text-txt-strong break-all">
              {name}
            </p>
          </div>
          <div>
            <p className="text-2xs text-muted mb-0.5">
              {t("cloud.appDomains.valueTarget", {
                defaultValue: "Value / Target",
              })}
            </p>
            <p className="font-mono text-xs text-muted break-all">{value}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
