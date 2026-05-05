import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-google-meet-cute", () => {
  it("exports the plugin metadata", { timeout: 60_000 }, async () => {
    const { default: googleMeetPlugin, googleMeetPlugin: namedExport } =
      await import("../src/index.ts");

    expect(namedExport).toBe(googleMeetPlugin);
    expect(googleMeetPlugin.name).toBe("plugin-google-meet-cute");
    expect(googleMeetPlugin.actions?.map((action) => action.name)).toEqual([
      "AUTHENTICATE_GOOGLE",
      "CREATE_MEETING",
      "GET_MEETING_INFO",
      "GET_PARTICIPANTS",
      "GENERATE_MEETING_REPORT",
    ]);
    expect(googleMeetPlugin.services).toHaveLength(2);
    expect(googleMeetPlugin.providers).toHaveLength(1);
  });
});
