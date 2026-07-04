/**
 * Wayland screenshot-portal helpers: session detection and parsing of portal
 * request handles and screenshot responses. Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import {
  isWaylandSession,
  parsePortalRequestHandle,
  parsePortalScreenshotResponse,
  portalFileUriToPath,
  WAYLAND_PORTAL_DBUS_TARGET,
} from "./wayland-portal.js";

describe("wayland screenshot portal helpers", () => {
  it("detects Wayland sessions from either standard environment hint", () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(
      isWaylandSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" }),
    ).toBe(false);
  });

  it("declares the standard xdg-desktop-portal screenshot target", () => {
    expect(WAYLAND_PORTAL_DBUS_TARGET).toEqual({
      busName: "org.freedesktop.portal.Desktop",
      objectPath: "/org/freedesktop/portal/desktop",
      method: "org.freedesktop.portal.Screenshot.Screenshot",
    });
  });

  it("parses the gdbus request handle returned by Screenshot", () => {
    expect(
      parsePortalRequestHandle(
        "(objectpath '/org/freedesktop/portal/desktop/request/1_123/eliza_abc',)",
      ),
    ).toBe("/org/freedesktop/portal/desktop/request/1_123/eliza_abc");
    expect(parsePortalRequestHandle("()")).toBeNull();
  });

  it("parses a successful screenshot response signal", () => {
    const handle = "/org/freedesktop/portal/desktop/request/1_123/eliza_abc";
    const output = `
${handle}: org.freedesktop.portal.Request::Response (uint32 0, {'uri': <'file:///run/user/501/doc/shot.png'>})
`;
    expect(parsePortalScreenshotResponse(output, handle)).toEqual({
      responseCode: 0,
      uri: "file:///run/user/501/doc/shot.png",
    });
  });

  it("parses a denied screenshot response without a uri", () => {
    expect(
      parsePortalScreenshotResponse(
        "org.freedesktop.portal.Request::Response (uint32 1, {})",
      ),
    ).toEqual({ responseCode: 1 });
  });

  it("converts portal file uris to local paths", () => {
    expect(portalFileUriToPath("file:///tmp/wayland%20shot.png")).toBe(
      "/tmp/wayland shot.png",
    );
    expect(() => portalFileUriToPath("document://portal/shot.png")).toThrow(
      /non-file URI/i,
    );
  });
});
