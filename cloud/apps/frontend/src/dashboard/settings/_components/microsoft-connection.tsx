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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@elizaos/cloud-ui";
import { Calendar, CheckCircle, Loader2, Mail, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface MicrosoftConnection {
  id: string;
  platform: string;
  email?: string;
  displayName?: string;
  scopes?: string[];
  status: string;
}

interface MicrosoftStatus {
  connected: boolean;
  connectionId?: string;
  email?: string;
  scopes?: string[];
}

export function MicrosoftConnection() {
  const [status, setStatus] = useState<MicrosoftStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const fetchStatus = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/oauth/connections?platform=microsoft");
      const data = await response.json();
      const connections: MicrosoftConnection[] = data.connections || [];
      const activeConnection = connections.find((c) => c.status === "active");

      setStatus({
        connected: !!activeConnection,
        connectionId: activeConnection?.id,
        email: activeConnection?.email,
        scopes: activeConnection?.scopes,
      });
    } catch {
      toast.error("Failed to fetch Microsoft status");
    }
    setIsLoading(false);
  };

  useEffect(() => {
    const controller = new AbortController();

    const loadStatus = async () => {
      setIsLoading(true);
      try {
        const response = await fetch("/api/v1/oauth/connections?platform=microsoft", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const data = await response.json();
          const connections: MicrosoftConnection[] = data.connections || [];
          const activeConnection = connections.find((c) => c.status === "active");

          setStatus({
            connected: !!activeConnection,
            connectionId: activeConnection?.id,
            email: activeConnection?.email,
            scopes: activeConnection?.scopes,
          });
          setIsLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    loadStatus();

    return () => controller.abort();
  }, []);

  const handleConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);

    try {
      const response = await fetch("/api/v1/oauth/microsoft/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUrl: "/dashboard/settings?tab=connections",
        }),
      });

      const data = await response.json();

      if (response.ok && data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast.error(data.error || "Failed to initiate Microsoft OAuth");
        setIsConnecting(false);
      }
    } catch {
      toast.error("Network error. Please check your connection.");
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (isDisconnecting || !status?.connectionId) return;
    setIsDisconnecting(true);

    try {
      const response = await fetch(`/api/v1/oauth/connections/${status.connectionId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Microsoft account disconnected");
        fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsDisconnecting(false);
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
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 23 23" aria-label="Microsoft">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
              Microsoft Services
            </CardTitle>
            <CardDescription>
              Connect Outlook Mail, Calendar for AI-powered automation
            </CardDescription>
          </div>
          {status?.connected && (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
              <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
                <Mail className="h-6 w-6 text-blue-600" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">{status.email}</div>
                <div className="text-sm text-muted-foreground">Microsoft Account Connected</div>
              </div>
            </div>

            {status.scopes && status.scopes.length > 0 && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm font-medium mb-2">Permissions granted:</p>
                <div className="flex flex-wrap gap-2">
                  {status.scopes
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

            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                Available automations:
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• Send emails via Outlook on your behalf</li>
                <li>• Create and manage calendar events</li>
                <li>• Read emails for AI-powered responses</li>
                <li>• Build email workflows with AI</li>
              </ul>
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-sm text-muted-foreground">Used for workflow automation</div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700"
                    disabled={isDisconnecting}
                  >
                    {isDisconnecting ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <XCircle className="h-4 w-4 mr-1" />
                    )}
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Microsoft Account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will revoke access to Outlook Mail and Calendar. Any active automations
                      using Microsoft services will stop working until you reconnect.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDisconnect}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-muted rounded-lg text-center">
                <Mail className="h-6 w-6 mx-auto mb-2 text-blue-500" />
                <p className="text-sm font-medium">Outlook</p>
                <p className="text-xs text-muted-foreground">Send & read emails</p>
              </div>
              <div className="p-3 bg-muted rounded-lg text-center">
                <Calendar className="h-6 w-6 mx-auto mb-2 text-blue-500" />
                <p className="text-sm font-medium">Calendar</p>
                <p className="text-xs text-muted-foreground">Manage events</p>
              </div>
            </div>

            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with Microsoft integration:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Send AI-generated emails via Outlook</li>
                <li>• Schedule and manage calendar events</li>
                <li>• Create email workflows triggered by messages</li>
                <li>• Auto-respond based on calendar availability</li>
              </ul>
            </div>

            <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Connecting...
                </>
              ) : (
                <>
                  <svg className="h-4 w-4 mr-2" viewBox="0 0 23 23" aria-hidden="true">
                    <path fill="currentColor" d="M1 1h10v10H1z" />
                    <path fill="currentColor" d="M12 1h10v10H12z" />
                    <path fill="currentColor" d="M1 12h10v10H1z" />
                    <path fill="currentColor" d="M12 12h10v10H12z" />
                  </svg>
                  Connect with Microsoft
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
