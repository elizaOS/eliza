/** A revoked remote bearer cannot reappear from native storage on app relaunch. */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scrubRevokedRemoteCredential } from "./active-server-credential";
import {
  getActiveProfile,
  upsertAndActivateAgentProfile,
} from "./agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const storage = vi.hoisted(() => ({
  setStorageValue: vi.fn(async (_key: string, _value: string) => {}),
}));
vi.mock("../bridge/storage-bridge", () => storage);

beforeEach(() => {
  localStorage.clear();
  storage.setStorageValue.mockClear();
});

describe("revoked remote credential", () => {
  it("clears only the selected bearer from local and native records", async () => {
    const apiBase = "http://10.0.0.241:31722";
    expect(
      savePersistedActiveServer({
        id: "remote:alpha-qa",
        kind: "remote",
        label: "Alpha QA",
        apiBase,
        accessToken: "revoked-session",
      }),
    ).toBe(true);
    upsertAndActivateAgentProfile({
      kind: "remote",
      label: "Alpha QA",
      apiBase,
      accessToken: "revoked-session",
    });

    expect(await scrubRevokedRemoteCredential("revoked-session", apiBase)).toBe(
      true,
    );
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
    expect(getActiveProfile()?.accessToken).toBeUndefined();
    expect(storage.setStorageValue).toHaveBeenCalledTimes(2);
    for (const [, value] of storage.setStorageValue.mock.calls) {
      expect(value).not.toContain("revoked-session");
    }

    expect(
      await scrubRevokedRemoteCredential(
        "different-session",
        "http://10.0.0.242:31722",
      ),
    ).toBe(false);
    expect(storage.setStorageValue).toHaveBeenCalledTimes(2);
  });
});
