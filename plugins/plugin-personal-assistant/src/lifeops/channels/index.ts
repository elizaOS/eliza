/** Barrel for the channel registry: channel contributions, the default pack, and priority-to-posture mapping. */
export type {
  ChannelCapabilities,
  ChannelContribution,
  ChannelRegistry,
  ChannelRegistryFilter,
} from "./contract.js";
export {
  DEFAULT_CHANNEL_PACK,
  registerDefaultChannelPack,
} from "./default-pack.js";
export {
  PRIORITY_TO_POSTURE,
  type PriorityPosture,
  type ScheduledTaskPriority,
} from "./priority-posture.js";
export {
  __resetChannelRegistryForTests,
  createChannelRegistry,
  getChannelRegistry,
  registerChannelRegistry,
} from "./registry.js";
