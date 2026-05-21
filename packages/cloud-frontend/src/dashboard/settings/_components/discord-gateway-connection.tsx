"use client";

import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ConnectionCallout,
  ConnectionCard,
  ConnectionDisconnectAction,
  ConnectionInstructions,
  DiscordIcon,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
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

interface Character {
  id: string;
  name: string;
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

function getStatusBadge(status: DiscordGatewayConnection["status"]) {
  switch (status) {
    case "connected":
      return (
        <Badge variant="default" className="bg-green-500">
          <CheckCircle className="h-3 w-3 mr-1" />
          Connected
        </Badge>
      );
    case "connecting":
      return (
        <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Connecting
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="secondary" className="bg-white/10 text-white/80">
          <Clock className="h-3 w-3 mr-1" />
          Pending
        </Badge>
      );
    case "disconnected":
      return (
        <Badge variant="secondary" className="bg-gray-500/20 text-gray-500">
          <XCircle className="h-3 w-3 mr-1" />
          Disconnected
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertCircle className="h-3 w-3 mr-1" />
          Error
        </Badge>
      );
  }
}

export function DiscordGatewayConnection() {
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

  const fetchConnections = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/v1/discord/connections", { signal });
      if (!signal?.aborted && response.ok) {
        const data = await response.json();
        setConnections(data.connections || []);
      }
    } catch {
      if (!signal?.aborted) {
        toast.error("Failed to fetch Discord connections");
      }
    }
  }, []);

  const fetchCharacters = useCallback(async (signal?: AbortSignal) => {
    setIsLoadingCharacters(true);
    try {
      const response = await fetch("/api/v1/dashboard", { signal });
      if (!signal?.aborted && response.ok) {
        const data = await response.json();
        setCharacters(
          data.agents?.map((a: { id: string; name: string }) => ({
            id: a.id,
            name: a.name,
          })) || [],
        );
      }
    } catch {
      if (!signal?.aborted) {
        toast.error("Failed to fetch characters");
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoadingCharacters(false);
      }
    }
  }, []);

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
    toast.success("Characters refreshed");
  };

  const handleCreate = async () => {
    if (!applicationId.trim()) {
      toast.error("Please enter an Application ID");
      return;
    }
    if (!botToken.trim()) {
      toast.error("Please enter a Bot Token");
      return;
    }
    if (!characterId) {
      toast.error("Please select a character");
      return;
    }

    setIsCreating(true);

    try {
      const response = await fetch("/api/v1/discord/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId: applicationId.trim(),
          botToken: botToken.trim(),
          characterId,
          metadata: {
            responseMode,
          },
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(
          "Discord bot connected! It will be active within 30 seconds.",
        );
        setApplicationId("");
        setBotToken("");
        setCharacterId("");
        setResponseMode("always");
        setShowForm(false);
        void fetchConnections();
      } else if (response.status === 409) {
        toast.error("A connection already exists for this Application ID");
      } else {
        toast.error(data.error || "Failed to create connection");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
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

      const response = await fetch(`/api/v1/discord/connections/${connId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Connection updated successfully");
        // Clear the edit state for this connection
        setEditState((prev) => {
          const newState = { ...prev };
          delete newState[connId];
          return newState;
        });
        void fetchConnections();
      } else {
        toast.error(data.error || "Failed to update connection");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setSavingId(null);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);

    try {
      const response = await fetch(`/api/v1/discord/connections/${id}`, {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Discord bot disconnected");
        setExpandedId(null);
        void fetchConnections();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
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
        name="Discord Gateway Bot"
        icon={<DiscordIcon className="text-[#5865F2]" />}
        description="Connect Discord gateway bots for AI-powered automation"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="Discord Gateway Bot"
      icon={<DiscordIcon className="text-[#5865F2]" />}
      description="Connect Discord gateway bots for AI-powered automation"
      status={connections.length > 0 ? "connected" : "disconnected"}
      statusBadge={
        connections.length > 0 ? (
          <Badge variant="outline">
            {connections.filter((c) => c.status === "connected").length} /{" "}
            {connections.length} Active
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
                              App: {conn.applicationId}
                            </span>
                            {getStatusBadge(conn.status)}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {character ? (
                              <>Character: {character.name}</>
                            ) : (
                              <span className="text-yellow-600">
                                No character linked
                              </span>
                            )}
                            {conn.metadata?.responseMode && (
                              <> · Mode: {conn.metadata.responseMode}</>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                            <span>
                              {conn.guildCount} server
                              {conn.guildCount !== 1 ? "s" : ""}
                            </span>
                            <span>·</span>
                            <span>{conn.eventsReceived} events received</span>
                            <span>·</span>
                            <span>{conn.eventsRouted} routed</span>
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
                            Add to Server
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
                                <Label>Character</Label>
                                <div className="flex gap-2">
                                  <Select
                                    value={edit.characterId}
                                    onValueChange={(v) =>
                                      updateEditState(conn.id, "characterId", v)
                                    }
                                  >
                                    <SelectTrigger className="flex-1">
                                      <SelectValue placeholder="Select a character..." />
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
                                <Label>Response Mode</Label>
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
                                      Every message
                                    </SelectItem>
                                    <SelectItem value="mention">
                                      Only when @mentioned
                                    </SelectItem>
                                    <SelectItem value="keyword">
                                      On keywords
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>

                            {/* Bot Token Update */}
                            <div className="space-y-2">
                              <Label>Update Bot Token (optional)</Label>
                              <Input
                                type="password"
                                placeholder="Leave empty to keep current token"
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
                                Only fill this if you need to change the bot
                                token. The bot will reconnect after saving.
                              </p>
                            </div>

                            {/* Active Toggle */}
                            <div className="flex items-center justify-between">
                              <div>
                                <Label>Connection Active</Label>
                                <p className="text-xs text-muted-foreground">
                                  Disable to temporarily stop the bot without
                                  deleting
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
                                {edit.isActive ? "Active" : "Inactive"}
                              </Button>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex items-center justify-between pt-2">
                              <ConnectionDisconnectAction
                                title="Delete Discord Bot Connection?"
                                description="This will disconnect the bot and remove it from all servers. The bot will stop responding to messages immediately."
                                onDisconnect={() => handleDelete(conn.id)}
                                isDisconnecting={deletingId === conn.id}
                                buttonLabel="Delete Connection"
                                confirmLabel="Delete"
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
                                Save Changes
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
              Add Another Bot
            </Button>
          )}

          {/* Create Form (collapsible) */}
          {showForm && (
            <div className="border rounded-sm p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Add New Discord Bot</h4>
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
                title="How to create a Discord bot"
                open={showInstructions}
                onOpenChange={setShowInstructions}
                triggerClassName="p-3 text-sm"
                contentClassName="p-3"
              >
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>
                    Go to the{" "}
                    <a
                      href="https://discord.com/developers/applications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#5865F2] hover:underline"
                    >
                      Discord Developer Portal
                    </a>
                  </li>
                  <li>Click &quot;New Application&quot; and give it a name</li>
                  <li>
                    Copy the <strong>Application ID</strong> from the General
                    Information page
                  </li>
                  <li>Go to the &quot;Bot&quot; section in the left sidebar</li>
                  <li>
                    Click &quot;Reset Token&quot; to generate a new bot token
                  </li>
                  <li>
                    Copy the <strong>Bot Token</strong> (you&apos;ll only see it
                    once!)
                  </li>
                  <li>
                    Enable &quot;Message Content Intent&quot; under Privileged
                    Gateway Intents
                  </li>
                  <li>
                    Paste both values below, select a character, and click
                    Connect
                  </li>
                  <li>
                    After connecting, click &quot;Add to Server&quot; to invite
                    the bot
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
            title="How to create a Discord bot"
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                Go to the{" "}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#5865F2] hover:underline"
                >
                  Discord Developer Portal
                </a>
              </li>
              <li>Click &quot;New Application&quot; and give it a name</li>
              <li>
                Copy the <strong>Application ID</strong> from the General
                Information page
              </li>
              <li>Go to the &quot;Bot&quot; section in the left sidebar</li>
              <li>Click &quot;Reset Token&quot; to generate a new bot token</li>
              <li>
                Copy the <strong>Bot Token</strong> (you&apos;ll only see it
                once!)
              </li>
              <li>
                Enable &quot;Message Content Intent&quot; under Privileged
                Gateway Intents
              </li>
              <li>
                Paste both values below, select a character, and click Connect
              </li>
              <li>
                After connecting, click &quot;Add to Server&quot; to invite the
                bot
              </li>
            </ol>
          </ConnectionInstructions>

          {/* Form */}
          {renderForm()}

          {/* Features */}
          <ConnectionCallout
            title="What your Discord bot can do:"
            items={[
              "Handle both server channels and direct messages (DMs)",
              "React only when mentioned (configurable)",
              "Process voice messages automatically",
              "Handle multiple Discord servers simultaneously",
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
            <Label htmlFor="applicationId">Application ID</Label>
            <Input
              id="applicationId"
              placeholder="123456789012345678"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Found in Discord Developer Portal → General Information
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="botToken">Bot Token</Label>
            <Input
              id="botToken"
              type="password"
              placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4.Gg..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Found in Discord Developer Portal → Bot → Reset Token
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="character">Character</Label>
            <div className="flex gap-2">
              <Select value={characterId} onValueChange={setCharacterId}>
                <SelectTrigger id="character" className="flex-1">
                  <SelectValue placeholder="Select a character..." />
                </SelectTrigger>
                <SelectContent>
                  {characters.length === 0 ? (
                    <SelectItem value="none" disabled>
                      No characters available
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
                title="Refresh characters"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isLoadingCharacters ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The AI character that will respond to messages
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="responseMode">Response Mode</Label>
            <Select
              value={responseMode}
              onValueChange={(v) => setResponseMode(v as typeof responseMode)}
            >
              <SelectTrigger id="responseMode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Every message</SelectItem>
                <SelectItem value="mention">Only when @mentioned</SelectItem>
                <SelectItem value="keyword">On keywords</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              When should the bot respond to messages?
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
              Connecting...
            </>
          ) : (
            <>
              <DiscordIcon className="h-4 w-4 mr-2" />
              Connect Discord Bot
            </>
          )}
        </Button>

        {characters.length === 0 && (
          <p className="text-sm text-center text-yellow-600">
            You need to create a character first before connecting a Discord
            bot.
          </p>
        )}
      </div>
    );
  }
}
