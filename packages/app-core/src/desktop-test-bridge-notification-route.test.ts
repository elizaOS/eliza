import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  new URL(
    "../platforms/electrobun/src/desktop-test-bridge-server.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("desktop test bridge notification observation", () => {
  it("exposes one canonical route backed by DesktopManager diagnostics", () => {
    expect(
      source.match(/pathname === "\/notifications" && method === "GET"/g),
    ).toHaveLength(1);
    expect(
      source.match(/pathname === "\/notifications" && method === "DELETE"/g),
    ).toHaveLength(1);
    expect(source).toContain(
      "getDesktopManager().getNotificationDiagnostics()",
    );
    expect(source).toContain(
      "getDesktopManager().clearNotificationDiagnostics()",
    );
    expect(source).not.toContain("readDesktopNotificationTestRecords");
    expect(source).not.toContain("installDesktopNotificationTestRecorder");
  });
});
