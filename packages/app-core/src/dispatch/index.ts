/**
 * @elizaos/app-core/dispatch
 *
 * Future home of the dispatch layer (ConnectorRegistry, ChannelRegistry,
 * ApprovalQueue, SendPolicy) currently implemented inside
 * plugin-personal-assistant. The interfaces are stable contracts; the
 * `Stub*` classes throw "not implemented" until the migration tracked in
 * README.md happens.
 */

export * from "./approval-queue.js";
export * from "./channel-registry.js";
export * from "./connector-registry.js";
export * from "./send-policy.js";
