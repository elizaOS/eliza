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
  ConnectionInstructions,
  Input,
  Label,
} from "@elizaos/ui";
import { ExternalLink, Loader2, MessageSquare, Phone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConnectionStatus } from "@/hooks/use-connection-status";

interface TwilioStatus {
  connected: boolean;
  phoneNumber?: string;
  accountSid?: string;
  webhookConfigured?: boolean;
  error?: string;
}

export function TwilioConnection() {
  const {
    status,
    isLoading,
    refetch: fetchStatus,
  } = useConnectionStatus<TwilioStatus>(
    "/api/v1/twilio/status",
    "Failed to fetch Twilio status",
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

  const handleConnect = async () => {
    if (isConnecting) return;
    if (!accountSid.trim()) {
      toast.error("Please enter your Twilio Account SID");
      return;
    }
    if (!authToken.trim()) {
      toast.error("Please enter your Twilio Auth Token");
      return;
    }
    if (!phoneNumber.trim()) {
      toast.error("Please enter your Twilio phone number");
      return;
    }

    setIsConnecting(true);

    try {
      const response = await fetch("/api/v1/twilio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountSid, authToken, phoneNumber }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Twilio SMS/Voice connected successfully!");
        setAccountSid("");
        setAuthToken("");
        setPhoneNumber("");
        fetchStatus();
      } else {
        toast.error(data.error || "Failed to connect Twilio");
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
      const response = await fetch("/api/v1/twilio/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Twilio disconnected");
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

  if (isLoading) {
    return (
      <ConnectionCard
        name="Twilio SMS & Voice"
        icon={<Phone className="text-red-500" />}
        description="Connect Twilio for SMS, MMS, and voice call automation"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="Twilio SMS & Voice"
      icon={<Phone className="text-red-500" />}
      description="Connect Twilio for SMS, MMS, and voice call automation"
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Phone className="h-6 w-6 text-red-600" />}
            iconClassName="bg-red-100"
            title={status?.phoneNumber}
            subtitle="Twilio Number Connected"
          >
            {status?.webhookConfigured && (
              <Badge variant="outline" className="mt-1 text-xs">
                Webhook Active
              </Badge>
            )}
          </ConnectionIdentityPanel>

          <ConnectionCallout
            title="Your AI agent can now:"
            tone="red"
            items={[
              "Send and receive SMS messages",
              "Handle MMS with images",
              "Make and receive voice calls",
              "Build conversational IVR systems",
            ]}
          />

          <ConnectionFooterActions
            note={`Account: ${status?.accountSid?.slice(0, 8) ?? ""}...`}
          >
            <ConnectionDisconnectAction
              title="Disconnect Twilio?"
              description="This will stop your AI agent from sending and receiving SMS/Voice calls. You can reconnect at any time."
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title="How to get Twilio credentials"
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                Go to{" "}
                <a
                  href="https://console.twilio.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-red-600 hover:underline inline-flex items-center gap-1"
                >
                  Twilio Console
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>Create an account or sign in</li>
              <li>Copy your Account SID and Auth Token from the dashboard</li>
              <li>Buy or use an existing phone number</li>
              <li>Enter your credentials below</li>
            </ol>
          </ConnectionInstructions>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="accountSid">Account SID</Label>
              <Input
                id="accountSid"
                type="text"
                placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="authToken">Auth Token</Label>
              <Input
                id="authToken"
                type="password"
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Found in your Twilio Console dashboard
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="twilioPhoneNumber">Twilio Phone Number</Label>
              <Input
                id="twilioPhoneNumber"
                type="tel"
                placeholder="+1 (555) 123-4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Your Twilio phone number with SMS capability
              </p>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">What you can do with Twilio:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Send and receive SMS/MMS messages</li>
              <li>• Create voice call automations</li>
              <li>• Build two-factor authentication</li>
              <li>• Handle customer support via text</li>
            </ul>
          </div>

          <Button
            onClick={handleConnect}
            disabled={
              isConnecting ||
              !accountSid.trim() ||
              !authToken.trim() ||
              !phoneNumber.trim()
            }
            className="w-full bg-red-600 hover:bg-red-700"
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Connecting...
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                Connect Twilio
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
