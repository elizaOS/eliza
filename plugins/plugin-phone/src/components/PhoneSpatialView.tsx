/**
 * PhoneSpatialView - the phone surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.ts`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the native call log, so it is safe to render in the Node agent process where
 * the terminal lives (no Capacitor runtime import).
 */

import type { CallLogEntry } from "@elizaos/capacitor-phone";
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

export interface PhoneCallRow {
  id: string;
  /** Display name: cached contact name, else the number. */
  name: string;
  number: string;
  /** Pre-formatted relative/short time. */
  when: string;
  direction: "incoming" | "outgoing" | "missed" | "voicemail" | "unknown";
}

export interface PhoneSnapshot {
  callReady: boolean;
  dialed: string;
  calls: PhoneCallRow[];
  loading?: boolean;
  error?: string | null;
}

const DIAL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function directionTone(direction: PhoneCallRow["direction"]): SpatialTone {
  switch (direction) {
    case "missed":
      return "danger";
    case "incoming":
      return "success";
    case "outgoing":
      return "primary";
    default:
      return "muted";
  }
}

function directionMark(direction: PhoneCallRow["direction"]): string {
  switch (direction) {
    case "missed":
      return "x";
    case "incoming":
      return "<";
    case "outgoing":
      return ">";
    case "voicemail":
      return "o";
    default:
      return ".";
  }
}

/** Map a native call-log entry to the presentational row shape. */
export function toPhoneCallRow(
  entry: CallLogEntry,
  when: string,
): PhoneCallRow {
  const type = String(entry.type ?? "").toLowerCase();
  const direction: PhoneCallRow["direction"] =
    type === "incoming" ||
    type === "outgoing" ||
    type === "missed" ||
    type === "voicemail"
      ? (type as PhoneCallRow["direction"])
      : "unknown";
  return {
    id: entry.id,
    name: entry.cachedName?.trim() || entry.number || "Unknown",
    number: entry.number ?? "",
    when,
    direction,
  };
}

export interface PhoneSpatialViewProps {
  snapshot: PhoneSnapshot;
  /** Dispatch by agent id: `key:<digit>`, `call`, `open-dialer`, `backspace`, `refresh`. */
  onAction?: (action: string) => void;
}

export function PhoneSpatialView({
  snapshot,
  onAction,
}: PhoneSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  return (
    <Card title="Phone" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={snapshot.callReady ? "success" : "danger"}
          grow={1}
        >
          {snapshot.callReady ? "call-ready" : "call-blocked"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.loading ? "loading" : `${snapshot.calls.length} recent`}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="dialer" />
      <Text style="subheading" align="center">
        {snapshot.dialed || " "}
      </Text>
      <HStack gap={1} wrap justify="center">
        {DIAL_KEYS.map((k) => (
          <Button
            key={k}
            variant="outline"
            tone="default"
            width={5}
            agent={`key-${k}`}
            onPress={dispatch(`key:${k}`)}
          >
            {k}
          </Button>
        ))}
      </HStack>
      <HStack gap={1} wrap>
        <Button grow={1} agent="call" onPress={dispatch("call")}>
          Call
        </Button>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="open-dialer"
          onPress={dispatch("open-dialer")}
        >
          Open dialer
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          agent="backspace"
          onPress={dispatch("backspace")}
        >
          Del
        </Button>
      </HStack>

      <Divider label="recent" />
      {snapshot.calls.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No recent calls
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.calls.slice(0, 8).map((call) => (
            <HStack
              key={call.id}
              gap={1}
              align="center"
              agent={`call-${call.id}`}
            >
              <Text tone={directionTone(call.direction)}>
                {directionMark(call.direction)}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {call.name}
                </Text>
                {call.name !== call.number ? (
                  <Text style="caption" tone="muted" wrap={false}>
                    {call.number}
                  </Text>
                ) : null}
              </VStack>
              <Text style="caption" tone="muted">
                {call.when}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}
