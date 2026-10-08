import { describe, expect, it } from "vitest";
import { formatSchedule } from "./cron-format";

describe("formatSchedule minute steps", () => {
  it("describes steps that divide the hour", () => {
    expect(formatSchedule("*/15 * * * *")).toBe("Every 15 minutes");
    expect(formatSchedule("*/1 * * * *")).toBe("Every minute");
  });

  it("keeps the raw expression for uneven minute steps", () => {
    expect(formatSchedule("*/45 * * * *")).toBe("*/45 * * * *");
    expect(formatSchedule("*/40 * * * *")).toBe("*/40 * * * *");
  });
});
