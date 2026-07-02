/**
 * Google Services cloud connector (OAuth-redirect).
 *
 * Imports the ConnectionCard family from `cloud-ui` and the cloud i18n + OAuth
 * hook from the app-hosted cloud surfaces.
 */

"use client";

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
import { useOAuthConnections } from "./oauth-connection";

export function GoogleConnection() {
  const t = useCloudT();
  const {
    activeConnections,
    isLoading,
    isConnecting,
    disconnectingId,
    connect: handleConnect,
    disconnect: handleDisconnect,
  } = useOAuthConnections({ platform: "google", label: "Google" });

  const getScopeIcon = (scope: string) => {
    if (scope.includes("gmail") || scope.includes("mail")) {
      return <Mail className="h-4 w-4" />;
    }
    if (scope.includes("calendar")) {
      return <Calendar className="h-4 w-4" />;
    }
    if (scope.includes("contacts") || scope.includes("people")) {
      return <Users className="h-4 w-4" />;
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
      status={hasConnections ? "connected" : "disconnected"}
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
                icon={<Mail className="h-6 w-6 text-[#FF5800]" />}
                iconClassName="bg-[#FF5800]/10"
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
                      <Badge key={scope} variant="outline" className="text-xs">
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
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t("cloud.google.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-2" />
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
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-muted rounded-sm text-center">
              <Mail className="h-6 w-6 mx-auto mb-2 text-red-500" />
              <p className="text-sm font-medium">
                {t("cloud.google.gmail", { defaultValue: "Gmail" })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.google.gmailDesc", {
                  defaultValue: "Send & read emails",
                })}
              </p>
            </div>
            <div className="p-3 bg-muted rounded-sm text-center">
              <Calendar className="h-6 w-6 mx-auto mb-2 text-[#FF5800]" />
              <p className="text-sm font-medium">
                {t("cloud.google.calendar", { defaultValue: "Calendar" })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.google.calendarDesc", {
                  defaultValue: "Manage events",
                })}
              </p>
            </div>
            <div className="p-3 bg-muted rounded-sm text-center">
              <Users className="h-6 w-6 mx-auto mb-2 text-green-500" />
              <p className="text-sm font-medium">
                {t("cloud.google.contacts", { defaultValue: "Contacts" })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("cloud.google.contactsDesc", {
                  defaultValue: "Access contacts",
                })}
              </p>
            </div>
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
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t("cloud.google.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <GoogleIcon className="h-4 w-4 mr-2 text-current" />
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

function GoogleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-label="Google">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
