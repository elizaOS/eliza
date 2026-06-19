/**
 * ChannelRegistry — registry of *channels* the agent can reach the owner (or
 * other entities) on. A channel is a named delivery surface ("owner:dm",
 * "owner:sms", "family:shared-thread") that connectors are bound to via the
 * ConnectorRegistry.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/channels ->
 *               packages/app-core/src/dispatch/channel-registry.ts)
 */

export interface ChannelDescriptor {
  readonly id: string;
  readonly label: string;
  /** Free-form kind classifier — "dm", "group", "broadcast", … */
  readonly kind?: string;
  /** Implementation-specific routing data (account id, room id, …). */
  readonly target?: Record<string, unknown>;
}

export interface ChannelRegistry {
  register(channel: ChannelDescriptor): void;
  get(id: string): ChannelDescriptor | undefined;
  list(): readonly ChannelDescriptor[];
}

export class StubChannelRegistry implements ChannelRegistry {
  register(_channel: ChannelDescriptor): void {
    throw new Error(
      "[StubChannelRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
    );
  }

  get(_id: string): ChannelDescriptor | undefined {
    throw new Error(
      "[StubChannelRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
    );
  }

  list(): readonly ChannelDescriptor[] {
    throw new Error(
      "[StubChannelRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
    );
  }
}
