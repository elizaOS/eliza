/**
 * Settings → Auto-training panel.
 *
 * Surfaces the auto-train trigger service:
 *   - Toggle autoTrain, edit threshold + cooldown.
 *   - Live counters per training task (polled every 30s).
 *   - "Train now" button per task.
 *   - Recent run history (status, source, datasetSize, finishedAt).
 *
 * Backend contract:
 *   GET    /api/training/auto/status
 *   POST   /api/training/auto/trigger      { task?, backend?, dryRun? }
 *   GET    /api/training/auto/runs?limit=N
 *   GET    /api/training/auto/runs/:runId
 *   GET    /api/training/auto/config
 *   POST   /api/training/auto/config
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
} from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";

type TrainingTask =
  | "should_respond"
  | "context_routing"
  | "action_planner"
  | "response"
  | "media_description";

const ALL_TASKS: TrainingTask[] = [
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
];

interface LastTrainEntry {
  runId: string;
  source: string;
  finishedAt: string;
  status: string;
}

interface AutoTrainStatus {
  autoTrainEnabled: boolean;
  triggerThreshold: number;
  cooldownHours: number;
  counters: Record<TrainingTask, number>;
  lastTrain: Partial<Record<TrainingTask, LastTrainEntry>>;
  perTaskThresholds: Record<TrainingTask, number>;
  perTaskCooldownMs: Record<TrainingTask, number>;
  serviceRegistered: boolean;
}

interface TrainingConfig {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
  backends: string[];
}

interface TrainingRun {
  runId: string;
  status: string;
  reason?: string;
  task: TrainingTask | null;
  backend: string | null;
  source: string;
  datasetSize: number;
  startedAt: string;
  finishedAt: string;
  artifactPath?: string;
}

interface ConfigResponse {
  config: TrainingConfig;
}

interface RunsResponse {
  runs: TrainingRun[];
}

interface TriggerResponse {
  runId: string;
  status: string;
}

const POLL_INTERVAL_MS = 30_000;
const TASK_LABELS: Record<TrainingTask, string> = {
  should_respond: "Should respond",
  context_routing: "Context routing",
  action_planner: "Action planner",
  response: "Response",
  media_description: "Media description",
};

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function statusTone(status: string): string {
  if (status === "succeeded") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "skipped") return "text-muted";
  return "text-txt";
}

export function TrainingSettingsPanel() {
  const [status, setStatus] = useState<AutoTrainStatus | null>(null);
  const [config, setConfig] = useState<TrainingConfig | null>(null);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [triggeringTask, setTriggeringTask] = useState<
    TrainingTask | "any" | null
  >(null);

  // Local-edit state for the config inputs so the user can type freely without
  // every keystroke firing a save.
  const [thresholdDraft, setThresholdDraft] = useState<string>("");
  const [cooldownDraft, setCooldownDraft] = useState<string>("");

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setErrorMessage(null);
    try {
      const [statusRes, configRes, runsRes] = await Promise.all([
        client.fetch<AutoTrainStatus>("/api/training/auto/status"),
        client.fetch<ConfigResponse>("/api/training/auto/config"),
        client.fetch<RunsResponse>("/api/training/auto/runs?limit=20"),
      ]);
      setStatus(statusRes);
      setConfig(configRes.config);
      setRuns(runsRes.runs);
      setThresholdDraft(String(configRes.config.triggerThreshold));
      setCooldownDraft(String(configRes.config.triggerCooldownHours));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => {
      void refresh(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const saveConfig = useCallback(
    async (patch: Partial<TrainingConfig>) => {
      if (!config) return;
      setSavingConfig(true);
      setErrorMessage(null);
      try {
        const next: TrainingConfig = { ...config, ...patch };
        const res = await client.fetch<ConfigResponse>(
          "/api/training/auto/config",
          {
            method: "POST",
            body: JSON.stringify(next),
          },
        );
        setConfig(res.config);
        setThresholdDraft(String(res.config.triggerThreshold));
        setCooldownDraft(String(res.config.triggerCooldownHours));
        await refresh(false);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingConfig(false);
      }
    },
    [config, refresh],
  );

  const handleAutoTrainToggle = useCallback(
    (enabled: boolean) => {
      void saveConfig({ autoTrain: enabled });
    },
    [saveConfig],
  );

  const handleThresholdCommit = useCallback(() => {
    if (!config) return;
    const parsed = Number(thresholdDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setErrorMessage("Threshold must be a positive integer");
      setThresholdDraft(String(config.triggerThreshold));
      return;
    }
    if (Math.floor(parsed) === config.triggerThreshold) return;
    void saveConfig({ triggerThreshold: Math.floor(parsed) });
  }, [config, saveConfig, thresholdDraft]);

  const handleCooldownCommit = useCallback(() => {
    if (!config) return;
    const parsed = Number(cooldownDraft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setErrorMessage("Cooldown hours must be zero or greater");
      setCooldownDraft(String(config.triggerCooldownHours));
      return;
    }
    if (parsed === config.triggerCooldownHours) return;
    void saveConfig({ triggerCooldownHours: parsed });
  }, [config, cooldownDraft, saveConfig]);

  const triggerNow = useCallback(
    async (task: TrainingTask | "any") => {
      setTriggeringTask(task);
      setErrorMessage(null);
      try {
        const body = task === "any" ? {} : { task };
        const res = await client.fetch<TriggerResponse>(
          "/api/training/auto/trigger",
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        await refresh(false);
        if (res.status === "skipped") {
          setErrorMessage(
            `Run ${res.runId} skipped — see Recent Runs for details.`,
          );
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setTriggeringTask(null);
      }
    },
    [refresh],
  );

  const counters = useMemo(() => status?.counters ?? null, [status]);
  const perTaskThresholds = useMemo(
    () => status?.perTaskThresholds ?? null,
    [status],
  );

  return (
    <Card
      className="border-border/60 bg-card/92 shadow-sm"
      data-testid="settings-training-panel"
    >
      <CardHeader className="px-4 py-4 pb-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-sm">Auto-training</CardTitle>
            <CardDescription className="mt-1 text-xs-tight leading-5">
              Counts completed trajectories per task and fires a training run
              when the threshold is hit. Manual triggers ignore the autoTrain
              toggle.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() => void refresh(false)}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-4 pb-4">
        {errorMessage ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs-tight leading-5 text-danger">
            {errorMessage}
          </div>
        ) : null}

        {status && status.serviceRegistered === false ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-xs-tight leading-5 text-amber-200">
            The TrainingTriggerService is not registered on the runtime.
            Counters will not advance until the agent registers it on startup.
          </div>
        ) : null}

        {loading || !config || !status ? (
          <div className="text-2xs text-muted">Loading…</div>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Configuration
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs-tight" htmlFor="auto-train-toggle">
                  Auto-train enabled
                </Label>
                <Switch
                  id="auto-train-toggle"
                  checked={config.autoTrain}
                  disabled={savingConfig}
                  onCheckedChange={(value) => handleAutoTrainToggle(value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label
                    className="text-2xs uppercase tracking-wide text-muted"
                    htmlFor="trigger-threshold"
                  >
                    Trigger threshold (trajectories)
                  </Label>
                  <Input
                    id="trigger-threshold"
                    type="number"
                    min={1}
                    value={thresholdDraft}
                    disabled={savingConfig}
                    onChange={(event) => setThresholdDraft(event.target.value)}
                    onBlur={handleThresholdCommit}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label
                    className="text-2xs uppercase tracking-wide text-muted"
                    htmlFor="cooldown-hours"
                  >
                    Cooldown hours
                  </Label>
                  <Input
                    id="cooldown-hours"
                    type="number"
                    min={0}
                    step="0.5"
                    value={cooldownDraft}
                    disabled={savingConfig}
                    onChange={(event) => setCooldownDraft(event.target.value)}
                    onBlur={handleCooldownCommit}
                  />
                </div>
              </div>
              <div className="text-2xs text-muted">
                Backends:{" "}
                {config.backends.length === 0
                  ? "none configured (threshold firings will skip)"
                  : config.backends.join(", ")}
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Counters
                </div>
                <Button
                  size="sm"
                  variant="default"
                  disabled={triggeringTask !== null}
                  onClick={() => void triggerNow("any")}
                >
                  {triggeringTask === "any"
                    ? "Triggering…"
                    : "Train any task now"}
                </Button>
              </div>
              <ul className="flex flex-col gap-2">
                {ALL_TASKS.map((task) => {
                  const count = counters?.[task] ?? 0;
                  const threshold = perTaskThresholds?.[task] ?? 0;
                  const last = status.lastTrain[task];
                  return (
                    <li
                      key={task}
                      className="flex items-center justify-between gap-3 rounded-md border border-default bg-bg-hover/40 px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <div className="text-xs-tight font-semibold text-txt">
                          {TASK_LABELS[task]}
                        </div>
                        <div className="text-2xs text-muted">
                          {count} / {threshold} trajectories
                          {last
                            ? ` · last: ${last.status} (${last.source}) at ${formatDate(last.finishedAt)}`
                            : " · last: never"}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={triggeringTask !== null}
                        onClick={() => void triggerNow(task)}
                      >
                        {triggeringTask === task ? "Triggering…" : "Train now"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="flex flex-col gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                Recent runs
              </div>
              {runs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-bg-hover/40 px-3 py-3 text-xs-tight leading-5 text-muted">
                  No training runs yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {runs.map((run) => (
                    <li
                      key={run.runId}
                      className="flex flex-col gap-1 rounded-md border border-default bg-bg-hover/40 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono text-2xs text-txt">
                          {run.runId}
                        </div>
                        <div
                          className={`text-2xs font-semibold uppercase tracking-wide ${statusTone(run.status)}`}
                        >
                          {run.status}
                        </div>
                      </div>
                      <div className="text-2xs text-muted">
                        task: {run.task ?? "—"} · backend: {run.backend ?? "—"}{" "}
                        · source: {run.source} · datasetSize: {run.datasetSize}{" "}
                        · finished: {formatDate(run.finishedAt)}
                      </div>
                      {run.reason ? (
                        <div className="text-2xs text-muted">
                          reason: {run.reason}
                        </div>
                      ) : null}
                      {run.artifactPath ? (
                        <div className="text-2xs text-muted">
                          artifact:{" "}
                          <span className="font-mono">{run.artifactPath}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
