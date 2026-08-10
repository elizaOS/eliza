/** Verifies the exported personal-Google capability contract stays read-only for Calendar. */

import { describe, expect, it } from "vitest";
import { LIFEOPS_GOOGLE_CAPABILITIES } from "./lifeops.js";

describe("LifeOps personal-Google capabilities", () => {
  it("exposes Calendar read without an unsupported write capability", () => {
    expect(LIFEOPS_GOOGLE_CAPABILITIES).toContain("google.calendar.read");
    expect(LIFEOPS_GOOGLE_CAPABILITIES).not.toContain("google.calendar.write");
  });
});
