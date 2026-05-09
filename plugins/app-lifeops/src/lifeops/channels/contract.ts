/**
 * W1-F — Channel contract.
 *
 * Frozen interface per `docs/audit/wave1-interfaces.md` §3.2 — replaces the
 * three overlapping channel enums (`LIFEOPS_REMINDER_CHANNELS` ∪
 * `LIFEOPS_CHANNEL_TYPES` ∪ `LIFEOPS_MESSAGE_CHANNELS`) per
 * `GAP_ASSESSMENT.md` §3.2.
 *
 * Wave 1 ships the contract + an empty registry; Wave 2 (W2-B) populates the
 * channel contributions. Channels reuse {@link DispatchResult} from the
 * connector contract so the runner's dispatch policy applies uniformly.
 */

import type { DispatchResult } from "../connectors/contract.js";

export interface ChannelCapabilities {
  send: boolean;
  read: boolean;
  reminders: boolean;
  voice: boolean;
  attachments: boolean;
  quietHoursAware: boolean;
}

export interface ChannelContribution {
  /**
   * Stable channel key — `"in_app"`, `"push"`, `"imessage"`, `"telegram"`,
   * `"discord"`, `"sms"`, etc. Referenced by `EscalationStep.channelKey`.
   */
  kind: string;

  describe: { label: string };

  capabilities: ChannelCapabilities;

  /**
   * Outbound dispatch verb. Only required when `capabilities.send` is true.
   * The payload shape is channel-specific; the registry does not validate it.
   */
  send?(payload: unknown): Promise<DispatchResult>;
}

export interface ChannelRegistryFilter {
  /**
   * Returns channels whose `capabilities` match every supplied flag.
   * `{ supports: { send: true, voice: true } }` returns channels that can both
   * send and carry voice.
   */
  supports?: Partial<ChannelCapabilities>;
}

export interface ChannelRegistry {
  register(c: ChannelContribution): void;
  list(filter?: ChannelRegistryFilter): ChannelContribution[];
  get(kind: string): ChannelContribution | null;
}
