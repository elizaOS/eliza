/** Verifies complete browser teardown of an account-scoped shared Cloud binding under jsdom. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "./agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { clearSharedCloudAccountBinding } from "./shared-cloud-account-binding";

const SHARED_BASE =
  "https://api.eliza.app/api/v1/eliza/agents/previous-account-agent";

describe("clearSharedCloudAccountBinding", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setBootConfig({
      branding: {},
      apiBase: SHARED_BASE,
      apiToken: "previous-account-token",
    });
  });

  it("clears active-server, profile, boot, and legacy base mirrors", () => {
    savePersistedActiveServer({
      id: "cloud:previous-account-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: SHARED_BASE,
    });
    saveAgentProfileRegistry({
      version: 1,
      activeProfileId: "old-profile",
      profiles: [
        {
          id: "old-profile",
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase: SHARED_BASE,
          createdAt: new Date().toISOString(),
        },
        {
          id: "inactive-old-profile",
          kind: "cloud",
          label: "Other old shared agent",
          apiBase: "https://api.eliza.app/api/v1/eliza/agents/other-old-agent",
          createdAt: new Date().toISOString(),
        },
        {
          id: "legacy-shared-profile",
          kind: "cloud",
          label: "Legacy shared agent",
          apiBase:
            "https://api.eliza.app/api/v1/eliza/agents/legacy-agent/bridge",
          createdAt: new Date().toISOString(),
        },
        {
          id: "self-hosted-profile",
          kind: "remote",
          label: "Self hosted",
          apiBase: "https://box.example/api/v1/eliza/agents/local-agent",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    localStorage.setItem("elizaos_api_base", SHARED_BASE);
    sessionStorage.setItem("elizaos_api_base", SHARED_BASE);

    expect(clearSharedCloudAccountBinding()).toBe(true);

    expect(loadPersistedActiveServer()).toBeNull();
    expect(loadAgentProfileRegistry()).toEqual({
      version: 1,
      activeProfileId: null,
      profiles: [
        expect.objectContaining({
          id: "self-hosted-profile",
          apiBase: "https://box.example/api/v1/eliza/agents/local-agent",
        }),
      ],
    });
    expect(getBootConfig().apiBase).toBeUndefined();
    expect(getBootConfig().apiToken).toBeUndefined();
    expect(localStorage.getItem("elizaos_api_base")).toBeNull();
    expect(sessionStorage.getItem("elizaos_api_base")).toBeNull();
  });
});
