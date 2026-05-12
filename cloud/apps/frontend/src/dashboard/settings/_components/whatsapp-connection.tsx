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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
} from "@elizaos/cloud-ui";
import {
  CheckCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  MessageSquare,
  Phone,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface WhatsAppStatus {
  connected: boolean;
  configured?: boolean;
  businessPhone?: string;
  webhookUrl?: string;
  verifyToken?: string;
  error?: string;
}

export function WhatsAppConnection() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/whatsapp/status", { signal });
      if (!signal?.aborted) {
        setStatus(await response.json());
      }
    } catch {
      if (!signal?.aborted) {
        toast.error("Failed to fetch WhatsApp status");
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchStatus(controller.signal);
    return () => controller.abort();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (isConnecting) return;
    if (!accessToken.trim()) {
      toast.error("Please enter your access token");
      return;
    }
    if (!phoneNumberId.trim()) {
      toast.error("Please enter your Phone Number ID");
      return;
    }
    if (!appSecret.trim()) {
      toast.error("Please enter your App Secret");
      return;
    }

    setIsConnecting(true);

    try {
      const response = await fetch("/api/v1/whatsapp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          phoneNumberId,
          appSecret,
          businessPhone: businessPhone || undefined,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("WhatsApp connected! Now configure the webhook in Meta.");
        setAccessToken("");
        setPhoneNumberId("");
        setAppSecret("");
        setBusinessPhone("");
        void fetchStatus();
      } else {
        toast.error(data.error || "Failed to connect WhatsApp");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);

    try {
      const response = await fetch("/api/v1/whatsapp/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("WhatsApp disconnected");
        void fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsDisconnecting(false);
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
              <MessageSquare className="h-5 w-5 text-green-500" />
              WhatsApp Business
            </CardTitle>
            <CardDescription>
              Connect WhatsApp Business for AI-powered conversations
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
            {/* Connected info */}
            <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <Phone className="h-6 w-6 text-green-600" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">{status.businessPhone || "WhatsApp Business"}</div>
                <div className="text-sm text-muted-foreground">WhatsApp Business Connected</div>
              </div>
            </div>

            {/* Webhook URL */}
            {status.webhookUrl && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Webhook URL (configure in Meta App Dashboard)
                </Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-background p-2 rounded border overflow-x-auto">
                    {status.webhookUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(status.webhookUrl!);
                      toast.success("Webhook URL copied to clipboard");
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}

            {/* Verify Token */}
            {status.verifyToken && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Verify Token (enter in Meta webhook configuration)
                </Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-background p-2 rounded border overflow-x-auto">
                    {status.verifyToken}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(status.verifyToken!);
                      toast.success("Verify token copied to clipboard");
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}

            {/* Post-connection setup instructions */}
            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                Webhook Setup Instructions
              </p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>
                  Go to{" "}
                  <a
                    href="https://developers.facebook.com/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    Meta App Dashboard
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>Navigate to WhatsApp {">"} Configuration</li>
                <li>Click &quot;Edit&quot; on the Callback URL section</li>
                <li>Paste the Webhook URL and Verify Token from above</li>
                <li>Subscribe to the &quot;messages&quot; webhook field</li>
              </ol>
            </div>

            {/* Capabilities */}
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
              <p className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                Your AI agent can now:
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• Receive and respond to WhatsApp messages</li>
                <li>• Have AI-powered conversations 24/7</li>
                <li>• Handle customer inquiries automatically</li>
              </ul>
            </div>

            {/* Disconnect */}
            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-sm text-muted-foreground">
                Messages are processed in real-time
              </div>
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
                    <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will stop your AI agent from receiving and sending WhatsApp messages. You
                      can reconnect at any time.
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
            {/* Setup instructions */}
            <Collapsible open={showInstructions} onOpenChange={setShowInstructions}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between p-4 h-auto bg-muted">
                  <span className="font-medium">How to get WhatsApp Business API credentials</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      showInstructions ? "rotate-180" : ""
                    }`}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="p-4 bg-muted rounded-b-lg border-t">
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>
                    Go to{" "}
                    <a
                      href="https://developers.facebook.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-600 hover:underline inline-flex items-center gap-1"
                    >
                      developers.facebook.com
                      <ExternalLink className="h-3 w-3" />
                    </a>{" "}
                    and create a Meta Business App
                  </li>
                  <li>Add the WhatsApp product to your app</li>
                  <li>Go to WhatsApp {">"} API Setup to find your Phone Number ID</li>
                  <li>Go to Settings {">"} Basic to find your App Secret</li>
                  <li>
                    Create a permanent access token via Meta Business Settings {">"} System Users
                  </li>
                  <li>Enter the credentials below to connect</li>
                </ol>
              </CollapsibleContent>
            </Collapsible>

            {/* Credential fields */}
            <div className="space-y-2">
              <Label htmlFor="waAccessToken">Access Token</Label>
              <Input
                id="waAccessToken"
                type="password"
                placeholder="EAAxxxxxxxxxxxxxxxxxxxxxxxx"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Permanent access token from Meta Business Settings
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="waPhoneNumberId">Phone Number ID</Label>
              <Input
                id="waPhoneNumberId"
                type="text"
                placeholder="123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Found in Meta App Dashboard under WhatsApp {">"} API Setup
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="waAppSecret">App Secret</Label>
              <Input
                id="waAppSecret"
                type="password"
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Found in Meta App Dashboard under Settings {">"} Basic
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="waBusinessPhone">Business Phone Number (optional)</Label>
              <Input
                id="waBusinessPhone"
                type="tel"
                placeholder="+1 (555) 123-4567"
                value={businessPhone}
                onChange={(e) => setBusinessPhone(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Your WhatsApp Business phone number (for display)
              </p>
            </div>

            {/* Capabilities preview */}
            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with WhatsApp:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Have AI conversations via WhatsApp</li>
                <li>• Receive real-time customer messages</li>
                <li>• Send automated responses 24/7</li>
                <li>• Handle inquiries naturally</li>
              </ul>
            </div>

            {/* Connect button */}
            <Button
              onClick={handleConnect}
              disabled={
                isConnecting || !accessToken.trim() || !phoneNumberId.trim() || !appSecret.trim()
              }
              className="w-full bg-green-600 hover:bg-green-700"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Connecting...
                </>
              ) : (
                <>
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Connect WhatsApp
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
