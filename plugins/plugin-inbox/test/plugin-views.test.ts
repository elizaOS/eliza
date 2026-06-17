import { describe, expect, it } from "vitest";
import { InboxView } from "../src/components/inbox/InboxView.tsx";
import { inboxPlugin } from "../src/plugin.ts";

// Regression guard pinning the view-registration descriptor in src/plugin.ts to
// the actually-exported component. If the componentExport name, route path, or
// the email/mail aliases drift, view loading silently breaks at runtime; this
// test fails loudly instead. Lives in the node env (no DOM needed).

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
});
