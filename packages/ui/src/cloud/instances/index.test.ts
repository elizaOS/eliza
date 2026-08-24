/** Verifies the instances domain barrel registers its three cloud routes through the package's configured test harness. */
import { describe, expect, it } from "vitest";
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

  it("registers every route in the cloud group without public exposure or a gate", () => {
    for (const path of [
      AGENT_DETAIL_ROUTE_PATH,
      AGENTS_ROUTE_PATH,
      MY_AGENTS_ROUTE_PATH,
    ]) {
      const route = getCloudRoute(path);
      expect(route?.group).toBe("cloud");
      expect(route?.public).toBeUndefined();
      expect(route?.publicAccess).toBeUndefined();
      expect(route?.gate).toBeUndefined();
    }
  });

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
