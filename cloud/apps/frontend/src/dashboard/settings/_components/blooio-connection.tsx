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
  MessageCircle,
  Smartphone,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface BlooioStatus {
  connected: boolean;
  phoneNumber?: string;
  webhookConfigured?: boolean;
  webhookUrl?: string;
  hasWebhookSecret?: boolean;
  error?: string;
}

export function BlooioConnection() {
  const [status, setStatus] = useState<BlooioStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [isSavingSecret, setIsSavingSecret] = useState(false);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/blooio/status", { signal });
      if (!signal?.aborted) {
        setStatus(await response.json());
      }
    } catch {
      if (!signal?.aborted) {
        toast.error("Failed to fetch Blooio status");
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
    if (!apiKey.trim()) {
      toast.error("Please enter your Blooio API key");
      return;
    }
    if (!phoneNumber.trim()) {
      toast.error("Please enter your iMessage phone number");
      return;
    }

    setIsConnecting(true);

    try {
      const response = await fetch("/api/v1/blooio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          phoneNumber,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Blooio connected! Now set up the webhook.");
        setApiKey("");
        setPhoneNumber("");
        void fetchStatus();
      } else {
        toast.error(data.error || "Failed to connect Blooio");
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
      const response = await fetch("/api/v1/blooio/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Blooio disconnected");
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

  const handleSaveSecret = async () => {
    if (isSavingSecret) return;
    if (!webhookSecret.trim()) {
      toast.error("Please enter the webhook signing secret");
      return;
    }

    setIsSavingSecret(true);

    try {
      const response = await fetch("/api/v1/blooio/webhook-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookSecret: webhookSecret.trim() }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Webhook secret saved!");
        setWebhookSecret("");
        void fetchStatus();
      } else {
        toast.error(data.error || "Failed to save webhook secret");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsSavingSecret(false);
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
              <MessageCircle className="h-5 w-5 text-green-500" />
              iMessage (Blooio)
            </CardTitle>
            <CardDescription>Connect iMessage for AI-powered text conversations</CardDescription>
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
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <Smartphone className="h-6 w-6 text-green-600" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">{status.phoneNumber}</div>
                <div className="text-sm text-muted-foreground">iMessage Connected via Blooio</div>
                {status.webhookConfigured && (
                  <Badge variant="outline" className="mt-1 text-xs">
                    Webhook Active
                  </Badge>
                )}
              </div>
            </div>

            {status.webhookUrl && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Step 1: Copy this webhook URL
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

            {status.webhookUrl && !status.hasWebhookSecret && (
              <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg space-y-3">
                <div>
                  <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400 mb-1">
                    Step 2: Create a webhook in Blooio
                  </p>
                  <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Go to Webhooks in your Blooio dashboard</li>
                    <li>Click &quot;Create Webhook&quot;</li>
                    <li>Paste the URL above</li>
                    <li>Copy the signing secret shown after creating</li>
                  </ol>
                </div>
                <div className="space-y-2 pt-2 border-t border-yellow-500/20">
                  <Label className="text-xs text-yellow-700 dark:text-yellow-400">
                    Step 3: Paste signing secret here
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder="whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      onClick={handleSaveSecret}
                      disabled={isSavingSecret || !webhookSecret.trim()}
                      size="sm"
                    >
                      {isSavingSecret ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {status.hasWebhookSecret && (
              <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                <p className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                  Your AI agent can now:
                </p>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>• Receive and respond to iMessages</li>
                  <li>• Send proactive messages to contacts</li>
                  <li>• Handle multi-turn conversations</li>
                  <li>• Process images and attachments</li>
                </ul>
              </div>
            )}

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
                    <AlertDialogTitle>Disconnect iMessage?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will stop your AI agent from receiving and sending iMessages. You can
                      reconnect at any time.
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
            <Collapsible open={showInstructions} onOpenChange={setShowInstructions}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between p-4 h-auto bg-muted">
                  <span className="font-medium">How to get Blooio credentials</span>
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
                      href="https://app.blooio.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-600 hover:underline inline-flex items-center gap-1"
                    >
                      app.blooio.com
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                  <li>Create an account and start a free trial</li>
                  <li>Go to Numbers section to get your Blooio number</li>
                  <li>Go to API Keys section and copy your API key</li>
                  <li>Enter the API key and phone number below</li>
                  <li>After connecting, you&apos;ll set up the webhook</li>
                </ol>
              </CollapsibleContent>
            </Collapsible>

            <div className="space-y-2">
              <Label htmlFor="blooioApiKey">Blooio API Key</Label>
              <Input
                id="blooioApiKey"
                type="password"
                placeholder="bloo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Get this from your Blooio dashboard</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="phoneNumber">Blooio Phone Number</Label>
              <Input
                id="phoneNumber"
                type="tel"
                placeholder="+1 (555) 123-4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The number Blooio generated for you (in Numbers section)
              </p>
            </div>

            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with iMessage:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Have AI conversations via text message</li>
                <li>• Receive real-time notifications</li>
                <li>• Send automated responses 24/7</li>
                <li>• Handle customer inquiries naturally</li>
              </ul>
            </div>

            <Button
              onClick={handleConnect}
              disabled={isConnecting || !apiKey.trim() || !phoneNumber.trim()}
              className="w-full bg-green-600 hover:bg-green-700"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Connecting...
                </>
              ) : (
                <>
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Connect iMessage
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
