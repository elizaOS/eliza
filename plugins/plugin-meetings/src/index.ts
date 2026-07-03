/**
 * @module plugin-meetings
 * @description elizaOS meeting transcription plugin — browser bots that join
 * Google Meet / Microsoft Teams / Zoom as guests, capture per-speaker audio,
 * transcribe through the runtime model layer (`ModelType.TRANSCRIPTION`), and
 * land diarized transcripts in the Transcripts view + knowledge store.
 *
 * Surface:
 *   - MeetingService ("meetings") — session state machine + orchestration
 *   - JOIN_MEETING / LEAVE_MEETING / GET_MEETING_TRANSCRIPT actions
 *   - ACTIVE_MEETINGS provider
 *   - /api/meetings* rawPath routes
 *
 * Env:
 *   - ELIZA_MEETINGS_ENABLED       opt-in auto-enable flag
 *   - ELIZA_MEETINGS_BOT_NAME      bot display name (default "<agent> Notetaker")
 *   - ELIZA_MEETINGS_CHROMIUM_PATH Chromium executable for the platform bots
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import type { MeetingPlatform } from "@elizaos/shared";
import {
  getMeetingTranscriptAction,
  joinMeetingAction,
  leaveMeetingAction,
} from "./actions/index.js";
import { createMeetingTranscriptionPipeline } from "./pipeline/index.js";
import { GoogleMeetAdapter } from "./platforms/googlemeet/adapter.js";
import { MsTeamsAdapter } from "./platforms/msteams/adapter.js";
import { ZoomAdapter } from "./platforms/zoom/adapter.js";
import { activeMeetingsProvider } from "./providers/active-meetings.js";
import { meetingsRoutes } from "./routes/meetings-routes.js";
import { MeetingService } from "./service.js";
import type { MeetingPlatformAdapter } from "./types.js";

export { MeetingEventEmitter } from "./events.js";
export { meetingsRoutes } from "./routes/meetings-routes.js";
export {
  MeetingJoinError,
  type MeetingPipelineInstance,
  MeetingService,
  type MeetingServiceDependencies,
} from "./service.js";
export {
  MeetingTranscriptWriter,
  readTranscriptRow,
} from "./transcripts/meeting-transcript-writer.js";
export * from "./types.js";

// Concrete wiring for the injectable seams: the browser platform adapters and
// the ASR pipeline. Kept here (not in service.ts) so the orchestration layer
// stays independently testable with scripted adapters/pipelines.
MeetingService.dependencyFactory = (_runtime: IAgentRuntime) => ({
  adapters: new Map<MeetingPlatform, MeetingPlatformAdapter>([
    ["google_meet", new GoogleMeetAdapter()],
    ["teams", new MsTeamsAdapter()],
    ["zoom", new ZoomAdapter()],
  ]),
  createPipeline: createMeetingTranscriptionPipeline,
});

export const meetingsPlugin: Plugin = {
  name: "meetings",
  description:
    "Meeting transcription — joins Google Meet / Microsoft Teams / Zoom as a notetaker bot and produces live, diarized transcripts",
  services: [MeetingService],
  actions: [joinMeetingAction, leaveMeetingAction, getMeetingTranscriptAction],
  providers: [activeMeetingsProvider],
  routes: meetingsRoutes,
  // Opt-in: the bots need a Chromium binary on the host, so the plugin is only
  // auto-enabled when the user has flagged it (or pointed at a browser) —
  // matching the repo pattern of env-gated connector plugins (e.g. calendly).
  autoEnable: {
    envKeys: ["ELIZA_MEETINGS_ENABLED", "ELIZA_MEETINGS_CHROMIUM_PATH"],
  },
};

export default meetingsPlugin;
