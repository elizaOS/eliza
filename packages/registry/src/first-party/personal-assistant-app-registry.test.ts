/** Exercises curated app ordering when registry metadata contains non-finite values. */
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCacheForTests } from "./index";

describe("personal-assistant app registry entry", () => {
  afterEach(() => {
    clearRegistryCacheForTests();
  });

  it("sorts curated app definitions safely when order contains NaN", async () => {
    const { collectCuratedAppDefinitions } = await import("./generate");
    const entries = [
      {
        npmName: "pkg-nan",
        curatedApp: { slug: "app-nan", order: NaN, aliases: [] },
      },
      {
        npmName: "pkg-a",
        curatedApp: { slug: "app-a", order: 5, aliases: [] },
      },
    ];

    const result = collectCuratedAppDefinitions(entries as never);
    expect(result).toHaveLength(2);
    expect(result[0]?.slug).toBe("app-nan");
    expect(result[1]?.slug).toBe("app-a");
  });
});
