/**
 * FocusSpatialView — the Focus / blocker surface authored with the spatial
 * vocabulary and mounted in `<SpatialSurface>` for the GUI surface.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives (no DOM/runtime imports).
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
          Loading
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
          <Text bold>Focus unavailable</Text>
          <Text tone="muted" style="caption">
            {snapshot.platform ?? "unknown"}
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
            Permission
          </Text>
          <Text tone="muted" style="caption">
            {snapshot.elevationPromptMethod
              ? snapshot.elevationPromptMethod
              : "Manual approval required"}
          </Text>
          {snapshot.reason ? (
            <Text tone="muted" style="caption">
              {snapshot.reason}
            </Text>
          ) : null}
        </>
      );
    case "active":
      return <FocusActiveBody snapshot={snapshot} dispatch={dispatch} />;
    default:
      return (
        <Text tone="muted" style="caption">
          Idle
        </Text>
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
      <Text bold>Focus active</Text>
      {canRelease ? (
        <HStack gap={1}>
          <Button
            tone="danger"
            grow={1}
            disabled={snapshot.releasing === true}
            agent="release"
            onPress={dispatch("release")}
          >
            {snapshot.releasing ? "Releasing" : "Release"}
          </Button>
        </HStack>
      ) : null}

      <Text tone="muted" style="caption">
        Started {snapshot.startedAt ?? "unknown"}
        {snapshot.endsAt ? ` - ends ${snapshot.endsAt}` : " - no end time"}
      </Text>
      <Text tone="muted" style="caption">
        Mode: {snapshot.matchMode ?? "exact"}
      </Text>

      <Divider label={`${sites.length} blocked`} />
      {sites.length === 0 ? (
        <Text tone="muted" style="caption">
          None
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
          Admin approval required to release.
        </Text>
      ) : null}
    </>
  );
}
