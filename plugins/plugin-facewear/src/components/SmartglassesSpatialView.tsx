/**
 * SmartglassesSpatialView - the Even Realities smartglasses diagnostics surface
 * authored once with the spatial vocabulary, so it renders correctly wherever
 * it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the smartglasses report (`HardwareReport`, `GlassSide`), so it is safe to
 * render in the Node agent process where the terminal lives (no transport or
 * BLE runtime import).
 *
 * The full GUI dashboard (`SmartglassesView.tsx`) is unchanged; this view is the
 * shared operator panel that reads the same computed `HardwareReport` the GUI
 * builds, plus the live state the GUI tracks (Wi-Fi, mic, test text, events).
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
} from "@elizaos/ui/spatial";
import type { GlassSide } from "../protocol/smartglasses.ts";
import type {
  HardwareReport,
  LensState,
} from "../ui/SmartglassesView.helpers.ts";

/** Visible row caps - mirror the GUI dashboard (`SmartglassesView.tsx`). */
const VISIBLE_TEST_LIMIT = 8;
const VISIBLE_EVENT_LIMIT = 12;
const VISIBLE_WIFI_LIMIT = 5;

export type SmartglassesPlatform = "desktop" | "ios" | "android";

export interface SmartglassesSnapshot {
  /** The computed hardware report - identical shape to the GUI's `report`. */
  report: HardwareReport;
  /** Live operator state the GUI tracks alongside the report. */
  micEnabled: boolean;
  wifiSsid: string;
  wifiPassword: string;
  testText: string;
  activePlatform: SmartglassesPlatform;
  /** Label of the in-flight operation, or null when idle. */
  busy: string | null;
  /** Last operator-facing error, or null. */
  error: string | null;
}

function lensTone(state: LensState): SpatialTone {
  switch (state) {
    case "connected":
      return "success";
    case "failed":
      return "danger";
    case "prompting":
      return "warning";
    default:
      return "muted";
  }
}

function lensMark(state: LensState): string {
  switch (state) {
    case "connected":
      return "[ok]";
    case "failed":
      return "[x]";
    case "prompting":
      return "[..]";
    default:
      return "[ ]";
  }
}

function passTone(pass: boolean): SpatialTone {
  return pass ? "success" : "muted";
}

function passMark(pass: boolean): string {
  return pass ? "[ok]" : "[ ]";
}

/** Human-friendly battery summary from the report headset state. */
function batterySummary(
  levels: Partial<Record<GlassSide, number>>,
): string | null {
  const parts: string[] = [];
  if (typeof levels.left === "number") parts.push(`L ${levels.left}%`);
  if (typeof levels.right === "number") parts.push(`R ${levels.right}%`);
  return parts.length > 0 ? parts.join("  ") : null;
}

export interface SmartglassesSpatialViewProps {
  snapshot: SmartglassesSnapshot;
  /**
   * Dispatch by agent id: `connect`, `run-check`, `clear-display`,
   * `display-test`, `mic-toggle`, `wifi-scan`, `wifi-status`, `wifi-save`,
   * `platform:<desktop|ios|android>`.
   */
  onAction?: (action: string) => void;
}

export function SmartglassesSpatialView({
  snapshot,
  onAction,
}: SmartglassesSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const { report } = snapshot;
  const testEntries = Object.entries(report.tests);
  const hiddenTests = Math.max(0, testEntries.length - VISIBLE_TEST_LIMIT);
  const hiddenEvents = Math.max(0, report.events.length - VISIBLE_EVENT_LIMIT);
  const hiddenWifi = Math.max(
    0,
    report.wifi.networks.length - VISIBLE_WIFI_LIMIT,
  );
  const battery = batterySummary(report.headsetState.batteryLevels);
  // Newest-first window over the event log, keyed by absolute index so keys are
  // stable across renders even when two events share a timestamp.
  const eventStart = Math.max(0, report.events.length - VISIBLE_EVENT_LIMIT);
  const recentEvents = report.events
    .slice(eventStart)
    .map((event, offset) => ({ ...event, key: eventStart + offset }))
    .reverse();

  return (
    <Card title="Smartglasses" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={report.ok ? "success" : report.connected ? "warning" : "danger"}
          grow={1}
        >
          {report.ok
            ? "validated"
            : report.connected
              ? "connected"
              : "disconnected"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.busy ? snapshot.busy : (report.transport ?? "no transport")}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <HStack gap={1} align="center">
        <Text style="caption" tone={lensTone(report.lenses.left)} grow={1}>
          {lensMark(report.lenses.left)} left
        </Text>
        <Text style="caption" tone={lensTone(report.lenses.right)} grow={1}>
          {lensMark(report.lenses.right)} right
        </Text>
      </HStack>

      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1}>
          {report.serialNumber ? `sn ${report.serialNumber}` : "sn unknown"}
        </Text>
        {battery ? (
          <Text style="caption" tone="muted">
            {battery}
          </Text>
        ) : null}
      </HStack>

      {report.setupHint ? (
        <Text style="caption" tone="warning">
          {report.setupHint}
        </Text>
      ) : null}

      <Divider label="diagnostics" />
      <List gap={0}>
        {testEntries.slice(0, VISIBLE_TEST_LIMIT).map(([name, pass]) => (
          <HStack key={name} gap={1} align="center" agent={`test-${name}`}>
            <Text tone={passTone(pass)}>{passMark(pass)}</Text>
            <Text style="caption" grow={1} wrap={false}>
              {name}
            </Text>
          </HStack>
        ))}
      </List>
      {hiddenTests > 0 ? (
        <Text style="caption" tone="muted">
          +{hiddenTests} checks
        </Text>
      ) : null}

      <Divider label="controls" />
      <HStack gap={1} wrap>
        <Button
          grow={1}
          tone={report.connected ? "default" : "primary"}
          variant={report.connected ? "outline" : "solid"}
          agent="connect"
          onPress={dispatch("connect")}
        >
          {report.connected ? "Reconnect" : "Connect"}
        </Button>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="run-check"
          onPress={dispatch("run-check")}
        >
          Run Check
        </Button>
        <Button
          variant={snapshot.micEnabled ? "solid" : "outline"}
          tone={snapshot.micEnabled ? "success" : "default"}
          agent="mic-toggle"
          onPress={dispatch("mic-toggle")}
        >
          {snapshot.micEnabled ? "Mic on" : "Mic off"}
        </Button>
      </HStack>

      <Field
        label="Display text"
        value={snapshot.testText}
        placeholder="Text to send to both lenses"
        agent="test-text"
      />
      <HStack gap={1} wrap>
        <Button
          grow={1}
          agent="display-test"
          onPress={dispatch("display-test")}
        >
          Send Display
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          agent="clear-display"
          onPress={dispatch("clear-display")}
        >
          Clear
        </Button>
      </HStack>

      <Divider label="wi-fi" />
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1} wrap={false}>
          {report.wifi.status}
        </Text>
        <Text style="caption" tone={report.wifi.available ? "muted" : "danger"}>
          {report.wifi.available ? "bridge" : "no bridge"}
        </Text>
      </HStack>
      <Field
        label="SSID"
        value={snapshot.wifiSsid}
        placeholder="Network name"
        agent="wifi-ssid"
      />
      <Field
        label="Password"
        kind="password"
        value={snapshot.wifiPassword}
        placeholder="Network password"
        agent="wifi-password"
      />
      <HStack gap={1} wrap>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="wifi-scan"
          onPress={dispatch("wifi-scan")}
        >
          Scan
        </Button>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="wifi-status"
          onPress={dispatch("wifi-status")}
        >
          Status
        </Button>
        <Button grow={1} agent="wifi-save" onPress={dispatch("wifi-save")}>
          Save Wi-Fi
        </Button>
      </HStack>
      {report.wifi.networks.length === 0 ? (
        <Text style="caption" tone="muted">
          No networks seen
        </Text>
      ) : (
        <List gap={0}>
          {report.wifi.networks.slice(0, VISIBLE_WIFI_LIMIT).map((network) => (
            <Text key={network} style="caption" wrap={false}>
              {network}
            </Text>
          ))}
        </List>
      )}
      {hiddenWifi > 0 ? (
        <Text style="caption" tone="muted">
          +{hiddenWifi} more
        </Text>
      ) : null}

      <Divider label="events" />
      {report.events.length === 0 ? (
        <Text style="caption" tone="muted" align="center">
          No events yet
        </Text>
      ) : (
        <List gap={0}>
          {recentEvents.map((event) => (
            <HStack key={event.key} gap={1} align="center">
              <Text style="caption" tone="primary" wrap={false}>
                {event.type}
              </Text>
              <Text style="caption" tone="muted" grow={1} wrap={false}>
                {event.detail}
              </Text>
            </HStack>
          ))}
        </List>
      )}
      {hiddenEvents > 0 ? (
        <Text style="caption" tone="muted">
          +{hiddenEvents} older events
        </Text>
      ) : null}
    </Card>
  );
}
