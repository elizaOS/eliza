"use client";

import {
  Badge,
  Button,
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionCopyRow,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
  Input,
  Label,
} from "@elizaos/ui";
import { ExternalLink, Loader2, MessageCircle, Smartphone } from "lucide-react";
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
      <ConnectionCard
        name="iMessage (Blooio)"
        icon={<MessageCircle className="text-green-500" />}
        description="Connect iMessage for AI-powered text conversations"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="iMessage (Blooio)"
      icon={<MessageCircle className="text-green-500" />}
      description="Connect iMessage for AI-powered text conversations"
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Smartphone className="h-6 w-6 text-green-600" />}
            iconClassName="bg-green-100"
            title={status?.phoneNumber}
            subtitle="iMessage Connected via Blooio"
          >
            {status?.webhookConfigured && (
              <Badge variant="outline" className="mt-1 text-xs">
                Webhook Active
              </Badge>
            )}
          </ConnectionIdentityPanel>

          {status?.webhookUrl && (
            <ConnectionCopyRow
              label="Step 1: Copy this webhook URL"
              value={status.webhookUrl}
              onCopied={() => toast.success("Webhook URL copied to clipboard")}
            />
          )}

          {status?.webhookUrl && !status.hasWebhookSecret && (
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
                    {isSavingSecret ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {status?.hasWebhookSecret && (
            <ConnectionCallout
              title="Your AI agent can now:"
              tone="green"
              items={[
                "Receive and respond to iMessages",
                "Send proactive messages to contacts",
                "Handle multi-turn conversations",
                "Process images and attachments",
              ]}
            />
          )}

          <ConnectionFooterActions note="Messages are processed in real-time">
            <ConnectionDisconnectAction
              title="Disconnect iMessage?"
              description="This will stop your AI agent from receiving and sending iMessages. You can reconnect at any time."
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title="How to get Blooio credentials"
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
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
          </ConnectionInstructions>

          <div className="space-y-2">
            <Label htmlFor="blooioApiKey">Blooio API Key</Label>
            <Input
              id="blooioApiKey"
              type="password"
              placeholder="bloo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Get this from your Blooio dashboard
            </p>
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
      }
    />
  );
}
