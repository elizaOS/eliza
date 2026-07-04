/**
 * The centrally-enumerated native permission probers, indexed by id and as an
 * array. `registerAllProbers` feeds these into the registry at boot.
 *
 * This set covers only OS-backed permissions the agent process probes itself.
 * Permissions whose implementation lives in an opt-in plugin are NOT listed
 * here — the plugin self-registers its prober at init via
 * `registry.registerProber`. `website-blocking` is one such case: its prober is
 * contributed by `@elizaos/plugin-personal-assistant`, so when that plugin is
 * not loaded the registry has no prober for it and surfaces an
 * unavailable/not-determined state rather than a hardwired "granted" (#12660).
 *
 * Importing this module is side-effect free; the bridge dylib and any
 * osascript shellouts are loaded lazily on first `check()`/`request()`.
 */

import type { PermissionId, Prober } from "../contracts.js";
import { accessibilityProber } from "./accessibility.js";
import { automationProber } from "./automation.js";
import { calendarProber } from "./calendar.js";
import { cameraProber } from "./camera.js";
import { contactsProber } from "./contacts.js";
import { fullDiskProber } from "./full-disk.js";
import { healthProber } from "./health.js";
import { locationProber } from "./location.js";
import { microphoneProber } from "./microphone.js";
import { nativePlatformProbers } from "./native-platform.js";
import { notesProber } from "./notes.js";
import { notificationsProber } from "./notifications.js";
import { remindersProber } from "./reminders.js";
import { screenRecordingProber } from "./screen-recording.js";
import { screentimeProber } from "./screentime.js";
import { shellProber } from "./shell.js";

export const ALL_PROBERS: readonly Prober[] = [
  accessibilityProber,
  automationProber,
  calendarProber,
  cameraProber,
  contactsProber,
  fullDiskProber,
  healthProber,
  locationProber,
  microphoneProber,
  ...nativePlatformProbers,
  notesProber,
  notificationsProber,
  remindersProber,
  screenRecordingProber,
  screentimeProber,
  shellProber,
];

export const PROBERS_BY_ID: ReadonlyMap<PermissionId, Prober> = new Map(
  ALL_PROBERS.map((p) => [p.id, p]),
);

export {
  accessibilityProber,
  automationProber,
  calendarProber,
  cameraProber,
  contactsProber,
  fullDiskProber,
  healthProber,
  locationProber,
  microphoneProber,
  notesProber,
  notificationsProber,
  remindersProber,
  screenRecordingProber,
  screentimeProber,
  shellProber,
};
