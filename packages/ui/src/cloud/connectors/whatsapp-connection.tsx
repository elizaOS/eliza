/**
 * WhatsApp Business cloud connector (token-credential + Meta webhook).
 *
 * Raw `fetch` connect/disconnect calls are swapped for the cloud {@link api}
 * client so the steward Bearer token is injected on native targets. The webhook
 * setup callout `tone="blue"` is fixed to neutral `tone="muted"` per brand rules.
 */

"use client";

import { ExternalLink, Loader2, MessageSquare, Phone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionCopyRow,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
} from "../../cloud-ui/components/connection-card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ApiError, api } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import { useConnectionStatus } from "./use-connection-status";

interface WhatsAppStatus {
  connected: boolean;
  configured?: boolean;
  businessPhone?: string;
  webhookUrl?: string;
  verifyToken?: string;
  error?: string;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body) {
      const apiError = (body as { error?: unknown }).error;
      if (typeof apiError === "string" && apiError) return apiError;
    }
    return error.message || fallback;
  }
  return fallback;
}

export function WhatsAppConnection() {
  const t = useCloudT();
  const {
    status,
    isLoading,
    refetch: fetchStatus,
  } = useConnectionStatus<WhatsAppStatus>(
    "/api/v1/whatsapp/status",
    t("cloud.whatsapp.statusFetchFailed", {
      defaultValue: "Failed to fetch WhatsApp status",
    }),
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
      toast.error(
        t("cloud.whatsapp.enterAccessToken", {
          defaultValue: "Please enter your access token",
        }),
      );
      return;
    }
    if (!phoneNumberId.trim()) {
      toast.error(
        t("cloud.whatsapp.enterPhoneNumberId", {
          defaultValue: "Please enter your Phone Number ID",
        }),
      );
      return;
    }
    if (!appSecret.trim()) {
      toast.error(
        t("cloud.whatsapp.enterAppSecret", {
          defaultValue: "Please enter your App Secret",
        }),
      );
      return;
    }

    setIsConnecting(true);

    try {
      const data = await api<{ success?: boolean; error?: string }>(
        "/api/v1/whatsapp/connect",
        {
          method: "POST",
          json: {
            accessToken,
            phoneNumberId,
            appSecret,
            businessPhone: businessPhone || undefined,
          },
        },
      );

      if (data.success) {
        toast.success(
          t("cloud.whatsapp.connected", {
            defaultValue:
              "WhatsApp connected! Now configure the webhook in Meta.",
          }),
        );
        setAccessToken("");
        setPhoneNumberId("");
        setAppSecret("");
        setBusinessPhone("");
        void fetchStatus();
      } else {
        toast.error(
          data.error ||
            t("cloud.whatsapp.connectFailed", {
              defaultValue: "Failed to connect WhatsApp",
            }),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? apiErrorMessage(
              error,
              t("cloud.whatsapp.connectFailed", {
                defaultValue: "Failed to connect WhatsApp",
              }),
            )
          : t("cloud.whatsapp.networkError", {
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
      await api("/api/v1/whatsapp/disconnect", { method: "DELETE" });
      toast.success(
        t("cloud.whatsapp.disconnected", {
          defaultValue: "WhatsApp disconnected",
        }),
      );
      void fetchStatus();
    } catch (error) {
      toast.error(
        apiErrorMessage(
          error,
          t("cloud.whatsapp.disconnectFailed", {
            defaultValue: "Failed to disconnect",
          }),
        ),
      );
    }

    setIsDisconnecting(false);
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.whatsapp.cardName", {
          defaultValue: "WhatsApp Business",
        })}
        icon={<MessageSquare className="text-green-500" />}
        description={t("cloud.whatsapp.cardDescription", {
          defaultValue: "Connect WhatsApp Business for AI-powered automation",
        })}
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name={t("cloud.whatsapp.cardName", {
        defaultValue: "WhatsApp Business",
      })}
      icon={<MessageSquare className="text-green-500" />}
      description={t("cloud.whatsapp.cardDescription", {
        defaultValue: "Connect WhatsApp Business for AI-powered automation",
      })}
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Phone className="h-6 w-6 text-green-600" />}
            iconClassName="bg-green-100"
            title={
              status?.businessPhone ||
              t("cloud.whatsapp.cardName", {
                defaultValue: "WhatsApp Business",
              })
            }
            subtitle={t("cloud.whatsapp.connectedSubtitle", {
              defaultValue: "WhatsApp Business Connected",
            })}
          />

          {status?.webhookUrl && (
            <ConnectionCopyRow
              label={t("cloud.whatsapp.webhookUrlLabel", {
                defaultValue: "Webhook URL (configure in Meta App Dashboard)",
              })}
              value={status.webhookUrl}
              onCopied={() =>
                toast.success(
                  t("cloud.whatsapp.webhookUrlCopied", {
                    defaultValue: "Webhook URL copied to clipboard",
                  }),
                )
              }
            />
          )}

          {status?.verifyToken && (
            <ConnectionCopyRow
              label={t("cloud.whatsapp.verifyTokenLabel", {
                defaultValue:
                  "Verify Token (enter in Meta webhook configuration)",
              })}
              value={status.verifyToken}
              onCopied={() =>
                toast.success(
                  t("cloud.whatsapp.verifyTokenCopied", {
                    defaultValue: "Verify token copied to clipboard",
                  }),
                )
              }
            />
          )}

          <ConnectionCallout
            title={t("cloud.whatsapp.webhookSetupTitle", {
              defaultValue: "Webhook Setup Instructions",
            })}
            tone="muted"
          >
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>
                {t("cloud.whatsapp.instructGoTo", { defaultValue: "Go to" })}{" "}
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline inline-flex items-center gap-1"
                >
                  {t("cloud.whatsapp.metaDashboard", {
                    defaultValue: "Meta App Dashboard",
                  })}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                {t("cloud.whatsapp.webhookStep2", {
                  defaultValue: "Navigate to WhatsApp > Configuration",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.webhookStep3", {
                  defaultValue: 'Click "Edit" on the Callback URL section',
                })}
              </li>
              <li>
                {t("cloud.whatsapp.webhookStep4", {
                  defaultValue:
                    "Paste the Webhook URL and Verify Token from above",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.webhookStep5", {
                  defaultValue: 'Subscribe to the "messages" webhook field',
                })}
              </li>
            </ol>
          </ConnectionCallout>

          <ConnectionCallout
            title={t("cloud.whatsapp.calloutTitle", {
              defaultValue: "Your AI agent can now:",
            })}
            tone="green"
            items={[
              t("cloud.whatsapp.calloutItem1", {
                defaultValue: "Receive and respond to WhatsApp messages",
              }),
              t("cloud.whatsapp.calloutItem2", {
                defaultValue: "Handle customer inquiries automatically",
              }),
            ]}
          />

          <ConnectionFooterActions
            note={t("cloud.whatsapp.realtimeNote", {
              defaultValue: "Messages are processed in real-time",
            })}
          >
            <ConnectionDisconnectAction
              title={t("cloud.whatsapp.disconnectTitle", {
                defaultValue: "Disconnect WhatsApp?",
              })}
              description={t("cloud.whatsapp.disconnectDescription", {
                defaultValue:
                  "This will stop your AI agent from receiving and sending WhatsApp messages. You can reconnect at any time.",
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
            title={t("cloud.whatsapp.instructionsTitle", {
              defaultValue: "How to get WhatsApp Business API credentials",
            })}
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                {t("cloud.whatsapp.instructGoTo", { defaultValue: "Go to" })}{" "}
                <a
                  href="https://developers.facebook.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-600 hover:underline inline-flex items-center gap-1"
                >
                  developers.facebook.com
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                {t("cloud.whatsapp.instructCreateApp", {
                  defaultValue: "and create a Meta Business App",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.instructAddProduct", {
                  defaultValue: "Add the WhatsApp product to your app",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.instructApiSetup", {
                  defaultValue:
                    "Go to WhatsApp > API Setup to find your Phone Number ID",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.instructAppSecret", {
                  defaultValue:
                    "Go to Settings > Basic to find your App Secret",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.instructAccessToken", {
                  defaultValue:
                    "Create a permanent access token via Meta Business Settings > System Users",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.instructEnterBelow", {
                  defaultValue: "Enter the credentials below to connect",
                })}
              </li>
            </ol>
          </ConnectionInstructions>

          {/* Credential fields */}
          <div className="space-y-2">
            <Label htmlFor="waAccessToken">
              {t("cloud.whatsapp.accessTokenLabel", {
                defaultValue: "Access Token",
              })}
            </Label>
            <Input
              id="waAccessToken"
              type="password"
              placeholder="EAAxxxxxxxxxxxxxxxxxxxxxxxx"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.whatsapp.accessTokenHint", {
                defaultValue:
                  "Permanent access token from Meta Business Settings",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="waPhoneNumberId">
              {t("cloud.whatsapp.phoneNumberIdLabel", {
                defaultValue: "Phone Number ID",
              })}
            </Label>
            <Input
              id="waPhoneNumberId"
              type="text"
              placeholder="123456789012345"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.whatsapp.phoneNumberIdHint", {
                defaultValue:
                  "Found in Meta App Dashboard under WhatsApp > API Setup",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="waAppSecret">
              {t("cloud.whatsapp.appSecretLabel", {
                defaultValue: "App Secret",
              })}
            </Label>
            <Input
              id="waAppSecret"
              type="password"
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.whatsapp.appSecretHint", {
                defaultValue:
                  "Found in Meta App Dashboard under Settings > Basic",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="waBusinessPhone">
              {t("cloud.whatsapp.businessPhoneLabel", {
                defaultValue: "Business Phone Number (optional)",
              })}
            </Label>
            <Input
              id="waBusinessPhone"
              type="tel"
              placeholder="+1 (555) 123-4567"
              value={businessPhone}
              onChange={(e) => setBusinessPhone(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.whatsapp.businessPhoneHint", {
                defaultValue:
                  "Your WhatsApp Business phone number (for display)",
              })}
            </p>
          </div>

          {/* Capabilities preview */}
          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">
              {t("cloud.whatsapp.whatYouCanDo", {
                defaultValue: "What you can do with WhatsApp:",
              })}
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                {t("cloud.whatsapp.capability1", {
                  defaultValue: "• Have AI conversations via WhatsApp",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.capability2", {
                  defaultValue: "• Receive real-time customer messages",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.capability3", {
                  defaultValue: "• Send automated responses 24/7",
                })}
              </li>
              <li>
                {t("cloud.whatsapp.capability4", {
                  defaultValue: "• Handle inquiries naturally",
                })}
              </li>
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
                {t("cloud.whatsapp.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                {t("cloud.whatsapp.connectButton", {
                  defaultValue: "Connect WhatsApp",
                })}
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
