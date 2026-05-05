import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-google-meet-cute", () => {
  it("exports the plugin metadata", { timeout: 120_000 }, async () => {
    const { default: googleMeetPlugin, googleMeetPlugin: namedExport } =
      await import("../src/index.ts");

    expect(namedExport).toBe(googleMeetPlugin);
    expect(googleMeetPlugin.name).toBe("plugin-google-meet-cute");
    expect(googleMeetPlugin.actions?.map((action) => action.name)).toEqual([
      "AUTHENTICATE_GOOGLE",
      "CREATE_MEETING",
      "GET_MEETING_INFO",
      "GET_PARTICIPANTS",
      "GENERATE_REPORT",
    ]);
    expect(
      googleMeetPlugin.actions
        ?.find((action) => action.name === "GET_MEETING_INFO")
        ?.parameters?.map((param) => param.name),
    ).toEqual(["meetingId"]);
    expect(
      googleMeetPlugin.actions
        ?.find((action) => action.name === "GET_PARTICIPANTS")
        ?.parameters?.map((param) => param.name),
    ).toEqual(["conferenceRecordName"]);
    expect(googleMeetPlugin.services).toHaveLength(2);
    expect(googleMeetPlugin.providers).toHaveLength(1);
  });
});
