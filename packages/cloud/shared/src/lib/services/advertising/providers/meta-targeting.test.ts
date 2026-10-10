/**
 * genders: ["all"] used to send genders: []. Meta omits the field when the
 * campaign should reach every gender.
 */

import { describe, expect, test } from "bun:test";
import { buildMetaTargeting } from "./meta-targeting";

describe("buildMetaTargeting", () => {
  test("omits genders when the campaign targets all genders", () => {
    const targeting = buildMetaTargeting({ genders: ["all"] });
    expect(targeting.genders).toBeUndefined();
    expect(targeting.geo_locations).toEqual({ countries: ["US"] });
  });

  test("keeps a male or female code", () => {
    expect(buildMetaTargeting({ genders: ["male"] }).genders).toEqual([1]);
    expect(buildMetaTargeting({ genders: ["female"] }).genders).toEqual([2]);
  });
});
