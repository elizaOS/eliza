import {
  type AppOperatorSurfaceProps,
  type AppSessionJsonValue,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type Ref,
  useCallback,
  useMemo,
  useState,
} from "react";
import { postAppRunCommand } from "./TwoThousandFourScapeOperatorSurface.helpers";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "default";
  size?: "sm" | "default";
  ref?: Ref<HTMLButtonElement>;
};

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function Button({
  className,
  variant,
  size,
  type = "button",
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "outline"
          ? "border border-border bg-transparent hover:bg-muted/50"
          : "bg-primary text-primary-foreground hover:bg-primary/90",
        size === "sm" ? "h-9" : "h-10",
        className,
      )}
      {...props}
    />
  );
}

function TuiSuggestedPromptButton({
  prompt,
  index,
  disabled,
  onSelect,
}: {
  prompt: string;
  index: number;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "tui-steering-suggestions",
    description: `Send the suggested instruction "${prompt}" to the bot`,
    onActivate: () => onSelect(prompt),
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(prompt)}
      style={tuiButtonStyle}
      {...agentProps}
    >
      {prompt}
    </button>
  );
}

function TuiCommandInput({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "tui-command",
    role: "text-input",
    label: "Operator command",
    group: "tui-steering",
    description: "Type an operator instruction to send to the bot",
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <input
      ref={ref}
      aria-label="2004scape command"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      placeholder="Send an operator instruction..."
      style={tuiInputStyle}
      {...agentProps}
    />
  );
}

function TuiSendCommandButton({
  disabled,
  onActivate,
}: {
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "tui-send-command",
    role: "button",
    label: "Send command",
    group: "tui-steering",
    description: "Send the typed operator command to the bot",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onActivate}
      style={tuiButtonStyle}
      {...agentProps}
    >
      send command
    </button>
  );
}

export function TwoThousandFourScapeTuiView() {
  const { appRuns, setActionNotice } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp("@elizaos/plugin-2004scape", appRuns),
    [appRuns],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const session = run?.session ?? null;
  const telemetry =
    session?.telemetry && typeof session.telemetry === "object"
      ? session.telemetry
      : null;
  const player = asRecord(telemetry?.player);
  const tutorial = asRecord(telemetry?.tutorial);
  const nearbyTargets = extractNearbyTargets(telemetry);
  const recentActivity = extractRecentActivity(telemetry);
  const suggestedPrompts = Array.isArray(session?.suggestedPrompts)
    ? session.suggestedPrompts.filter(
        (prompt: unknown): prompt is string =>
          typeof prompt === "string" && prompt.trim().length > 0,
      )
    : [];
  const autoPlayEnabled =
    readBooleanValue(telemetry, "autoPlay") ?? session?.status !== "paused";
  const viewState = {
    viewType: "tui",
    viewId: "2004scape",
    appName: "@elizaos/plugin-2004scape",
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    sessionStatus: session?.status ?? null,
    canSend: Boolean(session?.canSendCommands),
    activeRunCount: matchingRuns.length,
    autoPlayEnabled,
    player: {
      name: readStringValue(player, "name"),
      worldX: readNumberValue(player, "worldX"),
      worldZ: readNumberValue(player, "worldZ"),
      hp: readNumberValue(player, "hp"),
      maxHp: readNumberValue(player, "maxHp"),
    },
    tutorialActive: readBooleanValue(tutorial, "active") ?? false,
    nearbyTargetCount: nearbyTargets.length,
    recentActivityCount: recentActivity.length,
    suggestedPromptCount: suggestedPrompts.length,
  };

  const sendDraft = async (content: string) => {
    const trimmed = content.trim();
    if (!run?.runId || !trimmed || sending) return;
    setSending(true);
    try {
      const response = await postAppRunCommand(run.runId, "message", {
        content: trimmed,
      });
      setActionNotice(
        response.message,
        response.success ? "success" : "error",
        2600,
      );
      setDraft("");
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to send the 2004scape operator message.",
        "error",
        3200,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-view-state={JSON.stringify(viewState)} style={tuiRootStyle}>
      <div style={tuiRouteStyle}>elizaos://2004scape --type=tui</div>
      <div data-status={run?.status ?? "idle"} style={tuiMetaStyle}>
        {run?.status ?? "idle"} | {formatPlayerState(player)} | autoplay{" "}
        {autoPlayEnabled ? "on" : "off"}
      </div>
      <section style={tuiPanelStyle} aria-label="2004scape state">
        <strong style={tuiTitleStyle}>2004scape</strong>
        <div>run {run?.runId ?? "none"}</div>
        <div>session {session?.sessionId ?? "none"}</div>
        <div>
          commands {session?.canSendCommands ? "available" : "unavailable"}
        </div>
        <div>nearby targets {nearbyTargets.length}</div>
        <div style={tuiSubtleStyle}>suggested prompts</div>
        {(suggestedPrompts.length
          ? suggestedPrompts
          : ["check status", "continue tutorial", "pause"]
        )
          .slice(0, 6)
          .map((prompt, index) => (
            <TuiSuggestedPromptButton
              key={prompt}
              prompt={prompt}
              index={index}
              disabled={!session?.canSendCommands || sending}
              onSelect={(value) => void sendDraft(value)}
            />
          ))}
        <TuiCommandInput
          value={draft}
          disabled={!session?.canSendCommands || sending}
          onChange={setDraft}
          onSubmit={() => void sendDraft(draft)}
        />
        <TuiSendCommandButton
          disabled={!session?.canSendCommands || sending || !draft.trim()}
          onActivate={() => void sendDraft(draft)}
        />
      </section>
    </div>
  );
}

const tuiRootStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#020617",
  color: "#cbd5e1",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  padding: 20,
};
const tuiRouteStyle: CSSProperties = { color: "#7dd3fc", marginBottom: 4 };
const tuiMetaStyle: CSSProperties = { color: "#475569", marginBottom: 16 };
const tuiPanelStyle: CSSProperties = {
  border: "1px solid rgba(125,211,252,0.3)",
  borderRadius: 6,
  padding: 16,
  maxWidth: 760,
};
const tuiTitleStyle: CSSProperties = {
  display: "block",
  color: "#e2e8f0",
  marginBottom: 10,
};
const tuiSubtleStyle: CSSProperties = { color: "#64748b", marginTop: 14 };
const tuiButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  margin: "8px 0",
  background: "transparent",
  color: "#a7f3d0",
  border: "1px solid rgba(167,243,208,0.45)",
  borderRadius: 4,
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
};
const tuiInputStyle: CSSProperties = {
  width: "100%",
  marginTop: 14,
  background: "#020617",
  color: "#e2e8f0",
  border: "1px solid rgba(125,211,252,0.35)",
  borderRadius: 4,
  padding: "8px",
  fontFamily: "inherit",
};

function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      className={joinClasses(
        "flex w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

interface RecentActivityEntry {
  id: string;
  action?: string;
  detail?: string;
  ts?: string | number;
}

interface GameplayNote {
  id: string;
  label: string;
  detail: string;
}

interface NearbyTarget {
  id: string;
  name: string;
  distance: number | null;
  action: string | null;
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function sanitizeViewerLocation(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function extractRecentActivity(
  telemetry: Record<string, AppSessionJsonValue> | null | undefined,
): RecentActivityEntry[] {
  const recentActivity = telemetry?.recentActivity;
  if (!Array.isArray(recentActivity)) return [];
  const entries: Array<RecentActivityEntry | null> = recentActivity.map(
    (entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;
      const record = entry as Record<string, AppSessionJsonValue>;
      const normalizedEntry: RecentActivityEntry = {
        id: [
          typeof record.action === "string" ? record.action : "activity",
          typeof record.ts === "string" || typeof record.ts === "number"
            ? String(record.ts)
            : "unknown",
          typeof record.detail === "string" ? record.detail : "detail",
        ].join("-"),
        action: typeof record.action === "string" ? record.action : undefined,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        ts:
          typeof record.ts === "string" || typeof record.ts === "number"
            ? record.ts
            : undefined,
      };
      return normalizedEntry;
    },
  );
  return entries
    .filter((entry): entry is RecentActivityEntry => entry !== null)
    .slice(-4)
    .reverse();
}

function asRecord(
  value: AppSessionJsonValue | null | undefined,
): Record<string, AppSessionJsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, AppSessionJsonValue>)
    : null;
}

function asArray(
  value: AppSessionJsonValue | null | undefined,
): AppSessionJsonValue[] {
  return Array.isArray(value) ? value : [];
}

function readStringValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumberValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function formatDistance(distance: number | null): string {
  return distance === null ? "nearby" : `${distance.toFixed(1)} tiles`;
}

function formatPlayerState(
  player: Record<string, AppSessionJsonValue> | null,
): string {
  if (!player) return "Waiting for live player telemetry.";
  const worldX = readNumberValue(player, "worldX");
  const worldZ = readNumberValue(player, "worldZ");
  const hp = readNumberValue(player, "hp");
  const maxHp = readNumberValue(player, "maxHp");
  const coordText =
    worldX !== null && worldZ !== null
      ? `${worldX}, ${worldZ}`
      : "Coords pending";
  const hpText =
    hp !== null && maxHp !== null ? `${hp}/${maxHp} HP` : "HP pending";
  return `${coordText} · ${hpText}`;
}

function extractNearbyTargets(
  telemetry: Record<string, AppSessionJsonValue> | null,
): NearbyTarget[] {
  const npcTargets = asArray(telemetry?.nearbyNpcs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const options = asArray(entry.optionsWithIndex)
        .map((option) => asRecord(option))
        .filter(
          (option): option is Record<string, AppSessionJsonValue> =>
            option !== null,
        );
      return {
        id: `npc-${index}-${readStringValue(entry, "name") ?? "target"}`,
        name: readStringValue(entry, "name") ?? "Unknown NPC",
        distance: readNumberValue(entry, "distance"),
        action:
          readStringValue(options[0], "text") ??
          (options.length > 0 ? "Interact" : null),
      } satisfies NearbyTarget;
    });

  const locTargets = asArray(telemetry?.nearbyLocs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const options = asArray(entry.optionsWithIndex)
        .map((option) => asRecord(option))
        .filter(
          (option): option is Record<string, AppSessionJsonValue> =>
            option !== null,
        );
      return {
        id: `loc-${index}-${readStringValue(entry, "name") ?? "target"}`,
        name: readStringValue(entry, "name") ?? "Unknown object",
        distance: readNumberValue(entry, "distance"),
        action:
          readStringValue(options[0], "text") ??
          (options.length > 0 ? "Interact" : null),
      } satisfies NearbyTarget;
    });

  return [...npcTargets, ...locTargets]
    .sort((left, right) => (left.distance ?? 999) - (right.distance ?? 999))
    .slice(0, 4);
}

function extractGameplayNotes(
  telemetry: Record<string, AppSessionJsonValue> | null,
): GameplayNote[] {
  const gameMessages = asArray(telemetry?.gameMessages)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => ({
      id: `message-${index}`,
      label: readStringValue(entry, "sender") ?? "Game",
      detail: readStringValue(entry, "text") ?? "No message text.",
    }));
  const recentDialogs = asArray(telemetry?.recentDialogs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const parts = asArray(entry.text).filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      );
      return {
        id: `dialog-${index}`,
        label: "Dialog",
        detail: parts.join(" ").trim() || "Dialog prompt pending.",
      } satisfies GameplayNote;
    });

  return [...recentDialogs, ...gameMessages].slice(-4).reverse();
}

function summarizeInventoryAndSkills(
  telemetry: Record<string, AppSessionJsonValue> | null,
): string {
  const inventory = asArray(telemetry?.inventory)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry) => {
      const name = readStringValue(entry, "name") ?? "Item";
      const amount = readNumberValue(entry, "amount");
      return amount && amount > 1 ? `${name} x${amount}` : name;
    })
    .slice(0, 4);
  const skills = asArray(telemetry?.skills)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry) => {
      const name = readStringValue(entry, "name") ?? "Skill";
      const level = readNumberValue(entry, "level");
      return level !== null ? `${name} ${level}` : name;
    })
    .slice(0, 4);
  const parts = [skills.join(" · "), inventory.join(" · ")].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0
    ? parts.join(" | ")
    : "No inventory or skill data yet.";
}

function SuggestedPromptButton({
  prompt,
  index,
  onSelect,
}: {
  prompt: string;
  index: number;
  onSelect: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "steering-suggestions",
    description: `Send the suggested instruction "${prompt}" to the bot`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className="min-h-10 rounded-xl px-3 shadow-sm"
      onClick={() => onSelect(prompt)}
      {...agentProps}
    >
      {prompt}
    </Button>
  );
}

function ControlButton({
  action,
  label,
  onActivate,
}: {
  action: "pause" | "resume";
  label: string;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `control-${action}`,
    role: "button",
    label,
    group: "steering-controls",
    description: `${label} the 2004scape autonomous session`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className="min-h-10 rounded-xl px-3 shadow-sm"
      onClick={onActivate}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function OperatorMessageInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "operator-message",
    role: "text-input",
    label: "Operator instruction",
    group: "steering",
    description: "Tell the bot what to train, where to go, or what to say",
  });
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Tell the bot what to train, where to go, or what to say."
      className="min-h-11 rounded-xl"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit();
        }
      }}
      disabled={disabled}
      {...agentProps}
    />
  );
}

function SendMessageButton({
  sending,
  disabled,
  onActivate,
}: {
  sending: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "send-message",
    role: "button",
    label: "Send",
    group: "steering",
    description: "Send the typed operator instruction to the bot",
  });
  return (
    <Button
      ref={ref}
      type="button"
      className="min-h-11 rounded-xl px-4 shadow-sm"
      onClick={onActivate}
      disabled={disabled}
      {...agentProps}
    >
      {sending ? "Sending" : "Send"}
    </Button>
  );
}

export function TwoThousandFourScapeOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );
  const [operatorMessage, setOperatorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const session = run?.session ?? null;
  const telemetry =
    session?.telemetry && typeof session.telemetry === "object"
      ? session.telemetry
      : null;
  const suggestedPrompts: string[] = Array.isArray(session?.suggestedPrompts)
    ? session.suggestedPrompts
        .filter(
          (prompt: unknown): prompt is string =>
            typeof prompt === "string" && prompt.trim().length > 0,
        )
        .slice(0, 2)
    : [];
  const recentActivity = extractRecentActivity(telemetry).slice(0, 2);
  const tutorial = asRecord(telemetry?.tutorial);
  const player = asRecord(telemetry?.player);
  const combatStyle = asRecord(telemetry?.combatStyle);
  const nearbyTargets = extractNearbyTargets(telemetry).slice(0, 3);
  const gameplayNotes = extractGameplayNotes(telemetry).slice(0, 2);
  const autoPlayEnabled =
    readBooleanValue(telemetry, "autoPlay") ?? session?.status !== "paused";
  const intentLabel =
    readStringValue(telemetry, "intent") ??
    (session?.status === "paused" ? "paused" : "tutorial");
  const tutorialActive = readBooleanValue(tutorial, "active") ?? false;
  const tutorialPrompt =
    readStringValue(tutorial, "prompt") ??
    (tutorialActive
      ? "Working through the starter flow."
      : "Tutorial is clear.");
  const surfaceTitle =
    variant === "live"
      ? "2004scape Live Dashboard"
      : variant === "running"
        ? "2004scape Run Surface"
        : "2004scape Operator Surface";
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const viewerLocation = sanitizeViewerLocation(run?.viewer?.url);
  const botUsername = firstNonEmptyString(
    readStringValue(telemetry, "botName"),
    typeof run?.viewer?.embedParams?.bot === "string"
      ? run.viewer.embedParams.bot
      : null,
    run?.viewer?.authMessage?.authToken,
    session?.characterId,
  );
  const hasAutoLoginCredentials = Boolean(
    run?.viewer?.postMessageAuth &&
      run.viewer.authMessage?.authToken &&
      run.viewer.authMessage?.sessionToken,
  );
  const autoLoginLabel = run?.viewer?.postMessageAuth
    ? hasAutoLoginCredentials
      ? "Credentials stored"
      : "Waiting for stored credentials"
    : "Manual login required";
  const autoLoginSubtitle = botUsername ?? viewerLocation ?? undefined;
  const runtimeLabel =
    session?.status === "running"
      ? "Connected to 2004scape"
      : session?.status === "paused"
        ? "Loop paused"
        : session?.status === "connecting"
          ? "Connecting to 2004scape"
          : session?.status === "disconnected"
            ? "Waiting for the game gateway"
            : run?.supportsBackground
              ? "Continuous background run"
              : "Foreground session only";
  const runtimeTone =
    session?.status === "running"
      ? "success"
      : run?.health.state === "offline"
        ? "danger"
        : run?.health.state === "degraded" || session?.status === "disconnected"
          ? "warn"
          : "neutral";
  const steeringReady = Boolean(session?.canSendCommands && session?.sessionId);
  const steeringLabel = steeringReady
    ? "Live steering ready"
    : session?.sessionId
      ? "Bridge reconnecting"
      : "Waiting for command bridge";
  const steeringSubtitle = session?.sessionId
    ? `Session ${session.sessionId}`
    : `Run ${run?.runId ?? "pending"}`;
  const viewerLabel =
    run?.viewerAttachment === "attached"
      ? "Viewer attached"
      : run?.viewerAttachment === "detached"
        ? "Viewer detached"
        : "Viewer unavailable";
  const viewerSubtitle =
    run?.viewerAttachment === "unavailable" ? viewerLocation : undefined;
  const tutorialLabel = tutorialActive
    ? "Tutorial in progress"
    : "Tutorial clear";
  const tutorialTone = tutorialActive ? "warn" : "success";
  const tutorialSubtitle = tutorialPrompt;
  const loopLabel = autoPlayEnabled ? "Autoplay active" : "Autoplay paused";
  const loopSubtitle =
    session?.summary ??
    run?.summary ??
    "Waiting for the 2004scape runtime to report live state.";
  const playerLabel = formatPlayerState(player);
  const playerSubtitle = [
    readStringValue(player, "name"),
    readStringValue(combatStyle, "weaponName"),
    readStringValue(combatStyle, "activeStyle"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const fieldIntelLabel =
    nearbyTargets.length > 0
      ? nearbyTargets
          .map((target) =>
            target.action ? `${target.name} (${target.action})` : target.name,
          )
          .join(" · ")
      : "No nearby targets reported yet.";
  const fieldIntelSubtitle = summarizeInventoryAndSkills(telemetry);

  const sendOperatorMessage = useCallback(
    async (content: string) => {
      if (!run || content.length === 0 || sending) return false;

      setSending(true);
      setStatusMessage(null);
      try {
        if (run.runId) {
          const response = await postAppRunCommand(run.runId, "message", {
            content,
          });
          setStatusMessage(response.message ?? "Operator message sent.");
          return response.success;
        }
        setStatusMessage("Waiting for the 2004scape command bridge.");
        return false;
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send the 2004scape operator message.",
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [run, sending],
  );

  const handleSendMessage = useCallback(async () => {
    const content = operatorMessage.trim();
    if (content.length === 0) return;
    const sent = await sendOperatorMessage(content);
    if (sent) {
      setOperatorMessage("");
    }
  }, [operatorMessage, sendOperatorMessage]);

  const handleSuggestedPrompt = useCallback(
    async (prompt: string) => {
      await sendOperatorMessage(prompt.trim());
    },
    [sendOperatorMessage],
  );

  const handleControl = useCallback(
    async (action: "pause" | "resume") => {
      if (!run) return;
      setStatusMessage(null);
      try {
        const response = await postAppRunCommand(run.runId, "control", {
          action,
        });
        setStatusMessage(
          response.message ??
            (action === "pause"
              ? "2004scape session paused."
              : "2004scape session resumed."),
        );
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : `Failed to ${action} the 2004scape session.`,
        );
      }
    },
    [run],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="2004scape operator surface"
        body="Launch 2004scape to verify auto-login, background runtime, and the live agent loop here."
      />
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "2004scape-live-operator-surface"
          : variant === "running"
            ? "2004scape-running-operator-surface"
            : "2004scape-detail-operator-surface"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          {surfaceTitle}
        </div>
        <SurfaceBadge tone={toneForStatusText(run.status)}>
          {run.status}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForHealthState(run.health.state)}>
          {matchingRuns.length}
        </SurfaceBadge>
      </div>

      {showDashboard ? (
        <SurfaceSection title="Runtime">
          <div className="space-y-2">
            <SurfaceCard
              label="Login"
              value={autoLoginLabel}
              tone={hasAutoLoginCredentials ? "success" : "warn"}
              subtitle={autoLoginSubtitle}
            />
            <SurfaceCard
              label="Autoplay"
              value={loopLabel}
              tone={runtimeTone}
              subtitle={loopSubtitle}
            />
            <SurfaceCard
              label="Tutorial"
              value={tutorialLabel}
              tone={tutorialTone}
              subtitle={tutorialSubtitle}
            />
            <SurfaceCard
              label="Steering"
              value={steeringLabel}
              tone={steeringReady ? "success" : "warn"}
              subtitle={steeringSubtitle}
            />
          </div>
        </SurfaceSection>
      ) : null}

      {showDashboard ? (
        <SurfaceSection title="Live State">
          <div className="space-y-2">
            <SurfaceCard
              label="Goal"
              value={session?.goalLabel ?? "No goal recorded."}
              subtitle={session?.summary ?? run.summary ?? undefined}
            />
            <SurfaceCard
              label="Current Intent"
              value={intentLabel}
              subtitle={
                runtimeLabel !== "Connected to 2004scape"
                  ? runtimeLabel
                  : (run.health.message ?? "Live loop is responding.")
              }
            />
            <SurfaceCard
              label="Player"
              value={playerLabel}
              subtitle={playerSubtitle || undefined}
            />
            <SurfaceCard
              label="Viewer"
              value={viewerLabel}
              tone={toneForViewerAttachment(run.viewerAttachment)}
              subtitle={viewerSubtitle}
            />
            <SurfaceCard
              label="Field Intel"
              value={fieldIntelLabel}
              subtitle={fieldIntelSubtitle}
            />
          </div>
          {nearbyTargets.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Nearby Targets
              </div>
              <div className="space-y-2">
                {nearbyTargets.map((target) => (
                  <div
                    key={target.id}
                    className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                      <span>{target.name}</span>
                      <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                        {formatDistance(target.distance)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                      {target.action ? target.action : "No action"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {gameplayNotes.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Game Feed
              </div>
              {gameplayNotes.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                >
                  <div className="text-xs-tight font-medium text-txt">
                    {entry.label}
                  </div>
                  <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                    {entry.detail}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {recentActivity.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Recent Activity
              </div>
              {recentActivity.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                    <span>{entry.action ?? "activity"}</span>
                    <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                      {formatDetailTimestamp(entry.ts)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                    {entry.detail ?? "No detail captured."}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2 text-xs-tight italic text-muted">
              No activity.
            </div>
          )}
        </SurfaceSection>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Steering">
          {suggestedPrompts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestedPrompts.map((prompt, index) => (
                <SuggestedPromptButton
                  key={prompt}
                  prompt={prompt}
                  index={index}
                  onSelect={(value) => void handleSuggestedPrompt(value)}
                />
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {session?.controls?.includes("pause") ? (
              <ControlButton
                action="pause"
                label="Pause session"
                onActivate={() => void handleControl("pause")}
              />
            ) : null}
            {session?.controls?.includes("resume") ? (
              <ControlButton
                action="resume"
                label="Resume session"
                onActivate={() => void handleControl("resume")}
              />
            ) : null}
          </div>
          <div className="grid gap-2">
            <OperatorMessageInput
              value={operatorMessage}
              onChange={setOperatorMessage}
              onSubmit={() => void handleSendMessage()}
              disabled={!session?.sessionId}
            />
            <SendMessageButton
              sending={sending}
              disabled={
                sending ||
                !session?.sessionId ||
                operatorMessage.trim().length === 0
              }
              onActivate={() => void handleSendMessage()}
            />
          </div>
        </SurfaceSection>
      ) : null}

      {statusMessage ? (
        <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
          {statusMessage}
        </div>
      ) : null}
    </section>
  );
}
