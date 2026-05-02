import { Plugin, logger } from "@elizaos/core";
import { GoogleAuthService } from "./services/googleAuthService";
import { GoogleMeetAPIService } from "./services/googleMeetAPIService";
import {
  createMeetingAction,
  getMeetingInfoAction,
  getParticipantsAction,
  generateReportAction,
  authenticateAction
} from "./actions";
import { meetingProvider } from "./providers";
import { googleMeetConfigSchema } from "./types";

export const googleMeetPlugin: Plugin = {
  name: "plugin-google-meet-cute",
  description:
    "Google Meet integration plugin for ElizaOS - manage meetings, get participant info, and access meeting artifacts via Google Meet REST API",

  services: [GoogleAuthService, GoogleMeetAPIService],
  actions: [
    authenticateAction,
    createMeetingAction,
    getMeetingInfoAction,
    getParticipantsAction,
    generateReportAction
  ],
  providers: [meetingProvider],

  config: {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
    GOOGLE_MEET_DEFAULT_ACCESS_TYPE: process.env.GOOGLE_MEET_DEFAULT_ACCESS_TYPE,
    REPORT_OUTPUT_DIR: process.env.REPORT_OUTPUT_DIR,
  },

  async init(config: Record<string, string>, runtime?: any): Promise<void> {
    logger.info("Initializing Google Meet plugin...");

    try {
      // Validate configuration
      const validatedConfig = {
        GOOGLE_CLIENT_ID:
          runtime?.getSetting("GOOGLE_CLIENT_ID") ||
          config.GOOGLE_CLIENT_ID ||
          process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET:
          runtime?.getSetting("GOOGLE_CLIENT_SECRET") ||
          config.GOOGLE_CLIENT_SECRET ||
          process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI:
          runtime?.getSetting("GOOGLE_REDIRECT_URI") ||
          config.GOOGLE_REDIRECT_URI ||
          process.env.GOOGLE_REDIRECT_URI ||
          "http://localhost:3000/oauth2callback",
        GOOGLE_REFRESH_TOKEN:
          runtime?.getSetting("GOOGLE_REFRESH_TOKEN") ||
          config.GOOGLE_REFRESH_TOKEN ||
          process.env.GOOGLE_REFRESH_TOKEN,
        GOOGLE_MEET_DEFAULT_ACCESS_TYPE:
          runtime?.getSetting("GOOGLE_MEET_DEFAULT_ACCESS_TYPE") ||
          config.GOOGLE_MEET_DEFAULT_ACCESS_TYPE ||
          process.env.GOOGLE_MEET_DEFAULT_ACCESS_TYPE ||
          "OPEN",
        REPORT_OUTPUT_DIR:
          runtime?.getSetting("REPORT_OUTPUT_DIR") ||
          config.REPORT_OUTPUT_DIR ||
          process.env.REPORT_OUTPUT_DIR ||
          "./meeting-reports",
      };

      // Validate with schema
      await googleMeetConfigSchema.parseAsync(validatedConfig);

      logger.info("Google Meet plugin configuration validated successfully");

      // Store config in runtime if available
      if (runtime) {
        runtime.character.settings = runtime.character.settings || {};
        runtime.character.settings.googleMeetConfig = validatedConfig;
      }

      // Check if credentials are configured
      if (!validatedConfig.GOOGLE_CLIENT_ID || !validatedConfig.GOOGLE_CLIENT_SECRET) {
        logger.warn("Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to use the Google Meet API.");
      }
    } catch (error) {
      logger.error(
        "Google Meet plugin configuration validation failed:",
        error,
      );
      throw new Error(
        `Invalid Google Meet plugin configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  dependencies: [],
};

export default googleMeetPlugin;

// Export types and utilities for external use
export * from "./types";
export { GoogleAuthService } from "./services/googleAuthService";
export { GoogleMeetAPIService } from "./services/googleMeetAPIService";
