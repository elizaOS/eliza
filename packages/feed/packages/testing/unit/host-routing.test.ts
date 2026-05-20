import { describe, expect, it } from "bun:test";

import {
  getLegacyCanonicalOrigin,
  isLegacyCanonicalHostname,
} from "../../../apps/web/src/lib/host-routing";

describe("host-routing (legacy redirects)", () => {
  it("identifies legacy feed.social hosts", () => {
    expect(isLegacyCanonicalHostname("feed.social")).toBe(true);
    expect(isLegacyCanonicalHostname("www.feed.social")).toBe(true);
    expect(isLegacyCanonicalHostname("feed.market")).toBe(false);
  });

  it("maps legacy feed.social hosts to feed.market", () => {
    expect(getLegacyCanonicalOrigin("feed.social", "https:")).toBe(
      "https://feed.market",
    );
    expect(getLegacyCanonicalOrigin("www.feed.social", "https:")).toBe(
      "https://feed.market",
    );
  });

  it("returns null for non-legacy hosts", () => {
    expect(getLegacyCanonicalOrigin("feed.market", "https:")).toBeNull();
    expect(
      getLegacyCanonicalOrigin("staging.feed.market", "https:"),
    ).toBeNull();
  });
});
