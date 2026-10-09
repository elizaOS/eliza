import { GoogleIcon } from "../../login/icons";

/**
 * Google Services cloud connector (OAuth-redirect).
 *
 * Imports the ConnectionCard family from `cloud-ui` and the cloud i18n + OAuth
 * hook from the app-hosted cloud surfaces.
 */

("use client");

import { Calendar, Loader2, Mail, Plus, Users } from "lucide-react";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionDisconnectAction,
  ConnectionIdentityPanel,
} from "../../cloud-ui/components/connection-card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ConnectionCapabilityTile } from "./connection-capability-tile";
import { useOAuthConnections } from "./oauth-connection";

export function GoogleConnection() {
  const t = useCloudT();
  const {
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

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.google.cardName", { defaultValue: "Google Services" })}
        icon={<GoogleIcon />}
        description={t("cloud.google.cardDescription", {
          defaultValue:
            "Connect Gmail, Calendar, and Contacts for AI-powered automation",
        })}
        status="loading"
      />
    );
  }

  const hasConnections = activeConnections.length > 0;

  return (
    <ConnectionCard
      name={t("cloud.google.cardName", { defaultValue: "Google Services" })}
      icon={<GoogleIcon />}
      description={t("cloud.google.cardDescription", {
        defaultValue:
          "Connect Gmail, Calendar, and Contacts for AI-powered automation",
      })}
      status={isError ? "error" : hasConnections ? "connected" : "disconnected"}
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
  );
}
