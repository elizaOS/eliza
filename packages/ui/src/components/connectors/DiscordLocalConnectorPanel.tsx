/**
 * Setup panel for the locally-hosted Discord connector: reads bridge status and
 * the bot's guilds/channels via the API client and lets the owner pick the
 * guild + channel the agent listens on.
 */

import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { useAppSelector } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { CodeBlock } from "../ui/code-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type DiscordLocalStatus = Awaited<
  ReturnType<typeof client.getDiscordLocalStatus>
>;
type DiscordLocalGuild = Awaited<
  ReturnType<typeof client.listDiscordLocalGuilds>
>["guilds"][number];
type DiscordLocalChannel = Awaited<
  ReturnType<typeof client.listDiscordLocalChannels>
>["channels"][number];

const DISCORD_TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15, 16]);

function isTextLikeChannel(channel: DiscordLocalChannel): boolean {
  if (typeof channel.type !== "number") {
    return true;
  }
  return DISCORD_TEXT_CHANNEL_TYPES.has(channel.type);
}

function channelLabel(channel: DiscordLocalChannel): string {
  if (typeof channel.name === "string" && channel.name.trim().length > 0) {
    return `#${channel.name.trim()}`;
  }
  if (Array.isArray(channel.recipients) && channel.recipients.length > 0) {
    return channel.recipients
      .map(
        (recipient) =>
          recipient.global_name?.trim() ||
          recipient.username?.trim() ||
          recipient.id,
      )
      .join(", ");
  }
  return channel.id;
}

function currentUserLabel(status: DiscordLocalStatus | null): string | null {
  const currentUser = status?.currentUser;
  if (!currentUser) {
    return null;
  }
  return (
    currentUser.global_name?.trim() || currentUser.username?.trim() || null
  );
}

function selectedChannelIdsFromStatus(status: DiscordLocalStatus): string[] {
  return status.subscribedChannelIds.length > 0
    ? status.subscribedChannelIds
    : status.configuredChannelIds;
}

export function DiscordLocalConnectorPanel() {
  const t = useAppSelector((s) => s.t);
  const [status, setStatus] = useState<DiscordLocalStatus | null>(null);
  const [guilds, setGuilds] = useState<DiscordLocalGuild[]>([]);
  const [channels, setChannels] = useState<DiscordLocalChannel[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingGuilds, setLoadingGuilds] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const applyStatus = useCallback((nextStatus: DiscordLocalStatus) => {
    setStatus(nextStatus);
    setSelectedChannelIds(selectedChannelIdsFromStatus(nextStatus));
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      applyStatus(await client.getDiscordLocalStatus());
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setLoadingStatus(false);
    }
  }, [applyStatus]);

  const loadGuilds = useCallback(async () => {
    setLoadingGuilds(true);
    setError(null);
    try {
      const response = await client.listDiscordLocalGuilds();
      setGuilds(response.guilds);
      setSelectedGuildId((current) => {
        if (current && response.guilds.some((guild) => guild.id === current)) {
          return current;
        }
        return response.guilds[0]?.id ?? "";
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      setGuilds([]);
      setSelectedGuildId("");
    } finally {
      setLoadingGuilds(false);
    }
  }, []);

  const loadChannels = useCallback(async (guildId: string) => {
    if (!guildId) {
      setChannels([]);
      return;
    }
    setLoadingChannels(true);
    setError(null);
    try {
      const response = await client.listDiscordLocalChannels(guildId);
      setChannels(response.channels.filter(isTextLikeChannel));
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      setChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return client.onWsEvent("ws-reconnected", () => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  useEffect(() => {
    if (!status?.authenticated) {
      setGuilds([]);
      setChannels([]);
      setSelectedGuildId("");
      return;
    }
    void loadGuilds();
  }, [loadGuilds, status?.authenticated]);

  useEffect(() => {
    if (!status?.authenticated || !selectedGuildId) {
      setChannels([]);
      return;
    }
    void loadChannels(selectedGuildId);
  }, [loadChannels, selectedGuildId, status?.authenticated]);

  const toggleChannel = useCallback((channelId: string) => {
    setSelectedChannelIds((current) =>
      current.includes(channelId)
        ? current.filter((entry) => entry !== channelId)
        : [...current, channelId],
    );
    setSaveMessage(null);
  }, []);

  const handleAuthorize = useCallback(async () => {
    setAuthorizing(true);
    setError(null);
    setSaveMessage(null);
    try {
      applyStatus(await client.authorizeDiscordLocal());
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setAuthorizing(false);
    }
  }, [applyStatus]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    setError(null);
    setSaveMessage(null);
    try {
      await client.disconnectDiscordLocal();
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setDisconnecting(false);
    }
  }, [refreshStatus]);

  const handleSaveSubscriptions = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const response =
        await client.saveDiscordLocalSubscriptions(selectedChannelIds);
      setStatus((current) =>
        current
          ? {
              ...current,
              subscribedChannelIds: response.subscribedChannelIds,
              configuredChannelIds: response.subscribedChannelIds,
            }
          : current,
      );
      setSelectedChannelIds(response.subscribedChannelIds);
      setSaveMessage(
        t("pluginsview.DiscordLocalSubscriptionsSaved", {
          defaultValue: "Channel subscriptions saved.",
        }),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setSaving(false);
    }
  }, [selectedChannelIds, t]);
  const connectedUser = currentUserLabel(status);

  return (
    <PagePanel.Notice
      tone={error ? "danger" : status?.authenticated ? "accent" : "default"}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refreshStatus();
            }}
            disabled={loadingStatus}
          >
            {loadingStatus
              ? t("common.loading", { defaultValue: "Loading…" })
              : t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
          {status?.authenticated ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleDisconnect();
              }}
              disabled={disconnecting}
            >
              {disconnecting
                ? t("common.disconnecting", {
                    defaultValue: "Disconnecting…",
                  })
                : t("common.disconnect")}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void handleAuthorize();
              }}
              disabled={authorizing || !status?.available}
            >
              {authorizing
                ? t("pluginsview.DiscordLocalAuthorizing", {
                    defaultValue: "Authorizing…",
                  })
                : t("pluginsview.DiscordLocalAuthorize", {
                    defaultValue: "Authorize Discord desktop",
                  })}
            </Button>
          )}
        </>
      }
    >
      {/* Single dense copy block on the left; actions sit on the right via
          PagePanel.Notice. No extra title that duplicates the primary button. */}
      <div className="space-y-1 text-xs">
        <div className="font-medium leading-snug text-txt">
          {status?.authenticated
            ? t("pluginsview.DiscordLocalAuthorized", {
                defaultValue: "Discord desktop is authorized.",
              })
            : t("pluginsview.DiscordLocalAuthorizePrompt", {
                defaultValue:
                  "Authorize Eliza against the local Discord desktop app to read notifications, subscribe to channels, and send replies through macOS UI automation.",
              })}
        </div>
        {connectedUser ? (
          <CodeBlock variant="inline" tone="muted" value={connectedUser} />
        ) : null}
        {status?.ipcPath ? (
          <div className="text-muted">
            {t("pluginsview.DiscordLocalIpcPath", {
              defaultValue: "Discord IPC socket",
            })}
            :{" "}
            <code className="text-xs-tight text-muted-strong">
              {status.ipcPath}
            </code>
          </div>
        ) : null}
        {status?.lastError ? (
          <div className="text-danger">{status.lastError}</div>
        ) : null}
        {error ? <div className="text-danger">{error}</div> : null}
        {saveMessage ? <div className="text-ok">{saveMessage}</div> : null}
        {!status?.available ? (
          <div className="text-muted">
            {t("pluginsview.DiscordLocalUnavailable", {
              defaultValue:
                "Save the local Discord client ID and client secret, enable the connector, and keep the Discord desktop app running on this device.",
            })}
          </div>
        ) : null}

        {status?.authenticated ? (
          <Card variant="connectorPanel" stack="compact" padding="default">
            <div className="text-muted">
              {t("pluginsview.DiscordLocalSubscriptionsHint", {
                defaultValue:
                  "Select guild text channels to ingest directly. Direct-message notifications still flow through Discord RPC even without a subscribed channel list.",
              })}
            </div>
            {guilds.length > 0 ? (
              <div className="space-y-1">
                <span className="font-medium text-txt">
                  {t("common.server", {
                    defaultValue: "Server",
                  })}
                </span>
                <Select
                  value={selectedGuildId}
                  disabled={loadingGuilds}
                  onValueChange={setSelectedGuildId}
                >
                  <SelectTrigger
                    aria-label={t("common.server", {
                      defaultValue: "Server",
                    })}
                    variant="connectorLocal"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {guilds.map((guild) => (
                      <SelectItem key={guild.id} value={guild.id}>
                        {guild.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : loadingGuilds ? (
              <div className="text-muted">
                {t("pluginsview.DiscordLocalLoadingGuilds", {
                  defaultValue: "Loading Discord servers…",
                })}
              </div>
            ) : (
              <div className="text-muted">
                {t("pluginsview.DiscordLocalNoGuilds", {
                  defaultValue:
                    "No guilds were returned by the local Discord session.",
                })}
              </div>
            )}

            {selectedGuildId ? (
              <div className="space-y-2">
                <div className="font-medium text-txt">
                  {t("pluginsview.DiscordLocalChannels", {
                    defaultValue: "Subscribed channels",
                  })}
                </div>
                {loadingChannels ? (
                  <div className="text-muted">
                    {t("pluginsview.DiscordLocalLoadingChannels", {
                      defaultValue: "Loading channels…",
                    })}
                  </div>
                ) : channels.length > 0 ? (
                  <Card
                    variant="transparentSquare"
                    border="subtle"
                    surface="transparent"
                    stack="compact"
                    className="max-h-56 overflow-y-auto py-2"
                  >
                    {channels.map((channel) => {
                      const checked = selectedChannelIds.includes(channel.id);
                      return (
                        <Card
                          key={channel.id}
                          variant="vaultListRow"
                          flow="row"
                          gap="default"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggleChannel(channel.id)}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-txt">
                            {channelLabel(channel)}
                          </span>
                        </Card>
                      );
                    })}
                  </Card>
                ) : (
                  <div className="text-muted">
                    {t("pluginsview.DiscordLocalNoChannels", {
                      defaultValue:
                        "No text channels were returned for the selected server.",
                    })}
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-muted">
                    {t("pluginsview.DiscordLocalSelectedCount", {
                      count: selectedChannelIds.length,
                      defaultValue: "{{count}} selected",
                    })}
                  </span>
                  <Button
                    variant="default"
                    size="sm"
                    className="shrink-0 sm:self-end"
                    onClick={() => {
                      void handleSaveSubscriptions();
                    }}
                    disabled={saving}
                  >
                    {saving
                      ? t("common.saving", { defaultValue: "Saving..." })
                      : t("pluginsview.SaveChannelSubscriptions", {
                          defaultValue: "Save channel subscriptions",
                        })}
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </PagePanel.Notice>
  );
}
