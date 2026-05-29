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
import { useState } from "react";
import { toast } from "sonner";
import { useConnectionStatus } from "@/hooks/use-connection-status";
import { useT } from "@/providers/I18nProvider";

interface BlooioStatus {
  connected: boolean;
  phoneNumber?: string;
  webhookConfigured?: boolean;
  webhookUrl?: string;
  hasWebhookSecret?: boolean;
  error?: string;
}

export function BlooioConnection() {
  const t = useT();
  const {
    status,
    isLoading,
    refetch: fetchStatus,
  } = useConnectionStatus<BlooioStatus>(
    "/api/v1/blooio/status",
    t("cloud.blooio.statusFetchFailed", {
      defaultValue: "Failed to fetch Blooio status",
    }),
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [isSavingSecret, setIsSavingSecret] = useState(false);

  const handleConnect = async () => {
    if (isConnecting) return;
    if (!apiKey.trim()) {
      toast.error(
        t("cloud.blooio.enterApiKey", {
          defaultValue: "Please enter your Blooio API key",
        }),
      );
      return;
    }
    if (!phoneNumber.trim()) {
      toast.error(
        t("cloud.blooio.enterPhoneNumber", {
          defaultValue: "Please enter your iMessage phone number",
        }),
      );
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
        toast.success(
          t("cloud.blooio.connected", {
            defaultValue: "Blooio connected! Now set up the webhook.",
          }),
        );
        setApiKey("");
        setPhoneNumber("");
        void fetchStatus();
      } else {
        toast.error(
          data.error ||
            t("cloud.blooio.connectFailed", {
              defaultValue: "Failed to connect Blooio",
            }),
        );
      }
    } catch {
      toast.error(
        t("cloud.blooio.networkError", {
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
      const response = await fetch("/api/v1/blooio/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success(
          t("cloud.blooio.disconnected", {
            defaultValue: "Blooio disconnected",
          }),
        );
        void fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(
          data.error ||
            t("cloud.blooio.disconnectFailed", {
              defaultValue: "Failed to disconnect",
            }),
        );
      }
    } catch {
      toast.error(
        t("cloud.blooio.networkError", {
          defaultValue: "Network error. Please check your connection.",
        }),
      );
    }

    setIsDisconnecting(false);
  };

  const handleSaveSecret = async () => {
    if (isSavingSecret) return;
    if (!webhookSecret.trim()) {
      toast.error(
        t("cloud.blooio.enterWebhookSecret", {
          defaultValue: "Please enter the webhook signing secret",
        }),
      );
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
        toast.success(
          t("cloud.blooio.webhookSecretSaved", {
            defaultValue: "Webhook secret saved!",
          }),
        );
        setWebhookSecret("");
        void fetchStatus();
      } else {
        toast.error(
          data.error ||
            t("cloud.blooio.saveSecretFailed", {
              defaultValue: "Failed to save webhook secret",
            }),
        );
      }
    } catch {
      toast.error(
        t("cloud.blooio.networkError", {
          defaultValue: "Network error. Please check your connection.",
        }),
      );
    }

    setIsSavingSecret(false);
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.blooio.cardName", {
          defaultValue: "iMessage (Blooio)",
        })}
        icon={<MessageCircle className="text-green-500" />}
        description={t("cloud.blooio.cardDescription", {
          defaultValue: "Connect iMessage for AI-powered text conversations",
        })}
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name={t("cloud.blooio.cardName", { defaultValue: "iMessage (Blooio)" })}
      icon={<MessageCircle className="text-green-500" />}
      description={t("cloud.blooio.cardDescription", {
        defaultValue: "Connect iMessage for AI-powered text conversations",
      })}
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Smartphone className="h-6 w-6 text-green-600" />}
            iconClassName="bg-green-100"
            title={status?.phoneNumber}
            subtitle={t("cloud.blooio.connectedVia", {
              defaultValue: "iMessage Connected via Blooio",
            })}
          >
            {status?.webhookConfigured && (
              <Badge variant="outline" className="mt-1 text-xs">
                {t("cloud.blooio.webhookActive", {
                  defaultValue: "Webhook Active",
                })}
              </Badge>
            )}
          </ConnectionIdentityPanel>

          {status?.webhookUrl && (
            <ConnectionCopyRow
              label={t("cloud.blooio.step1Copy", {
                defaultValue: "Step 1: Copy this webhook URL",
              })}
              value={status.webhookUrl}
              onCopied={() =>
                toast.success(
                  t("cloud.blooio.webhookUrlCopied", {
                    defaultValue: "Webhook URL copied to clipboard",
                  }),
                )
              }
            />
          )}

          {status?.webhookUrl && !status.hasWebhookSecret && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-sm space-y-3">
              <div>
                <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400 mb-1">
                  {t("cloud.blooio.step2Title", {
                    defaultValue: "Step 2: Create a webhook in Blooio",
                  })}
                </p>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>
                    {t("cloud.blooio.step2Item1", {
                      defaultValue: "Go to Webhooks in your Blooio dashboard",
                    })}
                  </li>
                  <li>
                    {t("cloud.blooio.step2Item2", {
                      defaultValue: 'Click "Create Webhook"',
                    })}
                  </li>
                  <li>
                    {t("cloud.blooio.step2Item3", {
                      defaultValue: "Paste the URL above",
                    })}
                  </li>
                  <li>
                    {t("cloud.blooio.step2Item4", {
                      defaultValue:
                        "Copy the signing secret shown after creating",
                    })}
                  </li>
                </ol>
              </div>
              <div className="space-y-2 pt-2 border-t border-yellow-500/20">
                <Label className="text-xs text-yellow-700 dark:text-yellow-400">
                  {t("cloud.blooio.step3Label", {
                    defaultValue: "Step 3: Paste signing secret here",
                  })}
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
                      t("cloud.blooio.save", { defaultValue: "Save" })
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {status?.hasWebhookSecret && (
            <ConnectionCallout
              title={t("cloud.blooio.calloutTitle", {
                defaultValue: "Your AI agent can now:",
              })}
              tone="green"
              items={[
                t("cloud.blooio.calloutItem1", {
                  defaultValue: "Receive and respond to iMessages",
                }),
                t("cloud.blooio.calloutItem2", {
                  defaultValue: "Send proactive messages to contacts",
                }),
                t("cloud.blooio.calloutItem3", {
                  defaultValue: "Handle multi-turn conversations",
                }),
                t("cloud.blooio.calloutItem4", {
                  defaultValue: "Process images and attachments",
                }),
              ]}
            />
          )}

          <ConnectionFooterActions
            note={t("cloud.blooio.realtimeNote", {
              defaultValue: "Messages are processed in real-time",
            })}
          >
            <ConnectionDisconnectAction
              title={t("cloud.blooio.disconnectTitle", {
                defaultValue: "Disconnect iMessage?",
              })}
              description={t("cloud.blooio.disconnectDescription", {
                defaultValue:
                  "This will stop your AI agent from receiving and sending iMessages. You can reconnect at any time.",
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
            title={t("cloud.blooio.instructionsTitle", {
              defaultValue: "How to get Blooio credentials",
            })}
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                {t("cloud.blooio.instructGoTo", { defaultValue: "Go to" })}{" "}
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
              <li>
                {t("cloud.blooio.instructCreateAccount", {
                  defaultValue: "Create an account and start a free trial",
                })}
              </li>
              <li>
                {t("cloud.blooio.instructNumbers", {
                  defaultValue:
                    "Go to Numbers section to get your Blooio number",
                })}
              </li>
              <li>
                {t("cloud.blooio.instructApiKeys", {
                  defaultValue: "Go to API Keys section and copy your API key",
                })}
              </li>
              <li>
                {t("cloud.blooio.instructEnterBelow", {
                  defaultValue: "Enter the API key and phone number below",
                })}
              </li>
              <li>
                {t("cloud.blooio.instructWebhook", {
                  defaultValue: "After connecting, you'll set up the webhook",
                })}
              </li>
            </ol>
          </ConnectionInstructions>

          <div className="space-y-2">
            <Label htmlFor="blooioApiKey">
              {t("cloud.blooio.apiKeyLabel", {
                defaultValue: "Blooio API Key",
              })}
            </Label>
            <Input
              id="blooioApiKey"
              type="password"
              placeholder="bloo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.blooio.apiKeyHint", {
                defaultValue: "Get this from your Blooio dashboard",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneNumber">
              {t("cloud.blooio.phoneLabel", {
                defaultValue: "Blooio Phone Number",
              })}
            </Label>
            <Input
              id="phoneNumber"
              type="tel"
              placeholder="+1 (555) 123-4567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.blooio.phoneHint", {
                defaultValue:
                  "The number Blooio generated for you (in Numbers section)",
              })}
            </p>
          </div>

          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">
              {t("cloud.blooio.whatYouCanDo", {
                defaultValue: "What you can do with iMessage:",
              })}
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                {t("cloud.blooio.capability1", {
                  defaultValue: "• Have AI conversations via text message",
                })}
              </li>
              <li>
                {t("cloud.blooio.capability2", {
                  defaultValue: "• Receive real-time notifications",
                })}
              </li>
              <li>
                {t("cloud.blooio.capability3", {
                  defaultValue: "• Send automated responses 24/7",
                })}
              </li>
              <li>
                {t("cloud.blooio.capability4", {
                  defaultValue: "• Handle customer inquiries naturally",
                })}
              </li>
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
                {t("cloud.blooio.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <MessageCircle className="h-4 w-4 mr-2" />
                {t("cloud.blooio.connectButton", {
                  defaultValue: "Connect iMessage",
                })}
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
