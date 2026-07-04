/**
 * Unit coverage for the one-time app API-key store/consume flow. In-memory, no
 * network.
 */
import { describe, expect, it } from "vitest";
import {
  consumeOneTimeAppApiKey,
  storeOneTimeAppApiKey,
} from "./one-time-app-api-key.js";

// #9145 — a freshly minted app API key is shown exactly once; the hand-off must
// be consume-once (a second read returns nothing) so the secret can't be
// re-revealed. Distinct appIds keep the module-level map isolated per case.
describe("one-time app api key hand-off", () => {
  it("returns the key once, then forgets it", () => {
    storeOneTimeAppApiKey("app_consume", "eliza_secret");
    expect(consumeOneTimeAppApiKey("app_consume")).toBe("eliza_secret");
    expect(consumeOneTimeAppApiKey("app_consume")).toBeUndefined();
  });

  it("returns undefined for an unknown app id", () => {
    expect(consumeOneTimeAppApiKey("app_never_stored")).toBeUndefined();
  });

  it("ignores stores with a missing app id or key", () => {
    storeOneTimeAppApiKey("", "k");
    storeOneTimeAppApiKey("app_empty_key", "");
    expect(consumeOneTimeAppApiKey("")).toBeUndefined();
    expect(consumeOneTimeAppApiKey("app_empty_key")).toBeUndefined();
  });

  it("the latest store for an id wins before consumption", () => {
    storeOneTimeAppApiKey("app_overwrite", "old");
    storeOneTimeAppApiKey("app_overwrite", "new");
    expect(consumeOneTimeAppApiKey("app_overwrite")).toBe("new");
  });
});
