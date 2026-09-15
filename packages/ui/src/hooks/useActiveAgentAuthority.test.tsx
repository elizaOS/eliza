/** Verifies that mounted capability views follow the client's active agent. */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authorityState = vi.hoisted(() => ({
  value: "https://agent-a.test",
  profileId: "profile-a",
  revision: 0,
  listeners: new Set<() => void>(),
}));

const clientMock = vi.hoisted(() => ({
  getBaseUrl: vi.fn(() => authorityState.value),
  getAuthorityRevision: vi.fn(() => authorityState.revision),
  onAuthorityChange: vi.fn((onChange: () => void) => {
    authorityState.listeners.add(onChange);
    return () => authorityState.listeners.delete(onChange);
  }),
}));

vi.mock("../api/client", () => ({ client: clientMock }));
vi.mock("../state/agent-profiles", () => ({
  loadAgentProfileRegistry: () => ({
    version: 1,
    activeProfileId: authorityState.profileId,
    profiles: [],
  }),
}));

import { useActiveAgentAuthority } from "./useActiveAgentAuthority";

beforeEach(() => {
  authorityState.value = "https://agent-a.test";
  authorityState.profileId = "profile-a";
  authorityState.revision = 0;
  authorityState.listeners.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useActiveAgentAuthority", () => {
  it("re-renders when the API client points at another agent", () => {
    const { result } = renderHook(() => useActiveAgentAuthority());

    expect(result.current).toBe("profile-a\u0000https://agent-a.test\u00000");
    expect(authorityState.listeners.size).toBe(1);

    act(() => {
      authorityState.value = "https://agent-b.test";
      for (const onChange of authorityState.listeners) onChange();
    });

    expect(result.current).toBe("profile-a\u0000https://agent-b.test\u00000");
  });

  it("re-renders for a same-host switch to a different saved profile", () => {
    const { result } = renderHook(() => useActiveAgentAuthority());

    act(() => {
      authorityState.profileId = "profile-b";
      for (const onChange of authorityState.listeners) onChange();
    });

    expect(result.current).toBe("profile-b\u0000https://agent-a.test\u00000");
  });

  it("re-renders when credentials change on the same profile and host", () => {
    const { result } = renderHook(() => useActiveAgentAuthority());

    act(() => {
      authorityState.revision += 1;
      for (const onChange of authorityState.listeners) onChange();
    });

    expect(result.current).toBe("profile-a\u0000https://agent-a.test\u00001");
  });
});
