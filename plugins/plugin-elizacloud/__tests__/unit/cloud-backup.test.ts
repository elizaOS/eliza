import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CloudBackupService } from "../../src/services/cloud-backup";
import type { AgentSnapshot } from "../../src/types";

describe("CloudBackupService", () => {
  it("sorts snapshots deterministically even with missing or invalid created_at dates", async () => {
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        data: [
          { id: "s1", created_at: "2026-01-01T00:00:00Z", snapshotType: "auto" } as AgentSnapshot,
          {
            id: "s2",
            created_at: "invalid-date",
            snapshotType: "auto",
          } as unknown as AgentSnapshot,
          { id: "s3", created_at: "2026-02-01T00:00:00Z", snapshotType: "auto" } as AgentSnapshot,
        ],
      }),
    };

    const mockAuth = {
      getClient: () => mockClient,
    };

    const runtime = {
      getService: vi.fn().mockReturnValue(mockAuth),
    } as unknown as IAgentRuntime;

    const service = (await CloudBackupService.start(runtime)) as CloudBackupService;
    const latest = await service.getLatestSnapshot("test-container");

    expect(latest).toBeDefined();
    expect(latest?.id).toBe("s3");
  });
});
