/**
 * The call path of the shared Phone surfaces.
 *
 * When a host registered its admitted AOSP telephony client with
 * `registerTelephonyProfile` (`@elizaos/contracts/native-telephony`), a call
 * from the Phone view or its interaction handler only opens the host's dial
 * screen with the number filled in; the person places the call there, and the
 * system dialer keeps handling emergency numbers. Recent calls then come from
 * the profile's bounded, foreground-only read, requested only when the person
 * asks. Without a registered profile the existing direct bridge stays in use,
 * so Eliza's own app is unchanged.
 */

import {
  TELEPHONY_CALL_LOG_MAX,
  type TelephonyCallLogEntry,
  type TelephonyClient,
  type TelephonyHandoffResult,
  telephonyProfile,
} from "@elizaos/contracts/native-telephony";
import { type CallLogEntry, Phone } from "@elizaos/plugin-native-phone/bridge";

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

/** Recent calls through the registered profile: the host's bounded, foreground-only read. */
export type ProfileRecents =
  | { access: "granted"; voiceCapable: boolean; calls: CallLogEntry[] }
  /** The host declares the read but the owner has not granted it (or Android refused). */
  | { access: "needed"; voiceCapable: boolean }
  /** The host has no recent-calls read; the dial handoff still works. */
  | { access: "absent"; voiceCapable: boolean };

/** Maps a profile row into the Phone surface's call-log entry. Fields the
 * profile does not read (voicemail, accounts, transcripts) stay empty. */
function profileEntry(row: TelephonyCallLogEntry): CallLogEntry {
  return {
    id: row.id,
    number: row.number,
    cachedName: row.cachedName,
    date: row.date,
    durationSeconds: row.durationSeconds,
    type: row.type,
    rawType: 0,
    isNew: row.isNew,
    phoneAccountId: null,
    geocodedLocation: null,
    transcription: null,
    voicemailUri: null,
    agentTranscript: null,
    agentSummary: null,
    agentTranscriptUpdatedAt: null,
  };
}

/**
 * Reads recent calls through the profile. Access is requested only when the
 * person asked (`request`), never on mount; without it the status is reported
 * as `needed` rather than as an empty history.
 */
export async function loadProfileRecents(
  client: TelephonyClient,
  options: { limit?: number; request?: boolean } = {},
): Promise<ProfileRecents> {
  let status = await client.status();
  const voiceCapable = status.voiceCapable;
  if (status.permissions.callLog === undefined)
    return { access: "absent", voiceCapable };
  if (status.permissions.callLog !== "granted" && options.request)
    status = await client.requestAccess("callLog");
  if (status.permissions.callLog !== "granted")
    return { access: "needed", voiceCapable };
  const calls = await client.recentCalls(
    Math.min(TELEPHONY_CALL_LOG_MAX, Math.max(1, options.limit ?? 50)),
  );
  return { access: "granted", voiceCapable, calls: calls.map(profileEntry) };
}

/** Opens the dial screen. Behind the profile it needs a number (the handoff
 * fills it in); without one the direct bridge opens an empty dialer. */
export async function openDialerFromPhone(
  number: string,
): Promise<PhoneCallOutcome> {
  const client = telephonyProfile();
  if (!client) {
    await Phone.openDialer(number ? { number } : undefined);
    return { path: "direct" };
  }
  return { path: "handoff", result: await client.dial(number) };
}
