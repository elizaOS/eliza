import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type HyperscapeAgentGoalResponse,
  type HyperscapeEmbeddedAgent,
  type HyperscapeEmbeddedAgentControlAction,
  type HyperscapeJsonValue,
  type HyperscapeQuickActionsResponse,
  type HyperscapeScriptedRole,
} from "../../../api";
import { useApp } from "../../../state";
import type { AppDetailExtensionProps } from "./types";

const HYPERSCAPE_COMMAND_OPTIONS = [
  "chat",
  "move",
  "attack",
  "gather",
  "pickup",
  "drop",
  "equip",
  "use",
  "stop",
] as const;

const HYPERSCAPE_SCRIPTED_ROLE_OPTIONS: Array<{
  value: HyperscapeScriptedRole;
  label: string;
}> = [
  { value: "balanced", label: "Balanced" },
  { value: "combat", label: "Combat" },
  { value: "woodcutting", label: "Woodcutting" },
  { value: "fishing", label: "Fishing" },
  { value: "mining", label: "Mining" },
];

function formatHyperscapePosition(
  position: HyperscapeEmbeddedAgent["position"],
): string {
  if (!position) return "n/a";
  if (Array.isArray(position)) {
    const [x, y, z] = position;
    return `${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`;
  }
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

function parseHyperscapeCommandData(
  raw: string,
): { [key: string]: HyperscapeJsonValue } | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as HyperscapeJsonValue;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as { [key: string]: HyperscapeJsonValue };
  } catch {
    return null;
  }
}

export function HyperscapeAppDetailPanel({ app }: AppDetailExtensionProps) {
  const { setActionNotice, t } = useApp();
  const appLabel = app.displayName ?? app.name;
  const [panelOpen, setPanelOpen] = useState(false);
  const [agents, setAgents] = useState<HyperscapeEmbeddedAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [goalResponse, setGoalResponse] =
    useState<HyperscapeAgentGoalResponse | null>(null);
  const [quickActionsResponse, setQuickActionsResponse] =
    useState<HyperscapeQuickActionsResponse | null>(null);
  const [characterIdInput, setCharacterIdInput] = useState("");
  const [scriptedRole, setScriptedRole] = useState<"" | HyperscapeScriptedRole>(
    "",
  );
  const [autoStart, setAutoStart] = useState(true);
  const [messageInput, setMessageInput] = useState("");
  const [command, setCommand] =
    useState<(typeof HYPERSCAPE_COMMAND_OPTIONS)[number]>("chat");
  const [commandDataInput, setCommandDataInput] = useState("{}");

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setError(null);
    try {
      const response = await client.listHyperscapeEmbeddedAgents();
      setAgents(response.agents);
      setSelectedAgentId((current) => {
        if (
          current &&
          response.agents.some((agent) => agent.agentId === current)
        ) {
          return current;
        }
        return response.agents[0]?.agentId ?? "";
      });
      if (response.agents.length === 0) {
        setGoalResponse(null);
        setQuickActionsResponse(null);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load agents";
      setError(message);
      setActionNotice(`Hyperscape controls: ${message}`, "error", 4200);
    } finally {
      setAgentsLoading(false);
    }
  }, [setActionNotice]);

  const refreshTelemetry = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      setTelemetryLoading(true);
      try {
        const [nextGoalResponse, nextQuickActionsResponse] = await Promise.all([
          client.getHyperscapeAgentGoal(agentId),
          client.getHyperscapeAgentQuickActions(agentId),
        ]);
        setGoalResponse(nextGoalResponse);
        setQuickActionsResponse(nextQuickActionsResponse);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load agent telemetry";
        setActionNotice(`Hyperscape telemetry: ${message}`, "error", 4200);
      } finally {
        setTelemetryLoading(false);
      }
    },
    [setActionNotice],
  );

  useEffect(() => {
    if (!panelOpen) return;
    void loadAgents();
  }, [panelOpen, loadAgents]);

  useEffect(() => {
    if (!panelOpen || !selectedAgentId) return;
    void refreshTelemetry(selectedAgentId);
  }, [panelOpen, refreshTelemetry, selectedAgentId]);

  const handleCreateAgent = useCallback(async () => {
    const characterId = characterIdInput.trim();
    if (!characterId) {
      setActionNotice(
        "Character ID is required to create an embedded agent.",
        "error",
        3600,
      );
      return;
    }
    setBusyAction("create");
    try {
      const response = await client.createHyperscapeEmbeddedAgent({
        characterId,
        autoStart,
        scriptedRole: scriptedRole || undefined,
      });
      setActionNotice(
        response.message ?? "Embedded agent created.",
        "success",
        3000,
      );
      setCharacterIdInput("");
      await loadAgents();
      if (response.agent?.agentId) {
        setSelectedAgentId(response.agent.agentId);
        await refreshTelemetry(response.agent.agentId);
      }
    } catch (err) {
      setActionNotice(
        `Failed to create embedded agent: ${err instanceof Error ? err.message : "error"}`,
        "error",
        4200,
      );
    } finally {
      setBusyAction(null);
    }
  }, [
    autoStart,
    characterIdInput,
    loadAgents,
    refreshTelemetry,
    scriptedRole,
    setActionNotice,
  ]);

  const handleControlAgent = useCallback(
    async (action: HyperscapeEmbeddedAgentControlAction) => {
      if (!selectedAgent) {
        setActionNotice("Select an embedded agent first.", "error", 3200);
        return;
      }
      setBusyAction(`control:${action}`);
      try {
        const response = await client.controlHyperscapeEmbeddedAgent(
          selectedAgent.characterId,
          action,
        );
        setActionNotice(
          response.message ?? `Agent ${action} request sent.`,
          "success",
          3000,
        );
        await loadAgents();
        await refreshTelemetry(selectedAgent.agentId);
      } catch (err) {
        setActionNotice(
          `Failed to ${action} agent: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      } finally {
        setBusyAction(null);
      }
    },
    [loadAgents, refreshTelemetry, selectedAgent, setActionNotice],
  );

  const handleSendMessage = useCallback(
    async (contentOverride?: string) => {
      if (!selectedAgent) {
        setActionNotice("Select an embedded agent first.", "error", 3200);
        return;
      }
      const content = (contentOverride ?? messageInput).trim();
      if (!content) {
        setActionNotice("Message cannot be empty.", "error", 3000);
        return;
      }
      setBusyAction("message");
      try {
        const response = await client.sendHyperscapeAgentMessage(
          selectedAgent.agentId,
          content,
        );
        setActionNotice(
          response.message ?? "Message sent to agent.",
          "success",
          3000,
        );
        if (!contentOverride) {
          setMessageInput("");
        }
      } catch (err) {
        setActionNotice(
          `Failed to send message: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      } finally {
        setBusyAction(null);
      }
    },
    [messageInput, selectedAgent, setActionNotice],
  );

  const handleSendCommand = useCallback(async () => {
    if (!selectedAgent) {
      setActionNotice("Select an embedded agent first.", "error", 3200);
      return;
    }
    const nextCommand = command.trim();
    if (!nextCommand) {
      setActionNotice("Command cannot be empty.", "error", 3200);
      return;
    }
    const parsedData = parseHyperscapeCommandData(commandDataInput);
    if (parsedData === null) {
      setActionNotice("Command data must be valid JSON object.", "error", 3600);
      return;
    }
    setBusyAction("command");
    try {
      const response = await client.sendHyperscapeEmbeddedAgentCommand(
        selectedAgent.characterId,
        nextCommand,
        parsedData,
      );
      setActionNotice(
        response.message ?? `Command "${nextCommand}" sent.`,
        "success",
        3000,
      );
      await loadAgents();
      await refreshTelemetry(selectedAgent.agentId);
    } catch (err) {
      setActionNotice(
        `Failed to send command: ${err instanceof Error ? err.message : "error"}`,
        "error",
        4200,
      );
    } finally {
      setBusyAction(null);
    }
  }, [
    command,
    commandDataInput,
    loadAgents,
    refreshTelemetry,
    selectedAgent,
    setActionNotice,
  ]);

  return (
    <div className="flex flex-col gap-3">
      <div className="font-bold text-xs mb-2">{appLabel} Controls</div>
      <Button
        variant="default"
        size="sm"
        className="shadow-sm"
        onClick={() => setPanelOpen((open) => !open)}
      >
        {panelOpen ? `Hide ${appLabel} Controls` : `Show ${appLabel} Controls`}
      </Button>
      {panelOpen ? (
        <div className="flex flex-col gap-3">
          {error ? (
            <div className="p-2 border border-danger text-danger text-xs">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="default"
              size="sm"
              className="shadow-sm"
              disabled={agentsLoading}
              onClick={() => void loadAgents()}
            >
              {agentsLoading ? "Refreshing..." : "Refresh Agents"}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="shadow-sm"
              disabled={telemetryLoading || !selectedAgentId}
              onClick={() => void refreshTelemetry(selectedAgentId)}
            >
              {telemetryLoading
                ? "Loading telemetry..."
                : "Refresh Goal + Quick Actions"}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">
              {t("appsview.EmbeddedAgents")}
              {agents.length})
            </span>
            <select
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
              className="px-3 py-2 border border-border rounded-md bg-card text-txt text-xs focus:border-accent focus:outline-none"
            >
              <option value="">{t("appsview.SelectEmbeddedAgen")}</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name} ({agent.state}) [{agent.agentId}]
                </option>
              ))}
            </select>
            {selectedAgent ? (
              <div className="text-[11px] text-muted">
                {t("appsview.Character")} {selectedAgent.characterId}{" "}
                {t("appsview.Health")} {selectedAgent.health ?? "n/a"} {" / "}
                {selectedAgent.maxHealth ?? "n/a"} {t("appsview.Position")}{" "}
                {formatHyperscapePosition(selectedAgent.position)}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {(["start", "pause", "resume", "stop"] as const).map((action) => (
              <Button
                key={action}
                variant="default"
                size="sm"
                className="shadow-sm"
                disabled={!selectedAgent || busyAction === `control:${action}`}
                onClick={() => void handleControlAgent(action)}
              >
                {busyAction === `control:${action}`
                  ? `${action}...`
                  : action.charAt(0).toUpperCase() + action.slice(1)}
              </Button>
            ))}
          </div>

          <div className="border border-border p-2 flex flex-col gap-2">
            <div className="font-bold text-xs">
              {t("appsview.CreateEmbeddedAgen")}
            </div>
            <Input
              type="text"
              value={characterIdInput}
              onChange={(event) => setCharacterIdInput(event.target.value)}
              placeholder={t("appsview.CharacterID")}
              className="h-9 bg-card border-border text-xs"
            />
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={scriptedRole}
                onChange={(event) =>
                  setScriptedRole(
                    event.target.value as "" | HyperscapeScriptedRole,
                  )
                }
                className="px-3 py-2 border border-border rounded-md bg-card text-txt text-xs focus:border-accent focus:outline-none"
              >
                <option value="">{t("appsview.NoScriptedRole")}</option>
                {HYPERSCAPE_SCRIPTED_ROLE_OPTIONS.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(event) => setAutoStart(event.target.checked)}
                />
                {t("appsview.AutoStart")}
              </span>
              <Button
                variant="default"
                size="sm"
                className="shadow-sm"
                disabled={busyAction === "create"}
                onClick={() => void handleCreateAgent()}
              >
                {busyAction === "create" ? "Creating..." : "Create Agent"}
              </Button>
            </div>
          </div>

          <div className="border border-border p-2 flex flex-col gap-2">
            <div className="font-bold text-xs">{t("appsview.SendMessage")}</div>
            <textarea
              rows={2}
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              placeholder={t("appsview.SaySomethingToSel")}
              className="px-3 py-2 border border-border rounded-md bg-card text-txt text-xs focus:border-accent focus:outline-none resize-y"
            />
            <Button
              variant="default"
              size="sm"
              className="shadow-sm self-start"
              disabled={busyAction === "message"}
              onClick={() => void handleSendMessage()}
            >
              {busyAction === "message" ? "Sending..." : "Send Message"}
            </Button>
          </div>

          <div className="border border-border p-2 flex flex-col gap-2">
            <div className="font-bold text-xs">{t("appsview.SendCommand")}</div>
            <select
              value={command}
              onChange={(event) =>
                setCommand(
                  event.target
                    .value as (typeof HYPERSCAPE_COMMAND_OPTIONS)[number],
                )
              }
              className="px-3 py-2 border border-border rounded-md bg-card text-txt text-xs focus:border-accent focus:outline-none"
            >
              {HYPERSCAPE_COMMAND_OPTIONS.map((commandOption) => (
                <option key={commandOption} value={commandOption}>
                  {commandOption}
                </option>
              ))}
            </select>
            <textarea
              rows={2}
              value={commandDataInput}
              onChange={(event) => setCommandDataInput(event.target.value)}
              placeholder={t("appsview.Target000")}
              className="px-3 py-2 border border-border rounded-md bg-card text-txt text-xs focus:border-accent focus:outline-none resize-y"
            />
            <Button
              variant="default"
              size="sm"
              className="shadow-sm self-start"
              disabled={busyAction === "command"}
              onClick={() => void handleSendCommand()}
            >
              {busyAction === "command" ? "Sending..." : "Send Command"}
            </Button>
          </div>

          <div className="border border-border p-2 flex flex-col gap-2">
            <div className="font-bold text-xs">
              {t("appsview.GoalQuickActions")}
            </div>
            <div className="text-xs text-muted">
              {goalResponse?.goal ? (
                <>
                  Goal: {goalResponse.goal.description ?? "unknown"}
                  {typeof goalResponse.goal.progressPercent === "number"
                    ? ` (${goalResponse.goal.progressPercent}%)`
                    : ""}
                </>
              ) : (
                (goalResponse?.message ??
                "No active goal loaded for the selected agent.")
              )}
            </div>

            {goalResponse?.availableGoals?.length ? (
              <div className="flex flex-wrap gap-1">
                {goalResponse.availableGoals.slice(0, 8).map((goal) => (
                  <span
                    key={goal.id}
                    className="text-[10px] px-1.5 py-0.5 border border-border text-muted"
                    title={goal.description}
                  >
                    {goal.type}
                  </span>
                ))}
              </div>
            ) : null}

            {quickActionsResponse?.quickCommands?.length ? (
              <div className="flex flex-wrap gap-1">
                {quickActionsResponse.quickCommands.map((quickCommand) => (
                  <button
                    type="button"
                    key={quickCommand.id}
                    className="text-[10px] px-2 py-1 border border-border bg-card text-txt cursor-pointer hover:bg-accent hover:text-accent-fg disabled:opacity-40"
                    disabled={
                      !quickCommand.available || busyAction === "message"
                    }
                    onClick={() => void handleSendMessage(quickCommand.command)}
                    title={quickCommand.reason ?? quickCommand.command}
                  >
                    {quickCommand.label}
                  </button>
                ))}
              </div>
            ) : null}

            {quickActionsResponse?.nearbyLocations?.length ? (
              <div className="text-[11px] text-muted">
                {t("appsview.Nearby")}{" "}
                {quickActionsResponse.nearbyLocations
                  .slice(0, 4)
                  .map((location) => `${location.name} (${location.distance})`)
                  .join(", ")}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
