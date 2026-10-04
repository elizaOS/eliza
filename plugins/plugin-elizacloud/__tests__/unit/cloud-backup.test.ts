import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CloudBackupService } from "../../src/services/cloud-backup";
import type { AgentSnapshot } from "../../src/types";

describe("CloudBackupService", () => {
  it("sorts snapshots deterministically even with missing or invalid created_at dates", async () => {
    const mockClient = {
      requestData: vi.fn().mockResolvedValue({
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

  it("keeps the higher snapshot id when two backups share a timestamp", async () => {
    const same = "2026-08-20T16:00:00.000Z";
    const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const upper = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const mockClient = {
      requestData: vi.fn().mockResolvedValue({
        data: [
          { id: lower, created_at: same, snapshotType: "auto" } as AgentSnapshot,
          { id: upper, created_at: same, snapshotType: "auto" } as AgentSnapshot,
        ],
      }),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue({ getClient: () => mockClient }),
    } as unknown as IAgentRuntime;

    const service = (await CloudBackupService.start(runtime)) as CloudBackupService;
    const latest = await service.getLatestSnapshot("test-container");

    expect(latest?.id).toBe(upper);
  });
});
