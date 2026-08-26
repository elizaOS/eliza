/**
 * Discord Gateway Bot cloud connector (multi-connection CRUD).
 *
 * Raw `fetch` calls (list/create/patch/delete connections + character list) are
 * swapped for the cloud {@link api} client so the steward Bearer token is
 * injected on native targets.
 */

"use client";

import {
  AlertCircle,
  Bot,
  CheckCircle,
  Clock,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionDisconnectAction,
  ConnectionInstructions,
} from "../../cloud-ui/components/connection-card";
import { DiscordIcon } from "../../cloud-ui/components/icons";
import { Avatar, AvatarFallback } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { StatusBadge } from "../../components/ui/status-badge";
import { TextLink } from "../../components/ui/text-link";
import { ApiError, api, apiFetch } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";

type TFn = ReturnType<typeof useCloudT>;

interface Character {
  id: string;
  name: string;
}

function normalizeCharacters(
  agents: Array<{ id?: unknown; name?: unknown }> | undefined,
): Character[] {
  return (agents ?? []).flatMap((agent) => {
    if (typeof agent.id !== "string" || agent.id.length === 0) return [];
    return [
      {
        id: agent.id,
        name:
          typeof agent.name === "string" && agent.name.length > 0
            ? agent.name
            : agent.id,
      },
    ];
  });
}

async function fetchRuntimeCharacters(
  signal?: AbortSignal,
): Promise<Character[]> {
  const data = await api<{ agents?: Array<{ id?: unknown; name?: unknown }> }>(
    "/api/agents",
    { signal, skipAuth: true },
  );
  return normalizeCharacters(data.agents);
}

type DiscordDmPolicy = "open" | "allowlist" | "pairing" | "disabled";

const DISCORD_SNOWFLAKE_RE = /^\d{15,20}$/;

/**
 * Parse a comma/whitespace-separated snowflake list. Returns null when any
 * entry is not a Discord user snowflake so callers can surface a validation
 * error instead of silently persisting a broken allowlist.
 */
function parseSnowflakeList(raw: string): string[] | null {
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE_RE.test(id)) return null;
  }
  return ids;
}

interface DiscordConnectionPatch {
  characterId: string | null;
  isActive: boolean;
  metadata: {
    responseMode: "always" | "mention" | "keyword";
    ownerDiscordUserId?: string;
    dmPolicy?: DiscordDmPolicy;
    dmAllowFrom?: string[];
  };
  botToken?: string;
}

interface DiscordGatewayConnection {
  id: string;
  applicationId: string;
  botUserId: string | null;
  characterId: string | null;
  status: "pending" | "connecting" | "connected" | "disconnected" | "error";
  errorMessage: string | null;
  guildCount: number;
  eventsReceived: number;
  eventsRouted: number;
  isActive: boolean;
  metadata: {
    responseMode?: "always" | "mention" | "keyword";
    keywords?: string[];
    enabledChannels?: string[];
    disabledChannels?: string[];
    ownerDiscordUserId?: string;
    dmPolicy?: DiscordDmPolicy;
    dmAllowFrom?: string[];
  } | null;
  connectedAt: string | null;
  lastHeartbeat: string | null;
  createdAt: string;
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

function getStatusBadge(status: DiscordGatewayConnection["status"], t: TFn) {
  switch (status) {
    case "connected":
      return (
        <StatusBadge
          status="success"
          icon={<CheckCircle />}
          label={t("cloud.discord.statusConnected", {
            defaultValue: "Connected",
          })}
        />
      );
    case "connecting":
      return (
        <StatusBadge
          status="processing"
          label={t("cloud.discord.statusConnecting", {
            defaultValue: "Connecting",
          })}
        />
      );
    case "pending":
      return (
        <StatusBadge
          status="muted"
          icon={<Clock />}
          label={t("cloud.discord.statusPending", { defaultValue: "Pending" })}
        />
      );
    case "disconnected":
      return (
        <StatusBadge
          status="muted"
          icon={<XCircle />}
          label={t("cloud.discord.statusDisconnected", {
            defaultValue: "Disconnected",
          })}
        />
      );
    case "error":
      return (
        <StatusBadge
          status="danger"
          icon={<AlertCircle />}
          label={t("cloud.discord.statusError", { defaultValue: "Error" })}
        />
      );
  }
}

export function DiscordGatewayConnection() {
  const t = useCloudT();
  const [connections, setConnections] = useState<DiscordGatewayConnection[]>(
    [],
  );
  const [characters, setCharacters] = useState<Character[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingCharacters, setIsLoadingCharacters] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Form state for new connection
  const [applicationId, setApplicationId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [responseMode, setResponseMode] = useState<
    "always" | "mention" | "keyword"
  >("always");
  const [ownerDiscordUserId, setOwnerDiscordUserId] = useState("");
  const [dmPolicy, setDmPolicy] = useState<DiscordDmPolicy>("open");
  const [dmAllowFrom, setDmAllowFrom] = useState("");

  // Edit state for existing connections
  const [editState, setEditState] = useState<
    Record<
      string,
      {
        characterId: string;
        responseMode: "always" | "mention" | "keyword";
        ownerDiscordUserId: string;
        dmPolicy: DiscordDmPolicy;
        dmAllowFrom: string;
        botToken: string;
        isActive: boolean;
      }
    >
  >({});

  const fetchConnections = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await api<{ connections?: DiscordGatewayConnection[] }>(
          "/api/v1/discord/connections",
          { signal },
        );
        if (!signal?.aborted) {
          setConnections(data.connections || []);
        }
      } catch {
        if (!signal?.aborted) {
          toast.error(
            t("cloud.discord.fetchConnectionsFailed", {
              defaultValue: "Failed to fetch Discord connections",
            }),
          );
        }
      }
    },
    [t],
  );

  const fetchCharacters = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoadingCharacters(true);
      try {
        const data = await api<{
          agents?: Array<{ id?: unknown; name?: unknown }>;
        }>("/api/v1/dashboard", { signal });
        if (!signal?.aborted) {
          const nextCharacters = normalizeCharacters(data.agents);
          const fallbackCharacters =
            nextCharacters.length > 0
              ? nextCharacters
              : await fetchRuntimeCharacters(signal);
          if (!signal?.aborted) {
            setCharacters(fallbackCharacters);
            setCharacterId(
              (current) => current || fallbackCharacters[0]?.id || "",
            );
          }
        }
      } catch {
        if (!signal?.aborted) {
          try {
            const fallbackCharacters = await fetchRuntimeCharacters(signal);
            if (!signal?.aborted) {
              setCharacters(fallbackCharacters);
              setCharacterId(
                (current) => current || fallbackCharacters[0]?.id || "",
              );
            }
          } catch {
            toast.error(
              t("cloud.discord.fetchCharactersFailed", {
                defaultValue: "Failed to fetch characters",
              }),
            );
          }
        }
      } finally {
        if (!signal?.aborted) {
          setIsLoadingCharacters(false);
        }
      }
    },
    [t],
  );

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      await Promise.all([fetchConnections(signal), fetchCharacters(signal)]);
      setIsLoading(false);
    },
    [fetchConnections, fetchCharacters],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const handleRefreshCharacters = () => {
    void fetchCharacters();
    toast.success(
      t("cloud.discord.charactersRefreshed", {
        defaultValue: "Characters refreshed",
      }),
    );
  };

  const handleCreate = async () => {
    if (!applicationId.trim()) {
      toast.error(
        t("cloud.discord.enterApplicationId", {
          defaultValue: "Please enter an Application ID",
        }),
      );
      return;
    }
    if (!botToken.trim()) {
      toast.error(
        t("cloud.discord.enterBotToken", {
          defaultValue: "Please enter a Bot Token",
        }),
      );
      return;
    }
    if (!characterId) {
      toast.error(
        t("cloud.discord.selectCharacter", {
          defaultValue: "Please select a character",
        }),
      );
      return;
    }

    const parsedDmAllowFrom = parseSnowflakeList(dmAllowFrom);
    if (parsedDmAllowFrom === null) {
      toast.error(
        t("cloud.discord.dmAllowFromInvalid", {
          defaultValue:
            "Allowed DM user IDs must be Discord snowflakes (15-20 digits), separated by commas.",
        }),
      );
      return;
    }

    setIsCreating(true);

    try {
      const data = await api<{ success?: boolean; error?: string }>(
        "/api/v1/discord/connections",
        {
          method: "POST",
          json: {
            applicationId: applicationId.trim(),
            botToken: botToken.trim(),
            characterId,
            metadata: {
              responseMode,
              ...(ownerDiscordUserId.trim()
                ? { ownerDiscordUserId: ownerDiscordUserId.trim() }
                : {}),
              ...(dmPolicy !== "open" ? { dmPolicy } : {}),
              ...(parsedDmAllowFrom.length > 0
                ? { dmAllowFrom: parsedDmAllowFrom }
                : {}),
            },
          },
        },
      );

      if (data.success) {
        toast.success(
          t("cloud.discord.connectedToast", {
            defaultValue:
              "Discord bot connected! It will be active within 30 seconds.",
          }),
        );
        setApplicationId("");
        setBotToken("");
        setCharacterId("");
        setResponseMode("always");
        setOwnerDiscordUserId("");
        setDmPolicy("open");
        setDmAllowFrom("");
        setShowForm(false);
        void fetchConnections();
      } else {
        toast.error(
          data.error ||
            t("cloud.discord.createFailed", {
              defaultValue: "Failed to create connection",
            }),
        );
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(
          t("cloud.discord.connectionExists", {
            defaultValue: "A connection already exists for this Application ID",
          }),
        );
      } else if (error instanceof ApiError) {
        toast.error(
          apiErrorMessage(
            error,
            t("cloud.discord.createFailed", {
              defaultValue: "Failed to create connection",
            }),
          ),
        );
      } else {
        toast.error(
          t("cloud.discord.networkError", {
            defaultValue: "Network error. Please check your connection.",
          }),
        );
      }
    }

    setIsCreating(false);
  };

  const handleSaveChanges = async (connId: string) => {
    const edit = editState[connId];
    if (!edit) return;

    const parsedDmAllowFrom = parseSnowflakeList(edit.dmAllowFrom);
    if (parsedDmAllowFrom === null) {
      toast.error(
        t("cloud.discord.dmAllowFromInvalid", {
          defaultValue:
            "Allowed DM user IDs must be Discord snowflakes (15-20 digits), separated by commas.",
        }),
      );
      return;
    }

    setSavingId(connId);

    try {
      const payload: DiscordConnectionPatch = {
        characterId: edit.characterId || null,
        isActive: edit.isActive,
        metadata: {
          responseMode: edit.responseMode,
          ...(edit.ownerDiscordUserId.trim()
            ? { ownerDiscordUserId: edit.ownerDiscordUserId.trim() }
            : {}),
          ...(edit.dmPolicy !== "open" ? { dmPolicy: edit.dmPolicy } : {}),
          ...(parsedDmAllowFrom.length > 0
            ? { dmAllowFrom: parsedDmAllowFrom }
            : {}),
        },
      };

      // Only include botToken if it was changed (not empty)
      if (edit.botToken) {
        payload.botToken = edit.botToken;
      }

      const data = await api<{ success?: boolean; error?: string }>(
        `/api/v1/discord/connections/${connId}`,
        { method: "PATCH", json: payload },
      );

      if (data.success) {
        toast.success(
          t("cloud.discord.connectionUpdated", {
            defaultValue: "Connection updated successfully",
          }),
        );
        // Clear the edit state for this connection
        setEditState((prev) => {
          const newState = { ...prev };
          delete newState[connId];
          return newState;
        });
        void fetchConnections();
      } else {
        toast.error(
          data.error ||
            t("cloud.discord.updateFailed", {
              defaultValue: "Failed to update connection",
            }),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? apiErrorMessage(
              error,
              t("cloud.discord.updateFailed", {
                defaultValue: "Failed to update connection",
              }),
            )
          : t("cloud.discord.networkError", {
              defaultValue: "Network error. Please check your connection.",
            }),
      );
    }

    setSavingId(null);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);

    try {
      await apiFetch(`/api/v1/discord/connections/${id}`, { method: "DELETE" });
      toast.success(
        t("cloud.discord.disconnected", {
          defaultValue: "Discord bot disconnected",
        }),
      );
      setExpandedId(null);
      void fetchConnections();
    } catch (error) {
      toast.error(
        apiErrorMessage(
          error,
          t("cloud.discord.disconnectFailed", {
            defaultValue: "Failed to disconnect",
          }),
        ),
      );
    }

    setDeletingId(null);
  };

  const initEditState = (conn: DiscordGatewayConnection) => {
    if (!editState[conn.id]) {
      setEditState((prev) => ({
        ...prev,
        [conn.id]: {
          characterId: conn.characterId || "",
          responseMode: conn.metadata?.responseMode || "always",
          ownerDiscordUserId: conn.metadata?.ownerDiscordUserId || "",
          dmPolicy: conn.metadata?.dmPolicy || "open",
          dmAllowFrom: (conn.metadata?.dmAllowFrom || []).join(", "),
          botToken: "",
          isActive: conn.isActive,
        },
      }));
    }
  };

  const updateEditState = (
    connId: string,
    field: string,
    value: string | boolean,
  ) => {
    setEditState((prev) => ({
      ...prev,
      [connId]: {
        ...prev[connId],
        [field]: value,
      },
    }));
  };

  const getInviteUrl = (appId: string) => {
    // Permissions: Send Messages (2048) + Read Message History (65536) + Add Reactions (64) = 67648
    const permissions = "67648";
    const scopes = "bot";
    return `https://discord.com/api/oauth2/authorize?client_id=${appId}&permissions=${permissions}&scope=${scopes}`;
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.discord.cardName", {
          defaultValue: "Discord Gateway Bot",
        })}
        icon={<DiscordIcon className="text-txt" />}
        description={t("cloud.discord.cardDescription", {
          defaultValue:
            "Connect Discord gateway bots for AI-powered automation",
        })}
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name={t("cloud.discord.cardName", {
        defaultValue: "Discord Gateway Bot",
      })}
      icon={<DiscordIcon className="text-txt" />}
      description={t("cloud.discord.cardDescription", {
        defaultValue: "Connect Discord gateway bots for AI-powered automation",
      })}
      status={connections.length > 0 ? "connected" : "disconnected"}
      statusBadge={
        connections.length > 0 ? (
          <Badge variant="outline">
            {t("cloud.discord.activeCount", {
              active: connections.filter((c) => c.status === "connected")
                .length,
              total: connections.length,
              defaultValue: "{{active}} / {{total}} Active",
            })}
          </Badge>
        ) : null
      }
      connectedContent={
        <div className="space-y-4">
          {/* Existing Connections */}
          <div className="space-y-3">
            {connections.map((conn) => {
              const character = characters.find(
                (c) => c.id === conn.characterId,
              );
              const isExpanded = expandedId === conn.id;
              const edit = editState[conn.id];

              return (
                <Collapsible
                  key={conn.id}
                  open={isExpanded}
                  onOpenChange={(open) => {
                    setExpandedId(open ? conn.id : null);
                    if (open) initEditState(conn);
                  }}
                >
                  <Card variant="connectorPanel">
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="surface"
                        size="row"
                        align="start"
                        className="gap-4"
                      >
                        <Avatar className="size-12">
                          <AvatarFallback>
                            <Bot className="size-6 text-txt-strong" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold truncate">
                              {t("cloud.discord.appLabel", {
                                appId: conn.applicationId,
                                defaultValue: "App: {{appId}}",
                              })}
                            </span>
                            {getStatusBadge(conn.status, t)}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {character ? (
                              t("cloud.discord.characterLabel", {
                                name: character.name,
                                defaultValue: "Character: {{name}}",
                              })
                            ) : (
                              <span className="text-status-warning">
                                {t("cloud.discord.noCharacterLinked", {
                                  defaultValue: "No character linked",
                                })}
                              </span>
                            )}
                            {conn.metadata?.responseMode && (
                              <>
                                {" "}
                                {t("cloud.discord.modeLabel", {
                                  mode: conn.metadata.responseMode,
                                  defaultValue: "· Mode: {{mode}}",
                                })}
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                            <span>
                              {t("cloud.discord.serverCount", {
                                count: conn.guildCount,
                                defaultValue: "{{count}} servers",
                              })}
                            </span>
                            <span>·</span>
                            <span>
                              {t("cloud.discord.eventsReceived", {
                                count: conn.eventsReceived,
                                defaultValue: "{{count}} events received",
                              })}
                            </span>
                            <span>·</span>
                            <span>
                              {t("cloud.discord.eventsRouted", {
                                count: conn.eventsRouted,
                                defaultValue: "{{count}} routed",
                              })}
                            </span>
                          </div>
                          {conn.errorMessage && (
                            <div className="text-sm text-destructive mt-1">
                              {conn.errorMessage}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(
                                getInviteUrl(conn.applicationId),
                                "_blank",
                              );
                            }}
                          >
                            <ExternalLink className="size-4 mr-1" />
                            {t("cloud.discord.addToServer", {
                              defaultValue: "Add to Server",
                            })}
                          </Button>
                          <Settings
                            className={`size-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          />
                        </div>
                      </Button>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                  <Card
                    variant="topDivider"
                    stack="default"
                    padding="comfortable"
                  >
                        {edit && (
                          <>
                            {/* Character Selection */}
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div className="space-y-2">
                                <Label>
                                  {t("cloud.discord.character", {
                                    defaultValue: "Character",
                                  })}
                                </Label>
                                <div className="flex gap-2">
                                  <Select
                                    value={edit.characterId}
                                    onValueChange={(v) =>
                                      updateEditState(conn.id, "characterId", v)
                                    }
                                  >
                                    <SelectTrigger className="flex-1">
                                      <SelectValue
                                        placeholder={t(
                                          "cloud.discord.selectCharacterPlaceholder",
                                          {
                                            defaultValue:
                                              "Select a character...",
                                          },
                                        )}
                                      />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {characters.map((char) => (
                                        <SelectItem
                                          key={char.id}
                                          value={char.id}
                                        >
                                          {char.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={handleRefreshCharacters}
                                    disabled={isLoadingCharacters}
                                  >
                                    <RefreshCw
                                      className={`size-4 ${isLoadingCharacters ? "animate-spin" : ""}`}
                                    />
                                  </Button>
                                </div>
                              </div>

                              <div className="space-y-2">
                                <Label>
                                  {t("cloud.discord.responseMode", {
                                    defaultValue: "Response Mode",
                                  })}
                                </Label>
                                <Select
                                  value={edit.responseMode}
                                  onValueChange={(v) =>
                                    updateEditState(conn.id, "responseMode", v)
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="always">
                                      {t("cloud.discord.modeEveryMessage", {
                                        defaultValue: "Every message",
                                      })}
                                    </SelectItem>
                                    <SelectItem value="mention">
                                      {t("cloud.discord.modeMention", {
                                        defaultValue: "Only when @mentioned",
                                      })}
                                    </SelectItem>
                                    <SelectItem value="keyword">
                                      {t("cloud.discord.modeKeyword", {
                                        defaultValue: "On keywords",
                                      })}
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-2">
                                <Label>
                                  {t("cloud.discord.ownerDiscordUserId", {
                                    defaultValue: "Discord Owner ID",
                                  })}
                                </Label>
                                <Input
                                  placeholder={t(
                                    "cloud.discord.ownerDiscordUserIdPlaceholder",
                                    {
                                      defaultValue: "Your Discord user snowflake",
                                    },
                                  )}
                                  value={edit.ownerDiscordUserId}
                                  onChange={(e) =>
                                    updateEditState(
                                      conn.id,
                                      "ownerDiscordUserId",
                                      e.target.value,
                                    )
                                  }
                                />
                              </div>

                              <div className="space-y-2">
                                <Label>
                                  {t("cloud.discord.dmPolicy", {
                                    defaultValue: "DM Policy",
                                  })}
                                </Label>
                                <Select
                                  value={edit.dmPolicy}
                                  onValueChange={(v) =>
                                    updateEditState(conn.id, "dmPolicy", v)
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="open">
                                      {t("cloud.discord.dmPolicyOpen", {
                                        defaultValue: "Open (anyone can DM)",
                                      })}
                                    </SelectItem>
                                    <SelectItem value="allowlist">
                                      {t("cloud.discord.dmPolicyAllowlist", {
                                        defaultValue:
                                          "Allowlist (owner + allowed users)",
                                      })}
                                    </SelectItem>
                                    <SelectItem value="pairing">
                                      {t("cloud.discord.dmPolicyPairing", {
                                        defaultValue: "Owner only",
                                      })}
                                    </SelectItem>
                                    <SelectItem value="disabled">
                                      {t("cloud.discord.dmPolicyDisabled", {
                                        defaultValue: "Disabled (no DMs)",
                                      })}
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-2">
                                <Label>
                                  {t("cloud.discord.dmAllowFrom", {
                                    defaultValue: "Allowed DM User IDs",
                                  })}
                                </Label>
                                <Input
                                  placeholder={t(
                                    "cloud.discord.dmAllowFromPlaceholder",
                                    {
                                      defaultValue:
                                        "Comma-separated Discord user snowflakes",
                                    },
                                  )}
                                  value={edit.dmAllowFrom}
                                  onChange={(e) =>
                                    updateEditState(
                                      conn.id,
                                      "dmAllowFrom",
                                      e.target.value,
                                    )
                                  }
                                />
                              </div>
                            </div>

                            {/* Bot Token Update */}
                            <div className="space-y-2">
                              <Label>
                                {t("cloud.discord.updateBotToken", {
                                  defaultValue: "Update Bot Token (optional)",
                                })}
                              </Label>
                              <Input
                                type="password"
                                placeholder={t(
                                  "cloud.discord.keepCurrentToken",
                                  {
                                    defaultValue:
                                      "Leave empty to keep current token",
                                  },
                                )}
                                value={edit.botToken}
                                onChange={(e) =>
                                  updateEditState(
                                    conn.id,
                                    "botToken",
                                    e.target.value,
                                  )
                                }
                              />
                              <p className="text-xs text-muted-foreground">
                                {t("cloud.discord.tokenChangeHint", {
                                  defaultValue:
                                    "Only fill this if you need to change the bot token. The bot will reconnect after saving.",
                                })}
                              </p>
                            </div>

                            {/* Active Toggle */}
                            <div className="flex items-center justify-between">
                              <div>
                                <Label>
                                  {t("cloud.discord.connectionActive", {
                                    defaultValue: "Connection Active",
                                  })}
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  {t("cloud.discord.disableHint", {
                                    defaultValue:
                                      "Disable to temporarily stop the bot without deleting",
                                  })}
                                </p>
                              </div>
                              <Button
                                variant={edit.isActive ? "default" : "outline"}
                                size="sm"
                                onClick={() =>
                                  updateEditState(
                                    conn.id,
                                    "isActive",
                                    !edit.isActive,
                                  )
                                }
                              >
                                {edit.isActive
                                  ? t("cloud.discord.active", {
                                      defaultValue: "Active",
                                    })
                                  : t("cloud.discord.inactive", {
                                      defaultValue: "Inactive",
                                    })}
                              </Button>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex items-center justify-between pt-2">
                              <ConnectionDisconnectAction
                                title={t("cloud.discord.deleteTitle", {
                                  defaultValue:
                                    "Delete Discord Bot Connection?",
                                })}
                                description={t(
                                  "cloud.discord.deleteDescription",
                                  {
                                    defaultValue:
                                      "This will disconnect the bot and remove it from all servers. The bot will stop responding to messages immediately.",
                                  },
                                )}
                                onDisconnect={() => handleDelete(conn.id)}
                                isDisconnecting={deletingId === conn.id}
                                buttonLabel={t(
                                  "cloud.discord.deleteConnection",
                                  {
                                    defaultValue: "Delete Connection",
                                  },
                                )}
                                confirmLabel={t("cloud.discord.confirmDelete", {
                                  defaultValue: "Delete",
                                })}
                              />

                              <Button
                                onClick={() => handleSaveChanges(conn.id)}
                                disabled={savingId === conn.id}
                              >
                                {savingId === conn.id ? (
                                  <Loader2 className="size-4 animate-spin mr-2" />
                                ) : (
                                  <Save className="size-4 mr-2" />
                                )}
                                {t("cloud.discord.saveChanges", {
                                  defaultValue: "Save Changes",
                                })}
                              </Button>
                            </div>
                          </>
                        )}
                      </Card>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              );
            })}
          </div>

          {/* Add Another Button */}
          {!showForm && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowForm(true)}
            >
              <Plus className="size-4 mr-2" />
              {t("cloud.discord.addAnotherBot", {
                defaultValue: "Add Another Bot",
              })}
            </Button>
          )}

          {/* Create Form (collapsible) */}
          {showForm && (
            <Card variant="outlinedPadded" stack="default">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">
                  {t("cloud.discord.addNewBot", {
                    defaultValue: "Add New Discord Bot",
                  })}
                </h4>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowForm(false)}
                >
                  <XCircle className="size-4" />
                </Button>
              </div>

              {/* Instructions */}
              <ConnectionInstructions
                title={t("cloud.discord.howToTitle", {
                  defaultValue: "How to create a Discord bot",
                })}
                open={showInstructions}
                onOpenChange={setShowInstructions}
                triggerClassName="p-3 text-sm"
                contentClassName="p-3"
              >
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>
                    {t("cloud.discord.stepGoTo", { defaultValue: "Go to the" })}{" "}
                    <TextLink
                      href="https://discord.com/developers/applications"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("cloud.discord.devPortal", {
                        defaultValue: "Discord Developer Portal",
                      })}
                    </TextLink>
                  </li>
                  <li>
                    {t("cloud.discord.stepNewApp", {
                      defaultValue:
                        'Click "New Application" and give it a name',
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepCopyAppIdPrefix", {
                      defaultValue: "Copy the",
                    })}{" "}
                    <strong>
                      {t("cloud.discord.applicationId", {
                        defaultValue: "Application ID",
                      })}
                    </strong>{" "}
                    {t("cloud.discord.stepCopyAppIdSuffix", {
                      defaultValue: "from the General Information page",
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepBotSection", {
                      defaultValue:
                        'Go to the "Bot" section in the left sidebar',
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepResetToken", {
                      defaultValue:
                        'Click "Reset Token" to generate a new bot token',
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepCopyTokenPrefix", {
                      defaultValue: "Copy the",
                    })}{" "}
                    <strong>
                      {t("cloud.discord.botToken", {
                        defaultValue: "Bot Token",
                      })}
                    </strong>{" "}
                    {t("cloud.discord.stepCopyTokenSuffix", {
                      defaultValue: "(you'll only see it once!)",
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepMessageIntent", {
                      defaultValue:
                        'Enable "Message Content Intent" under Privileged Gateway Intents',
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepPasteValues", {
                      defaultValue:
                        "Paste both values below, select a character, and click Connect",
                    })}
                  </li>
                  <li>
                    {t("cloud.discord.stepAddToServer", {
                      defaultValue:
                        'After connecting, click "Add to Server" to invite the bot',
                    })}
                  </li>
                </ol>
              </ConnectionInstructions>

              {renderForm()}
            </Card>
          )}
        </div>
      }
      setupContent={
        <div className="space-y-4">
          {/* Instructions */}
          <ConnectionInstructions
            title={t("cloud.discord.howToTitle", {
              defaultValue: "How to create a Discord bot",
            })}
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                {t("cloud.discord.stepGoTo", { defaultValue: "Go to the" })}{" "}
                <TextLink
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("cloud.discord.devPortal", {
                    defaultValue: "Discord Developer Portal",
                  })}
                </TextLink>
              </li>
              <li>
                {t("cloud.discord.stepNewApp", {
                  defaultValue: 'Click "New Application" and give it a name',
                })}
              </li>
              <li>
                {t("cloud.discord.stepCopyAppIdPrefix", {
                  defaultValue: "Copy the",
                })}{" "}
                <strong>
                  {t("cloud.discord.applicationId", {
                    defaultValue: "Application ID",
                  })}
                </strong>{" "}
                {t("cloud.discord.stepCopyAppIdSuffix", {
                  defaultValue: "from the General Information page",
                })}
              </li>
              <li>
                {t("cloud.discord.stepBotSection", {
                  defaultValue: 'Go to the "Bot" section in the left sidebar',
                })}
              </li>
              <li>
                {t("cloud.discord.stepResetToken", {
                  defaultValue:
                    'Click "Reset Token" to generate a new bot token',
                })}
              </li>
              <li>
                {t("cloud.discord.stepCopyTokenPrefix", {
                  defaultValue: "Copy the",
                })}{" "}
                <strong>
                  {t("cloud.discord.botToken", { defaultValue: "Bot Token" })}
                </strong>{" "}
                {t("cloud.discord.stepCopyTokenSuffix", {
                  defaultValue: "(you'll only see it once!)",
                })}
              </li>
              <li>
                {t("cloud.discord.stepMessageIntent", {
                  defaultValue:
                    'Enable "Message Content Intent" under Privileged Gateway Intents',
                })}
              </li>
              <li>
                {t("cloud.discord.stepPasteValues", {
                  defaultValue:
                    "Paste both values below, select a character, and click Connect",
                })}
              </li>
              <li>
                {t("cloud.discord.stepAddToServer", {
                  defaultValue:
                    'After connecting, click "Add to Server" to invite the bot',
                })}
              </li>
            </ol>
          </ConnectionInstructions>

          {/* Form */}
          {renderForm()}

          {/* Features */}
          <ConnectionCallout
            title={t("cloud.discord.calloutTitle", {
              defaultValue: "What your Discord bot can do:",
            })}
            items={[
              t("cloud.discord.calloutItem1", {
                defaultValue:
                  "Handle both server channels and direct messages (DMs)",
              }),
              t("cloud.discord.calloutItem2", {
                defaultValue: "React only when mentioned (configurable)",
              }),
              t("cloud.discord.calloutItem3", {
                defaultValue: "Process voice messages automatically",
              }),
              t("cloud.discord.calloutItem4", {
                defaultValue: "Handle multiple Discord servers simultaneously",
              }),
            ]}
          />
        </div>
      }
    />
  );

  function renderForm() {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="applicationId">
              {t("cloud.discord.applicationId", {
                defaultValue: "Application ID",
              })}
            </Label>
            <Input
              id="applicationId"
              placeholder="123456789012345678"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.discord.appIdHint", {
                defaultValue:
                  "Found in Discord Developer Portal → General Information",
              })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="botToken">
              {t("cloud.discord.botToken", { defaultValue: "Bot Token" })}
            </Label>
            <Input
              id="botToken"
              type="password"
              placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4.Gg…"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.discord.botTokenHint", {
                defaultValue:
                  "Found in Discord Developer Portal → Bot → Reset Token",
              })}
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="character">
              {t("cloud.discord.character", { defaultValue: "Character" })}
            </Label>
            <div className="flex gap-2">
              <Select
                key={characterId || "discord-gateway-character-unselected"}
                value={characterId}
                onValueChange={setCharacterId}
              >
                <SelectTrigger id="character" className="flex-1">
                  <SelectValue
                    placeholder={t("cloud.discord.selectCharacterPlaceholder", {
                      defaultValue: "Select a character...",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {characters.length === 0 ? (
                    <SelectItem value="none" disabled>
                      {t("cloud.discord.noCharactersAvailable", {
                        defaultValue: "No characters available",
                      })}
                    </SelectItem>
                  ) : (
                    characters.map((char) => (
                      <SelectItem key={char.id} value={char.id}>
                        {char.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                onClick={handleRefreshCharacters}
                disabled={isLoadingCharacters}
                title={t("cloud.discord.refreshCharacters", {
                  defaultValue: "Refresh characters",
                })}
              >
                <RefreshCw
                  className={`size-4 ${isLoadingCharacters ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("cloud.discord.characterHint", {
                defaultValue: "The AI character that will respond to messages",
              })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="responseMode">
              {t("cloud.discord.responseMode", {
                defaultValue: "Response Mode",
              })}
            </Label>
            <Select
              value={responseMode}
              onValueChange={(v) => setResponseMode(v as typeof responseMode)}
            >
              <SelectTrigger id="responseMode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">
                  {t("cloud.discord.modeEveryMessage", {
                    defaultValue: "Every message",
                  })}
                </SelectItem>
                <SelectItem value="mention">
                  {t("cloud.discord.modeMention", {
                    defaultValue: "Only when @mentioned",
                  })}
                </SelectItem>
                <SelectItem value="keyword">
                  {t("cloud.discord.modeKeyword", {
                    defaultValue: "On keywords",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("cloud.discord.responseModeHint", {
                defaultValue: "When should the bot respond to messages?",
              })}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ownerDiscordUserId">
            {t("cloud.discord.ownerDiscordUserId", {
              defaultValue: "Discord Owner ID",
            })}
          </Label>
          <Input
            id="ownerDiscordUserId"
            placeholder={t("cloud.discord.ownerDiscordUserIdPlaceholder", {
              defaultValue: "Your Discord user snowflake",
            })}
            value={ownerDiscordUserId}
            onChange={(e) => setOwnerDiscordUserId(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="dmPolicy">
            {t("cloud.discord.dmPolicy", { defaultValue: "DM Policy" })}
          </Label>
          <Select
            value={dmPolicy}
            onValueChange={(v) => setDmPolicy(v as DiscordDmPolicy)}
          >
            <SelectTrigger id="dmPolicy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">
                {t("cloud.discord.dmPolicyOpen", {
                  defaultValue: "Open (anyone can DM)",
                })}
              </SelectItem>
              <SelectItem value="allowlist">
                {t("cloud.discord.dmPolicyAllowlist", {
                  defaultValue: "Allowlist (owner + allowed users)",
                })}
              </SelectItem>
              <SelectItem value="pairing">
                {t("cloud.discord.dmPolicyPairing", {
                  defaultValue: "Owner only",
                })}
              </SelectItem>
              <SelectItem value="disabled">
                {t("cloud.discord.dmPolicyDisabled", {
                  defaultValue: "Disabled (no DMs)",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("cloud.discord.dmPolicyHint", {
              defaultValue:
                "Who may direct-message the bot. Owner only and Allowlist admit the Discord Owner ID above.",
            })}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="dmAllowFrom">
            {t("cloud.discord.dmAllowFrom", {
              defaultValue: "Allowed DM User IDs",
            })}
          </Label>
          <Input
            id="dmAllowFrom"
            placeholder={t("cloud.discord.dmAllowFromPlaceholder", {
              defaultValue: "Comma-separated Discord user snowflakes",
            })}
            value={dmAllowFrom}
            onChange={(e) => setDmAllowFrom(e.target.value)}
          />
        </div>

        <Button
          onClick={handleCreate}
          disabled={
            isCreating ||
            !applicationId.trim() ||
            !botToken.trim() ||
            !characterId
          }
          className="w-full"
        >
          {isCreating ? (
            <>
              <Loader2 className="size-4 animate-spin mr-2" />
              {t("cloud.discord.connecting", { defaultValue: "Connecting..." })}
            </>
          ) : (
            <>
              <DiscordIcon className="size-4 mr-2" />
              {t("cloud.discord.connectBot", {
                defaultValue: "Connect Discord Bot",
              })}
            </>
          )}
        </Button>

        {characters.length === 0 && (
          <p className="text-sm text-center text-status-warning">
            {t("cloud.discord.needCharacterFirst", {
              defaultValue:
                "You need to create a character first before connecting a Discord bot.",
            })}
          </p>
        )}
      </div>
    );
  }
}
