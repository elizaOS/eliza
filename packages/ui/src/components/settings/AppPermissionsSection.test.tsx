// @vitest-environment jsdom

/**
 * Behavioural coverage for the per-app permission grant panel
 * (`AppPermissionsSection`) — this is the section actually mounted by the
 * settings registry (`settings-sections.ts` → id "app-permissions"). The
 * `permission-controls.tsx` primitives named in the brief render the *system*
 * permission surface (camera/mic/…), which is a different panel; this file
 * targets the real per-app grant/revoke wiring.
 *
 * SECURITY focus: a grant/revoke must call the API with the exact permission
 * namespace, the deny state must be reflected, and — critically — a failed
 * write must NOT leave the UI showing "granted".
 *
 * NOTE on "confirm/warning on a sensitive grant": the component has no
 * confirmation dialog. The only gating signal it renders is the per-app
 * "External · explicit consent" vs "First-party · auto-granted" descriptor, so
 * that is what is asserted here (see the "explicit-consent" test). If a real
 * confirm step is ever added, extend this file rather than the system-perm one.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppPermissionsView } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  value: {} as { setActionNotice: ReturnType<typeof vi.fn> },
}));

const clientMock = vi.hoisted(() => ({
  listAppPermissions: vi.fn(),
  setAppPermissions: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

// Inert, STABLE agent-surface handle so the component's useEffect/useCallback
// deps never change identity between renders (avoids a render loop).
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { AppPermissionsSection } from "./AppPermissionsSection";

const NOTES: AppPermissionsView = {
  slug: "acme-notes",
  trust: "external",
  isolation: "worker",
  requestedPermissions: {
    fs: { read: ["notes/**"] },
    net: { outbound: ["api.acme.test"] },
  },
  recognisedNamespaces: ["fs", "net"],
  grantedNamespaces: ["fs"],
  grantedAt: "2026-01-01T00:00:00.000Z",
};

function label(ns: "Filesystem" | "Network", slug = "acme-notes"): string {
  return `Toggle ${ns} for ${slug}`;
}

function toggle(name: string): HTMLButtonElement {
  return screen.getByRole("switch", { name }) as HTMLButtonElement;
}

describe("AppPermissionsSection grant/revoke wiring", () => {
  beforeEach(() => {
    appMock.value = { setActionNotice: vi.fn() };
    clientMock.listAppPermissions.mockReset();
    clientMock.setAppPermissions.mockReset();
    clientMock.listAppPermissions.mockResolvedValue([
      structuredClone(NOTES),
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it("reflects the deny state: an ungranted namespace renders unchecked", async () => {
    render(<AppPermissionsSection />);

    await screen.findByRole("switch", { name: label("Filesystem") });
    // fs is granted, net is not.
    expect(toggle(label("Filesystem")).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(toggle(label("Network")).getAttribute("aria-checked")).toBe("false");
  });

  it("granting a namespace PUTs the exact merged namespace set for that slug", async () => {
    clientMock.setAppPermissions.mockResolvedValue({
      ...structuredClone(NOTES),
      grantedNamespaces: ["fs", "net"],
    } satisfies AppPermissionsView);
    const user = userEvent.setup();

    render(<AppPermissionsSection />);
    await screen.findByRole("switch", { name: label("Network") });

    await user.click(toggle(label("Network")));

    await waitFor(() => {
      expect(clientMock.setAppPermissions).toHaveBeenCalledTimes(1);
    });
    // Exact call: slug + the union of previously-granted (fs) and the new ns.
    expect(clientMock.setAppPermissions).toHaveBeenCalledWith("acme-notes", [
      "fs",
      "net",
    ]);
    // UI now shows both granted (server response applied).
    await waitFor(() => {
      expect(toggle(label("Network")).getAttribute("aria-checked")).toBe(
        "true",
      );
    });
  });

  it("revoking a namespace PUTs the set WITHOUT that namespace", async () => {
    clientMock.listAppPermissions.mockResolvedValue([
      { ...structuredClone(NOTES), grantedNamespaces: ["fs", "net"] },
    ]);
    clientMock.setAppPermissions.mockResolvedValue({
      ...structuredClone(NOTES),
      grantedNamespaces: ["net"],
    } satisfies AppPermissionsView);
    const user = userEvent.setup();

    render(<AppPermissionsSection />);
    await waitFor(() =>
      expect(toggle(label("Filesystem")).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );

    await user.click(toggle(label("Filesystem")));

    await waitFor(() => {
      expect(clientMock.setAppPermissions).toHaveBeenCalledWith("acme-notes", [
        "net",
      ]);
    });
    expect(clientMock.setAppPermissions.mock.calls[0][1]).not.toContain("fs");
  });

  it("a FAILED write does NOT flip the toggle to granted and surfaces the error", async () => {
    clientMock.setAppPermissions.mockRejectedValue(new Error("registry locked"));
    const user = userEvent.setup();

    render(<AppPermissionsSection />);
    await screen.findByRole("switch", { name: label("Network") });
    expect(toggle(label("Network")).getAttribute("aria-checked")).toBe("false");

    await user.click(toggle(label("Network")));

    // Optimistic flip is reverted on rejection → back to DENIED.
    await waitFor(() => {
      expect(toggle(label("Network")).getAttribute("aria-checked")).toBe(
        "false",
      );
    });
    // Error is surfaced both inline and via the shell action notice.
    expect(screen.getByText("registry locked")).toBeTruthy();
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      "Failed to update permissions for acme-notes: registry locked",
      "error",
    );
    // The permission was NEVER left granted server-side either.
    expect(clientMock.setAppPermissions).toHaveBeenCalledTimes(1);
  });

  it("is idempotent under rapid re-click: the pending toggle is gated to one write", async () => {
    // Never-resolving write keeps the row in the pending/disabled state.
    let resolve: (v: AppPermissionsView) => void = () => {};
    clientMock.setAppPermissions.mockImplementation(
      () =>
        new Promise<AppPermissionsView>((res) => {
          resolve = res;
        }),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AppPermissionsSection />);
    await screen.findByRole("switch", { name: label("Network") });

    await user.click(toggle(label("Network")));
    // Row is now pending → the switch is disabled.
    await waitFor(() => {
      expect(toggle(label("Network")).hasAttribute("disabled")).toBe(true);
    });

    // Hammer it — a disabled toggle must not issue a second write.
    await user.click(toggle(label("Network")));
    await user.click(toggle(label("Filesystem")));

    expect(clientMock.setAppPermissions).toHaveBeenCalledTimes(1);

    // Unblock the in-flight write so the test tears down cleanly.
    resolve({ ...structuredClone(NOTES), grantedNamespaces: ["fs", "net"] });
    await waitFor(() =>
      expect(toggle(label("Network")).hasAttribute("disabled")).toBe(false),
    );
  });

  it("marks an external app as requiring explicit consent (the only grant gate rendered)", async () => {
    render(<AppPermissionsSection />);
    expect(
      await screen.findByText("External · explicit consent"),
    ).toBeTruthy();
  });
});
