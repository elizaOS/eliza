import { describe, it, expect } from "vitest";
import { googleMeetPlugin } from "../index";

describe("Google Meet Plugin", () => {
  it("should export the plugin with correct structure", () => {
    expect(googleMeetPlugin).toBeDefined();
    expect(googleMeetPlugin.name).toBe("plugin-google-meet-cute");
    expect(googleMeetPlugin.description).toContain("Google Meet integration plugin");
    expect(googleMeetPlugin.services).toBeDefined();
    expect(googleMeetPlugin.services).toHaveLength(2); // GoogleAuthService and GoogleMeetAPIService
    expect(googleMeetPlugin.actions).toBeDefined();
    expect(googleMeetPlugin.actions).toHaveLength(5); // 5 actions
    expect(googleMeetPlugin.providers).toBeDefined();
    expect(googleMeetPlugin.providers).toHaveLength(1); // meetingProvider
  });

  it("should have init function", () => {
    expect(googleMeetPlugin.init).toBeDefined();
    expect(typeof googleMeetPlugin.init).toBe("function");
  });

  it("should have all required actions", () => {
    const actionNames = googleMeetPlugin.actions?.map(action => action.name) || [];
    expect(actionNames).toContain("AUTHENTICATE_GOOGLE");
    expect(actionNames).toContain("CREATE_MEETING");
    expect(actionNames).toContain("GET_MEETING_INFO");
    expect(actionNames).toContain("GET_PARTICIPANTS");
    expect(actionNames).toContain("GENERATE_REPORT");
  });
}); 