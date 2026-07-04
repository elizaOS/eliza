/**
 * Microsoft Teams meeting bot adapter. Joins as an anonymous guest, enables
 * live captions, and routes the ONE mixed remote audio stream to speakers
 * via caption authorship (TeamsCaptionRouter). Prefers the Edge browser
 * channel — Teams serves its most stable guest web client to Edge.
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason, MeetingPlatform } from "@elizaos/shared";
import type { MeetingBotSession, MeetingPlatformAdapter } from "../../types.js";
import { launchMeetingBrowser, type MeetingBrowser } from "../shared/launch.js";
import { runMeetingFlow } from "../shared/meeting-flow.js";
import { createMsTeamsStrategies } from "./strategies.js";

const TAG = "[MsTeamsAdapter]";

export class MsTeamsAdapter implements MeetingPlatformAdapter {
  readonly platform: MeetingPlatform = "teams";

  async run(session: MeetingBotSession): Promise<MeetingEndReason> {
    let browser: MeetingBrowser;
    try {
      browser = await launchMeetingBrowser({ channel: "msedge" });
      logger.info(`${TAG} launched Edge channel browser`);
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        `${TAG} Edge channel unavailable — falling back to Chrome`,
      );
      browser = await launchMeetingBrowser({ channel: "chrome" });
    }

    try {
      return await runMeetingFlow({
        page: browser.page,
        session,
        strategies: createMsTeamsStrategies(),
        waitingRoomTimeoutMs: session.config.autoLeave.waitingRoomTimeoutMs,
      });
    } finally {
      await browser.close();
    }
  }
}
