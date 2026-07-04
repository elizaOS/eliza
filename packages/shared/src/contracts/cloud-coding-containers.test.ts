/**
 * Contract tests for the cloud coding-container surface: the canonical
 * CLOUD_CONTAINER runtime service-type slot and the schema that promotes a
 * VFS snapshot into a cloud container. Confirms the promotion request stays
 * strict — unrecognized keys (e.g. a legacy `legacyServiceType`) are rejected
 * with the exact issue message. Pure in-process schema parsing, no server or
 * mocks: it validates the same exported objects the live routes consume.
 */
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
