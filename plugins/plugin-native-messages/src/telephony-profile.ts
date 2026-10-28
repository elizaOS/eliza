/**
 * The send path of the shared Messages surfaces.
 *
 * A host whose native admission proves the AOSP telephony profile registers its
 * `createTelephonyClient` with `registerTelephonyProfile`. The Messages view and its interaction handler
 * then send only through that client's reviewed native send: the draft is
 * checked with the shared `reviewSms` against the live SIM status, and the
 * host's native dialog shows the exact content again before anything leaves the
 * device. Without a registered profile the existing direct bridge stays in use,
 * so Eliza's own app keeps working unchanged.
 */

import {
  reviewSms,
  type SmsReviewProblem,
  type SmsSendResult,
  telephonyProfile,
} from "@elizaos/contracts/native-telephony";
import { Messages } from "@elizaos/plugin-native-messages/bridge";
import type { SendSmsResult } from "./definitions";

export {
  registerTelephonyProfile,
  telephonyProfile,
} from "@elizaos/contracts/native-telephony";

/** A draft the shared review refused; nothing was sent. */
export class SmsDraftRefused extends Error {
  constructor(readonly problem: SmsReviewProblem) {
    super(`The message was not sent: ${problem}`);
    this.name = "SmsDraftRefused";
  }
}

export type MessagesSendOutcome =
  | { path: "direct"; result: SendSmsResult }
  | { path: "reviewed"; result: SmsSendResult };

function newOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error("No secure random source for an operation ID");
  return `messages-${uuid}`;
}

/**
 * Sends one text from a Messages surface. Behind the telephony profile it is a
 * reviewed native send with a fresh operation ID; a refused draft throws
 * {@link SmsDraftRefused} before native code is reached. The caller must not
 * retry a reviewed send automatically: its record may already exist.
 */
export async function sendFromMessages(
  address: string,
  body: string,
  options: { subscriptionId?: number | null } = {},
): Promise<MessagesSendOutcome> {
  const client = telephonyProfile();
  if (!client) {
    return {
      path: "direct",
      result: await Messages.sendSms({ address, body }),
    };
  }
  const status = await client.status();
  const checked = reviewSms(
    {
      recipients: [address],
      body,
      subscriptionId: options.subscriptionId ?? null,
    },
    status,
    "direct",
  );
  if ("problem" in checked) throw new SmsDraftRefused(checked.problem);
  return {
    path: "reviewed",
    result: await client.sendSms(checked.review, newOperationId()),
  };
}
