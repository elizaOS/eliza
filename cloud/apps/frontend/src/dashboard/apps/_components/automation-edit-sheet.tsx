"use client";

/**
 * Automation Edit Sheet
 *
 * Slide-out sheet for editing or setting up automation for a platform.
 * Supports Discord, Telegram, and Twitter automation configuration.
 *
 * Used for both "Set Up" (create) and "Edit" (update) flows.
 */

import {
  Button,
  Image,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Slider,
  Switch,
} from "@elizaos/cloud-ui";
import { Bot, CheckCircle, Hash, Loader2, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Platform } from "./platform-automation-card";

interface AgentCharacter {
  id: string;
  name: string;
  avatar_url?: string;
  avatarUrl?: string;
  bio?: string | string[];
}

interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  channelCount: number;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface TelegramChat {
  id: string;
  type: string;
  title: string;
  username?: string;
  isAdmin: boolean;
  canPost: boolean;
}

interface AutomationConfig {
  enabled: boolean;
  guildId?: string;
  channelId?: string;
  groupId?: string;
  autoAnnounce?: boolean;
  autoPost?: boolean;
  autoReply?: boolean;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  postIntervalMin?: number;
  postIntervalMax?: number;
  agentCharacterId?: string;
  vibeStyle?: string;
}

interface AutomationEditSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform;
  appId: string;
  mode: "create" | "edit";
  onSuccess?: () => void;
}

const PLATFORM_CONFIG = {
  discord: {
    name: "Discord",
    icon: Hash,
    color: "text-[#5865F2]",
  },
  telegram: {
    name: "Telegram",
    icon: Send,
    color: "text-[#0088cc]",
  },
  twitter: {
    name: "Twitter/X",
    icon: Bot,
    color: "text-sky-500",
  },
};

const DEFAULT_INTERVALS = {
  discord: { min: 120, max: 240 },
  telegram: { min: 120, max: 240 },
  twitter: { min: 90, max: 150 },
};

async function requestTelegramChats(method: "GET" | "POST") {
  const response = await fetch("/api/v1/telegram/scan-chats", {
    method,
    credentials: "include",
  });

  if (!response.ok) {
    const data = (await response.json()) as { error?: string };
    throw new Error(data.error || "Failed to scan for chats");
  }

  const data = (await response.json()) as { chats?: TelegramChat[] };
  return data.chats || [];
}

async function loadTelegramChats() {
  const cachedChats = await requestTelegramChats("GET");
  return cachedChats.length > 0 ? cachedChats : requestTelegramChats("POST");
}

export function AutomationEditSheet({
  open,
  onOpenChange,
  platform,
  appId,
  mode,
  onSuccess,
}: AutomationEditSheetProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state
  const [config, setConfig] = useState<AutomationConfig>({
    enabled: true,
    autoAnnounce: true,
    autoPost: true,
    autoReply: true,
    announceIntervalMin: DEFAULT_INTERVALS[platform].min,
    announceIntervalMax: DEFAULT_INTERVALS[platform].max,
    postIntervalMin: DEFAULT_INTERVALS[platform].min,
    postIntervalMax: DEFAULT_INTERVALS[platform].max,
  });

  // Discord-specific state
  const [discordGuilds, setDiscordGuilds] = useState<DiscordGuild[]>([]);
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  // Track currently selected guild/channel names for display
  const [selectedGuildName, setSelectedGuildName] = useState<string | null>(null);
  const [selectedChannelName, setSelectedChannelName] = useState<string | null>(null);

  // Telegram-specific state
  const [telegramChats, setTelegramChats] = useState<TelegramChat[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  // Track the current chat name from existing config (for when chat isn't in list)
  const [existingTelegramChatName, setExistingTelegramChatName] = useState<string | null>(null);

  // Character state
  const [characters, setCharacters] = useState<AgentCharacter[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);

  const platformConfig = PLATFORM_CONFIG[platform];

  // Reset all form state to defaults
  const resetForm = useCallback(() => {
    setConfig({
      enabled: true,
      autoAnnounce: true,
      autoPost: true,
      autoReply: true,
      announceIntervalMin: DEFAULT_INTERVALS[platform].min,
      announceIntervalMax: DEFAULT_INTERVALS[platform].max,
      postIntervalMin: DEFAULT_INTERVALS[platform].min,
      postIntervalMax: DEFAULT_INTERVALS[platform].max,
    });
    setDiscordGuilds([]);
    setDiscordChannels([]);
    setSelectedGuildName(null);
    setSelectedChannelName(null);
    setTelegramChats([]);
    setIsScanning(false);
    setExistingTelegramChatName(null);
    setCharacters([]);
    setSelectedCharacterId(null);
    setLoadError(null);
    setIsLoading(true);
  }, [platform]);
  const fetchDiscordChannels = useCallback(
    async (guildId: string): Promise<DiscordChannel[] | null> => {
      setIsLoadingChannels(true);
      try {
        const res = await fetch(`/api/v1/discord/channels?guildId=${guildId}`);
        if (res.ok) {
          const data = await res.json();
          const channels = data.channels || [];
          setDiscordChannels(channels);
          return channels;
        }
        return null;
      } catch {
        setDiscordChannels([]);
        return null;
      } finally {
        setIsLoadingChannels(false);
      }
    },
    [],
  );

  // Fetch initial data
  const fetchData = useCallback(async () => {
    setIsLoading(true);

    try {
      // Fetch characters from the correct endpoint
      const charactersRes = await fetch("/api/my-agents/characters");
      if (charactersRes.ok) {
        const charactersData = await charactersRes.json();
        // The response structure is { success: true, data: { characters: [...] } }
        setCharacters(charactersData.data?.characters || charactersData.characters || []);
      }

      // Store Discord guilds for lookup later
      let fetchedDiscordGuilds: DiscordGuild[] = [];

      // Platform-specific fetches
      if (platform === "discord") {
        // Fetch Discord status and guilds
        const statusRes = await fetch("/api/v1/discord/status");
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          fetchedDiscordGuilds = statusData.guilds || [];
          setDiscordGuilds(fetchedDiscordGuilds);
        }
      }

      // Store Telegram chats for lookup later
      let fetchedTelegramChats: TelegramChat[] = [];

      if (platform === "telegram") {
        fetchedTelegramChats = await loadTelegramChats();
        setTelegramChats(fetchedTelegramChats);
      }

      // If editing, fetch current config
      if (mode === "edit") {
        const configRes = await fetch(`/api/v1/apps/${appId}/${platform}-automation`);
        if (configRes.ok) {
          const configData = await configRes.json();
          setConfig({
            enabled: configData.enabled ?? true,
            guildId: configData.guildId,
            channelId: configData.channelId,
            groupId: configData.groupId,
            autoAnnounce: configData.autoAnnounce ?? true,
            autoPost: configData.autoPost ?? true,
            autoReply: configData.autoReply ?? true,
            announceIntervalMin: configData.announceIntervalMin ?? DEFAULT_INTERVALS[platform].min,
            announceIntervalMax: configData.announceIntervalMax ?? DEFAULT_INTERVALS[platform].max,
            postIntervalMin: configData.postIntervalMin ?? DEFAULT_INTERVALS[platform].min,
            postIntervalMax: configData.postIntervalMax ?? DEFAULT_INTERVALS[platform].max,
            agentCharacterId: configData.agentCharacterId,
            vibeStyle: configData.vibeStyle,
          });
          setSelectedCharacterId(configData.agentCharacterId || null);

          // Fetch channels for the selected guild and set display names
          if (platform === "discord" && configData.guildId) {
            // Set guild name
            const guild = fetchedDiscordGuilds.find((g) => g.id === configData.guildId);
            if (guild) {
              setSelectedGuildName(guild.name);
            } else {
              setSelectedGuildName(`Server ID: ${configData.guildId}`);
            }

            // Fetch channels and set channel name
            const channels = await fetchDiscordChannels(configData.guildId);
            if (configData.channelId && channels) {
              const channel = channels.find((c: DiscordChannel) => c.id === configData.channelId);
              if (channel) {
                setSelectedChannelName(channel.name);
              } else {
                setSelectedChannelName(`Channel ID: ${configData.channelId}`);
              }
            }
          }

          // For Telegram, try to find the chat name from fetched chats
          if (platform === "telegram") {
            const currentChatId = configData.channelId || configData.groupId;
            if (currentChatId) {
              const matchingChat = fetchedTelegramChats.find((c) => c.id === currentChatId);
              if (matchingChat) {
                setExistingTelegramChatName(matchingChat.title);
              } else {
                // Chat not found in list - might be removed or bot lost access
                setExistingTelegramChatName(`Chat ID: ${currentChatId}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
      setLoadError("Failed to load data. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [appId, mode, platform, fetchDiscordChannels]);

  useEffect(() => {
    if (open) {
      // Reset form state before fetching to ensure clean slate
      resetForm();
      fetchData();
    }
  }, [open, fetchData, resetForm]);

  const scanTelegramChats = async () => {
    setIsScanning(true);
    try {
      const chats = await requestTelegramChats("POST");
      setTelegramChats(chats);
      if (chats.length > 0) {
        toast.success(`Found ${chats.length} chat(s)`);
      } else {
        toast.info("No chats found. Send a message in your Telegram group first, then scan again.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to scan for chats");
    } finally {
      setIsScanning(false);
    }
  };

  const handleGuildChange = async (guildId: string) => {
    setConfig((prev) => ({
      ...prev,
      guildId,
      channelId: undefined,
    }));
    setDiscordChannels([]);
    setSelectedChannelName(null);

    // Set guild name
    const guild = discordGuilds.find((g) => g.id === guildId);
    setSelectedGuildName(guild?.name || null);

    if (guildId) {
      await fetchDiscordChannels(guildId);
    }
  };

  const handleSave = async () => {
    // Validate
    if (platform === "discord") {
      if (!config.guildId) {
        toast.error("Please select a Discord server");
        return;
      }
      if (!config.channelId) {
        toast.error("Please select a Discord channel");
        return;
      }
    }

    if (platform === "telegram") {
      if (!config.channelId && !config.groupId) {
        toast.error("Please select a Telegram channel or group");
        return;
      }
    }

    setIsSaving(true);

    try {
      const body: Record<string, unknown> = {
        enabled: true,
        agentCharacterId: selectedCharacterId || undefined,
      };

      if (platform === "discord") {
        body.guildId = config.guildId;
        body.channelId = config.channelId;
        body.autoAnnounce = config.autoAnnounce;
        body.announceIntervalMin = config.announceIntervalMin;
        body.announceIntervalMax = config.announceIntervalMax;
      }

      if (platform === "telegram") {
        body.channelId = config.channelId;
        body.groupId = config.groupId;
        body.autoAnnounce = config.autoAnnounce;
        body.autoReply = config.autoReply;
        body.announceIntervalMin = config.announceIntervalMin;
        body.announceIntervalMax = config.announceIntervalMax;
      }

      if (platform === "twitter") {
        body.autoPost = config.autoPost;
        body.postIntervalMin = config.postIntervalMin;
        body.postIntervalMax = config.postIntervalMax;
      }

      const response = await fetch(`/api/v1/apps/${appId}/${platform}-automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        toast.success(
          mode === "create" ? "Automation set up successfully!" : "Automation updated!",
        );
        onOpenChange(false);
        onSuccess?.();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to save automation");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const getMinIntervalHours = () => {
    const min = platform === "twitter" ? config.postIntervalMin : config.announceIntervalMin;
    return ((min ?? 120) / 60).toFixed(1);
  };

  const getMaxIntervalHours = () => {
    const max = platform === "twitter" ? config.postIntervalMax : config.announceIntervalMax;
    return ((max ?? 240) / 60).toFixed(1);
  };

  const getBioPreview = (bio: string | string[] | undefined): string => {
    if (!bio) return "No description";
    const text = Array.isArray(bio) ? bio[0] : bio;
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-[#0a0a0a] border-l border-white/10 w-full sm:max-w-[420px] overflow-y-auto p-0">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0a0a0a] border-b border-white/10 px-6 py-5">
          <SheetHeader className="space-y-1">
            <SheetTitle className="text-white flex items-center gap-2.5 text-lg font-semibold">
              <div
                className={`p-1.5 rounded-md ${platform === "discord" ? "bg-[#5865F2]/20" : platform === "telegram" ? "bg-[#0088cc]/20" : "bg-sky-500/20"}`}
              >
                <platformConfig.icon className={`h-4 w-4 ${platformConfig.color}`} />
              </div>
              {mode === "create" ? "Set Up" : "Edit"} {platformConfig.name} Automation
            </SheetTitle>
            <SheetDescription className="text-white/50 text-sm">
              {mode === "create"
                ? `Configure automated posting for ${platformConfig.name}`
                : `Update your ${platformConfig.name} automation settings`}
            </SheetDescription>
          </SheetHeader>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-white/30" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 px-6">
            <p className="text-red-400/90 text-sm text-center">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoadError(null);
                fetchData();
              }}
              className="text-white border-white/20 hover:bg-white/5"
            >
              Retry
            </Button>
          </div>
        ) : (
          <div className="px-6 py-6 space-y-8">
            {/* Discord: Server & Channel Selection */}
            {platform === "discord" && (
              <div className="space-y-5">
                <div className="space-y-2.5">
                  <Label className="text-white/90 text-sm font-medium">Server</Label>
                  <Select value={config.guildId || ""} onValueChange={handleGuildChange}>
                    <SelectTrigger className="bg-white/[0.03] border-white/10 text-white h-11 hover:bg-white/[0.05] transition-colors">
                      {config.guildId && selectedGuildName ? (
                        <span className="truncate">{selectedGuildName}</span>
                      ) : (
                        <SelectValue placeholder="Choose a server" />
                      )}
                    </SelectTrigger>
                    <SelectContent className="bg-[#141414] border-white/10">
                      {discordGuilds.length === 0 ? (
                        <div className="p-3 text-center text-white/40 text-sm">
                          No servers found. Add the bot to a server first.
                        </div>
                      ) : (
                        discordGuilds.map((guild) => (
                          <SelectItem
                            key={guild.id}
                            value={guild.id}
                            className="text-white hover:bg-white/10 cursor-pointer"
                          >
                            {guild.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {discordGuilds.length === 0 && (
                    <p className="text-xs text-white/40 leading-relaxed">
                      Your Discord bot needs to be added to at least one server.
                    </p>
                  )}
                </div>

                <div className="space-y-2.5">
                  <Label className="text-white/90 text-sm font-medium">Channel</Label>
                  <Select
                    value={config.channelId || ""}
                    onValueChange={(value) => {
                      setConfig((prev) => ({ ...prev, channelId: value }));
                      const channel = discordChannels.find((c) => c.id === value);
                      setSelectedChannelName(channel?.name || null);
                    }}
                    disabled={!config.guildId || isLoadingChannels}
                  >
                    <SelectTrigger className="bg-white/[0.03] border-white/10 text-white h-11 hover:bg-white/[0.05] transition-colors disabled:opacity-50">
                      {isLoadingChannels ? (
                        <span className="flex items-center gap-2 text-white/60">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </span>
                      ) : config.channelId && selectedChannelName ? (
                        <span className="truncate">#{selectedChannelName}</span>
                      ) : (
                        <SelectValue placeholder="Choose a channel" />
                      )}
                    </SelectTrigger>
                    <SelectContent className="bg-[#141414] border-white/10">
                      {discordChannels.filter((c) => c.type === 0).length === 0 ? (
                        <div className="p-3 text-center text-white/40 text-sm">
                          {config.guildId ? "No text channels found" : "Select a server first"}
                        </div>
                      ) : (
                        discordChannels
                          .filter((c) => c.type === 0)
                          .map((channel) => (
                            <SelectItem
                              key={channel.id}
                              value={channel.id}
                              className="text-white hover:bg-white/10 cursor-pointer"
                            >
                              #{channel.name}
                            </SelectItem>
                          ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Telegram: Channel/Group Selection */}
            {platform === "telegram" && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label className="text-white/90 text-sm font-medium">Channel or Group</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={scanTelegramChats}
                    disabled={isScanning}
                    className="h-7 px-2 text-xs text-white/60 hover:text-white hover:bg-white/10"
                  >
                    {isScanning ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1" />
                    )}
                    Scan
                  </Button>
                </div>
                <Select
                  value={config.channelId || config.groupId || ""}
                  onValueChange={(value) => {
                    const chat = telegramChats.find((c) => c.id === value);
                    if (chat) {
                      setConfig((prev) => ({
                        ...prev,
                        channelId: chat.type === "channel" ? value : undefined,
                        groupId: chat.type !== "channel" ? value : undefined,
                      }));
                      setExistingTelegramChatName(chat.title);
                    }
                  }}
                >
                  <SelectTrigger className="bg-white/[0.03] border-white/10 text-white h-11 hover:bg-white/[0.05] transition-colors">
                    {(config.channelId || config.groupId) && existingTelegramChatName ? (
                      <span className="truncate">{existingTelegramChatName}</span>
                    ) : (
                      <SelectValue placeholder="Choose a channel or group" />
                    )}
                  </SelectTrigger>
                  <SelectContent className="bg-[#141414] border-white/10">
                    {telegramChats.filter((c) => c.canPost).length === 0 ? (
                      <div className="p-3 text-center text-white/40 text-sm">
                        No channels or groups found
                      </div>
                    ) : (
                      telegramChats
                        .filter((c) => c.canPost)
                        .map((chat) => (
                          <SelectItem
                            key={chat.id}
                            value={chat.id}
                            className="text-white hover:bg-white/10 cursor-pointer"
                          >
                            {chat.title}
                            <span className="text-white/40 ml-1.5">({chat.type})</span>
                          </SelectItem>
                        ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-white/40 leading-relaxed">
                  Add your Telegram bot as admin to channels/groups where it should post.
                </p>
                {telegramChats.length === 0 && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <span className="text-xs text-blue-400/90 leading-relaxed">
                      <strong>Tip:</strong> Send a message in your Telegram group/channel first,
                      then click &quot;Scan&quot; to discover it.
                    </span>
                  </div>
                )}
                {telegramChats.length > 0 &&
                  telegramChats.filter((c) => c.canPost).length === 0 && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <span className="text-xs text-amber-400/90 leading-relaxed">
                        Found {telegramChats.length} chats but none have post permissions. Make the
                        bot an admin.
                      </span>
                    </div>
                  )}
                {mode === "edit" &&
                  (config.channelId || config.groupId) &&
                  !telegramChats.find((c) => c.id === (config.channelId || config.groupId)) && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <span className="text-xs text-amber-400/90 leading-relaxed">
                        Previously selected chat may have been removed or bot lost access.
                      </span>
                    </div>
                  )}
              </div>
            )}

            {/* Interval Settings */}
            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-white/90 text-sm font-medium">Post Interval</Label>
                <p className="text-sm text-white/50">
                  Posts every{" "}
                  <span className="text-white/70 font-medium">{getMinIntervalHours()}</span> to{" "}
                  <span className="text-white/70 font-medium">{getMaxIntervalHours()}</span> hours
                </p>
              </div>
              <div className="space-y-5 pt-1">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-white/50">Minimum</span>
                    <span className="text-xs text-white/70 font-medium tabular-nums">
                      {getMinIntervalHours()}h
                    </span>
                  </div>
                  <Slider
                    value={[
                      platform === "twitter"
                        ? (config.postIntervalMin ?? 90)
                        : (config.announceIntervalMin ?? 120),
                    ]}
                    min={30}
                    max={720}
                    step={30}
                    onValueChange={([value]) => {
                      if (platform === "twitter") {
                        setConfig((prev) => ({
                          ...prev,
                          postIntervalMin: value,
                          postIntervalMax: Math.max(value, prev.postIntervalMax ?? 150),
                        }));
                      } else {
                        setConfig((prev) => ({
                          ...prev,
                          announceIntervalMin: value,
                          announceIntervalMax: Math.max(value, prev.announceIntervalMax ?? 240),
                        }));
                      }
                    }}
                    className="w-full [&_[role=slider]]:bg-[#FF5800] [&_[role=slider]]:border-[#FF5800] [&_.bg-primary]:bg-[#FF5800]"
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-white/50">Maximum</span>
                    <span className="text-xs text-white/70 font-medium tabular-nums">
                      {getMaxIntervalHours()}h
                    </span>
                  </div>
                  <Slider
                    value={[
                      platform === "twitter"
                        ? (config.postIntervalMax ?? 150)
                        : (config.announceIntervalMax ?? 240),
                    ]}
                    min={30}
                    max={1440}
                    step={30}
                    onValueChange={([value]) => {
                      if (platform === "twitter") {
                        setConfig((prev) => ({
                          ...prev,
                          postIntervalMax: value,
                          postIntervalMin: Math.min(value, prev.postIntervalMin ?? 90),
                        }));
                      } else {
                        setConfig((prev) => ({
                          ...prev,
                          announceIntervalMax: value,
                          announceIntervalMin: Math.min(value, prev.announceIntervalMin ?? 120),
                        }));
                      }
                    }}
                    className="w-full [&_[role=slider]]:bg-[#FF5800] [&_[role=slider]]:border-[#FF5800] [&_.bg-primary]:bg-[#FF5800]"
                  />
                </div>
              </div>
            </div>

            {/* Telegram: Auto-Reply Toggle */}
            {platform === "telegram" && (
              <div className="flex items-center justify-between gap-4 p-4 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="space-y-0.5">
                  <Label className="text-white/90 text-sm font-medium">Auto-Reply</Label>
                  <p className="text-xs text-white/50">Automatically reply to messages in groups</p>
                </div>
                <Switch
                  checked={config.autoReply ?? true}
                  onCheckedChange={(checked) =>
                    setConfig((prev) => ({ ...prev, autoReply: checked }))
                  }
                  className="data-[state=checked]:bg-[#FF5800]"
                />
              </div>
            )}

            {/* Agent Voice Selection */}
            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-white/90 text-sm font-medium">Agent Voice</Label>
                <p className="text-xs text-white/50">
                  Choose a character to give your posts a unique voice
                </p>
              </div>

              <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                {/* Default AI option */}
                <button
                  type="button"
                  onClick={() => setSelectedCharacterId(null)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                    selectedCharacterId === null
                      ? "border-[#FF5800]/60 bg-[#FF5800]/10"
                      : "border-white/[0.08] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="shrink-0">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-[#FF5800] to-[#FF8C00] flex items-center justify-center">
                      <Bot className="h-5 w-5 text-white" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white/90 font-medium text-sm">Default AI</div>
                    <div className="text-white/50 text-xs truncate">Standard promotional voice</div>
                  </div>
                  {selectedCharacterId === null && (
                    <CheckCircle className="h-5 w-5 text-[#FF5800] shrink-0" />
                  )}
                </button>

                {/* User Characters */}
                {characters.map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    onClick={() => setSelectedCharacterId(character.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                      selectedCharacterId === character.id
                        ? "border-[#FF5800]/60 bg-[#FF5800]/10"
                        : "border-white/[0.08] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="shrink-0">
                      {character.avatar_url || character.avatarUrl ? (
                        <Image
                          src={(character.avatar_url || character.avatarUrl) as string}
                          alt={character.name}
                          width={40}
                          height={40}
                          className="rounded-full object-cover h-10 w-10"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-[#FF5800] to-[#FF8C00] flex items-center justify-center">
                          <span className="text-white font-medium text-sm">
                            {character.name?.charAt(0)?.toUpperCase() || "?"}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white/90 font-medium text-sm">{character.name}</div>
                      <div className="text-white/50 text-xs truncate">
                        {getBioPreview(character.bio)}
                      </div>
                    </div>
                    {selectedCharacterId === character.id && (
                      <CheckCircle className="h-5 w-5 text-[#FF5800] shrink-0" />
                    )}
                  </button>
                ))}

                {characters.length === 0 && (
                  <div className="text-center py-6 text-white/40 text-xs">
                    No characters available. Create one in the Agents section.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-[#0a0a0a] border-t border-white/10 px-6 py-4 mt-auto">
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
              className="text-white/60 hover:text-white hover:bg-white/5"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isLoading || isSaving}
              className="bg-[#FF5800] hover:bg-[#FF5800]/90 text-white min-w-[120px] h-10"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
