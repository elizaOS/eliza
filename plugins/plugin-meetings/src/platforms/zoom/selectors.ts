/**
 * Zoom Web Client DOM selectors — ported verbatim from Vexa
 * (services/vexa-bot/core/src/platforms/zoom/web/selectors.ts, Apache-2.0;
 * verified from live DOM inspection). Constants only.
 */

// ---- Pre-join page ----
export const zoomNameInputSelector = "#input-for-name";
export const zoomJoinButtonSelector = "button.preview-join-button";
export const zoomPreviewMuteSelector = "#preview-audio-control-button";
export const zoomPreviewVideoSelector = "#preview-video-control-button";
export const zoomPermissionDismissSelector =
  'button:has-text("Continue without microphone and camera")';
export const zoomPasscodeInputSelector =
  'input[placeholder*="passcode" i], input[placeholder*="password" i], input[type="password"]';

// ---- In-meeting indicators ----
export const zoomLeaveButtonSelector = 'button[aria-label="Leave"]';
export const zoomAudioButtonSelector = "button.join-audio-container__btn";
export const zoomVideoButtonSelector = "button.send-video-container__btn";
export const zoomParticipantsButtonSelector =
  'button[aria-label*="participants list"]';
export const zoomMeetingAppSelector = ".meeting-app";

// ---- Host-not-started / invalid meeting ----
export const zoomInvalidMeetingText = "This meeting link is invalid";
export const zoomErrorPageTitle = "Error - Zoom";

// ---- Waiting room ----
export const zoomWaitingRoomTexts = [
  "Please wait, the meeting host will let you in soon.",
  "Please wait",
  "Waiting for the host to start this meeting",
  "Waiting for the host to start the meeting",
  "waiting room",
  "Waiting Room",
  "Host has joined. We've let them know you're here",
];

// ---- Removal / end-of-meeting ----
export const zoomMeetingEndedModalSelector = ".zm-modal-body-title";
export const zoomRemovalTexts = [
  "This meeting has been ended by host",
  "removed from the meeting",
  "meeting has ended",
  "Meeting has ended",
  "ended by the host",
  "You have been removed",
  "host ended the meeting",
];

// ---- Auth-required gate ----
export const zoomAuthRequiredTexts = [
  "sign in to join this meeting",
  "sign in to join",
  "authentication is required",
  "only authenticated users can join",
  "this meeting requires authentication",
];

// ---- Speaker / participant DOM ----
/** Active speaker tile (main large video frame, normal layout). */
export const zoomActiveSpeakerSelector =
  ".speaker-active-container__video-frame";
/** Active speaker tile in screen-share layout (--active modifier). */
export const zoomActiveSpeakerBarSelector =
  ".speaker-bar-container__video-frame--active";
/** Participant name label inside a tile (span within the avatar footer). */
export const zoomParticipantNameSelector = ".video-avatar__avatar-footer";

// ---- Leave dialog ----
export const zoomLeaveConfirmSelectors = [
  "button.leave-meeting-options__btn--danger",
  "button.leave-meeting-options__btn",
  'button.zm-btn--danger[aria-label*="Leave"]',
];
