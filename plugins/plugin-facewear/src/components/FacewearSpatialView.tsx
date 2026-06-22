/**
 * FacewearSpatialView - the facewear device-management surface authored once
 * with the spatial vocabulary, so it renders correctly wherever it is shown:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the device registry, so it is safe to render in the Node agent process where
 * the terminal lives (no fetch/Capacitor runtime import).
 */

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
import type { FacewearDeviceType } from "../devices/registry.ts";

/** A connected facewear device, mirrored from `/api/facewear/status`. */
export interface FacewearDeviceRow {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
}

/** A supported device the operator can connect/manage. */
export interface FacewearProfileRow {
  type: FacewearDeviceType;
  name: string;
  manufacturer: string;
  connectionType: string;
  connected: boolean;
}

export interface FacewearSnapshot {
  /** Supported device profiles with their derived connected state. */
  profiles: FacewearProfileRow[];
  /** The live connected devices the status route reports. */
  devices: FacewearDeviceRow[];
  /** Number of connected devices (the header pill count). */
  connectedCount: number;
  loading?: boolean;
  error?: string | null;
}

const VISIBLE_DEVICE_LIMIT = 4;

/** Empty snapshot used by the terminal registry before live data arrives. */
export const EMPTY_FACEWEAR_SNAPSHOT: FacewearSnapshot = {
  profiles: [],
  devices: [],
  connectedCount: 0,
  loading: false,
  error: null,
};

function connectionTone(connected: boolean): SpatialTone {
  return connected ? "success" : "muted";
}

export interface FacewearSpatialViewProps {
  snapshot: FacewearSnapshot;
  /**
   * Dispatch by agent id: `connect:<deviceType>` (connect/manage a profile),
   * `refresh`, `xr-connect`, `xr-status`.
   */
  onAction?: (action: string) => void;
}

export function FacewearSpatialView({
  snapshot,
  onAction,
}: FacewearSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const { connectedCount } = snapshot;
  const visibleDevices = snapshot.devices.slice(0, VISIBLE_DEVICE_LIMIT);
  const hiddenDevices = Math.max(
    0,
    snapshot.devices.length - VISIBLE_DEVICE_LIMIT,
  );

  return (
    <Card title="Facewear" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={connectedCount > 0 ? "success" : "muted"}
          grow={1}
        >
          {connectedCount > 0
            ? `${connectedCount} device${connectedCount === 1 ? "" : "s"} connected`
            : "No devices connected"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.loading ? "loading" : `${snapshot.profiles.length} models`}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      {visibleDevices.length > 0 ? (
        <>
          <Divider label="active" />
          <HStack gap={1} wrap>
            {visibleDevices.map((device) => (
              <Text key={device.id} style="caption" tone="success" wrap={false}>
                {device.deviceType ?? device.kind}
              </Text>
            ))}
            {hiddenDevices > 0 ? (
              <Text style="caption" tone="muted">
                +{hiddenDevices}
              </Text>
            ) : null}
          </HStack>
        </>
      ) : null}

      <Divider label="devices" />
      {snapshot.profiles.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          {snapshot.loading ? "Loading devices" : "No supported devices"}
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.profiles.map((profile) => (
            <HStack
              key={profile.type}
              gap={1}
              align="center"
              agent={`device-${profile.type}`}
            >
              <Text tone={connectionTone(profile.connected)}>
                {profile.connected ? "[ok]" : "[ ]"}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {profile.name}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {profile.manufacturer} · {profile.connectionType}
                </Text>
              </VStack>
              <Button
                variant={profile.connected ? "outline" : "solid"}
                tone={profile.connected ? "default" : "primary"}
                agent={`connect:${profile.type}`}
                onPress={dispatch(`connect:${profile.type}`)}
              >
                {profile.connected ? "Manage" : "Connect"}
              </Button>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="actions" />
      <HStack gap={1} wrap>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="xr-connect"
          onPress={dispatch("xr-connect")}
        >
          XR Connect
        </Button>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="xr-status"
          onPress={dispatch("xr-status")}
        >
          XR Status
        </Button>
        <Button
          variant="ghost"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>
    </Card>
  );
}
