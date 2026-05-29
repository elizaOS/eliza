"use client";

import {
  Badge,
  Button,
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
} from "@elizaos/ui";
import { Calendar, Loader2, Mail } from "lucide-react";
import { useOAuthConnections } from "./oauth-connection";

export function MicrosoftConnection() {
  const {
    activeConnections,
    isLoading,
    isConnecting,
    disconnectingId,
    connect: handleConnect,
    disconnect,
  } = useOAuthConnections({ platform: "microsoft", label: "Microsoft" });

  // Microsoft is a single-account integration: surface the first active link.
  const activeConnection = activeConnections[0];
  const isDisconnecting = disconnectingId !== null;
  const handleDisconnect = () => {
    if (!activeConnection) return;
    void disconnect(activeConnection.id);
  };

  const getScopeIcon = (scope: string) => {
    if (scope.includes("Mail")) {
      return <Mail className="h-4 w-4" />;
    }
    if (scope.includes("Calendar")) {
      return <Calendar className="h-4 w-4" />;
    }
    return null;
  };

  const getScopeName = (scope: string) => {
    if (scope === "Mail.Send") return "Send emails";
    if (scope === "Mail.Read") return "Read emails";
    if (scope === "Mail.ReadWrite") return "Read & write emails";
    if (scope === "Calendars.Read") return "Read calendar";
    if (scope === "Calendars.ReadWrite") return "Read & write calendar";
    if (scope === "User.Read") return "Read profile";
    if (scope === "offline_access") return "Offline access";
    return scope;
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name="Microsoft Services"
        icon={<MicrosoftIcon />}
        description="Connect Outlook Mail, Calendar for AI-powered automation"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="Microsoft Services"
      icon={<MicrosoftIcon />}
      description="Connect Outlook Mail, Calendar for AI-powered automation"
      status={activeConnection ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Mail className="h-6 w-6 text-[#FF5800]" />}
            iconClassName="bg-[#FF5800]/10"
            title={activeConnection?.email}
            subtitle="Microsoft Account Connected"
          />

          {activeConnection?.scopes && activeConnection.scopes.length > 0 && (
            <div className="p-3 bg-muted rounded-sm">
              <p className="text-sm font-medium mb-2">Permissions granted:</p>
              <div className="flex flex-wrap gap-2">
                {activeConnection.scopes
                  .filter((s) => !["openid", "profile", "email"].includes(s))
                  .map((scope) => (
                    <Badge key={scope} variant="outline" className="text-xs">
                      {getScopeIcon(scope)}
                      <span className="ml-1">{getScopeName(scope)}</span>
                    </Badge>
                  ))}
              </div>
            </div>
          )}

          <ConnectionCallout
            title="Available automations:"
            tone="blue"
            items={[
              "Send emails via Outlook on your behalf",
              "Create and manage calendar events",
              "Read emails for AI-powered responses",
              "Build email workflows with AI",
            ]}
          />

          <ConnectionFooterActions note="Used for workflow automation">
            <ConnectionDisconnectAction
              title="Disconnect Microsoft Account?"
              description="This will revoke access to Outlook Mail and Calendar. Any active automations using Microsoft services will stop working until you reconnect."
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-muted rounded-sm text-center">
              <Mail className="h-6 w-6 mx-auto mb-2 text-[#FF5800]" />
              <p className="text-sm font-medium">Outlook</p>
              <p className="text-xs text-muted-foreground">
                Send & read emails
              </p>
            </div>
            <div className="p-3 bg-muted rounded-sm text-center">
              <Calendar className="h-6 w-6 mx-auto mb-2 text-[#FF5800]" />
              <p className="text-sm font-medium">Calendar</p>
              <p className="text-xs text-muted-foreground">Manage events</p>
            </div>
          </div>

          <ConnectionCallout
            title="What you can do with Microsoft integration:"
            items={[
              "Send AI-generated emails via Outlook",
              "Schedule and manage calendar events",
              "Create email workflows triggered by messages",
              "Auto-respond based on calendar availability",
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
                Connecting...
              </>
            ) : (
              <>
                <MicrosoftIcon className="h-4 w-4 mr-2 text-current" />
                Connect with Microsoft
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}

function MicrosoftIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 23 23" aria-label="Microsoft">
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}
