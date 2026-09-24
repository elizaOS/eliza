import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AuthRepository } from "../../services/auth-store";
import { appendAuditEvent, resolveAuditLogPath } from "./audit";

it.each([null, new Error("database unavailable")])(
  "writes the fallback audit file while propagating every database rejection",
  async (reason) => {
    const state = await mkdtemp(join(tmpdir(), "app-audit-"));
    const env = { ELIZA_STATE_DIR: state };
    const store = {
      appendAuditEvent: vi.fn().mockRejectedValue(reason),
    } as unknown as AuthRepository;
    try {
      await expect(
        appendAuditEvent(
          {
            actorIdentityId: null,
            ip: null,
            userAgent: null,
            action: "auth.test",
            outcome: "failure",
          },
          { store, env },
        ),
      ).rejects.toBe(reason);
      const written = JSON.parse(
        await readFile(resolveAuditLogPath(env), "utf8"),
      );
      expect(written).toMatchObject({
        action: "auth.test",
        outcome: "failure",
      });
      expect(store.appendAuditEvent).toHaveBeenCalledWith(written);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
);
