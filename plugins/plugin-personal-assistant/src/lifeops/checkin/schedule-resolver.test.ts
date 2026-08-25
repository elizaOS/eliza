import { describe, expect, it, vi } from "vitest";
import { resolveCheckinSchedule } from "./schedule-resolver";

const readProfile = vi.hoisted(() => ({ readLifeOpsOwnerProfile: vi.fn() }));

vi.mock("../owner-profile.js", () => readProfile);

const runtime = {} as never;

function profileWith(overrides: Record<string, unknown>) {
  return {
    morningCheckinTime: undefined,
    nightCheckinTime: undefined,
    ...overrides,
  };
}

describe("resolveCheckinSchedule", () => {
  it("normalizes and zero-pads valid times", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "9:05", nightCheckinTime: "22:30" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: "09:05",
      nightCheckinTime: "22:30",
    });
  });

  it("rejects single-digit minutes (HH:MM requires two digits)", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "7:5" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: null,
      nightCheckinTime: null,
    });
  });

  it("keeps boundary values 00:00 and 23:59", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "0:00", nightCheckinTime: "23:59" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: "00:00",
      nightCheckinTime: "23:59",
    });
  });

  it("rejects hours out of range", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "24:00" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: null,
      nightCheckinTime: null,
    });
  });

  it("rejects minutes out of range", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ nightCheckinTime: "12:60" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: null,
      nightCheckinTime: null,
    });
  });

  it("rejects non-HH:MM shapes", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "abc", nightCheckinTime: "-1:00" }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: null,
      nightCheckinTime: null,
    });
  });

  it("returns null for unconfigured or blank slots", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "", nightCheckinTime: "   " }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: null,
      nightCheckinTime: null,
    });
  });

  it("trims surrounding whitespace before parsing", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(
      profileWith({ morningCheckinTime: "  08:30  " }),
    );
    await expect(resolveCheckinSchedule(runtime)).resolves.toEqual({
      morningCheckinTime: "08:30",
      nightCheckinTime: null,
    });
  });

  it("reads the profile through readLifeOpsOwnerProfile", async () => {
    readProfile.readLifeOpsOwnerProfile.mockResolvedValue(profileWith({}));
    await resolveCheckinSchedule(runtime);
    expect(readProfile.readLifeOpsOwnerProfile).toHaveBeenCalledWith(runtime);
  });
});
