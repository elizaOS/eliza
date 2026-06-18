/**
 * HyperscapeSpatialView - the Hyperscape operator surface authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the app run/session contracts, so it is safe to render in the Node agent
 * process where the terminal lives (no `@elizaos/app-core` runtime import).
 *
 * The Hyperscape canvas itself is an embedded iframe viewer that cannot render
 * in a terminal; this view is the operator panel around it (run health, viewer
 * attachment, session goal, pause/resume controls, suggested prompts, and the
 * recent activity feed) - the part that is meaningful on every surface.
 */

import type {
  AppRunEvent,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionActivityItem,
  AppSessionControlAction,
  AppSessionJsonValue,
  AppSessionState,
} from "@elizaos/shared";
import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

export interface HyperscapeSnapshot {
  /** Latest run summary for the Hyperscape app, or `null` when none is live. */
  run: AppRunSummary | null;
}

export interface HyperscapeActivityRow {
  id: string;
  label: string;
  detail: string;
}

function statusTone(status: string | undefined): SpatialTone {
  switch (status) {
    case "running":
    case "ready":
      return "success";
    case "degraded":
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

function healthTone(state: AppRunSummary["health"]["state"]): SpatialTone {
  switch (state) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    default:
      return "danger";
  }
}

function viewerTone(attachment: AppRunViewerAttachment): SpatialTone {
  switch (attachment) {
    case "attached":
      return "success";
    case "detached":
      return "warning";
    default:
      return "muted";
  }
}

function eventTone(severity: AppRunEvent["severity"]): SpatialTone {
  switch (severity) {
    case "error":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "muted";
  }
}

function activityTone(
  severity: AppSessionActivityItem["severity"],
): SpatialTone {
  switch (severity) {
    case "error":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "muted";
  }
}

function asTelemetryRecord(
  value: Record<string, AppSessionJsonValue> | null | undefined,
): Record<string, AppSessionJsonValue> | null {
  return value && typeof value === "object" ? value : null;
}

/** Recent run events + session activity + telemetry activity, newest first. */
export function extractActivity(run: AppRunSummary): HyperscapeActivityRow[] {
  const rows: Array<HyperscapeActivityRow & { tone: SpatialTone }> = [];

  for (const event of run.recentEvents ?? []) {
    rows.push({
      id: event.eventId,
      label: event.kind,
      detail: event.message,
      tone: eventTone(event.severity),
    });
  }

  for (const item of run.session?.activity ?? []) {
    rows.push({
      id: item.id,
      label: item.type,
      detail: item.message,
      tone: activityTone(item.severity),
    });
  }

  const telemetry = asTelemetryRecord(run.session?.telemetry);
  const telemetryActivity = telemetry?.recentActivity;
  if (Array.isArray(telemetryActivity)) {
    for (const [index, item] of telemetryActivity.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, AppSessionJsonValue>;
      const action =
        typeof record.action === "string" ? record.action : "activity";
      rows.push({
        id: `${action}-${index}`,
        label: action,
        detail:
          typeof record.detail === "string"
            ? record.detail
            : "No detail captured.",
        tone: "muted",
      });
    }
  }

  return rows.slice(0, 6);
}

const CONTROL_LABEL: Record<AppSessionControlAction, string> = {
  pause: "Pause",
  resume: "Resume",
};

function StatusHeader({ run }: { run: AppRunSummary }) {
  return (
    <HStack gap={1} align="center">
      <Text style="caption" tone={statusTone(run.status)} grow={1}>
        {run.status}
      </Text>
      <Text style="caption" tone={viewerTone(run.viewerAttachment)}>
        {`viewer:${run.viewerAttachment}`}
      </Text>
    </HStack>
  );
}

function SessionFacts({ session }: { session: AppSessionState }) {
  return (
    <VStack gap={0}>
      {session.goalLabel ? (
        <Text wrap>{`Goal: ${session.goalLabel}`}</Text>
      ) : null}
      {session.followEntity ? (
        <Text style="caption" tone="muted" wrap={false}>
          {`Following ${session.followEntity}`}
        </Text>
      ) : null}
      {session.summary ? (
        <Text style="caption" tone="muted" wrap>
          {session.summary}
        </Text>
      ) : null}
    </VStack>
  );
}

export interface HyperscapeSpatialViewProps {
  snapshot: HyperscapeSnapshot;
  /**
   * Dispatch by agent id: `control:pause`, `control:resume`,
   * `prompt:<text>`, `refresh`.
   */
  onAction?: (action: string) => void;
}

export function HyperscapeSpatialView({
  snapshot,
  onAction,
}: HyperscapeSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const { run } = snapshot;

  if (!run) {
    return (
      <Card title="Hyperscape" gap={1} padding={1}>
        <Text tone="muted" align="center" style="caption">
          No active Hyperscape run
        </Text>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </Card>
    );
  }

  const session = run.session;
  const activity = extractActivity(run);
  const controls = session?.controls ?? [];
  const suggestedPrompts = session?.suggestedPrompts ?? [];
  const canSendCommands = session?.canSendCommands ?? false;

  return (
    <Card title="Hyperscape" gap={1} padding={1}>
      <StatusHeader run={run} />

      <HStack gap={1} align="center">
        <Text style="caption" tone={healthTone(run.health.state)} grow={1}>
          {`health:${run.health.state}`}
        </Text>
        {session?.mode ? (
          <Text style="caption" tone="muted">
            {session.mode}
          </Text>
        ) : null}
      </HStack>

      {run.health.message ? (
        <Text tone={healthTone(run.health.state)} style="caption" wrap>
          {run.health.message}
        </Text>
      ) : null}

      {session ? <SessionFacts session={session} /> : null}

      {run.awaySummary ? (
        <Text style="caption" tone="muted" wrap>
          {`Away: ${run.awaySummary.message}`}
        </Text>
      ) : null}

      <Divider label="controls" />
      {controls.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No controls available
        </Text>
      ) : (
        <HStack gap={1} wrap>
          {controls.map((control) => (
            <Button
              key={control}
              grow={1}
              tone={control === "pause" ? "warning" : "primary"}
              agent={`control-${control}`}
              onPress={dispatch(`control:${control}`)}
            >
              {CONTROL_LABEL[control]}
            </Button>
          ))}
          <Button
            variant="outline"
            tone="default"
            agent="refresh"
            onPress={dispatch("refresh")}
          >
            Refresh
          </Button>
        </HStack>
      )}

      <Divider label="prompts" />
      {!canSendCommands ? (
        <Text tone="muted" align="center" style="caption">
          Commands disabled
        </Text>
      ) : suggestedPrompts.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No suggested prompts
        </Text>
      ) : (
        <VStack gap={0}>
          {suggestedPrompts.slice(0, 4).map((prompt) => (
            <Button
              key={prompt}
              variant="ghost"
              tone="default"
              width="100%"
              agent={`prompt-${prompt}`}
              onPress={dispatch(`prompt:${prompt}`)}
            >
              {prompt}
            </Button>
          ))}
        </VStack>
      )}

      <Divider label="activity" />
      {activity.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No recent activity
        </Text>
      ) : (
        <List gap={0}>
          {activity.map((row) => (
            <HStack key={row.id} gap={1} align="start">
              <Text tone="muted" wrap={false}>
                -
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {row.label}
                </Text>
                <Text style="caption" tone="muted" wrap>
                  {row.detail}
                </Text>
              </VStack>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}
