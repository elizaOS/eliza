/**
 * Microsoft Teams DOM selectors — ported verbatim from Vexa
 * (services/vexa-bot/core/src/platforms/msteams/selectors.ts, Apache-2.0).
 * Constants only; no runtime logic.
 */

export const teamsInitialAdmissionIndicators: string[] = [
  'button[id="hangup-button"]',
  'button[data-tid="hangup-main-btn"]',
  'button[aria-label="Leave"]',
  '[role="toolbar"] button[aria-label*="Leave"]',
  'button[aria-label*="Leave"]',
];

export const teamsWaitingRoomIndicators: string[] = [
  'text="Someone will let you in shortly"',
  'text="You\'re in the lobby"',
  'text="Waiting for someone to let you in"',
  'text="Please wait until someone admits you"',
  'text="Wait for someone to admit you"',
  'text="Waiting to be admitted"',
  'text="Your request to join has been sent"',
];

export const teamsRejectionIndicators: string[] = [
  'text="Sorry, but you were denied"',
  'text="You were denied entry"',
  'text="Access denied"',
  'text="Entry denied"',
  'text="Request denied"',
  'text="Admission denied"',
  'text="Unable to join"',
  '[role="dialog"]:has-text("denied")',
  '[role="alertdialog"]:has-text("denied")',
  'button[aria-label*="denied"]',
];

/**
 * Pre-join "Continue without audio or video" confirmation dialog. Teams
 * renders this modal when the browser denies camera/mic permission; the
 * prejoin "Join now" button never enables until it is dismissed.
 */
export const teamsContinueWithoutMediaSelectors: string[] = [
  'button:has-text("Continue without audio or video")',
  'button[aria-label="Continue without audio or video"]',
  'button[aria-label*="Continue without audio"]',
  '[role="dialog"] button:has-text("Continue without audio or video")',
  '[role="alertdialog"] button:has-text("Continue without audio or video")',
];

export const teamsContinueButtonSelectors: string[] = [
  'button:has-text("Continue")',
];

export const teamsJoinButtonSelectors: string[] = [
  'button:has-text("Join now")',
  'button:has-text("Join")',
];

export const teamsCameraButtonSelectors: string[] = [
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn on camera"]',
  'button[aria-label*="Turn camera off"]',
  'button[aria-label*="Turn camera on"]',
  'button[aria-label*="Turn off video"]',
  'button[aria-label*="Turn on video"]',
];

export const teamsNameInputSelectors: string[] = [
  'input[placeholder*="name"]',
  'input[placeholder*="Name"]',
  'input[type="text"]',
];

export const teamsComputerAudioRadioSelectors: string[] = [
  'radio[aria-label*="Computer audio"]',
  'radio:has-text("Computer audio")',
  '[role="radio"][aria-label*="Computer audio"]',
];

export const teamsDontUseAudioRadioSelectors: string[] = [
  'radio[aria-label*="Don\'t use audio"]',
  'radio:has-text("Don\'t use audio")',
  '[role="radio"][aria-label*="Don\'t use audio"]',
];

export const teamsSpeakerEnableSelectors: string[] = [
  'button[aria-label*="Turn speaker on"]',
  'button[aria-label*="Speaker is off"]',
  'button:has-text("Turn speaker on")',
  'button:has-text("Speaker is off")',
];

/**
 * Live captions DOM. HOST and GUEST caption trees differ; the only stable
 * atoms across both are [data-tid="author"] and
 * [data-tid="closed-caption-text"] inside the renderer wrapper — pair them
 * by document order.
 */
export const teamsCaptionSelectors = {
  rendererWrapper: '[data-tid="closed-caption-renderer-wrapper"]',
  authorName: '[data-tid="author"]',
  captionText: '[data-tid="closed-caption-text"]',
  moreButton: "#callingButtons-showMoreBtn",
} as const;

/** Primary voice-level speaking indicator (fallback speaker attribution). */
export const teamsVoiceLevelSelector =
  '[data-tid="voice-level-stream-outline"]';

export const teamsRemovalPhrases: string[] = [
  "you've been removed from this meeting",
  "you have been removed from this meeting",
  "removed from meeting",
  "meeting ended",
  "call ended",
];

export const teamsPrimaryHangupButtonSelector = "#hangup-button";

export const teamsLeaveSelectors: string[] = [
  'button[id="hangup-button"]',
  'button[data-tid="hangup-main-btn"]',
  'button[aria-label="Cancel"]',
  'button:has-text("Cancel")',
  'button[aria-label="Leave"]',
  'button:has-text("Leave")',
  'button[aria-label*="Leave"]',
  '[role="toolbar"] button[aria-label*="Leave"]',
  'button[aria-label*="End meeting"]',
  'button:has-text("End meeting")',
  'button[aria-label*="Hang up"]',
  'button:has-text("Hang up")',
  '[role="dialog"] button:has-text("Leave")',
  '[role="alertdialog"] button:has-text("Leave")',
];
