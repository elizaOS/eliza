import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConsentDialog } from "./ConsentDialog";
import type { PluginPermission } from "./PermissionList";

const PERMS: PluginPermission[] = [
  {
    id: "net.egress",
    label: "Network egress",
    description: "Outbound HTTP / DNS to remote hosts.",
    sensitive: true,
    scope: "*.openai.com, *.anthropic.com",
  },
  {
    id: "fs.read",
    label: "Workspace read",
    description: "Read files inside the agent workspace.",
  },
  {
    id: "fs.write.outside",
    label: "Filesystem write outside workspace",
    description: "Write files anywhere on the device.",
    sensitive: true,
  },
];

afterEach(() => cleanup());

describe("ConsentDialog", () => {
  test("sensitive permissions default to off, non-sensitive can be pre-selected", () => {
    const onConfirm = vi.fn();
    render(
      <ConsentDialog
        open
        onOpenChange={() => {}}
        pluginName="plugin-foo"
        publisher="ElizaLabs"
        trust="signed"
        permissions={PERMS}
        initialSelected={["net.egress", "fs.read", "fs.write.outside"]}
        onConfirm={onConfirm}
      />,
    );
    // Both sensitive perms were filtered out of the initial set; fs.read is on.
    const netCheckbox = screen.getByTestId("perm-checkbox-net.egress");
    const fsReadCheckbox = screen.getByTestId("perm-checkbox-fs.read");
    const fsWriteCheckbox = screen.getByTestId(
      "perm-checkbox-fs.write.outside",
    );
    expect(
      netCheckbox.getAttribute("aria-checked") ??
        netCheckbox.getAttribute("data-state"),
    ).not.toBe("checked");
    expect(fsReadCheckbox.getAttribute("data-state")).toBe("checked");
    expect(
      fsWriteCheckbox.getAttribute("aria-checked") ??
        fsWriteCheckbox.getAttribute("data-state"),
    ).not.toBe("checked");
  });

  test("install is disabled when signature is invalid", () => {
    render(
      <ConsentDialog
        open
        onOpenChange={() => {}}
        pluginName="plugin-bad"
        trust="unsigned"
        permissions={PERMS}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId("consent-dialog-blocked")).toBeInTheDocument();
    const confirm = screen.getByTestId("consent-dialog-confirm");
    expect(confirm).toBeDisabled();
  });

  test("confirm reports the currently selected permissions", () => {
    const onConfirm = vi.fn();
    render(
      <ConsentDialog
        open
        onOpenChange={() => {}}
        pluginName="plugin-ok"
        trust="signed"
        permissions={PERMS}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("perm-checkbox-fs.read"));
    fireEvent.click(screen.getByTestId("consent-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const granted = onConfirm.mock.calls[0]?.[0] as string[];
    expect(granted).toContain("fs.read");
    expect(granted).not.toContain("net.egress");
    expect(granted).not.toContain("fs.write.outside");
  });
});
