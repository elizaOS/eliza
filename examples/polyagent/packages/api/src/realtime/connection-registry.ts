import { logger } from "@polyagent/shared";
import type { RealtimeChannel } from "./index";

interface ConnectionInfo {
  id: string;
  userId: string;
  channels: RealtimeChannel[];
  connectedAt: number;
}

class ConnectionRegistry {
  private connections = new Map<string, ConnectionInfo>();

  add(connection: ConnectionInfo) {
    this.connections.set(connection.id, connection);
    logger.debug(
      "Realtime connection added",
      { connectionId: connection.id, channels: connection.channels },
      "Realtime",
    );
  }

  remove(id: string) {
    this.connections.delete(id);
    logger.debug(
      "Realtime connection removed",
      { connectionId: id },
      "Realtime",
    );
  }

  snapshot() {
    const byChannel: Record<string, number> = {};
    for (const info of this.connections.values()) {
      for (const ch of info.channels) {
        byChannel[ch] = (byChannel[ch] || 0) + 1;
      }
    }
    return {
      totalConnections: this.connections.size,
      byChannel,
    };
  }
}

const registry = new ConnectionRegistry();

export const connections = {
  add: (info: ConnectionInfo) => registry.add(info),
  remove: (id: string) => registry.remove(id),
  snapshot: () => registry.snapshot(),
};
