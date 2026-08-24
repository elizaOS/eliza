/** Verifies the instances domain barrel registers its three cloud routes through the package's configured test harness. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrivateCloudRegistrationForTests } from "../private-cloud-registration";
import { registerPublicCloudSurfaces } from "../register-public";
import { CloudRouterShell } from "../shell/CloudRouterShell";
import { getCloudRoute, listCloudRoutes } from "../shell/cloud-route-registry";
import {
  AGENT_DETAIL_ROUTE_PATH,
  AGENTS_ROUTE_PATH,
  AgentDetailPage,
  AgentsPage,
  MY_AGENTS_ROUTE_PATH,
  MyAgentsPage,
  useAgent,
  useAgents,
} from "./index";

vi.mock("../shell/StewardProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shell/StewardProvider")>();
  return {
    ...actual,
    StewardAuthProvider: ({ children }: { children: ReactNode }) =>
      createElement(Fragment, null, children),
  };
});

beforeEach(() => {
  registerPublicCloudSurfaces();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetPrivateCloudRegistrationForTests();
});

/**
 * Proves the instances (hosted agents) domain mounts the Instances table, the
 * agent detail page, and the My Agents console into the same cloud-route
 * registry consumed by the CloudRouterShell, as an import side effect.
 */
describe("instances cloud-route registration", () => {
  it("exports the canonical agents route path constants", () => {
    expect(AGENTS_ROUTE_PATH).toBe("cloud/agents");
    expect(AGENT_DETAIL_ROUTE_PATH).toBe("cloud/agents/:id");
    expect(MY_AGENTS_ROUTE_PATH).toBe("cloud/my-agents");
  });

  it("registers all three routes into the shared registry on import", () => {
    for (const path of [
      AGENT_DETAIL_ROUTE_PATH,
      AGENTS_ROUTE_PATH,
      MY_AGENTS_ROUTE_PATH,
    ]) {
      const route = getCloudRoute(path);
      expect(route, `missing ${path}`).toBeDefined();
      expect(route?.element, `empty element for ${path}`).toBeTruthy();
    }
  });

  it("registers every route in the authenticated cloud-management group", () => {
    for (const path of [
      AGENT_DETAIL_ROUTE_PATH,
      AGENTS_ROUTE_PATH,
      MY_AGENTS_ROUTE_PATH,
    ]) {
      const route = getCloudRoute(path);
      expect(route?.group).toBe("cloud");
    }
  });

  it.each([
    ["agents table", "/cloud/agents"],
    ["agent detail", "/cloud/agents/agent-123"],
    ["My Agents console", "/cloud/my-agents"],
  ])(
    "rejects unauthenticated access to the %s route at the real shell boundary",
    async (_label, path) => {
      window.history.replaceState({}, "", path);

      render(
        createElement(CloudRouterShell, {
          appElement: createElement("div", {
            "data-testid": "authenticated-app-probe",
          }),
        }),
      );

      await waitFor(() => {
        expect(`${window.location.pathname}${window.location.search}`).toBe(
          `/login?returnTo=${encodeURIComponent(path)}`,
        );
      });
      expect(screen.queryByTestId("authenticated-app-probe")).toBeNull();
    },
  );

  it("resolves each route to the very component object the barrel exports", () => {
    expect(getCloudRoute(AGENTS_ROUTE_PATH)?.element).toBe(AgentsPage);
    expect(getCloudRoute(AGENT_DETAIL_ROUTE_PATH)?.element).toBe(
      AgentDetailPage,
    );
    expect(getCloudRoute(MY_AGENTS_ROUTE_PATH)?.element).toBe(MyAgentsPage);
  });

  it("registers the routes in detail, table, console order", () => {
    const paths = listCloudRoutes().map((route) => route.path);
    const detail = paths.indexOf(AGENT_DETAIL_ROUTE_PATH);
    const table = paths.indexOf(AGENTS_ROUTE_PATH);
    const console_ = paths.indexOf(MY_AGENTS_ROUTE_PATH);
    expect(detail).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThan(detail);
    expect(console_).toBeGreaterThan(table);
  });

  it("re-exports the hosted-agent data hooks as callable functions", () => {
    expect(typeof useAgent).toBe("function");
    expect(typeof useAgents).toBe("function");
  });
});
