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
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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

interface DiscordConnectionPatch {
  characterId: string | null;
  isActive: boolean;
  metadata: { responseMode: "always" | "mention" | "keyword" };
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
        <Badge variant="default" className="bg-green-500">
          <CheckCircle className="h-3 w-3 mr-1" />
          {t("cloud.discord.statusConnected", { defaultValue: "Connected" })}
        </Badge>
      );
    case "connecting":
      return (
        <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          {t("cloud.discord.statusConnecting", { defaultValue: "Connecting" })}
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="secondary" className="bg-white/10 text-white/80">
          <Clock className="h-3 w-3 mr-1" />
          {t("cloud.discord.statusPending", { defaultValue: "Pending" })}
        </Badge>
      );
    case "disconnected":
      return (
        <Badge variant="secondary" className="bg-gray-500/20 text-gray-500">
          <XCircle className="h-3 w-3 mr-1" />
          {t("cloud.discord.statusDisconnected", {
            defaultValue: "Disconnected",
          })}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertCircle className="h-3 w-3 mr-1" />
          {t("cloud.discord.statusError", { defaultValue: "Error" })}
        </Badge>
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

  // Edit state for existing connections
  const [editState, setEditState] = useState<
    Record<
      string,
      {
        characterId: string;
        responseMode: "always" | "mention" | "keyword";
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
            metadata: { responseMode },
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

    setSavingId(connId);

    try {
      const payload: DiscordConnectionPatch = {
        characterId: edit.characterId || null,
        isActive: edit.isActive,
        metadata: {
          responseMode: edit.responseMode,
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
        icon={<DiscordIcon className="text-[#5865F2]" />}
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
      icon={<DiscordIcon className="text-[#5865F2]" />}
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
                  <div className="border rounded-sm">
                    <CollapsibleTrigger asChild>
                      <div className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors">
                        <div className="h-12 w-12 rounded-full bg-[#5865F2] flex items-center justify-center flex-shrink-0">
                          <Bot className="h-6 w-6 text-white" />
                        </div>
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
                              <span className="text-yellow-600">
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
                            <div className="text-sm text-red-500 mt-1">
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
                            <ExternalLink className="h-4 w-4 mr-1" />
                            {t("cloud.discord.addToServer", {
                              defaultValue: "Add to Server",
                            })}
                          </Button>
                          <Settings
                            className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          />
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <div className="border-t p-4 space-y-4 bg-muted/30">
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
                                      className={`h-4 w-4 ${isLoadingCharacters ? "animate-spin" : ""}`}
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
                                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                ) : (
                                  <Save className="h-4 w-4 mr-2" />
                                )}
                                {t("cloud.discord.saveChanges", {
                                  defaultValue: "Save Changes",
                                })}
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
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
              <Plus className="h-4 w-4 mr-2" />
              {t("cloud.discord.addAnotherBot", {
                defaultValue: "Add Another Bot",
              })}
            </Button>
          )}

          {/* Create Form (collapsible) */}
          {showForm && (
            <div className="border rounded-sm p-4 space-y-4">
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
                  <XCircle className="h-4 w-4" />
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
                    <a
                      href="https://discord.com/developers/applications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#5865F2] hover:underline"
                    >
                      {t("cloud.discord.devPortal", {
                        defaultValue: "Discord Developer Portal",
                      })}
                    </a>
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
            </div>
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
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#5865F2] hover:underline"
                >
                  {t("cloud.discord.devPortal", {
                    defaultValue: "Discord Developer Portal",
                  })}
                </a>
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
              placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4.Gg..."
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
                  className={`h-4 w-4 ${isLoadingCharacters ? "animate-spin" : ""}`}
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

        <Button
          onClick={handleCreate}
          disabled={
            isCreating ||
            !applicationId.trim() ||
            !botToken.trim() ||
            !characterId
          }
          className="w-full bg-[#5865F2] hover:bg-[#4752C4]"
        >
          {isCreating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              {t("cloud.discord.connecting", { defaultValue: "Connecting..." })}
            </>
          ) : (
            <>
              <DiscordIcon className="h-4 w-4 mr-2" />
              {t("cloud.discord.connectBot", {
                defaultValue: "Connect Discord Bot",
              })}
            </>
          )}
        </Button>

        {characters.length === 0 && (
          <p className="text-sm text-center text-yellow-600">
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
