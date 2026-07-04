/**
 * Google Meet selectors — ported VERBATIM from Vexa
 * (services/vexa-bot/core/src/platforms/googlemeet/selectors.ts, Apache-2.0).
 * Constants only; no runtime logic. Locale-agnostic structural selectors come
 * FIRST, English-text fallbacks LAST (see selectors.ts rationale for the
 * non-English lobby bugs these lists fix).
 */

export const googleInitialAdmissionIndicators: readonly string[] = [
  // DOM fallback selectors — only indicators that do NOT appear in the lobby.
  // DANGER: Leave call, toolbar, mic/camera toggles all exist in the lobby too!
  // Primary admission signal is active MediaStreams (checked in admission.ts).
  "[data-participant-id]",
  "[data-self-name]",
  'button[aria-label*="Share screen"]',
  'button[aria-label*="Present now"]',
];

export const googleWaitingRoomIndicators: readonly string[] = [
  'text="Asking to be let in..."',
  'text*="Asking to be let in"',
  "text=\"You'll join the call when someone lets you in\"",
  "text*=\"You'll join the call when someone lets you\"",
  'text="Please wait until a meeting host brings you into the call"',
  'text="Waiting for the host to let you in"',
  "text=\"You're in the waiting room\"",
  'text="Asking to be let in"',
  '[aria-label*="waiting room"]',
  '[aria-label*="Asking to be let in"]',
  '[aria-label*="waiting for admission"]',
];

export const googleRejectionIndicators: readonly string[] = [
  'text*="denied your request"',
  'text*="denied your request to join"',
  'text*="Your request to join was denied"',
  'text*="You were denied"',
  "text*=\"weren't allowed to join\"",
  'text*="not allowed to join"',
  'text*="not admitted"',
  "text*=\"can't join this call\"",
  'text*="cannot join this call"',
  'text*="Ask to join again"',
  'button:has-text("Ask to join again")',
  'button:has-text("Return to home screen")',
  'text="Meeting not found"',
  "text=\"Can't join the meeting\"",
  'text="Unable to join"',
  'text="Access denied"',
  'text="Meeting has ended"',
  'text="This meeting has ended"',
  'text="Invalid meeting"',
  'text="Meeting link expired"',
  '[role="dialog"]:has-text("Meeting not found")',
  '[role="alertdialog"]:has-text("Meeting not found")',
  '[role="dialog"]:has-text("meeting not found")',
  '[role="alertdialog"]:has-text("meeting not found")',
  '[role="dialog"]:has-text("Meeting has ended")',
  '[role="alertdialog"]:has-text("Meeting has ended")',
  '[role="dialog"]:has-text("meeting has ended")',
  '[role="alertdialog"]:has-text("meeting has ended")',
  'button:has-text("Try again")',
  'button:has-text("Retry")',
  'button:has-text("Go back")',
  'button[aria-label*="retry"]',
  'button[aria-label*="try again"]',
];

export const googleAdmissionIndicators: readonly string[] = [
  'button[aria-label*="Chat"]',
  'button[aria-label*="chat"]',
  'button[aria-label*="People"]',
  'button[aria-label*="people"]',
  'button[aria-label*="Participants"]',
  'button[aria-label*="Leave call"]',
  'button[aria-label*="Leave meeting"]',
  'button[aria-label*="Turn off microphone"]',
  'button[aria-label*="Turn on microphone"]',
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn on camera"]',
  'button[aria-label*="Share screen"]',
  'button[aria-label*="Present now"]',
  '[role="toolbar"]',
  "[data-participant-id]",
  "[data-self-name]",
  "[data-audio-level]",
  '[aria-label*="microphone"]',
  '[aria-label*="camera"]',
  '[data-tooltip*="microphone"]',
  '[data-tooltip*="camera"]',
  '[aria-label*="meeting"]',
  "div[data-meeting-id]",
];

export const googleParticipantSelectors: readonly string[] = [
  "div[data-participant-id]",
  "[data-participant-id]",
  '[aria-label*="participant"]',
  "[data-self-name]",
  ".participant-tile",
  ".video-tile",
];

export const googleSpeakingClassNames: readonly string[] = [
  "Oaajhc",
  "HX2H7",
  "wEsLMd",
  "OgVli",
  "speaking",
  "active-speaker",
  "speaker-active",
  "speaking-indicator",
  "audio-active",
  "mic-active",
  "microphone-active",
  "voice-active",
  "speaking-border",
  "speaking-glow",
  "speaking-highlight",
];

export const googleSpeakingIndicators: readonly string[] = [
  '[data-audio-level]:not([data-audio-level="0"])',
  ".Oaajhc",
  ".HX2H7",
  ".wEsLMd",
  ".OgVli",
];

export const googleParticipantContainerSelectors: readonly string[] = [
  "[data-participant-id]",
  "[data-self-name]",
  ".participant-tile",
  ".video-tile",
  '[jsname="BOHaEe"]',
];

export const googleNameSelectors: readonly string[] = [
  "span.notranslate",
  "[data-self-name]",
  ".zWGUib",
  ".cS7aqe.N2K3jd",
  ".XWGOtd",
  '[data-tooltip*="name"]',
  '[aria-label*="name"]',
  ".participant-name",
  ".display-name",
  ".user-name",
];

export const googleRemovalIndicators: readonly string[] = [
  'text="Meeting ended"',
  'text*="Meeting ended"',
  'text="Call ended"',
  'text*="Call ended"',
  'text="You left the meeting"',
  'text*="You left the meeting"',
  'text="Connection lost"',
  'text*="Connection lost"',
  'text="Unable to connect"',
  'text*="Unable to connect"',
  'text="Reconnecting"',
  'text*="Reconnecting"',
  '[role="alert"]',
  '[role="alertdialog"]',
  ".error-message",
  ".connection-error",
  ".meeting-error",
];

// Locale-agnostic FIRST (structure / jsname / role), then English text fallback.
export const googleJoinButtonSelectors: readonly string[] = [
  "button[jsname]:not([aria-label]):has(span)",
  "div[jscontroller] button[jsname]:not([aria-label]):has(span)",
  '//button[.//span[text()="Ask to join"]]',
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'button:has-text("Join")',
];

export const googleCameraButtonSelectors: readonly string[] = [
  '[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn on camera"]',
];

export const googleMicrophoneButtonSelectors: readonly string[] = [
  '[aria-label*="Turn off microphone"]',
  'button[aria-label*="Turn off microphone"]',
  'button[aria-label*="Turn on microphone"]',
];

export const googleNameInputSelectors: readonly string[] = [
  'input[jsname][type="text"]',
  'input[type="text"]:not([aria-hidden="true"])',
  'div[jscontroller] input[type="text"]',
  'input[type="text"][aria-label="Your name"]',
  'input[placeholder*="name"]',
  'input[placeholder*="Name"]',
];

export const googleLeaveSelectors: readonly string[] = [
  'button[aria-label="Leave call"]',
  'button[aria-label*="Leave"]',
  'button[aria-label*="leave"]',
  '[role="toolbar"] button[aria-label*="Leave"]',
  'button[aria-label*="End meeting"]',
  'button:has-text("End meeting")',
  'button[aria-label*="Hang up"]',
  'button:has-text("Hang up")',
  'button:has-text("Leave meeting")',
  'button:has-text("Just leave the meeting")',
  'button:has-text("Leave")',
  '[role="dialog"] button:has-text("Leave")',
  '[role="dialog"] button:has-text("End meeting")',
  '[role="alertdialog"] button:has-text("Leave")',
  'button:has-text("Close")',
  'button[aria-label="Close"]',
  'button:has-text("Cancel")',
  'button[aria-label="Cancel"]',
];
