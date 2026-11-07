import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  mirrorSavedConfigToLive,
  setLiveElizaConfigSource,
} from "../src/api/config-state.ts";

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.unstubAllEnvs();
});

it("updates every reader of the saved file while isolating another config", () => {
  const a: ElizaConfig = { models: { large: "a" } };
  const sibling: ElizaConfig = { models: { large: "a" } };
  const b: ElizaConfig = { models: { large: "b" } };
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "/tmp/eliza-mirror-a.json");
  releases.push(setLiveElizaConfigSource(() => a));
  const releaseSibling = setLiveElizaConfigSource(() => sibling);
  releases.push(releaseSibling);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "/tmp/eliza-mirror-b.json");
  releases.push(setLiveElizaConfigSource(() => b));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "/tmp/eliza-mirror-a.json");
  const saved: ElizaConfig = { models: { large: "updated" } };
  mirrorSavedConfigToLive(saved);
  expect(a).toEqual(saved);
  expect(sibling).toEqual(saved);
  expect(b.models?.large).toBe("b");
  expect(a.models).not.toBe(saved.models);
  expect(a.models).not.toBe(sibling.models);
  releaseSibling();
  mirrorSavedConfigToLive({ models: { large: "next" } });
  expect(a.models?.large).toBe("next");
  expect(sibling.models?.large).toBe("updated");
});
