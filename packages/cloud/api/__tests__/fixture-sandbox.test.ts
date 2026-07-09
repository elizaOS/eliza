/** Verifies fixture sandboxes stay inert across first seed and repeated preloads. */

import { describe, expect, mock, test } from "bun:test";
import type { NewAgentSandbox } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import {
  ensureFixtureSandbox,
  type FixtureSandboxRecord,
} from "../test/e2e/fixture-sandbox";

const baseSandbox = {
  id: "11111111-1111-4111-8111-111111111111",
  sandbox_id: "playwright-e2e-org-sandbox",
  status: "running",
  bridge_url: "http://127.0.0.1:65535",
  health_url: "http://127.0.0.1:65535/health",
} satisfies FixtureSandboxRecord;

function repository() {
  const create = mock(async (data: NewAgentSandbox): Promise<unknown> => data);
  const update = mock(
    async (
      id: string,
      _data: Partial<NewAgentSandbox>,
    ): Promise<{ id: string } | undefined> => ({ id }),
  );
  return { create, update };
}

const fixtureOptions = {
  slug: "playwright-e2e-org",
  organizationId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
};

describe("ensureFixtureSandbox", () => {
  test("creates an inert row without a fake runtime endpoint", async () => {
    const repo = repository();
    await ensureFixtureSandbox({
      ...fixtureOptions,
      sandboxes: [],
      repository: repo,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox_id: "playwright-e2e-org-sandbox",
        status: "stopped",
        bridge_url: null,
        health_url: null,
      }),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  test("repairs the old running loopback sentinel on the next preload", async () => {
    const repo = repository();
    await ensureFixtureSandbox({
      ...fixtureOptions,
      sandboxes: [baseSandbox],
      repository: repo,
    });

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(baseSandbox.id, {
      status: "stopped",
      bridge_url: null,
      health_url: null,
    });
  });

  test("does not write again once the fixture is inert", async () => {
    const repo = repository();
    await ensureFixtureSandbox({
      ...fixtureOptions,
      sandboxes: [
        {
          ...baseSandbox,
          status: "stopped",
          bridge_url: null,
          health_url: null,
        },
      ],
      repository: repo,
    });

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  test("creates the named fixture when an unrelated sandbox already exists", async () => {
    const repo = repository();
    await ensureFixtureSandbox({
      ...fixtureOptions,
      sandboxes: [{ ...baseSandbox, sandbox_id: "another-sandbox" }],
      repository: repo,
    });

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.update).not.toHaveBeenCalled();
  });

  test("fails fast when a raced update cannot repair the fixture", async () => {
    const repo = repository();
    repo.update.mockResolvedValue(undefined);

    await expect(
      ensureFixtureSandbox({
        ...fixtureOptions,
        sandboxes: [baseSandbox],
        repository: repo,
      }),
    ).rejects.toThrow(
      `E2E fixture sandbox disappeared while normalizing it: ${baseSandbox.id}`,
    );
  });
});
