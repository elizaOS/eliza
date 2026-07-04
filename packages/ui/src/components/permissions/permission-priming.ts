/**
 * Declares the platform-specific permission priming sets, rationale copy, and
 * persisted shown-state for the onboarding soft-ask flow.
 */
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import { getFrontendPlatform } from "../../platform/platform-guards";

/**
 * Permission-priming logic for the post-login onboarding modal.
 *
 * This module owns three concerns and nothing else:
 *  1. Which permissions to prime, per platform, as an explicit crash-guarded
 *     allowlist (never a loop over PERMISSION_IDS — that would hard-crash iOS on
 *     an unentitled request; see the platform table below).
 *  2. The plain-language rationale copy shown in each soft-ask card, before any
 *     OS dialog is triggered.
 *  3. The persisted "already primed" flag so the modal shows once and can be
 *     re-triggered from Settings.
 *
 * The soft-ask contract: the OS permission dialog is only ever fired when the
 * user taps "Enable" on a card. Priming a permission here does NOT request it —
 * it only decides that a rationale card is worth showing.
 */

export type PrimingPlatform = "ios" | "android" | "desktop" | "web";

export interface PrimingPermissionCopy {
  /** Icon key (matches SYSTEM_PERMISSIONS `icon` keys in permission-types). */
  icon: string;
  /** i18n key for the card title; `title` is the English fallback. */
  titleKey: string;
  title: string;
  /** i18n key for the value-proposition line; `rationale` is the fallback. */
  rationaleKey: string;
  rationale: string;
}

/**
 * Value-proposition copy for every permission we ever prime. Keyed by
 * PermissionId. First-person, benefit-led — this is what earns the "Enable"
 * tap, so it must read as *why the user wins*, not what the OS is about to ask.
 */
export const PRIMING_COPY: Partial<
  Record<PermissionId, PrimingPermissionCopy>
> = {
  microphone: {
    icon: "mic",
    titleKey: "permissionpriming.microphone.title",
    title: "Talk to me",
    rationaleKey: "permissionpriming.microphone.rationale",
    rationale:
      "Turn on your microphone so you can speak instead of type. Voice stays on your device unless you send it.",
  },
  "speech-recognition": {
    icon: "audio-lines",
    titleKey: "permissionpriming.speechRecognition.title",
    title: "Understand your voice",
    rationaleKey: "permissionpriming.speechRecognition.rationale",
    rationale:
      "Allow speech recognition so I can turn what you say into text for hands-free chats.",
  },
  location: {
    icon: "map-pin",
    titleKey: "permissionpriming.location.title",
    title: "Plan around where you are",
    rationaleKey: "permissionpriming.location.rationale",
    rationale:
      "Share your location so I can factor in travel time, your time zone, and place-aware reminders.",
  },
  notifications: {
    icon: "bell",
    titleKey: "permissionpriming.notifications.title",
    title: "Reach you when it matters",
    rationaleKey: "permissionpriming.notifications.rationale",
    rationale:
      "Let me send notifications for reminders, follow-ups, and results from work I do in the background.",
  },
  camera: {
    icon: "camera",
    titleKey: "permissionpriming.camera.title",
    title: "Show me things",
    rationaleKey: "permissionpriming.camera.rationale",
    rationale:
      "Enable the camera so you can capture photos and video for me to look at.",
  },
};

/**
 * Explicit per-platform, ordered priming sets. Highest-value first (voice).
 *
 * iOS crash guard: every id here MUST have a declared `NS*UsageDescription` in
 * packages/app-core/platforms/ios/App/App/Info.plist — requesting an unentitled
 * permission on iOS aborts the process. Verified present for this set:
 * microphone, speech-recognition, notifications, location (When-In-Use). Never
 * add contacts / reminders / bluetooth here (their usage strings are absent).
 *
 * Web is intentionally empty: eager browser permission prompts on load are a
 * dark pattern browsers de-rank, so on web everything stays just-in-time via the
 * agent's in-chat permission-card.
 */
const PRIMING_SETS: Record<PrimingPlatform, readonly PermissionId[]> = {
  ios: ["microphone", "speech-recognition", "notifications", "location"],
  android: ["microphone", "notifications", "location"],
  desktop: ["microphone", "notifications", "location"],
  web: [],
};

export interface ResolvePrimingOptions {
  /** Override the detected platform (tests / Settings). */
  platform?: PrimingPlatform;
  /**
   * Explicit id list, e.g. a Settings "re-request just these" flow. Still
   * filtered so only ids with priming copy survive.
   */
  only?: readonly PermissionId[];
}

/**
 * The ordered list of permissions to prime for the current platform. Only ids
 * that have both a platform-set entry (or explicit `only`) AND rationale copy
 * are returned, so the modal can never render a card it has no words for.
 */
export function resolvePrimingSet(
  opts: ResolvePrimingOptions = {},
): PermissionId[] {
  const platform = opts.platform ?? getFrontendPlatform();
  const base = opts.only ?? PRIMING_SETS[platform] ?? [];
  return base.filter(
    (id): id is PermissionId => PRIMING_COPY[id] !== undefined,
  );
}

/** localStorage key for the shown-once flag. */
export const PERMISSION_PRIMING_STORAGE_KEY = "eliza:permissions-primed";

/**
 * True once the priming modal has run to completion (granted, skipped, or
 * dismissed). Storage access can throw in locked-down webviews — a throw means
 * "we don't know", which we treat as not-yet-primed so the modal errs toward
 * showing rather than silently never appearing.
 */
export function hasPrimedPermissions(): boolean {
  try {
    return localStorage.getItem(PERMISSION_PRIMING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record that priming has been shown so it does not reappear on next launch. */
export function markPermissionsPrimed(): void {
  try {
    localStorage.setItem(PERMISSION_PRIMING_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable — the modal will show again next launch, which is a
    // benign degradation, not a failure worth surfacing.
  }
}

/** Clear the flag so the priming modal can be re-triggered (Settings entry). */
export function resetPermissionPriming(): void {
  try {
    localStorage.removeItem(PERMISSION_PRIMING_STORAGE_KEY);
  } catch {
    // Same benign degradation as markPermissionsPrimed.
  }
}
