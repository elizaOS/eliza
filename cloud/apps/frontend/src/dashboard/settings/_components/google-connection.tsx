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
import { Calendar, CheckCircle, Loader2, Mail, Plus, Users, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface GoogleConnection {
  id: string;
  platform: string;
  email?: string;
  displayName?: string;
  scopes?: string[];
  status: string;
}

export function GoogleConnection() {
  const [connections, setConnections] = useState<GoogleConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const fetchConnections = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    const response = await fetch("/api/v1/oauth/connections?platform=google", {
      signal,
    });
    if (signal?.aborted) return;
    if (!response.ok) {
      toast.error("Failed to fetch Google connections");
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as {
      connections?: GoogleConnection[];
    };
    setConnections(data.connections ?? []);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchConnections(controller.signal);
    return () => controller.abort();
  }, [fetchConnections]);

  const handleConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);

    const response = await fetch("/api/v1/oauth/google/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUrl: "/dashboard/settings?tab=connections",
      }),
    });

    const data = (await response.json()) as {
      authUrl?: string;
      error?: string;
    };
    if (response.ok && data.authUrl) {
      window.location.href = data.authUrl;
      return;
    }
    toast.error(data.error || "Failed to initiate Google OAuth");
    setIsConnecting(false);
  };

  const handleDisconnect = async (connectionId: string) => {
    if (disconnectingId) return;
    setDisconnectingId(connectionId);

    const response = await fetch(`/api/v1/oauth/connections/${connectionId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      toast.success("Google account disconnected");
      await fetchConnections();
    } else {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      toast.error(data.error || "Failed to disconnect");
    }

    setDisconnectingId(null);
  };

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
    if (scope.includes("gmail.send")) return "Send emails";
    if (scope.includes("gmail.readonly")) return "Read emails";
    if (scope.includes("gmail.modify")) return "Modify emails";
    if (scope.includes("calendar.events")) return "Calendar events";
    if (scope.includes("calendar.readonly")) return "Read calendar";
    if (scope.includes("contacts.readonly")) return "Read contacts";
    if (scope.includes("people")) return "Contacts";
    return scope.split("/").pop() || scope;
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

  const activeConnections = connections.filter((c) => c.status === "active");
  const hasConnections = activeConnections.length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 24 24" aria-label="Google">
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
              Google Services
            </CardTitle>
            <CardDescription>
              Connect Gmail, Calendar, and Contacts for AI-powered automation
            </CardDescription>
          </div>
          {hasConnections && (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              {activeConnections.length} connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {hasConnections ? (
          <div className="space-y-4">
            <div className="space-y-3">
              {activeConnections.map((connection) => (
                <div
                  key={connection.id}
                  className="flex items-center gap-4 p-4 bg-muted rounded-lg"
                >
                  <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <Mail className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">
                      {connection.email || connection.displayName || connection.id}
                    </div>
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
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 hover:text-red-700 shrink-0"
                        disabled={disconnectingId === connection.id}
                      >
                        {disconnectingId === connection.id ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-1" />
                        ) : (
                          <XCircle className="h-4 w-4 mr-1" />
                        )}
                        Disconnect
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Disconnect {connection.email || "Google account"}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          This will revoke access for this account. Other connected Google accounts
                          will continue to work.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDisconnect(connection.id)}
                          className="bg-red-600 hover:bg-red-700"
                        >
                          Disconnect
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
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
                  Connecting...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  Add another Google account
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-muted rounded-lg text-center">
                <Mail className="h-6 w-6 mx-auto mb-2 text-red-500" />
                <p className="text-sm font-medium">Gmail</p>
                <p className="text-xs text-muted-foreground">Send & read emails</p>
              </div>
              <div className="p-3 bg-muted rounded-lg text-center">
                <Calendar className="h-6 w-6 mx-auto mb-2 text-blue-500" />
                <p className="text-sm font-medium">Calendar</p>
                <p className="text-xs text-muted-foreground">Manage events</p>
              </div>
              <div className="p-3 bg-muted rounded-lg text-center">
                <Users className="h-6 w-6 mx-auto mb-2 text-green-500" />
                <p className="text-sm font-medium">Contacts</p>
                <p className="text-xs text-muted-foreground">Access contacts</p>
              </div>
            </div>

            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with Google integration:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Send AI-generated emails on your behalf</li>
                <li>• Schedule and manage calendar events</li>
                <li>• Create email workflows triggered by messages</li>
                <li>• Connect multiple Google accounts (personal + work)</li>
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
                  <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="currentColor"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  Connect with Google
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
