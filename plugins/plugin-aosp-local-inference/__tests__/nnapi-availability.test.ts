import { describe, expect, it } from "vitest";

import {
  probeNnapiAvailability,
  type NnapiAvailability,
} from "../src/nnapi-availability";

describe("probeNnapiAvailability", () => {
  it("reports the documented readiness-scaffold stub shape", async () => {
    const result: NnapiAvailability = await probeNnapiAvailability();

    expect(result).toEqual<NnapiAvailability>({
      available: false,
      reason: "not implemented",
      androidApiLevel: null,
    });
  });

  it("never throws — the probe is the boundary for future ORT introspection errors", async () => {
    await expect(probeNnapiAvailability()).resolves.toBeDefined();
  });
});
