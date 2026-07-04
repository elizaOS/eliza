import { describe, expect, it } from "vitest";
import {
  CLOUD_CONTAINER_SERVICE_TYPE,
  PromoteVfsToCloudContainerRequestSchema,
} from "./cloud-coding-containers.js";

describe("cloud coding container contracts", () => {
  it("exports the canonical runtime service slot", () => {
    expect(CLOUD_CONTAINER_SERVICE_TYPE).toBe("CLOUD_CONTAINER");
  });

  it("keeps VFS promotion requests strict", () => {
    const parsed = PromoteVfsToCloudContainerRequestSchema.safeParse({
      source: {
        sourceKind: "project",
        projectId: "vfs-project",
        revision: "snapshot-1",
        files: [
          {
            path: "src/index.ts",
            contents: "export {};",
            encoding: "utf-8",
          },
        ],
      },
      preferredAgent: "codex",
      legacyServiceType: "cloud-container",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      'Unrecognized key: "legacyServiceType"',
    );
  });
});
