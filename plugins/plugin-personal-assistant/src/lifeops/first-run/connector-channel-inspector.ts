/**
 * Real connector-backed {@link ChannelInspector} for the first-run channel
 * picker (Q4). Resolves a notification channel to its backing connector via the
 * channel pack's `channelConnectorKind` edge, then reads live status off the
 * runtime's `ConnectorRegistry` — the same registry the CONNECTOR action and
 * the reminder runner dispatch through.
 *
 * It fixes #14730: the picker must report the channel's *observed* connection
 * state, never a fabricated "disconnected". In-process channels (`in_app`,
 * `push`) the runtime delivers directly are always connected; a connector-backed
 * channel is `connected` only when its contribution reports `state: "ok"`,
 * `disconnected` when it reports `disconnected`, and honestly `unknown` when the
 * connector is unregistered or its status probe throws — the validator then
 * warns the owner rather than claiming a state it could not observe.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { channelConnectorKind } from "../channels/index.js";
import { getConnectorRegistry } from "../connectors/index.js";
import type { ChannelConnectionState, ChannelInspector } from "./questions.js";
import { SUPPORTED_NOTIFICATION_CHANNELS } from "./questions.js";

export class ConnectorChannelInspector implements ChannelInspector {
  constructor(private readonly runtime: IAgentRuntime) {}

  isRegistered(channel: string): boolean {
    return (SUPPORTED_NOTIFICATION_CHANNELS as readonly string[]).includes(
      channel,
    );
  }

  async connectionState(channel: string): Promise<ChannelConnectionState> {
    const connectorKind = channelConnectorKind(channel);
    // In-process channel (in_app / push): the runtime delivers it directly, so
    // its connection is not gated on any connector.
    if (connectorKind === null) {
      return "connected";
    }
    // Channel not in the pack at all — no connector edge to probe.
    if (connectorKind === undefined) {
      return "unknown";
    }
    const registry = getConnectorRegistry(this.runtime);
    const contribution = registry?.get(connectorKind);
    if (!contribution) {
      return "unknown";
    }
    let status: Awaited<ReturnType<typeof contribution.status>>;
    try {
      status = await contribution.status();
    } catch (error) {
      // error-policy:J7 a status-probe failure is genuinely unobservable, not a
      // fabricated disconnect. Surface it via the diagnostic boundary and answer
      // honestly "unknown" so the first-run picker warns rather than lies.
      this.runtime.reportError(
        "first-run.channel-inspector",
        error instanceof Error ? error : new Error(String(error)),
        { channel, connectorKind },
      );
      return "unknown";
    }
    if (status.state === "ok") return "connected";
    if (status.state === "disconnected") return "disconnected";
    // "degraded" — reachable but not fully healthy; treat as unknown so the
    // owner is warned without a hard "disconnected" claim.
    return "unknown";
  }
}
