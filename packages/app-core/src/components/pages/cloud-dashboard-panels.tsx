import {
  Button,
  Input,
  SectionCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useIntervalWhenDocumentVisible,
} from "@elizaos/ui";
import {
  ChevronDown,
  ExternalLink,
  Github,
  Loader2,
  MessageCircle,
  Settings2,
  ShieldAlert,
  Terminal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloudCompatAgent,
  type CloudCompatDiscordConfig,
  type CloudCompatManagedDiscordStatus,
  type CloudCompatManagedGithubStatus,
  client,
} from "../../api";
import { getVrmPreviewUrl, useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { STATUS_BADGE } from "./cloud-dashboard-utils";

export function AgentStatusBadge({ status }: { status: string }) {
  const { t } = useApp();
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.stopped;
  return (
    <span
      className={`text-2xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${badge?.className}`}
    >
      {t(badge?.i18nKey)}
    </span>
  );
}

export function CloudAgentCard({
  agent,
  onDelete,
  deleting,
  launching,
  onLaunch,
  onOpenUI,
  openingUI,
  onSelect,
  selected = false,
}: {
  agent: CloudCompatAgent;
  onDelete: (id: string) => void;
  deleting: boolean;
  launching: boolean;
  onLaunch: (id: string) => void;
  onOpenUI: (id: string) => void;
  openingUI: boolean;
  onSelect?: (id: string) => void;
  selected?: boolean;
}) {
  const { t } = useApp();
  return (
    // biome-ignore lint/a11y/useSemanticElements: cannot use button due to nested buttons
    <div
      className={`flex cursor-pointer flex-col justify-between gap-4 rounded-2xl border p-5 transition-all duration-200 ${
        selected
          ? "border-accent/45 bg-accent/8 shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.12),0_14px_30px_rgba(0,0,0,0.12)]"
          : "border-border/60 bg-card/88 shadow-sm hover:border-accent/30"
      }`}
      onClick={() => onSelect?.(agent.agent_id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(agent.agent_id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {(() => {
            const agentName = agent.agent_name ?? "";
            const avatarIndex =
              (agentName
                .split("")
                .reduce((acc, c) => acc + c.charCodeAt(0), 0) %
                8) +
              1;
            return (
              <img
                src={getVrmPreviewUrl(avatarIndex)}
                alt={agentName}
                className="w-7 h-7 rounded-full object-cover shrink-0 border border-border/40"
              />
            );
          })()}
          <span className="max-w-[16rem] truncate text-sm font-bold text-txt-strong">
            {agent.agent_name || t("elizaclouddashboard.unnamedAgent")}
          </span>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <div className="space-y-1 text-xs-tight text-muted">
        <div className="flex items-center justify-between gap-3">
          <span>{t("elizaclouddashboard.node")}</span>
          <span className="truncate font-mono text-txt-strong/70">
            {agent.node_id?.slice(0, 8) ?? "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>{t("elizaclouddashboard.created")}</span>
          <span className="text-right text-txt-strong/70">
            {new Date(agent.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          size="sm"
          className="h-9 flex-1 rounded-xl border-border/40 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onLaunch(agent.agent_id);
          }}
          disabled={launching}
        >
          {launching ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <ExternalLink className="w-3 h-3 mr-1" />
          )}
          {t("elizaclouddashboard.open")}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-xl border-danger/30 px-0 text-xs text-danger hover:bg-danger/10 sm:w-10"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(agent.agent_id);
          }}
          disabled={deleting || launching}
        >
          {deleting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action toggle labels (display name → config key)
// ---------------------------------------------------------------------------

const ACTION_TOGGLES: Array<{
  key: keyof NonNullable<CloudCompatDiscordConfig["actions"]>;
  label: string;
}> = [
  { key: "reactions", label: "Reactions" },
  { key: "stickers", label: "Stickers" },
  { key: "emojiUploads", label: "Emoji Uploads" },
  { key: "stickerUploads", label: "Sticker Uploads" },
  { key: "polls", label: "Polls" },
  { key: "permissions", label: "Permissions" },
  { key: "messages", label: "Messages" },
  { key: "threads", label: "Threads" },
  { key: "pins", label: "Pins" },
  { key: "search", label: "Search" },
  { key: "memberInfo", label: "Member Info" },
  { key: "roleInfo", label: "Role Info" },
  { key: "roles", label: "Roles" },
  { key: "channelInfo", label: "Channel Info" },
  { key: "voiceStatus", label: "Voice Status" },
  { key: "events", label: "Events" },
  { key: "moderation", label: "Moderation" },
  { key: "channels", label: "Channels" },
  { key: "presence", label: "Presence" },
];

// ---------------------------------------------------------------------------
// DiscordSettingsPanel — expandable advanced config
// ---------------------------------------------------------------------------

function DiscordSettingsPanel({
  agentId,
  setActionNotice,
  t,
}: {
  agentId: string;
  setActionNotice: (
    msg: string,
    kind?: "success" | "error" | "info",
    duration?: number,
  ) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<CloudCompatDiscordConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await client.getCloudCompatAgentDiscordConfig(agentId);
      setConfig(res.data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [agentId]);

  useEffect(() => {
    if (expanded && !config && !loadError) {
      void fetchConfig();
    }
  }, [expanded, config, loadError, fetchConfig]);

  const patch = (partial: Partial<CloudCompatDiscordConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...partial } : prev));
    setDirty(true);
  };

  const patchDm = (
    partial: Partial<NonNullable<CloudCompatDiscordConfig["dm"]>>,
  ) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            dm: {
              ...(prev.dm ?? {}),
              ...partial,
            },
          }
        : prev,
    );
    setDirty(true);
  };

  const patchActions = (
    key: keyof NonNullable<CloudCompatDiscordConfig["actions"]>,
    value: boolean,
  ) => {
    setConfig((prev) => ({
      ...prev,
      actions: { ...prev?.actions, [key]: value },
    }));
    setDirty(true);
  };

  const patchIntents = (
    partial: Partial<NonNullable<CloudCompatDiscordConfig["intents"]>>,
  ) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            intents: {
              ...(prev.intents ?? {}),
              ...partial,
            },
          }
        : prev,
    );
    setDirty(true);
  };

  const patchFlagSetting = (
    key: "execApprovals" | "pluralkit",
    enabled: boolean,
  ) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            [key]: {
              ...(prev[key] ?? {}),
              enabled,
            },
          }
        : prev,
    );
    setDirty(true);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await client.updateCloudCompatAgentDiscordConfig(
        agentId,
        config,
      );
      setConfig(res.data);
      setDirty(false);
      setActionNotice(
        t("elizaclouddashboard.DiscordSettingsSaved", {
          defaultValue: "Discord settings saved.",
        }),
        "success",
        3000,
      );
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.DiscordSettingsSaveFailed", {
              defaultValue: "Failed to save Discord settings.",
            }),
        "error",
        4200,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/25 bg-bg/40">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
          <Settings2 className="h-3 w-3" />
          {t("elizaclouddashboard.DiscordSettings", {
            defaultValue: "Discord Settings",
          })}
        </span>
        <ChevronDown
          className={`h-3 w-3 text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="space-y-3 px-3 pb-3 pt-3">
          {loadError ? (
            <p className="text-xs-tight text-muted">
              {t("elizaclouddashboard.DiscordSettingsLoadError", {
                defaultValue:
                  "Could not load Discord settings. The cloud endpoint may not be available yet.",
              })}
            </p>
          ) : !config ? (
            <div className="flex items-center gap-2 text-xs-tight text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("common.loading", { defaultValue: "Loading..." })}
            </div>
          ) : (
            <>
              {/* ── DM Policy ─────────────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordDmPolicy", {
                    defaultValue: "DM Policy",
                  })}
                </span>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordDmEnabled", {
                        defaultValue: "DMs enabled",
                      })}
                    </span>
                    <Switch
                      checked={config.dm?.enabled ?? true}
                      onCheckedChange={(v: boolean) => patchDm({ enabled: v })}
                      className="scale-75"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordDmPolicyLabel", {
                        defaultValue: "Policy",
                      })}
                    </span>
                    <Select
                      value={config.dm?.policy ?? "pairing"}
                      onValueChange={(v: string) =>
                        patchDm({
                          policy: v as "open" | "pairing" | "allowlist",
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-28 rounded-md border-border/40 bg-bg/80 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="pairing">Pairing</SelectItem>
                        <SelectItem value="allowlist">Allowlist</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordGroupDms", {
                        defaultValue: "Group DMs",
                      })}
                    </span>
                    <Switch
                      checked={config.dm?.groupEnabled ?? false}
                      onCheckedChange={(v: boolean) =>
                        patchDm({ groupEnabled: v })
                      }
                      className="scale-75"
                    />
                  </div>
                </div>
              </div>

              {/* ── Guild Settings ────────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordGuildSettings", {
                    defaultValue: "Guild Settings",
                  })}
                </span>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordRequireMention", {
                        defaultValue: "Require @mention",
                      })}
                    </span>
                    <Switch
                      checked={config.requireMention ?? false}
                      onCheckedChange={(v: boolean) =>
                        patch({ requireMention: v })
                      }
                      className="scale-75"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordReactionNotifs", {
                        defaultValue: "Reaction notifications",
                      })}
                    </span>
                    <Select
                      value={config.reactionNotifications ?? "off"}
                      onValueChange={(v: string) =>
                        patch({
                          reactionNotifications: v as
                            | "off"
                            | "own"
                            | "all"
                            | "allowlist",
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-28 rounded-md border-border/40 bg-bg/80 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="own">Own</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="allowlist">Allowlist</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* ── Action Toggles ────────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordActions", {
                    defaultValue: "Action Toggles",
                  })}
                </span>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {ACTION_TOGGLES.map(({ key, label }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-xs-tight text-txt-strong">
                        {label}
                      </span>
                      <Switch
                        checked={config.actions?.[key] ?? true}
                        onCheckedChange={(v: boolean) => patchActions(key, v)}
                        className="scale-[0.6]"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Message Formatting ────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordFormatting", {
                    defaultValue: "Message Formatting",
                  })}
                </span>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <span className="mb-1 block text-xs-tight text-muted">
                      {t("elizaclouddashboard.DiscordMaxLines", {
                        defaultValue: "Max lines per message",
                      })}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      value={config.maxLinesPerMessage ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        patch({
                          maxLinesPerMessage: v ? Number(v) : undefined,
                        });
                      }}
                      className="h-7 rounded-md bg-bg/80 text-xs"
                      placeholder="Default"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs-tight text-muted">
                      {t("elizaclouddashboard.DiscordChunkLimit", {
                        defaultValue: "Text chunk limit",
                      })}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      value={config.textChunkLimit ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        patch({
                          textChunkLimit: v ? Number(v) : undefined,
                        });
                      }}
                      className="h-7 rounded-md bg-bg/80 text-xs"
                      placeholder="Default"
                    />
                  </div>
                </div>
              </div>

              {/* ── Intents ───────────────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordIntents", {
                    defaultValue: "Privileged Intents",
                  })}
                </span>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordPresenceIntent", {
                        defaultValue: "Presence",
                      })}
                    </span>
                    <Switch
                      checked={config.intents?.presence ?? false}
                      onCheckedChange={(v: boolean) =>
                        patchIntents({ presence: v })
                      }
                      className="scale-75"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordGuildMembersIntent", {
                        defaultValue: "Guild Members",
                      })}
                    </span>
                    <Switch
                      checked={config.intents?.guildMembers ?? false}
                      onCheckedChange={(v: boolean) =>
                        patchIntents({ guildMembers: v })
                      }
                      className="scale-75"
                    />
                  </div>
                  <p className="text-2xs leading-relaxed text-warn">
                    {t("elizaclouddashboard.DiscordIntentsWarning", {
                      defaultValue:
                        "Privileged intents require opt-in via the Discord Developer Portal. Enable them there first or the bot will fail to connect.",
                    })}
                  </p>
                </div>
              </div>

              {/* ── Advanced ──────────────────────────────── */}
              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.DiscordAdvanced", {
                    defaultValue: "Advanced",
                  })}
                </span>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordPluralKit", {
                        defaultValue: "PluralKit integration",
                      })}
                    </span>
                    <Switch
                      checked={config.pluralkit?.enabled ?? false}
                      onCheckedChange={(v: boolean) =>
                        patchFlagSetting("pluralkit", v)
                      }
                      className="scale-75"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-txt-strong">
                      {t("elizaclouddashboard.DiscordExecApprovals", {
                        defaultValue: "Exec approvals via DM",
                      })}
                    </span>
                    <Switch
                      checked={config.execApprovals?.enabled ?? false}
                      onCheckedChange={(v: boolean) =>
                        patchFlagSetting("execApprovals", v)
                      }
                      className="scale-75"
                    />
                  </div>
                </div>
              </div>

              {/* ── Save Button ───────────────────────────── */}
              <Button
                variant="default"
                size="sm"
                className="h-8 w-full rounded-xl text-xs font-semibold"
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : null}
                {t("elizaclouddashboard.DiscordSaveSettings", {
                  defaultValue: "Save Discord Settings",
                })}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface StatusDetail {
  status?: string;
  databaseStatus?: string;
  lastHeartbeat?: string | number | Date | null;
}

export function AgentDetailSidebar({
  agent,
  onClose,
}: {
  agent: CloudCompatAgent | undefined;
  onClose: () => void;
}) {
  const { t, setActionNotice } = useApp();
  const [logs, setLogs] = useState<string>("");
  const [statusDetail, setStatusDetail] = useState<StatusDetail | null>(null);
  const [managedDiscord, setManagedDiscord] =
    useState<CloudCompatManagedDiscordStatus | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);
  const [botNickname, setBotNickname] = useState("");
  const [managedGithub, setManagedGithub] =
    useState<CloudCompatManagedGithubStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);
  const lastAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const fetchDetails = useCallback(async () => {
    if (!agent) return;
    try {
      const [statusRes, logsRes, discordRes, githubRes] = await Promise.all([
        client.getCloudCompatAgentStatus(agent.agent_id),
        client.getCloudCompatAgentLogs(agent.agent_id, 100),
        client
          .getCloudCompatAgentManagedDiscord(agent.agent_id)
          .catch(() => null),
        client
          .getCloudCompatAgentManagedGithub(agent.agent_id)
          .catch(() => null),
      ]);

      if (!aliveRef.current) return;
      setStatusDetail(statusRes.data);
      setLogs(typeof logsRes.data === "string" ? logsRes.data : "");
      setManagedDiscord(discordRes?.data ?? null);
      setManagedGithub(githubRes?.data ?? null);
      if (
        !lastAgentIdRef.current ||
        lastAgentIdRef.current !== agent.agent_id
      ) {
        lastAgentIdRef.current = agent.agent_id;
        setBotNickname(discordRes?.data?.botNickname ?? agent.agent_name ?? "");
      }
    } catch {
      // Silently retry next tick
    }
  }, [agent]);

  useEffect(() => {
    void fetchDetails();
  }, [fetchDetails]);

  useIntervalWhenDocumentVisible(
    () => {
      void fetchDetails();
    },
    5000,
    Boolean(agent),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: rerun when logs update
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  if (!agent) return null;

  const discordAdminLabel =
    managedDiscord?.adminDiscordDisplayName ||
    managedDiscord?.adminDiscordUsername ||
    managedDiscord?.adminDiscordUserId;

  const handleConnectDiscord = async () => {
    if (!agent) return;
    setDiscordBusy(true);
    try {
      const response = await client.createCloudCompatAgentManagedDiscordOauth(
        agent.agent_id,
        {
          returnUrl:
            typeof window !== "undefined" ? window.location.href : undefined,
          botNickname: botNickname.trim() || undefined,
        },
      );

      await openExternalUrl(response.data.authorizeUrl);
      setActionNotice(
        t("elizaclouddashboard.DiscordSetupContinuesInBrowser", {
          defaultValue:
            "Finish Discord setup in your browser, then return here.",
        }),
        "info",
        5000,
      );
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.DiscordSetupFailed", {
              defaultValue: "Failed to start Discord setup.",
            }),
        "error",
        4200,
      );
    } finally {
      if (aliveRef.current) {
        setDiscordBusy(false);
      }
    }
  };

  const handleDisconnectDiscord = async () => {
    if (!agent) return;
    setDiscordBusy(true);
    try {
      const response = await client.disconnectCloudCompatAgentManagedDiscord(
        agent.agent_id,
      );
      if (!aliveRef.current) return;
      setManagedDiscord(response.data);
      setActionNotice(
        t("elizaclouddashboard.DiscordDisconnected", {
          defaultValue: "Managed Discord disconnected from this agent.",
        }),
        "success",
        4200,
      );
      void fetchDetails();
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.DiscordDisconnectFailed", {
              defaultValue: "Failed to disconnect managed Discord.",
            }),
        "error",
        4200,
      );
    } finally {
      if (aliveRef.current) {
        setDiscordBusy(false);
      }
    }
  };

  const handleConnectGithub = async () => {
    if (!agent) return;
    setGithubBusy(true);
    try {
      const response = await client.createCloudCompatAgentManagedGithubOauth(
        agent.agent_id,
      );

      await openExternalUrl(response.data.authorizeUrl);
      setActionNotice(
        t("elizaclouddashboard.GitHubSetupContinuesInBrowser", {
          defaultValue:
            "Finish GitHub authorization in your browser, then return here.",
        }),
        "info",
        5000,
      );
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.GitHubSetupFailed", {
              defaultValue: "Failed to start GitHub setup.",
            }),
        "error",
        4200,
      );
    } finally {
      if (aliveRef.current) {
        setGithubBusy(false);
      }
    }
  };

  const handleDisconnectGithub = async () => {
    if (!agent) return;
    setGithubBusy(true);
    try {
      const response = await client.disconnectCloudCompatAgentManagedGithub(
        agent.agent_id,
      );
      if (!aliveRef.current) return;
      setManagedGithub(response.data);
      setActionNotice(
        t("elizaclouddashboard.GitHubDisconnected", {
          defaultValue: "GitHub disconnected from this agent.",
        }),
        "success",
        4200,
      );
      void fetchDetails();
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.GitHubDisconnectFailed", {
              defaultValue: "Failed to disconnect GitHub.",
            }),
        "error",
        4200,
      );
    } finally {
      if (aliveRef.current) {
        setGithubBusy(false);
      }
    }
  };

  return (
    <div className="space-y-4 animate-in slide-in-from-right-8 duration-300">
      <SectionCard
        title={t("elizaclouddashboard.agentDetails")}
        className="relative overflow-hidden rounded-3xl border-accent/30 bg-card/92 shadow-sm backdrop-blur-xl"
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-4 right-4 p-1 rounded-full text-muted hover:text-txt-strong"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </Button>

        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border/40 bg-bg/40 p-3">
              <span className="text-2xs text-muted uppercase font-bold tracking-wider mb-1 block">
                {t("elizaclouddashboard.Status", {
                  defaultValue: "Status",
                })}
              </span>
              <AgentStatusBadge status={statusDetail?.status || agent.status} />
            </div>
            <div className="rounded-xl border border-border/40 bg-bg/40 p-3">
              <span className="text-2xs text-muted uppercase font-bold tracking-wider mb-1 block">
                {t("elizaclouddashboard.DatabaseStatus", {
                  defaultValue: "DB Status",
                })}
              </span>
              <span className="text-xs font-mono">
                {statusDetail?.databaseStatus || agent.database_status || "—"}
              </span>
            </div>
            <div className="rounded-xl border border-border/40 bg-bg/40 p-3 sm:col-span-2">
              <span className="text-2xs text-muted uppercase font-bold tracking-wider mb-1 block">
                {t("elizaclouddashboard.Heartbeat", {
                  defaultValue: "Heartbeat",
                })}
              </span>
              <span className="text-xs font-mono">
                {statusDetail?.lastHeartbeat
                  ? new Date(statusDetail.lastHeartbeat).toLocaleString()
                  : agent.last_heartbeat_at
                    ? new Date(agent.last_heartbeat_at).toLocaleString()
                    : t("elizaclouddashboard.NoHeartbeatYet", {
                        defaultValue: "No heartbeat yet",
                      })}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-border/40 bg-bg/80 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-2xs text-muted uppercase font-bold tracking-wider flex items-center gap-2">
                <MessageCircle className="w-3 h-3" />
                {t("elizaclouddashboard.Discord", {
                  defaultValue: "Discord",
                })}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-2xs font-bold uppercase tracking-wider ${
                  managedDiscord?.connected
                    ? "border-ok/30 bg-ok/10 text-ok"
                    : "border-border/50 bg-bg/50 text-muted"
                }`}
              >
                {managedDiscord?.connected
                  ? t("common.connected", {
                      defaultValue: "Connected",
                    })
                  : t("common.notConnected", {
                      defaultValue: "Not connected",
                    })}
              </span>
            </div>

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                  <span className="mb-1 block text-2xs font-bold uppercase tracking-wider text-muted">
                    {t("elizaclouddashboard.Server", {
                      defaultValue: "Server",
                    })}
                  </span>
                  <span className="text-xs text-txt-strong">
                    {managedDiscord?.guildName ||
                      t("elizaclouddashboard.NoServerLinkedYet", {
                        defaultValue: "No server linked yet",
                      })}
                  </span>
                </div>
                <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                  <span className="mb-1 block text-2xs font-bold uppercase tracking-wider text-muted">
                    {t("elizaclouddashboard.AdminLock", {
                      defaultValue: "Admin lock",
                    })}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-txt-strong">
                    {managedDiscord?.adminDiscordAvatarUrl ? (
                      <img
                        src={managedDiscord.adminDiscordAvatarUrl}
                        alt={
                          discordAdminLabel
                            ? `@${discordAdminLabel}`
                            : "Discord owner"
                        }
                        className="h-5 w-5 rounded-full border border-border/40 object-cover"
                      />
                    ) : null}
                    <span>
                      {discordAdminLabel
                        ? `@${discordAdminLabel}`
                        : t("elizaclouddashboard.WhoeverLinksBecomesAdmin", {
                            defaultValue:
                              "Whoever completes setup becomes admin",
                          })}
                    </span>
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                <span className="mb-2 block text-2xs font-bold uppercase tracking-wider text-muted">
                  {t("elizaclouddashboard.BotNickname", {
                    defaultValue: "Bot nickname",
                  })}
                </span>
                <Input
                  value={botNickname}
                  maxLength={32}
                  onChange={(event) => setBotNickname(event.target.value)}
                  className="h-9 rounded-lg bg-bg/80 text-sm"
                  placeholder={agent.agent_name || "Eliza"}
                />
                <p className="mt-2 text-xs-tight leading-relaxed text-muted">
                  {managedDiscord?.configured
                    ? t("elizaclouddashboard.DiscordAdminLockCopy", {
                        defaultValue:
                          "The Discord account that finishes setup must own the server. That account becomes the only Discord connector admin for role-gated actions on this agent.",
                      })
                    : t("elizaclouddashboard.DiscordManagedAppUnavailable", {
                        defaultValue:
                          "The shared Discord app is not configured on Eliza Cloud yet.",
                      })}
                </p>
                {managedDiscord?.applicationId ? (
                  <p className="mt-1 text-xs-tight text-muted">
                    {t("elizaclouddashboard.SharedAppId", {
                      defaultValue: "Shared app ID: {{id}}",
                      id: managedDiscord.applicationId,
                    })}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="h-9 rounded-xl px-4 text-xs font-semibold"
                  disabled={discordBusy || !managedDiscord?.configured}
                  onClick={() => void handleConnectDiscord()}
                >
                  {discordBusy ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-1.5 h-3 w-3" />
                  )}
                  {managedDiscord?.connected
                    ? t("elizaclouddashboard.ReconnectDiscord", {
                        defaultValue: "Reconnect / change server",
                      })
                    : t("elizaclouddashboard.ConnectDiscord", {
                        defaultValue: "Connect Discord",
                      })}
                </Button>
                {managedDiscord?.connected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-xl border-danger/30 px-4 text-xs text-danger hover:bg-danger/10"
                    disabled={discordBusy}
                    onClick={() => void handleDisconnectDiscord()}
                  >
                    <Unplug className="mr-1.5 h-3 w-3" />
                    {t("elizaclouddashboard.DisconnectDiscord", {
                      defaultValue: "Disconnect",
                    })}
                  </Button>
                ) : null}
              </div>

              {managedDiscord?.connectedAt ? (
                <div className="flex items-start gap-2 rounded-lg border border-border/25 bg-bg/40 px-3 py-2 text-xs-tight text-muted">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {t("elizaclouddashboard.DiscordConnectedAt", {
                      defaultValue: "Linked {{time}}",
                      time: new Date(
                        managedDiscord.connectedAt,
                      ).toLocaleString(),
                    })}
                  </span>
                </div>
              ) : null}

              {managedDiscord?.connected ? (
                <DiscordSettingsPanel
                  agentId={agent.agent_id}
                  setActionNotice={setActionNotice}
                  t={t}
                />
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border/40 bg-bg/80 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-2xs text-muted uppercase font-bold tracking-wider flex items-center gap-2">
                <Github className="w-3 h-3" />
                {t("elizaclouddashboard.GitHub", {
                  defaultValue: "GitHub",
                })}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-2xs font-bold uppercase tracking-wider ${
                  managedGithub?.connected
                    ? "border-ok/30 bg-ok/10 text-ok"
                    : "border-border/50 bg-bg/50 text-muted"
                }`}
              >
                {managedGithub?.connected
                  ? t("common.connected", {
                      defaultValue: "Connected",
                    })
                  : t("common.notConnected", {
                      defaultValue: "Not connected",
                    })}
              </span>
            </div>

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                  <span className="mb-1 block text-2xs font-bold uppercase tracking-wider text-muted">
                    {t("elizaclouddashboard.GitHubAccount", {
                      defaultValue: "Account",
                    })}
                  </span>
                  <span className="text-xs text-txt-strong">
                    {managedGithub?.githubUsername
                      ? `@${managedGithub.githubUsername}`
                      : t("elizaclouddashboard.NoGitHubLinkedYet", {
                          defaultValue: "No account linked yet",
                        })}
                  </span>
                </div>
                <div className="rounded-lg border border-border/30 bg-bg/55 p-3">
                  <span className="mb-1 block text-2xs font-bold uppercase tracking-wider text-muted">
                    {t("elizaclouddashboard.GitHubScopes", {
                      defaultValue: "Scopes",
                    })}
                  </span>
                  <span className="text-xs text-txt-strong font-mono">
                    {managedGithub?.scopes?.length
                      ? managedGithub.scopes.join(", ")
                      : "—"}
                  </span>
                </div>
              </div>

              <p className="text-xs-tight leading-relaxed text-muted">
                {managedGithub?.configured
                  ? t("elizaclouddashboard.GitHubOAuthCopy", {
                      defaultValue:
                        "Connect your GitHub account to let this agent push code, create pull requests, and manage issues on your behalf.",
                    })
                  : t("elizaclouddashboard.GitHubOAuthUnavailable", {
                      defaultValue:
                        "GitHub OAuth is not configured on Eliza Cloud yet.",
                    })}
              </p>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="h-9 rounded-xl px-4 text-xs font-semibold"
                  disabled={githubBusy || !managedGithub?.configured}
                  onClick={() => void handleConnectGithub()}
                >
                  {githubBusy ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <Github className="mr-1.5 h-3 w-3" />
                  )}
                  {managedGithub?.connected
                    ? t("elizaclouddashboard.ReconnectGitHub", {
                        defaultValue: "Reconnect / change account",
                      })
                    : t("elizaclouddashboard.ConnectGitHub", {
                        defaultValue: "Connect GitHub",
                      })}
                </Button>
                {managedGithub?.connected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-xl border-danger/30 px-4 text-xs text-danger hover:bg-danger/10"
                    disabled={githubBusy}
                    onClick={() => void handleDisconnectGithub()}
                  >
                    <Unplug className="mr-1.5 h-3 w-3" />
                    {t("elizaclouddashboard.DisconnectGitHub", {
                      defaultValue: "Disconnect",
                    })}
                  </Button>
                ) : null}
              </div>

              {managedGithub?.connectedAt ? (
                <div className="flex items-start gap-2 rounded-lg border border-border/25 bg-bg/40 px-3 py-2 text-xs-tight text-muted">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {t("elizaclouddashboard.GitHubConnectedAt", {
                      defaultValue: "Linked {{time}}",
                      time: new Date(
                        managedGithub.connectedAt,
                      ).toLocaleString(),
                    })}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border/40 bg-bg/80 p-3">
            <span className="text-2xs text-muted uppercase font-bold tracking-wider mb-2 flex items-center gap-2">
              <Terminal className="w-3 h-3" />{" "}
              {t("elizaclouddashboard.LiveLogs", {
                defaultValue: "Live Logs",
              })}
            </span>
            <div className="custom-scrollbar h-64 overflow-y-auto rounded-lg border border-border/30 bg-bg/65 p-3">
              <pre className="text-2xs font-mono text-txt-strong/85 whitespace-pre-wrap break-all">
                {logs ||
                  t("elizaclouddashboard.NoLogsAvailableDeploying", {
                    defaultValue: "No logs available. Deploying...",
                  })}
                <div ref={logsEndRef} />
              </pre>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
