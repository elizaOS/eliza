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
import { useT } from "@/providers/I18nProvider";

interface TwilioStatus {
  connected: boolean;
  phoneNumber?: string;
  accountSid?: string;
  webhookConfigured?: boolean;
  error?: string;
}

export function TwilioConnection() {
  const t = useT();
  const {
    status,
    isLoading,
    refetch: fetchStatus,
  } = useConnectionStatus<TwilioStatus>(
    "/api/v1/twilio/status",
    t("cloud.twilio.statusFetchFailed", {
      defaultValue: "Failed to fetch Twilio status",
    }),
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
      toast.error(
        t("cloud.twilio.enterAccountSid", {
          defaultValue: "Please enter your Twilio Account SID",
        }),
      );
      return;
    }
    if (!authToken.trim()) {
      toast.error(
        t("cloud.twilio.enterAuthToken", {
          defaultValue: "Please enter your Twilio Auth Token",
        }),
      );
      return;
    }
    if (!phoneNumber.trim()) {
      toast.error(
        t("cloud.twilio.enterPhoneNumber", {
          defaultValue: "Please enter your Twilio phone number",
        }),
      );
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
        toast.success(
          t("cloud.twilio.connected", {
            defaultValue: "Twilio SMS/Voice connected successfully!",
          }),
        );
        setAccountSid("");
        setAuthToken("");
        setPhoneNumber("");
        fetchStatus();
      } else {
        toast.error(
          data.error ||
            t("cloud.twilio.connectFailed", {
              defaultValue: "Failed to connect Twilio",
            }),
        );
      }
    } catch {
      toast.error(
        t("cloud.twilio.networkError", {
          defaultValue: "Network error. Please check your connection.",
        }),
      );
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
        toast.success(
          t("cloud.twilio.disconnected", {
            defaultValue: "Twilio disconnected",
          }),
        );
        fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(
          data.error ||
            t("cloud.twilio.disconnectFailed", {
              defaultValue: "Failed to disconnect",
            }),
        );
      }
    } catch {
      toast.error(
        t("cloud.twilio.networkError", {
          defaultValue: "Network error. Please check your connection.",
        }),
      );
    }

    setIsDisconnecting(false);
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.twilio.cardName", {
          defaultValue: "Twilio SMS & Voice",
        })}
        icon={<Phone className="text-red-500" />}
        description={t("cloud.twilio.cardDescription", {
          defaultValue:
            "Connect Twilio for SMS, MMS, and voice call automation",
        })}
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name={t("cloud.twilio.cardName", { defaultValue: "Twilio SMS & Voice" })}
      icon={<Phone className="text-red-500" />}
      description={t("cloud.twilio.cardDescription", {
        defaultValue: "Connect Twilio for SMS, MMS, and voice call automation",
      })}
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Phone className="h-6 w-6 text-red-600" />}
            iconClassName="bg-red-100"
            title={status?.phoneNumber}
            subtitle={t("cloud.twilio.connectedSubtitle", {
              defaultValue: "Twilio Number Connected",
            })}
          >
            {status?.webhookConfigured && (
              <Badge variant="outline" className="mt-1 text-xs">
                {t("cloud.twilio.webhookActive", {
                  defaultValue: "Webhook Active",
                })}
              </Badge>
            )}
          </ConnectionIdentityPanel>

          <ConnectionCallout
            title={t("cloud.twilio.calloutTitle", {
              defaultValue: "Your AI agent can now:",
            })}
            tone="red"
            items={[
              t("cloud.twilio.calloutItem1", {
                defaultValue: "Send and receive SMS messages",
              }),
              t("cloud.twilio.calloutItem2", {
                defaultValue: "Handle MMS with images",
              }),
              t("cloud.twilio.calloutItem3", {
                defaultValue: "Make and receive voice calls",
              }),
              t("cloud.twilio.calloutItem4", {
                defaultValue: "Build conversational IVR systems",
              }),
            ]}
          />

          <ConnectionFooterActions
            note={t("cloud.twilio.accountNote", {
              account: status?.accountSid?.slice(0, 8) ?? "",
              defaultValue: "Account: {{account}}...",
            })}
          >
            <ConnectionDisconnectAction
              title={t("cloud.twilio.disconnectTitle", {
                defaultValue: "Disconnect Twilio?",
              })}
              description={t("cloud.twilio.disconnectDescription", {
                defaultValue:
                  "This will stop your AI agent from sending and receiving SMS/Voice calls. You can reconnect at any time.",
              })}
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title={t("cloud.twilio.instructionsTitle", {
              defaultValue: "How to get Twilio credentials",
            })}
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                {t("cloud.twilio.instructGoTo", { defaultValue: "Go to" })}{" "}
                <a
                  href="https://console.twilio.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-red-600 hover:underline inline-flex items-center gap-1"
                >
                  {t("cloud.twilio.console", {
                    defaultValue: "Twilio Console",
                  })}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                {t("cloud.twilio.instructSignIn", {
                  defaultValue: "Create an account or sign in",
                })}
              </li>
              <li>
                {t("cloud.twilio.instructCopyCreds", {
                  defaultValue:
                    "Copy your Account SID and Auth Token from the dashboard",
                })}
              </li>
              <li>
                {t("cloud.twilio.instructBuyNumber", {
                  defaultValue: "Buy or use an existing phone number",
                })}
              </li>
              <li>
                {t("cloud.twilio.instructEnterBelow", {
                  defaultValue: "Enter your credentials below",
                })}
              </li>
            </ol>
          </ConnectionInstructions>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="accountSid">
                {t("cloud.twilio.accountSidLabel", {
                  defaultValue: "Account SID",
                })}
              </Label>
              <Input
                id="accountSid"
                type="text"
                placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="authToken">
                {t("cloud.twilio.authTokenLabel", {
                  defaultValue: "Auth Token",
                })}
              </Label>
              <Input
                id="authToken"
                type="password"
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("cloud.twilio.authTokenHint", {
                  defaultValue: "Found in your Twilio Console dashboard",
                })}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="twilioPhoneNumber">
                {t("cloud.twilio.phoneLabel", {
                  defaultValue: "Twilio Phone Number",
                })}
              </Label>
              <Input
                id="twilioPhoneNumber"
                type="tel"
                placeholder="+1 (555) 123-4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("cloud.twilio.phoneHint", {
                  defaultValue: "Your Twilio phone number with SMS capability",
                })}
              </p>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">
              {t("cloud.twilio.whatYouCanDo", {
                defaultValue: "What you can do with Twilio:",
              })}
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                {t("cloud.twilio.capability1", {
                  defaultValue: "• Send and receive SMS/MMS messages",
                })}
              </li>
              <li>
                {t("cloud.twilio.capability2", {
                  defaultValue: "• Create voice call automations",
                })}
              </li>
              <li>
                {t("cloud.twilio.capability3", {
                  defaultValue: "• Build two-factor authentication",
                })}
              </li>
              <li>
                {t("cloud.twilio.capability4", {
                  defaultValue: "• Handle customer support via text",
                })}
              </li>
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
                {t("cloud.twilio.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                {t("cloud.twilio.connectButton", {
                  defaultValue: "Connect Twilio",
                })}
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
