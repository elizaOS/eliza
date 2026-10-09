import { GoogleIcon } from "../../login/icons";

/**
 * Google Services cloud connector (OAuth-redirect).
 *
 * Imports the ConnectionCard family from `cloud-ui` and the cloud i18n + OAuth
 * hook from the app-hosted cloud surfaces.
 */

("use client");

import { Calendar, Loader2, Mail, Plus, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionDisconnectAction,
  ConnectionIdentityPanel,
} from "../../cloud-ui/components/connection-card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { isSafeNavigationUrl } from "../../utils/navigation-url";
import { api } from "../lib/api-client";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ConnectionCapabilityTile } from "./connection-capability-tile";
import { useOAuthConnections } from "./oauth-connection";

export function GoogleConnection() {
  const t = useCloudT();
  const auth = useSessionAuth();
  const accountId =
    auth.ready && auth.authenticated ? (auth.user?.id ?? null) : null;
  const {
    connections,
    activeConnections,
    isLoading,
    isError,
    errorMessage,
    isConnecting,
    disconnectingId,
    connect: handleConnect,
    disconnect: handleDisconnect,
    refetch,
  } = useOAuthConnections({ platform: "google", label: "Google" });

  const getScopeIcon = (scope: string) => {
    if (scope.includes("gmail") || scope.includes("mail")) {
      return <Mail className="size-4" />;
    }
    if (scope.includes("calendar")) {
      return <Calendar className="size-4" />;
    }
    if (scope.includes("contacts") || scope.includes("people")) {
      return <Users className="size-4" />;
    }
    return null;
  };

  const getScopeName = (scope: string) => {
    if (scope.includes("gmail.send"))
      return t("cloud.google.scopeSendEmails", { defaultValue: "Send emails" });
    if (scope.includes("gmail.readonly"))
      return t("cloud.google.scopeReadEmails", { defaultValue: "Read emails" });
    if (scope.includes("gmail.modify"))
      return t("cloud.google.scopeModifyEmails", {
        defaultValue: "Modify emails",
      });
    if (scope.includes("calendar.events"))
      return t("cloud.google.scopeCalendarEvents", {
        defaultValue: "Calendar events",
      });
    if (scope.includes("calendar.readonly"))
      return t("cloud.google.scopeReadCalendar", {
        defaultValue: "Read calendar",
      });
    if (scope.includes("contacts.readonly"))
      return t("cloud.google.scopeReadContacts", {
        defaultValue: "Read contacts",
      });
    if (scope.includes("people"))
      return t("cloud.google.scopeContacts", { defaultValue: "Contacts" });
    return scope.split("/").pop() || scope;
  };

  const hasConnections = activeConnections.length > 0;

  return (
    <>
      <GooglePersonalContextConnect
        key={accountId ?? "signed-out"}
        accountId={accountId}
        connectionsVersion={connections
          .map((connection) => `${connection.id}:${connection.status}`)
          .join("|")}
        onConnectionsChange={refetch}
      />
      <ConnectionCard
        name={t("cloud.google.cardName", { defaultValue: "Google Services" })}
        icon={<GoogleIcon />}
        description={t("cloud.google.cardDescription", {
          defaultValue:
            "Connect Gmail, Calendar, and Contacts for AI-powered automation",
        })}
        status={
          isLoading
            ? "loading"
            : isError
              ? "error"
              : hasConnections
                ? "connected"
                : "disconnected"
        }
        errorMessage={
          errorMessage ??
          t("cloud.google.statusFetchFailed", {
            defaultValue: "Couldn’t load Google connections.",
          })
        }
        onRetry={() => void refetch()}
        statusBadge={
          <ConnectionConnectedBadge
            label={t("cloud.google.connectedCount", {
              count: activeConnections.length,
              defaultValue: "{{count}} connected",
            })}
          />
        }
        connectedContent={
          <div className="space-y-4">
            <div className="space-y-3">
              {activeConnections.map((connection) => (
                <ConnectionIdentityPanel
                  key={connection.id}
                  icon={<Mail className="size-6 text-txt" />}
                  iconClassName="bg-muted"
                  title={
                    connection.email || connection.displayName || connection.id
                  }
                  actions={
                    <ConnectionDisconnectAction
                      title={t("cloud.google.disconnectTitle", {
                        account:
                          connection.email ||
                          t("cloud.google.googleAccount", {
                            defaultValue: "Google account",
                          }),
                        defaultValue: "Disconnect {{account}}?",
                      })}
                      description={t("cloud.google.disconnectDescription", {
                        defaultValue:
                          "This will revoke access for this account. Other connected Google accounts will continue to work.",
                      })}
                      onDisconnect={() => handleDisconnect(connection.id)}
                      isDisconnecting={disconnectingId === connection.id}
                    />
                  }
                >
                  {connection.scopes && connection.scopes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {connection.scopes.map((scope) => (
                        <Badge key={scope} variant="outline">
                          {getScopeIcon(scope)}
                          <span className="ml-1">{getScopeName(scope)}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </ConnectionIdentityPanel>
              ))}
            </div>

            <Button
              variant="outline"
              onClick={handleConnect}
              disabled={isConnecting}
              className="w-full"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  {t("cloud.google.connecting", {
                    defaultValue: "Connecting...",
                  })}
                </>
              ) : (
                <>
                  <Plus className="size-4 mr-2" />
                  {t("cloud.google.addAnother", {
                    defaultValue: "Add another Google account",
                  })}
                </>
              )}
            </Button>
          </div>
        }
        setupContent={
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ConnectionCapabilityTile
                icon={<Mail className="size-6 text-accent" aria-hidden />}
                title={t("cloud.google.gmail", { defaultValue: "Gmail" })}
                description={t("cloud.google.gmailDesc", {
                  defaultValue: "Send & read emails",
                })}
              />
              <ConnectionCapabilityTile
                icon={<Calendar className="size-6 text-txt" aria-hidden />}
                title={t("cloud.google.calendar", {
                  defaultValue: "Calendar",
                })}
                description={t("cloud.google.calendarDesc", {
                  defaultValue: "Manage events",
                })}
              />
              <ConnectionCapabilityTile
                icon={<Users className="size-6 text-accent" aria-hidden />}
                title={t("cloud.google.contacts", {
                  defaultValue: "Contacts",
                })}
                description={t("cloud.google.contactsDesc", {
                  defaultValue: "Access contacts",
                })}
              />
            </div>

            <ConnectionCallout
              title={t("cloud.google.calloutTitle", {
                defaultValue: "What you can do with Google integration:",
              })}
              items={[
                t("cloud.google.calloutItem1", {
                  defaultValue: "Send AI-generated emails on your behalf",
                }),
                t("cloud.google.calloutItem2", {
                  defaultValue: "Schedule and manage calendar events",
                }),
                t("cloud.google.calloutItem3", {
                  defaultValue: "Create email workflows triggered by messages",
                }),
                t("cloud.google.calloutItem4", {
                  defaultValue:
                    "Connect multiple Google accounts (personal + work)",
                }),
              ]}
            />

            <Button
              onClick={handleConnect}
              disabled={isConnecting}
              className="w-full"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  {t("cloud.google.connecting", {
                    defaultValue: "Connecting...",
                  })}
                </>
              ) : (
                <>
                  <GoogleIcon className="size-4 mr-2 text-current" />
                  {t("cloud.google.connectButton", {
                    defaultValue: "Connect with Google",
                  })}
                </>
              )}
            </Button>
          </div>
        }
      />
    </>
  );
}
interface PersonalGoogleStatus {
  purpose: "personal_google_context_v1";
  selectedConnectionId: string | null;
  status: {
    connected: boolean;
    configured: boolean;
    reason: string;
    connectionId: string | null;
    identity: { email?: unknown; name?: unknown } | null;
    grantedScopes: string[];
  } | null;
}

function GooglePersonalContextConnect({
  accountId,
  connectionsVersion,
  onConnectionsChange,
}: {
  accountId: string | null;
  connectionsVersion: string;
  onConnectionsChange: () => Promise<void>;
}) {
  const t = useCloudT();
  const [data, setData] = useState<PersonalGoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [action, setAction] = useState<"connect" | "disconnect" | null>(null);
  const alive = useRef(true);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      actionController.current?.abort();
    };
  }, []);
  // External grant changes and explicit refresh invalidate this selected-consent read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionsVersion and refresh intentionally retrigger the request.
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setLoadError(false);
    setLoading(Boolean(accountId));
    if (accountId)
      void api<PersonalGoogleStatus>(
        "/api/v1/eliza/google/status?side=owner&purpose=personal_google_context_v1",
        { signal: controller.signal },
      )
        .then((next) => {
          if (controller.signal.aborted) return;
          if (
            next.purpose !== "personal_google_context_v1" ||
            (next.status?.connectionId &&
              next.status.connectionId !== next.selectedConnectionId)
          ) {
            throw new Error("Personal Google status mismatch");
          }
          setData(next);
        })
        .catch(() => {
          if (!controller.signal.aborted) setLoadError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    return () => controller.abort();
  }, [accountId, connectionsVersion, refresh]);

  const startAction = () => {
    if (!accountId || actionController.current) return null;
    const controller = new AbortController();
    actionController.current = controller;
    setActionError(undefined);
    return controller;
  };
  async function connect() {
    const controller = startAction();
    if (!controller) return;
    setAction("connect");
    try {
      const result = await api<{ authUrl: string }>(
        "/api/v1/eliza/google/connect/initiate",
        {
          method: "POST",
          json: { side: "owner", purpose: "personal_google_context_v1" },
          signal: controller.signal,
        },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (!isSafeNavigationUrl(result.authUrl))
        throw new Error("Invalid Google authorization URL");
      window.location.href = result.authUrl;
    } catch {
      if (alive.current && !controller.signal.aborted)
        setActionError(
          t("cloud.google.personalConnectFailed", {
            defaultValue:
              "Couldn’t start the Google connection. Please try again.",
          }),
        );
    } finally {
      if (alive.current && !controller.signal.aborted) setAction(null);
      if (actionController.current === controller)
        actionController.current = null;
    }
  }
  async function disconnect() {
    const connectionId = data?.selectedConnectionId;
    if (!connectionId) return;
    const controller = startAction();
    if (!controller) return;
    setAction("disconnect");
    try {
      await api("/api/v1/eliza/google/disconnect", {
        method: "POST",
        json: { side: "owner", connectionId },
        signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return;
      setRefresh((value) => value + 1);
      await onConnectionsChange();
    } catch {
      if (alive.current && !controller.signal.aborted)
        setActionError(
          t("cloud.google.personalDisconnectFailed", {
            defaultValue:
              "Couldn’t disconnect this Google account. Refresh its status and try again.",
          }),
        );
    } finally {
      if (alive.current && !controller.signal.aborted) setAction(null);
      if (actionController.current === controller)
        actionController.current = null;
    }
  }
  const selected = data?.selectedConnectionId;
  const status = data?.status;
  const connected = Boolean(
    selected &&
      status?.connected &&
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
      ].every((scope) => status.grantedScopes.includes(scope)),
  );
  const identity = status?.identity;
  const accountName =
    typeof identity?.email === "string"
      ? identity.email
      : typeof identity?.name === "string"
        ? identity.name
        : t("cloud.google.googleAccount", { defaultValue: "Google account" });
  const connectButton = (
    <Button
      type="button"
      onClick={() => void connect()}
      disabled={!accountId || action !== null || status?.configured === false}
    >
      {action === "connect" && (
        <Loader2 className="size-4 animate-spin mr-2" aria-hidden />
      )}
      {action === "connect"
        ? t("cloud.google.connecting", { defaultValue: "Connecting..." })
        : selected
          ? t("cloud.google.personalReconnect", {
              defaultValue: "Reconnect personal context",
            })
          : t("cloud.google.personalConnect", {
              defaultValue: "Connect personal context",
            })}
    </Button>
  );
  const content = (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("cloud.google.personalDisclosure", {
          defaultValue:
            "Eliza can read requested Gmail messages and Google Calendar events for your personal chat. Requested content is processed by Eliza’s configured AI providers. This personal context connection does not send email, change calendars, or import your inbox in the background.",
        })}
      </p>
      {selected && (
        <ConnectionIdentityPanel
          icon={<GoogleIcon />}
          title={accountName}
          subtitle={
            connected
              ? t("cloud.google.personalSelected", {
                  defaultValue: "Selected for personal chat · read only",
                })
              : t("cloud.google.personalReauth", {
                  defaultValue: "Personal context needs reconnection",
                })
          }
          className="flex-wrap"
          actions={
            <ConnectionDisconnectAction
              title={t("cloud.google.personalDisconnectTitle", {
                defaultValue: "Disconnect personal Google context?",
              })}
              description={t("cloud.google.personalDisconnectDescription", {
                defaultValue:
                  "Revoke this selected Google connection and stop using it in personal chat. Other Google accounts are not disconnected.",
              })}
              onDisconnect={() => void disconnect()}
              isDisconnecting={action !== null}
              buttonLabel={t("cloud.google.personalDisconnect", {
                defaultValue: "Disconnect personal context",
              })}
              confirmLabel={t("cloud.google.personalDisconnect", {
                defaultValue: "Disconnect personal context",
              })}
            />
          }
        />
      )}
      {status?.configured === false && (
        <p className="text-sm">
          {t("cloud.google.personalNotConfigured", {
            defaultValue:
              "Personal Google connections are not configured. Contact your administrator.",
          })}
        </p>
      )}
      {!accountId && (
        <p className="text-sm">
          {t("cloud.google.personalSignIn", {
            defaultValue: "Sign in to manage personal Google context.",
          })}
        </p>
      )}
      {!connected && connectButton}
      {actionError && (
        <div role="alert" className="space-y-2">
          <p className="text-sm">{actionError}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={action !== null}
          >
            {t("cloud.google.personalRefresh", {
              defaultValue: "Refresh status",
            })}
          </Button>
        </div>
      )}
    </div>
  );
  return (
    <>
      <ConnectionCard
        name={t("cloud.google.personalName", {
          defaultValue: "Google for personal chat",
        })}
        icon={<GoogleIcon />}
        description={t("cloud.google.personalDescription", {
          defaultValue:
            "Read-only Gmail and Calendar context, separately selected for your personal chat.",
        })}
        status={
          loading
            ? "loading"
            : loadError
              ? "error"
              : status?.configured === false && !selected
                ? "not-configured"
                : connected
                  ? "connected"
                  : "disconnected"
        }
        onRetry={() => setRefresh((value) => value + 1)}
        statusBadge={
          <ConnectionConnectedBadge
            label={t("cloud.google.personalReadOnly", {
              defaultValue: "Read only",
            })}
          />
        }
        connectedContent={content}
        setupContent={content}
        notConfiguredMessage={t("cloud.google.personalNotConfigured", {
          defaultValue:
            "Personal Google connections are not configured. Contact your administrator.",
        })}
      />
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 py-2">
          <p className="text-sm">
            {t("cloud.google.personalStatusFailed", {
              defaultValue:
                "Couldn’t check personal Google context. Retry to manage its connection.",
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t("cloud.google.personalRetry", {
              defaultValue: "Retry personal context",
            })}
          </Button>
        </div>
      )}
    </>
  );
}
