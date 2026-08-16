/**
 * Verifies that the server-only directory schema preserves host-native path
 * authority after the shared wire contract is made browser-safe.
 */

import nodePath from "node:path";
import { PostLoadFromDirectoryRequestSchema } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { PostLoadFromDirectoryServerRequestSchema } from "./apps-loading-directory-schema";

describe("PostLoadFromDirectoryServerRequestSchema", () => {
  it("accepts an absolute path for the current host", () => {
    const directory = nodePath.resolve("apps");

    expect(
      PostLoadFromDirectoryServerRequestSchema.parse({ directory }),
    ).toEqual({ directory });
  });

  it("matches host-native semantics for every portable absolute form", () => {
    for (const directory of ["/tmp/apps", "C:\\Eliza\\apps"]) {
      expect(
        PostLoadFromDirectoryRequestSchema.safeParse({ directory }).success,
      ).toBe(true);
      expect(
        PostLoadFromDirectoryServerRequestSchema.safeParse({ directory })
          .success,
      ).toBe(nodePath.isAbsolute(directory));
    }
  });
});
