/**
 * Join-page state and escape-path coverage with the Cloud controller mocked at
 * its typed progress boundary; no browser session or live Cloud is used.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudAgentJoinProgress,
  CloudAgentJoinProgressHandler,
} from "../../api/client-types-cloud";
import { cloudAgentJoinError } from "../../api/cloud-agent-join-progress";
import type { RunJoinFlowArgs } from "./lib/run-join-flow";

const testDoubles = vi.hoisted(() => ({
  client: {
    selectOrProvisionCloudAgent: vi.fn(),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  },
  clearPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
}));

vi.mock("../../api", () => ({ client: testDoubles.client }));

vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({ preferSharedCloudTier: true }),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../sso-bridge/sso-bridge", () => ({
  signOutFromSsoBridgedHost: vi.fn(async () => undefined),
}));

vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: vi.fn(),
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ authenticated: true, ready: true }),
}));

vi.mock("../../state/persistence", () => ({
  clearPersistedActiveServer: testDoubles.clearPersistedActiveServer,
  savePersistedActiveServer: testDoubles.savePersistedActiveServer,
  savePersistedFirstRunComplete: testDoubles.savePersistedFirstRunComplete,
}));

const { signOutFromSsoBridgedHost } = await import("../sso-bridge/sso-bridge");
const { runJoinFlow } = await import("./lib/run-join-flow");
const { default: JoinPage } = await import("./JoinPage");

const mocks = {
  runJoinFlow: runJoinFlow as unknown as ReturnType<typeof vi.fn>,
  signOut: signOutFromSsoBridgedHost as unknown as ReturnType<typeof vi.fn>,
};

const PROVISIONING_PROGRESS: CloudAgentJoinProgress = {
  phase: "provisioning",
  source: "cold_provision",
  agentId: "agent-test",
  jobId: "job-test",
  status: "processing",
  elapsedMs: 3_210,
  correlationId: "job-test",
};

function renderJoinPage(options: { strict?: boolean } = {}) {
  const page = (
    <MemoryRouter initialEntries={["/join"]}>
      <Routes>
        <Route path="/join" element={<JoinPage />} />
        <Route path="/login" element={<p>Login escape reached</p>} />
      </Routes>
    </MemoryRouter>
  );
  return render(options.strict ? <StrictMode>{page}</StrictMode> : page);
}

describe("JoinPage lifecycle state", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.runJoinFlow.mockReset();
    mocks.signOut.mockClear();
    testDoubles.client.selectOrProvisionCloudAgent.mockReset();
    testDoubles.client.setBaseUrl.mockReset();
    testDoubles.client.setToken.mockReset();
    testDoubles.clearPersistedActiveServer.mockReset();
    testDoubles.savePersistedActiveServer.mockReset();
    testDoubles.savePersistedFirstRunComplete.mockReset();
    window.localStorage.clear();
    window.localStorage.setItem("steward_session_token", "test-session-token");
  });

  it("renders phase, elapsed time, and canonical correlation while provisioning", async () => {
    mocks.runJoinFlow.mockImplementation(
      async (args: { onProgress?: CloudAgentJoinProgressHandler }) => {
        args.onProgress?.(
          "provisioning",
          "Starting your agent…",
          PROVISIONING_PROGRESS,
        );
        return await new Promise(() => undefined);
      },
    );

    renderJoinPage();

    expect(await screen.findByText("Starting your agent…")).toBeTruthy();
    expect(screen.getByTestId("cloud-join-phase").textContent).toContain(
      "provisioning (processing) · 3s",
    );
    expect(screen.getByTestId("cloud-join-correlation").textContent).toContain(
      "job-test",
    );
    expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1);
    expect(mocks.runJoinFlow).toHaveBeenCalledWith(
      expect.objectContaining({ preferSharedTier: true }),
    );
  });

  it("does not duplicate the active flow during the StrictMode effect replay", async () => {
    mocks.runJoinFlow.mockImplementation(
      async () => await new Promise(() => undefined),
    );

    renderJoinPage({ strict: true });

    await waitFor(() => expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1);
  });

  it("signs out through the bridged host and invalidates the active attempt", async () => {
    let finish: ((value: unknown) => void) | undefined;
    let obsoleteFlowSettled = false;
    mocks.runJoinFlow.mockImplementation(async (args: RunJoinFlowArgs) => {
      args.onProgress?.(
        "provisioning",
        "Starting your agent…",
        PROVISIONING_PROGRESS,
      );
      const result = await new Promise((resolve) => {
        finish = resolve;
      });
      args.client.setBaseUrl("https://agent-test.elizacloud.ai");
      args.client.setToken("test-session-token");
      args.effects.savePersistedActiveServer({
        id: "cloud:agent-test",
        kind: "cloud",
        label: "Eliza",
      });
      args.effects.savePersistedFirstRunComplete(true);
      obsoleteFlowSettled = true;
      return result;
    });

    renderJoinPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Login escape reached")).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1);

    finish?.({
      agentId: "agent-test",
      agentName: "Eliza",
      apiBase: "https://agent-test.elizacloud.ai",
      created: true,
      dedicated: true,
    });
    await waitFor(() => {
      expect(obsoleteFlowSettled).toBe(true);
    });
    expect(testDoubles.client.setBaseUrl).not.toHaveBeenCalled();
    expect(testDoubles.client.setToken).not.toHaveBeenCalled();
    expect(testDoubles.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(testDoubles.savePersistedFirstRunComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Login escape reached")).toBeTruthy();
  });

  it("invalidates attempt-scoped client and persistence writes on unmount", async () => {
    let finish: ((value: unknown) => void) | undefined;
    let obsoleteFlowSettled = false;
    mocks.runJoinFlow.mockImplementation(async (args: RunJoinFlowArgs) => {
      const result = await new Promise((resolve) => {
        finish = resolve;
      });
      args.client.setBaseUrl("https://agent-test.elizacloud.ai");
      args.client.setToken("test-session-token");
      args.effects.savePersistedActiveServer({
        id: "cloud:agent-test",
        kind: "cloud",
        label: "Eliza",
      });
      args.effects.savePersistedFirstRunComplete(true);
      obsoleteFlowSettled = true;
      return result;
    });

    const rendered = renderJoinPage();
    await waitFor(() => expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1));
    rendered.unmount();
    await Promise.resolve();

    finish?.({
      agentId: "agent-test",
      agentName: "Eliza",
      apiBase: "https://agent-test.elizacloud.ai",
      created: true,
      dedicated: true,
    });
    await waitFor(() => expect(obsoleteFlowSettled).toBe(true));

    expect(testDoubles.client.setBaseUrl).not.toHaveBeenCalled();
    expect(testDoubles.client.setToken).not.toHaveBeenCalled();
    expect(testDoubles.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(testDoubles.savePersistedFirstRunComplete).not.toHaveBeenCalled();
  });

  it("renders the last typed receipt on terminal failure and retries only on command", async () => {
    const failedProgress: CloudAgentJoinProgress = {
      ...PROVISIONING_PROGRESS,
      status: "failed",
      elapsedMs: 12_345,
    };
    mocks.runJoinFlow.mockRejectedValue(
      cloudAgentJoinError("Provisioning worker unavailable", failedProgress),
    );

    renderJoinPage();

    expect(
      await screen.findByText("Provisioning worker unavailable"),
    ).toBeTruthy();
    expect(screen.getByTestId("cloud-join-phase").textContent).toContain(
      "provisioning (failed) · 12s",
    );
    expect(screen.getByTestId("cloud-join-correlation").textContent).toContain(
      "job-test",
    );
    expect(mocks.runJoinFlow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.runJoinFlow).toHaveBeenCalledTimes(2));
  });
});
