import { describe, expect, it } from "bun:test";
import {
  MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS,
  managedCleanupErrorPreview,
} from "./remote-host-cleanup-diagnostic";

describe("managed remote-host cleanup diagnostics", () => {
  it("preserves a complete diagnostic that fits the bounded preview", () => {
    expect(managedCleanupErrorPreview("Headscale unavailable")).toBe("Headscale unavailable");
  });

  it("marks an oversized diagnostic as an explicit bounded preview", () => {
    const preview = managedCleanupErrorPreview(
      "x".repeat(MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS + 20),
    );
    expect(preview).toHaveLength(MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS);
    expect(preview).toMatch(/… \[truncated\]$/);
  });
});
