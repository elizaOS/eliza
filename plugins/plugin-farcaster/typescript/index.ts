import type { Plugin } from "@elizaos/core";
import { farcasterActions } from "./actions";
import { farcasterProviders } from "./providers";
import { farcasterWebhookRoutes } from "./routes/webhook";
import { FarcasterService } from "./services/FarcasterService";

export { FarcasterClient } from "./client/FarcasterClient";
export {
  EmbedManager,
  isEmbedCast,
  isEmbedUrl,
  type ProcessedEmbed,
} from "./managers/EmbedManager";
export { FarcasterService } from "./services/FarcasterService";
export type {
  Cast,
  CastEmbed,
  CastId,
  FarcasterConfig,
  FarcasterEventTypes,
  FarcasterMessageType,
  FidRequest,
  Profile,
} from "./types";

export const farcasterPlugin: Plugin = {
  name: "farcaster",
  description: "Farcaster client plugin for sending and receiving casts",
  services: [FarcasterService],
  actions: farcasterActions,
  providers: farcasterProviders,
  routes: farcasterWebhookRoutes,
};

export default farcasterPlugin;
