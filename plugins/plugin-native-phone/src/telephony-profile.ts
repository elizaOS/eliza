/**
 * The call path of the shared Phone surfaces.
 *
 * When a host registered its admitted AOSP telephony client with
 * `registerTelephonyProfile` (`@elizaos/contracts/native-telephony`), a call
 * from the Phone view or its interaction handler only opens the host's dial
 * screen with the number filled in; the person places the call there, and the
 * system dialer keeps handling emergency numbers. Without a registered profile
 * the existing direct bridge stays in use, so Eliza's own app is unchanged.
 */

import {
  type TelephonyHandoffResult,
  telephonyProfile,
} from "@elizaos/contracts/native-telephony";
import { Phone } from "@elizaos/plugin-native-phone/bridge";

export {
  registerTelephonyProfile,
  telephonyProfile,
} from "@elizaos/contracts/native-telephony";

export type PhoneCallOutcome =
  | { path: "direct" }
  | { path: "handoff"; result: TelephonyHandoffResult };

/** Starts a call to an already normalized number. Behind the profile it is a
 * dial-screen handoff and never a placed call. */
export async function callFromPhone(number: string): Promise<PhoneCallOutcome> {
  const client = telephonyProfile();
  if (!client) {
    await Phone.placeCall({ number });
    return { path: "direct" };
  }
  return { path: "handoff", result: await client.dial(number) };
}
