"use client";

import {
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
import { ExternalLink, Loader2, MessageSquare, Phone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConnectionStatus } from "@/hooks/use-connection-status";

interface WhatsAppStatus {
  connected: boolean;
  configured?: boolean;
  businessPhone?: string;
  webhookUrl?: string;
  verifyToken?: string;
  error?: string;
}

export function WhatsAppConnection() {
  const {
    status,
    isLoading,
    refetch: fetchStatus,
  } = useConnectionStatus<WhatsAppStatus>(
    "/api/v1/whatsapp/status",
    "Failed to fetch WhatsApp status",
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

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
      <ConnectionCard
        name="WhatsApp Business"
        icon={<MessageSquare className="text-green-500" />}
        description="Connect WhatsApp Business for AI-powered automation"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="WhatsApp Business"
      icon={<MessageSquare className="text-green-500" />}
      description="Connect WhatsApp Business for AI-powered automation"
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Phone className="h-6 w-6 text-green-600" />}
            iconClassName="bg-green-100"
            title={status?.businessPhone || "WhatsApp Business"}
            subtitle="WhatsApp Business Connected"
          />

          {status?.webhookUrl && (
            <ConnectionCopyRow
              label="Webhook URL (configure in Meta App Dashboard)"
              value={status.webhookUrl}
              onCopied={() => toast.success("Webhook URL copied to clipboard")}
            />
          )}

          {status?.verifyToken && (
            <ConnectionCopyRow
              label="Verify Token (enter in Meta webhook configuration)"
              value={status.verifyToken}
              onCopied={() => toast.success("Verify token copied to clipboard")}
            />
          )}

          <ConnectionCallout title="Webhook Setup Instructions" tone="blue">
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>
                Go to{" "}
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#FF5800] hover:underline inline-flex items-center gap-1"
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
          </ConnectionCallout>

          <ConnectionCallout
            title="Your AI agent can now:"
            tone="green"
            items={[
              "Receive and respond to WhatsApp messages",
              "Handle customer inquiries automatically",
            ]}
          />

          <ConnectionFooterActions note="Messages are processed in real-time">
            <ConnectionDisconnectAction
              title="Disconnect WhatsApp?"
              description="This will stop your AI agent from receiving and sending WhatsApp messages. You can reconnect at any time."
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title="How to get WhatsApp Business API credentials"
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
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
              <li>
                Go to WhatsApp {">"} API Setup to find your Phone Number ID
              </li>
              <li>Go to Settings {">"} Basic to find your App Secret</li>
              <li>
                Create a permanent access token via Meta Business Settings {">"}{" "}
                System Users
              </li>
              <li>Enter the credentials below to connect</li>
            </ol>
          </ConnectionInstructions>

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
            <Label htmlFor="waBusinessPhone">
              Business Phone Number (optional)
            </Label>
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
          <div className="p-4 bg-muted rounded-sm">
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
              isConnecting ||
              !accessToken.trim() ||
              !phoneNumberId.trim() ||
              !appSecret.trim()
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
      }
    />
  );
}
