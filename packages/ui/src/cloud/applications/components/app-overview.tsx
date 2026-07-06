/**
 * Application detail — Overview tab.
 * Bare same-origin `fetch` is routed through the typed `api`/`regenerateAppApiKey`
 * helpers so the Steward Bearer token is attached on every target.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Coins,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  Mail,
  RefreshCw,
  Rocket,
  Shield,
  TrendingUp,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DashboardStatCard } from "../../../cloud-ui/components/brand";
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
import { CopyButton } from "../../../components/ui/copy-button";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { App } from "../lib/apps";
import {
  deployApp,
  deployRepoUrlFromApp,
  getLatestAppDeployment,
  regenerateAppApiKey,
  validateDeployAppInput,
} from "../lib/apps";
import { openExternalUrlOnNative } from "../lib/native-cloud-nav";

interface AppOverviewProps {
  app: App;
  showApiKey?: string;
}

const DEPLOY_STATUS_POLL_INTERVAL_MS = 3_000;
const DEPLOY_STATUS_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AppOverview({ app, showApiKey }: AppOverviewProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayApiKey, setDisplayApiKey] = useState(showApiKey || "");
  const [showKey, setShowKey] = useState(!!showApiKey);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isPollingDeployment, setIsPollingDeployment] = useState(false);
  const [deployRepoUrl, setDeployRepoUrl] = useState(() =>
    deployRepoUrlFromApp(app),
  );
  const [deployRef, setDeployRef] = useState("");
  const [deployDockerfile, setDeployDockerfile] = useState("");
  const [deployInputError, setDeployInputError] = useState<string | null>(null);
  const [monetizationEnabled, setMonetizationEnabled] = useState<
    boolean | null
  >(null);
  const [totalEarnings, setTotalEarnings] = useState<number | null>(null);
  const hideApiKeyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deploymentPollInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const revealApiKey = useCallback((apiKey: string) => {
    if (hideApiKeyTimerRef.current) {
      clearTimeout(hideApiKeyTimerRef.current);
    }
    setDisplayApiKey(apiKey);
    setShowKey(true);
    hideApiKeyTimerRef.current = setTimeout(() => {
      setDisplayApiKey("");
      setShowKey(false);
      hideApiKeyTimerRef.current = null;
    }, 60000);
  }, []);

  useEffect(() => {
    if (showApiKey) revealApiKey(showApiKey);
  }, [showApiKey, revealApiKey]);

  useEffect(() => {
    const repoUrl = deployRepoUrlFromApp(app);
    setDeployRepoUrl((current) => current || repoUrl);
  }, [app]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (hideApiKeyTimerRef.current) clearTimeout(hideApiKeyTimerRef.current);
    };
  }, []);

  const refreshAppRecord = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["app", app.id] }),
    [app.id, queryClient],
  );

  const pollLatestDeployment = useCallback(
    async (showTerminalToast: boolean) => {
      if (deploymentPollInFlightRef.current) return;

      deploymentPollInFlightRef.current = true;
      setIsPollingDeployment(true);
      const deadline = Date.now() + DEPLOY_STATUS_POLL_TIMEOUT_MS;

      try {
        while (Date.now() < deadline && mountedRef.current) {
          const record = await getLatestAppDeployment(app.id);
          await refreshAppRecord();

          if (record.status === "READY") {
            if (showTerminalToast && mountedRef.current) {
              toast.success(
                t("cloud.apps.overview.deployReady", {
                  defaultValue: "Deployment is live",
                }),
              );
            }
            return;
          }

          if (record.status === "ERROR") {
            toast.error(
              record.error ||
                t("cloud.apps.overview.deployFailed", {
                  defaultValue: "Deployment failed",
                }),
            );
            return;
          }

          if (record.status === "DRAFT") return;

          await wait(DEPLOY_STATUS_POLL_INTERVAL_MS);
        }

        if (showTerminalToast && mountedRef.current) {
          toast.error(
            t("cloud.apps.overview.deployPollTimeout", {
              defaultValue:
                "Deployment is still running. Refresh the app to check status.",
            }),
          );
        }
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("cloud.apps.overview.deployStatusFailed", {
                  defaultValue: "Failed to check deployment status",
                }),
          );
        }
      } finally {
        deploymentPollInFlightRef.current = false;
        if (mountedRef.current) setIsPollingDeployment(false);
      }
    },
    [app.id, refreshAppRecord, t],
  );

  useEffect(() => {
    if (
      app.deployment_status === "building" ||
      app.deployment_status === "deploying"
    ) {
      void pollLatestDeployment(false);
    }
  }, [app.deployment_status, pollLatestDeployment]);

  useEffect(() => {
    let cancelled = false;
    void api<{
      success?: boolean;
      monetization?: {
        monetizationEnabled: boolean;
        totalCreatorEarnings: number;
      };
    }>(`/api/v1/apps/${app.id}/monetization`)
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.monetization) {
          setMonetizationEnabled(data.monetization.monetizationEnabled);
          setTotalEarnings(data.monetization.totalCreatorEarnings);
        }
      })
      .catch(() => {
        // Monetization summary is non-critical; leave the card hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  async function handleRegenerateApiKey(): Promise<void> {
    setIsRegenerating(true);
    try {
      const apiKey = await regenerateAppApiKey(app.id);
      revealApiKey(apiKey);
      toast.success(
        t("cloud.apps.overview.regenSuccess", {
          defaultValue: "API key regenerated",
        }),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.apps.overview.regenFailedShort", {
              defaultValue: "Failed to regenerate",
            }),
      );
    } finally {
      setIsRegenerating(false);
    }
  }

  async function handleDeploy(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const validation = validateDeployAppInput({
      repoUrl: deployRepoUrl,
      ref: deployRef,
      dockerfile: deployDockerfile,
    });

    if (!validation.ok) {
      setDeployInputError(validation.error);
      return;
    }

    setDeployInputError(null);
    setIsDeploying(true);
    try {
      await deployApp(app.id, validation.value);
      // Refresh the app record so the Deployment status flips to "building"
      // without a manual reload (the key is a prefix of the auth-scoped key).
      await refreshAppRecord();
      toast.success(
        t("cloud.apps.overview.deployStarted", {
          defaultValue: "Deployment started",
        }),
      );
      void pollLatestDeployment(true);
    } catch (error) {
      // Includes the gated `apps_deploy_disabled` case (deploy flag off) — show
      // the server's reason rather than pretending it worked.
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.apps.overview.deployFailed", {
              defaultValue: "Failed to start deployment",
            }),
      );
    } finally {
      setIsDeploying(false);
    }
  }

  const deploymentInProgress =
    app.deployment_status === "building" ||
    app.deployment_status === "deploying";
  const deploymentButtonDisabled =
    isDeploying || isPollingDeployment || deploymentInProgress;
  const allowedOrigins: string[] = Array.isArray(app.allowed_origins)
    ? app.allowed_origins.filter(
        (origin): origin is string => typeof origin === "string",
      )
    : [];
  const maskedApiKey = `eliza_${"•".repeat(32)}`;
  const deployRepoInputId = `deploy-repo-url-${app.id}`;
  const deployRefInputId = `deploy-ref-${app.id}`;
  const deployDockerfileInputId = `deploy-dockerfile-${app.id}`;

  return (
    <div className="space-y-4">
      {/* New API Key Alert */}
      {showKey && displayApiKey && (
        <div className="p-4 rounded-sm bg-card border border-border">
          <div className="flex items-start gap-3">
            <Key className="h-5 w-5 text-muted mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-txt mb-2">
                {t("cloud.apps.overview.apiKeyOnce", {
                  defaultValue: "Your API Key (shown once)",
                })}
              </p>
              <div className="flex items-center gap-2 mb-2">
                <code className="flex-1 bg-surface px-3 py-2 rounded-sm text-xs text-muted font-mono overflow-x-auto">
                  {displayApiKey}
                </code>
                <CopyButton
                  value={displayApiKey}
                  copyLabel="Copy API Key"
                  copiedLabel="Copied"
                  className="p-2 bg-surface shrink-0"
                />
              </div>
              <p className="text-xs text-muted">
                {t("cloud.apps.overview.saveKeyHint", {
                  defaultValue:
                    "Save this key securely. You won't see it again. This message disappears in 60 seconds.",
                })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <DashboardStatCard
          label={t("cloud.apps.overview.stat.status", {
            defaultValue: "Status",
          })}
          value={
            app.is_active
              ? t("cloud.apps.overview.statusActive", {
                  defaultValue: "Active",
                })
              : t("cloud.apps.overview.statusInactive", {
                  defaultValue: "Inactive",
                })
          }
          icon={<Activity className="h-5 w-5" />}
          accent={app.is_active ? "emerald" : "red"}
        />
        <DashboardStatCard
          label={t("cloud.apps.overview.stat.deployment", {
            defaultValue: "Deployment",
          })}
          value={
            (app.deployment_status || "draft").charAt(0).toUpperCase() +
            (app.deployment_status || "draft").slice(1)
          }
          icon={<Rocket className="h-5 w-5" />}
          accent="white"
        />
        <DashboardStatCard
          label={t("cloud.apps.overview.stat.totalUsers", {
            defaultValue: "Total Users",
          })}
          value={app.total_users?.toLocaleString("en-US") || "0"}
          icon={<Shield className="h-5 w-5" />}
          accent="violet"
        />
        <DashboardStatCard
          label={t("cloud.apps.overview.stat.totalRequests", {
            defaultValue: "Total Requests",
          })}
          value={app.total_requests?.toLocaleString("en-US") || "0"}
          icon={<TrendingUp className="h-5 w-5" />}
          accent="orange"
        />
      </div>

      {/* Deployment (#9145) — the client trigger for POST /apps/:id/deploy. */}
      <div className="bg-card rounded-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Rocket className="h-4 w-4 text-muted" />
            {t("cloud.apps.overview.deployment", {
              defaultValue: "Deployment",
            })}
          </h3>
        </div>
        <p className="text-xs text-neutral-500">
          {deploymentInProgress || isPollingDeployment
            ? t("cloud.apps.overview.deployBuilding", {
                defaultValue: "A deployment is in progress…",
              })
            : app.deployment_status === "deployed"
              ? t("cloud.apps.overview.deployLive", {
                  defaultValue:
                    "Your app is live. Redeploy to push the latest build.",
                })
              : t("cloud.apps.overview.deployDraft", {
                  defaultValue:
                    "Mobile and desktop builds request a cloud build from a repository commit. Local source bundles, images, zips, tars, and artifacts are not uploaded.",
                })}
        </p>
        <form
          className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"
          onSubmit={handleDeploy}
        >
          <label className="space-y-1.5" htmlFor={deployRepoInputId}>
            <span className="text-[11px] font-medium uppercase tracking-normal text-neutral-500">
              {t("cloud.apps.overview.deployRepoUrl", {
                defaultValue: "Repository URL",
              })}
            </span>
            <Input
              id={deployRepoInputId}
              value={deployRepoUrl}
              onChange={(event) => setDeployRepoUrl(event.target.value)}
              placeholder="https://github.com/org/app.git"
              density="compact"
              hasError={Boolean(deployInputError)}
              className="border-border bg-surface text-txt placeholder:text-neutral-600"
            />
          </label>
          <label className="space-y-1.5" htmlFor={deployRefInputId}>
            <span className="text-[11px] font-medium uppercase tracking-normal text-neutral-500">
              {t("cloud.apps.overview.deployCommitSha", {
                defaultValue: "Commit SHA",
              })}
            </span>
            <Input
              id={deployRefInputId}
              value={deployRef}
              onChange={(event) => setDeployRef(event.target.value)}
              placeholder="40-character SHA"
              density="compact"
              hasError={Boolean(deployInputError)}
              className="font-mono border-border bg-surface text-txt placeholder:text-neutral-600"
            />
          </label>
          <div className="flex items-end">
            <Button
              variant="ghost"
              type="submit"
              disabled={deploymentButtonDisabled}
              className="h-9 w-full min-w-28 text-xs text-neutral-200 bg-surface hover:bg-bg-hover flex items-center justify-center gap-1 transition-colors disabled:opacity-50"
            >
              {isDeploying || isPollingDeployment || deploymentInProgress ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Rocket className="h-3 w-3" />
              )}
              {deploymentInProgress || isPollingDeployment
                ? t("cloud.apps.overview.deploying", {
                    defaultValue: "Deploying",
                  })
                : app.deployment_status === "deployed"
                  ? t("cloud.apps.overview.redeploy", {
                      defaultValue: "Redeploy",
                    })
                  : t("cloud.apps.overview.deploy", {
                      defaultValue: "Deploy",
                    })}
            </Button>
          </div>
          <label
            className="space-y-1.5 md:col-span-2"
            htmlFor={deployDockerfileInputId}
          >
            <span className="text-[11px] font-medium uppercase tracking-normal text-neutral-500">
              {t("cloud.apps.overview.deployDockerfile", {
                defaultValue: "Dockerfile path",
              })}
            </span>
            <Input
              id={deployDockerfileInputId}
              value={deployDockerfile}
              onChange={(event) => setDeployDockerfile(event.target.value)}
              placeholder="Dockerfile"
              density="compact"
              hasError={Boolean(deployInputError)}
              className="border-border bg-surface text-txt placeholder:text-neutral-600"
            />
          </label>
        </form>
        {deployInputError && (
          <p className="text-xs text-red-300" role="alert">
            {deployInputError}
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* API Key Card */}
        <div className="bg-card rounded-sm p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-txt flex items-center gap-2">
              <Key className="h-4 w-4 text-muted" />
              {t("cloud.apps.overview.apiKey", { defaultValue: "API Key" })}
            </h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={isRegenerating}
                  className="text-xs text-neutral-400 hover:text-txt flex items-center gap-1 transition-colors"
                >
                  {isRegenerating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  {t("cloud.apps.overview.regenerate", {
                    defaultValue: "Regenerate",
                  })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("cloud.apps.overview.regenTitle", {
                      defaultValue: "Regenerate API Key?",
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("cloud.apps.overview.regenBody", {
                      defaultValue:
                        "This will immediately invalidate your current API key. Your app will stop working until you update it with the new key.",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t("cloud.apps.deleteDialog.cancel", {
                      defaultValue: "Cancel",
                    })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRegenerateApiKey}
                    className="bg-txt text-bg hover:bg-txt/90"
                  >
                    {t("cloud.apps.overview.regenerate", {
                      defaultValue: "Regenerate",
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="bg-surface rounded-sm p-3 border border-border">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-muted font-mono overflow-x-auto">
                {showKey && displayApiKey ? displayApiKey : maskedApiKey}
              </code>
              {displayApiKey && (
                <>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="p-1.5 hover:bg-bg-hover rounded-sm transition-colors"
                  >
                    {showKey ? (
                      <EyeOff className="h-3.5 w-3.5 text-muted" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 text-muted" />
                    )}
                  </Button>
                  <CopyButton
                    value={displayApiKey}
                    copyLabel="Copy API Key"
                    copiedLabel="Copied"
                  />
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            {t("cloud.apps.overview.apiKeyHint", {
              defaultValue:
                "Use this key to authenticate API requests from your app.",
            })}
          </p>
        </div>

        {/* Basic Info Card */}
        <div className="bg-card rounded-sm p-4 space-y-4">
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted" />
            {t("cloud.apps.overview.appInformation", {
              defaultValue: "App Information",
            })}
          </h3>

          <div className="space-y-3">
            {app.description && (
              <InfoRow
                label={t("cloud.apps.overview.description", {
                  defaultValue: "Description",
                })}
                value={app.description}
              />
            )}
            {app.production_url && app.deployment_status === "deployed" && (
              <InfoRow
                label="Production URL"
                value={app.production_url}
                href={app.production_url}
              />
            )}
            {app.website_url && (
              <InfoRow
                label="Website"
                value={app.website_url}
                href={app.website_url}
              />
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
                value={new Date(app.last_deployed_at).toLocaleDateString(
                  "en-US",
                  {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                )}
              />
            )}
          </div>
        </div>
      </div>

      {/* Monetization Card */}
      {monetizationEnabled !== null && (
        <div className="bg-card rounded-sm p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-sm bg-surface">
                <Coins className="h-5 w-5 text-muted" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-txt">Monetization</h3>
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
                    ? "bg-green-500/20 text-green-400 border-green-500/30"
                    : "bg-surface text-muted border-border",
                )}
              >
                {monetizationEnabled ? "Enabled" : "Disabled"}
              </Badge>
              <Button
                variant="ghost"
                type="button"
                onClick={() =>
                  navigate(`/dashboard/apps/${app.id}?tab=monetization`)
                }
                className="p-2 hover:bg-bg-hover rounded-sm transition-colors"
              >
                <ChevronRight className="h-4 w-4 text-neutral-400" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Allowed Origins */}
      <div className="bg-card rounded-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted" />
            Allowed Origins
          </h3>
          <Button
            variant="ghost"
            type="button"
            onClick={() => navigate(`/dashboard/apps/${app.id}?tab=settings`)}
            className="text-xs text-neutral-400 hover:text-txt transition-colors"
          >
            Edit
          </Button>
        </div>
        <p className="text-xs text-neutral-500">
          API requests are only accepted from these domains
        </p>
        <div className="flex flex-wrap gap-2">
          {allowedOrigins.length > 0 ? (
            allowedOrigins.map((origin) => (
              <Badge
                key={origin}
                className="bg-surface text-muted border-border"
              >
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
          onClick={(e) => {
            // Native studio: a WebView target="_blank" is dropped/hijacks the
            // WebView — open external links in the system browser. No-op on web.
            if (openExternalUrlOnNative(href)) {
              e.preventDefault();
            }
          }}
          className="text-sm text-txt hover:opacity-75 transition-opacity flex items-center gap-1 mt-0.5"
        >
          {icon}
          <span className="truncate">{value}</span>
          {!href.startsWith("mailto:") && (
            <ExternalLink className="h-3 w-3 shrink-0" />
          )}
        </a>
      ) : (
        <p className="text-sm text-txt mt-0.5 line-clamp-2">{value}</p>
      )}
    </div>
  );
}
