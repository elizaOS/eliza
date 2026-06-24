/**
 * FocusSpatialView — the Focus / blocker surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no DOM/runtime imports).
 */

import { Button, Card, Divider, HStack, List, Text } from "@elizaos/ui/spatial";

/** Which screen of the website-blocking state machine to draw. */
export type FocusPhase =
  | "loading"
  | "error"
  | "unavailable"
  | "permission"
  | "active"
  | "empty";

export interface FocusSnapshot {
  /** Current state-machine phase. */
  phase: FocusPhase;
  /** Error message (phase: "error"). */
  error?: string | null;
  /** Platform string (phase: "unavailable"). */
  platform?: string;
  /** Why blocking is unavailable / what permission is needed. */
  reason?: string | null;
  /** Elevation method to surface in the permission phase, if known. */
  elevationPromptMethod?: string | null;
  /** Active session start time (already formatted for display). */
  startedAt?: string;
  /** Active session end time (already formatted), or null for no end time. */
  endsAt?: string | null;
  /** Match mode of the active block. */
  matchMode?: string;
  /** Hosts blocked in the active session. */
  blockedWebsites?: string[];
  /** Whether the active block can be released early (gates the Release button). */
  canUnblockEarly?: boolean;
  /** Whether releasing needs elevation (drives the can't-release note). */
  requiresElevation?: boolean;
  /** Whether a release request is in flight (disables the button). */
  releasing?: boolean;
}

export interface FocusSpatialViewProps {
  snapshot: FocusSnapshot;
  /** Dispatch by agent id: `retry` (reload after error), `release` (end block). */
  onAction?: (action: string) => void;
}

export function FocusSpatialView({
  snapshot,
  onAction,
}: FocusSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  return (
    <Card gap={1} padding={1}>
      <FocusBody snapshot={snapshot} dispatch={dispatch} />
    </Card>
  );
}

function FocusBody({
  snapshot,
  dispatch,
}: {
  snapshot: FocusSnapshot;
  dispatch: (action: string) => () => void;
}) {
  switch (snapshot.phase) {
    case "loading":
      return (
        <Text tone="muted" style="caption">
          Loading focus status...
        </Text>
      );
    case "error":
      return (
        <>
          <Text tone="danger" style="caption">
            {snapshot.error || "Could not load website blocking status."}
          </Text>
          <HStack gap={1}>
            <Button agent="retry" onPress={dispatch("retry")}>
              Retry
            </Button>
          </HStack>
        </>
      );
    case "unavailable":
      return (
        <>
          <Text bold>Focus blocking is unavailable</Text>
          <Text tone="muted" style="caption">
            The website-blocking engine is not available on this device
            (platform: {snapshot.platform ?? "unknown"}).
          </Text>
          {snapshot.reason ? (
            <Text tone="muted" style="caption">
              {snapshot.reason}
            </Text>
          ) : null}
        </>
      );
    case "permission":
      return (
        <>
          <Text bold tone="warning">
            Permission needed
          </Text>
          <Text tone="muted" style="caption">
            Eliza needs administrator/root approval to edit the system hosts
            file before it can block websites.
          </Text>
          <Text tone="muted" style="caption">
            {snapshot.elevationPromptMethod
              ? `Approval method: ${snapshot.elevationPromptMethod}`
              : "This device can't raise an approval prompt automatically."}
          </Text>
          {snapshot.reason ? (
            <Text tone="muted" style="caption">
              {snapshot.reason}
            </Text>
          ) : null}
          <Text tone="muted" style="caption">
            Ask the assistant to "enable website blocking" and approve the
            system prompt when it appears.
          </Text>
        </>
      );
    case "active":
      return <FocusActiveBody snapshot={snapshot} dispatch={dispatch} />;
    default:
      return (
        <>
          <Text tone="muted" style="caption">
            No active focus session.
          </Text>
          <Text tone="muted" style="caption">
            Say "block distractions for 1 hour" to start one.
          </Text>
        </>
      );
  }
}

function FocusActiveBody({
  snapshot,
  dispatch,
}: {
  snapshot: FocusSnapshot;
  dispatch: (action: string) => () => void;
}) {
  const sites = snapshot.blockedWebsites ?? [];
  const canRelease = snapshot.canUnblockEarly === true;
  return (
    <>
      <Text bold>Focus session active</Text>
      {canRelease ? (
        <HStack gap={1}>
          <Button
            tone="danger"
            grow={1}
            disabled={snapshot.releasing === true}
            agent="release"
            onPress={dispatch("release")}
          >
            {snapshot.releasing ? "Releasing" : "Release block"}
          </Button>
        </HStack>
      ) : null}

      <Text tone="muted" style="caption">
        Started {snapshot.startedAt ?? "unknown"}
        {snapshot.endsAt ? ` - ends ${snapshot.endsAt}` : " - no end time"}
      </Text>
      <Text tone="muted" style="caption">
        Match mode: {snapshot.matchMode ?? "exact"}
      </Text>

      <Divider label={`${sites.length} blocked`} />
      {sites.length === 0 ? (
        <Text tone="muted" style="caption">
          No websites blocked
        </Text>
      ) : (
        <List gap={0}>
          {sites.map((site) => (
            <HStack key={site} gap={1} align="center">
              <Text tone="muted" wrap={false}>
                x
              </Text>
              <Text grow={1} wrap={false}>
                {site}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      {!canRelease && snapshot.requiresElevation ? (
        <Text tone="muted" style="caption">
          Releasing this block needs administrator/root approval. Ask the
          assistant to release it.
        </Text>
      ) : null}
    </>
  );
}
