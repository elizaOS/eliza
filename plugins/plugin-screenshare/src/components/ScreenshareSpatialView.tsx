/**
 * ScreenshareSpatialView - the screen-share operator surface authored once with
 * the spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no DOM/browser import).
 *
 * The actual screen pixels are streamed in the external viewer page; this view
 * is the session manager + capability dashboard (status, platform, frame/input
 * counters, capabilities, connection details, and operator actions).
 */

import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

export type ScreenshareSessionStatus = "active" | "stopped" | "idle";

export interface ScreenshareSessionSnapshot {
  id: string;
  label: string;
  status: ScreenshareSessionStatus;
  platform: string;
  frameCount: number;
  inputCount: number;
  /** Pre-formatted clock/relative time, or null when never. */
  lastFrameAt: string | null;
  lastInputAt: string | null;
}

export interface ScreenshareCapabilitySnapshot {
  name: string;
  available: boolean;
  /** Backing tool/primitive name (e.g. the computeruse provider). */
  tool: string;
}

export interface ScreenshareConnectionSnapshot {
  /** Session token (already redacted to a short prefix by the host). */
  token: string;
  sessionId: string;
  baseUrl: string;
}

export interface ScreenshareSnapshot {
  platform: string;
  session: ScreenshareSessionSnapshot | null;
  capabilities: ScreenshareCapabilitySnapshot[];
  host: ScreenshareConnectionSnapshot | null;
  remote: ScreenshareConnectionSnapshot | null;
  loading?: boolean;
  busy?: string | null;
  error?: string | null;
}

function statusTone(status: ScreenshareSessionStatus): SpatialTone {
  switch (status) {
    case "active":
      return "success";
    case "stopped":
      return "danger";
    default:
      return "muted";
  }
}

function capabilityMark(available: boolean): string {
  return available ? "ok" : "off";
}

export interface ScreenshareSpatialViewProps {
  snapshot: ScreenshareSnapshot;
  /** Dispatch by agent id: `start`, `stop`, `rotate`, `copy`, `open-viewer`, `connect`, `refresh`. */
  onAction?: (action: string) => void;
}

export function ScreenshareSpatialView({
  snapshot,
  onAction,
}: ScreenshareSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const session = snapshot.session;
  const isActive = session?.status === "active";
  const liveCaps = snapshot.capabilities.filter((cap) => cap.available).length;

  return (
    <Card title="Screen Share" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={isActive ? "success" : statusTone(session?.status ?? "idle")}
          grow={1}
        >
          {snapshot.loading ? "loading" : (session?.status ?? "idle")}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.platform || "desktop"}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="session" />
      {session ? (
        <VStack gap={0}>
          <HStack gap={1} align="center">
            <Text tone={statusTone(session.status)}>
              {session.status === "active" ? ">" : "."}
            </Text>
            <Text bold wrap={false} grow={1}>
              {session.label || session.id}
            </Text>
            <Text style="caption" tone="muted">
              {session.platform}
            </Text>
          </HStack>
          <HStack gap={1}>
            <Text style="caption" tone="muted" grow={1}>
              frames {session.frameCount}
            </Text>
            <Text style="caption" tone="muted" grow={1}>
              inputs {session.inputCount}
            </Text>
          </HStack>
          <HStack gap={1}>
            <Text style="caption" tone="muted" grow={1}>
              last frame {session.lastFrameAt ?? "never"}
            </Text>
            <Text style="caption" tone="muted" grow={1}>
              last input {session.lastInputAt ?? "never"}
            </Text>
          </HStack>
        </VStack>
      ) : (
        <Text tone="muted" align="center" style="caption">
          No active session
        </Text>
      )}

      <HStack gap={1} wrap>
        <Button
          grow={1}
          agent="start"
          disabled={snapshot.busy === "start"}
          onPress={dispatch(isActive ? "rotate" : "start")}
        >
          {isActive ? "Rotate" : "Start"}
        </Button>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="open-viewer"
          disabled={!snapshot.host}
          onPress={dispatch("open-viewer")}
        >
          Open
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="copy"
          disabled={!snapshot.host}
          onPress={dispatch("copy")}
        >
          Copy
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          agent="stop"
          disabled={!isActive}
          onPress={dispatch("stop")}
        >
          Stop
        </Button>
      </HStack>

      <Divider label="capabilities" />
      <Text style="caption" tone="muted">
        {liveCaps} live / {snapshot.capabilities.length}
      </Text>
      {snapshot.capabilities.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No capabilities reported
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.capabilities.map((cap) => (
            <HStack
              key={cap.name}
              gap={1}
              align="center"
              agent={`cap-${cap.name}`}
            >
              <Text tone={cap.available ? "success" : "danger"}>
                {capabilityMark(cap.available)}
              </Text>
              <Text bold wrap={false} grow={1}>
                {cap.name}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {cap.tool}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="connect" />
      <Field
        label="Remote server URL"
        value={snapshot.remote?.baseUrl ?? ""}
        placeholder="Server URL"
        agent="input-remote-base"
      />
      <Field
        label="Remote session id"
        value={snapshot.remote?.sessionId ?? ""}
        placeholder="Session"
        agent="input-remote-session"
      />
      <Field
        label="Remote session token"
        value={snapshot.remote?.token ?? ""}
        placeholder="Token"
        kind="password"
        agent="input-remote-token"
      />
      <HStack gap={1}>
        <Button
          grow={1}
          variant={snapshot.remote ? "solid" : "outline"}
          tone={snapshot.remote ? "primary" : "default"}
          agent="connect"
          disabled={!snapshot.remote}
          onPress={dispatch("connect")}
        >
          Connect
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="refresh"
          disabled={snapshot.loading}
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>
    </Card>
  );
}
