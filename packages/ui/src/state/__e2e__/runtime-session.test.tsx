// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRuntimeSessionState } from "../../app/use-runtime-session";
import type { AuthStatusState } from "../../hooks/useAuthStatus";

const auth: AuthStatusState = { phase: "authenticated", identity: { id: "owner-1", displayName: "Owner", kind: "owner" }, session: { id: "native-owned-session", kind: "local", expiresAt: null }, access: { mode: "local", role: "OWNER", passwordConfigured: true, ownerConfigured: true } };
const agents = { agents: [{ id: "agent-1", name: "Local agent", status: "running" }] };
afterEach(cleanup);
describe("AppProvider runtime session readback", () => {
  it("keeps the verified generation stable across ordinary auth/status refresh", async () => {
    const readAgents = vi.fn(async () => agents);
    const props = { active: true, authority: "native:1", apiBase: "eliza-local-agent://ipc", auth, currentAuth: () => auth, verifyAuth: async () => auth, currentAuthority: () => "native:1", readAgents };
    const { result, rerender } = renderHook(input => useRuntimeSessionState(input), { initialProps: props });
    await waitFor(() => expect(result.current.status).toBe("verified"));
    const verified = result.current;
    rerender({ ...props, auth: { ...auth } });
    expect(result.current).toBe(verified);
    expect(readAgents).toHaveBeenCalledOnce();
  });
  it("refuses an old authority's late response even before React sees the change", async () => {
    let finish!: (value: unknown) => void;
    let authority = "native:1";
    const readAgents = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useRuntimeSessionState({ active: true, authority: "native:1", apiBase: "eliza-local-agent://ipc", auth, currentAuth: () => auth, verifyAuth: async () => auth, currentAuthority: () => authority, readAgents }));
    await waitFor(() => expect(readAgents).toHaveBeenCalledOnce());
    authority = "native:2";
    await act(async () => { finish(agents); });
    expect(result.current.status).toBe("verifying");
  });
  it("requires a fresh verified generation after runtime restart under the same owner", async () => {
    let finish!: (value: unknown) => void;
    const readAgents = vi.fn().mockResolvedValueOnce(agents).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const props = { active: true, authority: "native:1", apiBase: "eliza-local-agent://ipc", auth, currentAuth: () => auth, verifyAuth: async () => auth, currentAuthority: () => "native:1", readAgents };
    const { result, rerender } = renderHook(input => useRuntimeSessionState(input), { initialProps: props });
    await waitFor(() => expect(result.current.status).toBe("verified"));
    const previous = result.current;
    rerender({ ...props, active: false });
    expect(result.current.status).toBe("inactive");
    rerender(props);
    expect(result.current.status).toBe("verifying");
    await waitFor(() => expect(readAgents).toHaveBeenCalledTimes(2));
    await act(async () => { finish(agents); });
    expect(result.current.status).toBe("verified");
    expect(result.current).not.toBe(previous);
  });
  it.each([{ agents: [] }, { agents: [{ ...agents.agents[0], status: "starting" }] }, { agents: [...agents.agents, ...agents.agents] }])("does not publish a non-running or ambiguous runtime", async value => {
    const { result } = renderHook(() => useRuntimeSessionState({ active: true, authority: "native:1", apiBase: "eliza-local-agent://ipc", auth, currentAuth: () => auth, verifyAuth: async () => auth, currentAuthority: () => "native:1", readAgents: async () => value }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });
});
