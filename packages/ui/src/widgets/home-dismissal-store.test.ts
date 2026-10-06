import { describe, expect, it } from "vitest";
import {
  __resetHomeDismissalsForTests,
  isHomeWidgetSunset,
  recordHomeWidgetSeen,
} from "./home-dismissal-store";

describe("isHomeWidgetSunset", () => {
  it("retires after the configured number of sessions", () => {
    __resetHomeDismissalsForTests();
    const key = "home/nudge";
    const priorSession = { [key]: { seen: 1, acted: false, dismissed: false } };
    expect(isHomeWidgetSunset(key, { afterSeen: 1 }, priorSession)).toBe(true);
  });

  it("counts the current session without retiring the card until the next one", () => {
    __resetHomeDismissalsForTests();
    const key = "home/nudge";
    recordHomeWidgetSeen(key);
    const currentSession = { [key]: { seen: 1, acted: false, dismissed: false } };
    expect(isHomeWidgetSunset(key, { afterSeen: 1 }, currentSession)).toBe(false);
    __resetHomeDismissalsForTests();
    expect(isHomeWidgetSunset(key, { afterSeen: 1 }, currentSession)).toBe(true);
    expect(isHomeWidgetSunset(key, { afterSeen: 2 }, currentSession)).toBe(false);
  });
});
