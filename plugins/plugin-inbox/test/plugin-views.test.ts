/**
 * Pins the plugin-inbox view and route registration contract in a Node test
 * environment. The UI barrels are mocked so this can assert descriptor drift,
 * view aliases, and HTTP route metadata without evaluating browser-only code.
 */
import { describe, expect, it, vi } from "vitest";

// This node-env guard imports the real InboxView (to assert its function name
// matches the registration). InboxView now pulls in the `@elizaos/ui` renderer
// barrel; stub it (and the agent-surface subpath) so the node import resolves
// without evaluating the browser-only renderer dist.
vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "http://test.local", sendChatMessage: vi.fn() },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { InboxView } from "../src/components/inbox/InboxView.tsx";
import { inboxPlugin } from "../src/plugin.ts";

describe("inboxPlugin view registration", () => {
  it("registers exactly one view with the inbox descriptor", () => {
    expect(inboxPlugin.views).toBeDefined();
    expect(inboxPlugin.views).toHaveLength(1);

    const view = inboxPlugin.views?.[0];
    expect(view).toBeDefined();
    expect(view?.id).toBe("inbox");
    expect(view?.label).toBe("Inbox");
    expect(view?.path).toBe("/inbox");
    expect(view?.componentExport).toBe("InboxView");
    expect(view?.bundlePath).toBe("dist/views/bundle.js");
    expect(view?.visibleInManager).toBe(true);
    expect(view?.desktopTabEnabled).toBe(true);
  });

  it("declares email/mail aliases so command->view routing resolves", () => {
    const tags = inboxPlugin.views?.[0]?.tags ?? [];
    expect(tags).toContain("email");
    expect(tags).toContain("mail");
    expect(tags).toContain("inbox");
  });

  it("componentExport name matches the actually-exported component", () => {
    // Drift guard: the descriptor names "InboxView"; the module must export a
    // component under that exact name (catches rename-without-updating-plugin).
    expect(inboxPlugin.views?.[0]?.componentExport).toBe(InboxView.name);
    expect(typeof InboxView).toBe("function");
  });

  it("registers the triage and queue operation HTTP routes", () => {
    const paths = (inboxPlugin.routes ?? []).map((route) => ({
      type: route.type,
      path: route.path,
    }));

    expect(paths).toEqual([
      { type: "GET", path: "/api/lifeops/inbox/triage" },
      { type: "POST", path: "/api/lifeops/inbox/triage" },
      { type: "POST", path: "/api/lifeops/inbox/:id/reply" },
      { type: "POST", path: "/api/lifeops/inbox/:id/snooze" },
      { type: "POST", path: "/api/lifeops/inbox/:id/archive" },
      { type: "POST", path: "/api/lifeops/inbox/:id/approve" },
    ]);
  });
});
