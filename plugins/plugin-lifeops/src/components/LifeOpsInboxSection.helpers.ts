// Channel-grouping constants for the LifeOps inbox. Kept out of
// LifeOpsInboxSection.tsx so that file exports only React components and stays
// Fast-Refresh-compatible in dev. Consumed by sibling section components that
// split the inbox into message vs. mail channels.

import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsInboxChannel,
} from "@elizaos/shared";

export const LIFEOPS_MESSAGE_CHANNELS: LifeOpsInboxChannel[] =
  LIFEOPS_INBOX_CHANNELS.filter((channel) => channel !== "gmail");
export const LIFEOPS_MAIL_CHANNELS: LifeOpsInboxChannel[] = ["gmail"];
