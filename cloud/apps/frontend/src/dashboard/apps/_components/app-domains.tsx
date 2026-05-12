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
  Button,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
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

interface AppDomainsProps {
  appId: string;
}

export function AppDomains({ appId }: AppDomainsProps) {
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
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchDomains = useCallback(async () => {
    const response = await fetch(`/api/v1/apps/${appId}/domains`);
    const data = await response.json();
    if (data.success) {
      setDomains(data.domains);
      setSandboxUrl(data.sandboxUrl || null);
    }
    setIsLoading(false);
  }, [appId]);

  const checkDomainStatus = useCallback(
    async (domain: string, silent = false) => {
      if (!silent) setIsChecking(true);
      const response = await fetch(`/api/v1/apps/${appId}/domains/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });

      const data = await response.json();

      if (data.success) {
        setDomainStatus(data);
        setLastChecked(new Date());
        if (data.verified) {
          if (!silent) {
            toast.success("Domain verified!", {
              description: "SSL certificate is now being provisioned",
              icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
            });
          }
          await fetchDomains();
        }
      }
      if (!silent) setIsChecking(false);
    },
    [appId, fetchDomains],
  );

  useEffect(() => {
    void fetchDomains();
  }, [fetchDomains]);

  useEffect(() => {
    const primaryDomain = domains.find((d) => d.isPrimary);
    if (primaryDomain?.customDomain && !primaryDomain.customDomainVerified) {
      pollIntervalRef.current = setInterval(() => {
        checkDomainStatus(primaryDomain.customDomain!, true);
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
    toast.success(`${label} copied to clipboard`);
    setTimeout(() => setCopiedValue(null), 2000);
  };

  const handleAddDomain = async () => {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;

    const domainRegex = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
    if (!domainRegex.test(domain)) {
      toast.error("Invalid domain", {
        description: "Please enter a valid domain like example.com or app.example.com",
      });
      return;
    }

    setIsAdding(true);
    const response = await fetch(`/api/v1/apps/${appId}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();

    if (data.success) {
      toast.success(data.verified ? "Domain verified!" : "Domain added successfully", {
        description: data.verified
          ? "SSL certificate is being provisioned automatically"
          : "Configure your DNS records to complete setup",
      });
      setDomainStatus({
        domain: data.domain,
        status: data.verified ? "valid" : "pending",
        configured: data.verified,
        verified: data.verified,
        sslStatus: data.verified ? "active" : "pending",
        configuredBy: null,
        records: data.verificationRecords,
        isApexDomain: data.isApexDomain,
        dnsInstructions: data.dnsInstructions,
      });
      setNewDomain("");
      setShowAddForm(false);
      await fetchDomains();
    } else {
      toast.error("Failed to add domain", { description: data.error });
    }
    setIsAdding(false);
  };

  const handleRemoveDomain = async (domain: string) => {
    setIsRemoving(true);
    const response = await fetch(`/api/v1/apps/${appId}/domains`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();

    if (data.success) {
      toast.success("Domain removed successfully");
      setDomainStatus(null);
      await fetchDomains();
    } else {
      toast.error("Failed to remove domain", { description: data.error });
    }
    setIsRemoving(false);
  };

  const primaryDomain = domains.find((d) => d.isPrimary);
  const hasCustomDomain = !!primaryDomain?.customDomain;
  const needsVerification = hasCustomDomain && !primaryDomain?.customDomainVerified;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Main Domains Card */}
        <div className="bg-neutral-900 rounded-xl p-4">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-medium text-white flex items-center gap-2">
                <Globe className="h-4 w-4 text-[#FF5800]" />
                Domains
              </h3>
              <p className="text-xs text-neutral-500 mt-1">Connect custom domains to your app</p>
            </div>
            {primaryDomain && !hasCustomDomain && !showAddForm && !isLoading && (
              <Button
                onClick={() => setShowAddForm(true)}
                size="sm"
                className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white rounded-lg"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Add Domain
              </Button>
            )}
          </div>

          {/* Loading State */}
          {isLoading ? (
            <div className="space-y-3">
              <div className="h-16 bg-black/30 rounded-lg animate-pulse" />
              <div className="h-16 bg-black/30 rounded-lg animate-pulse opacity-50" />
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
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-blue-300 font-medium">Development URL</p>
                    <p className="text-xs text-blue-300/70 mt-0.5">
                      Deploy your app to get a permanent subdomain and add custom domains.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : !primaryDomain ? (
            /* No App Deployed */
            <div className="p-6 rounded-lg bg-amber-500/5 border border-amber-500/20 text-center">
              <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-3">
                <AlertTriangle className="h-6 w-6 text-amber-400" />
              </div>
              <h4 className="text-sm font-medium text-white mb-1">No App Deployed</h4>
              <p className="text-xs text-neutral-500 max-w-sm mx-auto">
                Deploy your app first to get a subdomain. Once deployed, you can add custom domains
                here.
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
                  status={primaryDomain.customDomainVerified ? "verified" : "pending"}
                  sslStatus={primaryDomain.sslStatus}
                  onRefresh={() => checkDomainStatus(primaryDomain.customDomain!)}
                  onRemove={() => handleRemoveDomain(primaryDomain.customDomain!)}
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
                    <div className="p-6 rounded-lg border border-white/5 bg-black/20">
                      <h4 className="text-sm font-medium text-white mb-1">Add Custom Domain</h4>
                      <p className="text-xs text-neutral-500 mb-4">Enter your domain name below</p>
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
                          className="flex-1 bg-black/30 border-white/10 focus:border-[#FF5800]/50 rounded-lg placeholder:text-neutral-600"
                        />
                        <div className="flex gap-2">
                          <Button
                            onClick={handleAddDomain}
                            disabled={isAdding || !newDomain.trim()}
                            className={`h-9 px-4 ${
                              isAdding || !newDomain.trim()
                                ? "bg-neutral-700 text-neutral-400"
                                : "bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
                            }`}
                          >
                            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Domain"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setShowAddForm(false);
                              setNewDomain("");
                            }}
                            className="h-9 px-4 border-white/20 text-white hover:bg-white/10"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Empty Custom Domain State */}
              {primaryDomain && !hasCustomDomain && !showAddForm && (
                <div className="p-6 rounded-lg border border-white/5 bg-black/20 text-center">
                  <h4 className="text-sm font-medium text-white">Use Your Own Domain</h4>
                  <p className="text-xs text-neutral-500 max-w-xs mx-auto mt-2">
                    Connect a custom domain to make your app accessible at your own branded URL
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
                onRefresh={() => checkDomainStatus(primaryDomain?.customDomain || "")}
                isChecking={isChecking}
                lastChecked={lastChecked}
                copyToClipboard={copyToClipboard}
                copiedValue={copiedValue}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Quick Reference */}
        <div className="bg-neutral-900 rounded-xl p-4">
          <h3 className="text-sm font-medium text-white mb-4">Quick DNS Reference</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-4 rounded-lg bg-black/40">
              <div>
                <p className="text-sm font-medium text-white">Subdomains</p>
                <p className="text-xs text-neutral-500 font-mono mt-1">app.example.com</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white font-mono">CNAME</p>
                <p className="text-xs text-white font-mono mt-1">{"<your-cloudflare-cname>"}</p>
              </div>
            </div>
            <div className="flex items-center justify-between p-4 rounded-lg bg-black/40">
              <div>
                <p className="text-sm font-medium text-white">Root Domains</p>
                <p className="text-xs text-neutral-500 font-mono mt-1">example.com</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white font-mono">A</p>
                <p className="text-xs text-white font-mono mt-1">76.76.21.21</p>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            DNS changes typically propagate within 5 minutes to 48 hours
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
  const fullUrl = url || `https://${domain}`;
  const isVerified = status === "verified";

  return (
    <div
      className={`
        rounded-lg border p-3
        ${isVerified ? "bg-black/30 border-white/10" : "bg-amber-500/5 border-amber-500/20"}
      `}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-white truncate">{domain}</span>
            <DomainStatusBadge status={status} sslStatus={sslStatus} />
            {type === "subdomain" && (
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider">Default</span>
            )}
          </div>
          {isVerified && (
            <div className="flex items-center gap-1 text-emerald-400/80 mt-2">
              <Lock className="h-3 w-3" />
              <span className="text-xs">SSL/TLS Secured</span>
            </div>
          )}
          {!isVerified && type === "custom" && (
            <div className="flex items-center gap-1 text-amber-400/80 mt-2">
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs">DNS verification pending</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(fullUrl, "URL")}
                className="h-8 w-8 p-0 text-neutral-400 hover:text-white hover:bg-white/10"
              >
                {copiedValue === fullUrl ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-neutral-800 text-white border-white/10">
              Copy URL
            </TooltipContent>
          </Tooltip>

          {isVerified && url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 w-8 text-neutral-400 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-neutral-800 text-white border-white/10">
                Open in new tab
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
                  <RefreshCw className={`h-4 w-4 ${isChecking ? "animate-spin" : ""}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="bg-neutral-800 text-white border-white/10">
                Check DNS status
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
                <TooltipContent side="bottom" className="bg-neutral-800 text-white border-white/10">
                  Remove domain
                </TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove Domain</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to remove{" "}
                    <code className="px-1.5 py-0.5 bg-white/10 rounded font-mono text-white">
                      {domain}
                    </code>
                    ? Users will no longer be able to access your app via this domain.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onRemove} className="bg-red-600 hover:bg-red-700">
                    Remove Domain
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

function DomainStatusBadge({ status, sslStatus }: { status: string; sslStatus: string }) {
  if (status === "verified" && sslStatus === "active") {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1 text-[10px]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
        </span>
        Active
      </Badge>
    );
  }

  if (sslStatus === "provisioning") {
    return (
      <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 gap-1 text-[10px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        SSL Provisioning
      </Badge>
    );
  }

  return (
    <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1 text-[10px]">
      <Clock className="h-3 w-3" />
      Pending
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
  const isApex = domain.split(".").length === 2;
  const currentStatus = domainStatus?.status || "pending";

  // TODO(cloudflare): replace placeholder DNS targets once Cloudflare anycast IP and
  // CNAME target are finalized for the cloud deployment.
  const dnsRecords: DnsInstruction[] = domainStatus?.dnsInstructions || [
    isApex
      ? { type: "A", name: "@", value: "76.76.21.21" }
      : {
          type: "CNAME",
          name: domain.split(".")[0],
          value: "<your-cloudflare-cname>",
        },
  ];

  const txtRecords = domainStatus?.records?.filter((r) => r.type === "TXT") || [];

  return (
    <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-400" />
          <div>
            <h3 className="text-sm font-medium text-white">Configure DNS</h3>
            <p className="text-xs text-neutral-500">Add these records at your DNS provider</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastChecked && (
            <span className="text-xs text-neutral-500 hidden sm:block">
              Last checked: {lastChecked.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isChecking}
            className="border-white/10 hover:bg-white/10 rounded-lg"
          >
            {isChecking ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            Verify
          </Button>
        </div>
      </div>

      {/* Status Banner */}
      <div
        className={`p-3 rounded-lg border flex items-start gap-2 ${
          currentStatus === "valid"
            ? "bg-emerald-500/10 border-emerald-500/20"
            : currentStatus === "invalid"
              ? "bg-red-500/10 border-red-500/20"
              : "bg-amber-500/10 border-amber-500/20"
        }`}
      >
        {currentStatus === "valid" ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-emerald-300 font-medium">DNS Verified</p>
              <p className="text-xs text-emerald-300/70">SSL certificate is being provisioned</p>
            </div>
          </>
        ) : currentStatus === "invalid" ? (
          <>
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-red-300 font-medium">DNS Configuration Issue</p>
              <p className="text-xs text-red-300/70">Please check your records match exactly</p>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 text-amber-400 animate-spin shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-amber-300 font-medium">Waiting for DNS Propagation</p>
              <p className="text-xs text-amber-300/70">This may take a few minutes</p>
            </div>
          </>
        )}
      </div>

      {/* DNS Records */}
      <div className="space-y-3">
        {txtRecords.length > 0 && (
          <div>
            <h4 className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-2">
              Verification Record
            </h4>
            <div className="space-y-2">
              {txtRecords.map((record, i) => (
                <DnsRecordRow
                  key={i}
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
            {isApex ? "A Record" : "CNAME Record"}
          </h4>
          <div className="space-y-2">
            {dnsRecords.map((record, i) => (
              <DnsRecordRow
                key={i}
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
  return (
    <div className="group bg-black/30 rounded-lg border border-white/5 p-3">
      {/* Desktop */}
      <div className="hidden sm:flex items-center gap-3">
        <Badge
          variant="outline"
          className="font-mono text-[10px] border-white/20 text-neutral-400 bg-white/5"
        >
          {type}
        </Badge>
        <span className="font-mono text-xs text-white flex-1 truncate">{name}</span>
        <span className="font-mono text-xs text-neutral-500 flex-1 truncate">{value}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(value, `${type} value`)}
          className="h-7 w-7 p-0 text-neutral-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copiedValue === value ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
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
            onClick={() => copyToClipboard(value, `${type} value`)}
            className="h-7 px-2 text-neutral-500 hover:text-white"
          >
            {copiedValue === value ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5 text-[10px]">Copy</span>
          </Button>
        </div>
        <div className="space-y-1.5">
          <div>
            <p className="text-[10px] text-neutral-500 mb-0.5">Name / Host</p>
            <p className="font-mono text-xs text-white break-all">{name}</p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 mb-0.5">Value / Target</p>
            <p className="font-mono text-xs text-neutral-400 break-all">{value}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
