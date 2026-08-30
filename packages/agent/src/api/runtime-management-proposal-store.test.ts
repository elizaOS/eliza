/** Exercises the real filesystem proposal store across restart and concurrent consumers. */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRuntimeManagementProposalStore,
  type RuntimeManagementProposal,
} from "./runtime-management-proposal-store.ts";

const directories: string[] = [];

async function temporaryStore(): Promise<{
  directory: string;
  proposal: RuntimeManagementProposal;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-proposal-"));
  directories.push(directory);
  return {
    directory,
    proposal: {
      proposalId: "10000000-0000-4000-8000-000000000001",
      nonce: "nonce-one",
      clientId: "renderer-one",
      requestKey: '{"op":"remove","runtimeId":"vps-1"}',
      expiresAt: Date.now() + 60_000,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FileRuntimeManagementProposalStore", () => {
  it("survives restart and atomically permits one exact consumer", async () => {
    const { directory, proposal } = await temporaryStore();
    await new FileRuntimeManagementProposalStore(directory).create(proposal);
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    const [proposalFile] = await readdir(proposalDirectory);
    if (!proposalFile) throw new Error("proposal file was not persisted");
    const proposalPath = path.join(proposalDirectory, proposalFile);
    const serialized = await readFile(proposalPath, "utf8");
    expect(serialized).not.toContain(proposal.nonce);
    expect(JSON.parse(serialized)).toMatchObject({
      proposalId: proposal.proposalId,
      nonceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    if (process.platform !== "win32") {
      expect((await stat(proposalPath)).mode & 0o777).toBe(0o600);
    }

    const restartedA = new FileRuntimeManagementProposalStore(directory);
    const restartedB = new FileRuntimeManagementProposalStore(directory);
    const outcomes = await Promise.all([
      restartedA.consume(proposal),
      restartedB.consume(proposal),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await expect(restartedA.consume(proposal)).resolves.toBe(false);
  });

  it("fails closed on a malformed partial proposal file", async () => {
    const { directory, proposal } = await temporaryStore();
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    await mkdir(proposalDirectory, { recursive: true });
    await writeFile(
      path.join(proposalDirectory, `${proposal.proposalId}.json`),
      '{"proposalId":',
      { flag: "wx" },
    );
    const store = new FileRuntimeManagementProposalStore(directory);
    await expect(store.consume(proposal)).resolves.toBe(false);
  });

  it("does not consume authority for a mismatched target, renderer, or nonce", async () => {
    const { directory, proposal } = await temporaryStore();
    const store = new FileRuntimeManagementProposalStore(directory);
    await store.create(proposal);

    await expect(
      store.consume({
        ...proposal,
        requestKey: '{"op":"remove","runtimeId":"vps-2"}',
      }),
    ).resolves.toBe(false);
    await expect(
      store.consume({ ...proposal, clientId: "renderer-two" }),
    ).resolves.toBe(false);
    await expect(
      store.consume({ ...proposal, nonce: "nonce-two" }),
    ).resolves.toBe(false);
    await expect(store.consume(proposal)).resolves.toBe(true);
  });

  it("collects expired proposals and abandoned consumed claims on later use", async () => {
    const { directory, proposal } = await temporaryStore();
    const store = new FileRuntimeManagementProposalStore(directory);
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    const expired = { ...proposal, expiresAt: Date.now() - 1 };
    await store.create(expired);
    const expiredPath = path.join(
      proposalDirectory,
      `${proposal.proposalId}.json`,
    );
    await utimes(expiredPath, new Date(0), new Date(0));

    const consumedProposal = {
      ...proposal,
      proposalId: "20000000-0000-4000-8000-000000000002",
    };
    await store.create(consumedProposal);
    const consumedPath = path.join(
      proposalDirectory,
      `${consumedProposal.proposalId}.consumed-30000000-0000-4000-8000-000000000003`,
    );
    await rename(
      path.join(proposalDirectory, `${consumedProposal.proposalId}.json`),
      consumedPath,
    );
    await utimes(consumedPath, new Date(0), new Date(0));

    await store.create({
      ...proposal,
      proposalId: "40000000-0000-4000-8000-000000000004",
    });
    const names = await readdir(proposalDirectory);
    expect(names).not.toContain(`${proposal.proposalId}.json`);
    expect(names).not.toContain(path.basename(consumedPath));
  });

  it("collects an abandoned partial only after its race-safe age floor", async () => {
    const { directory, proposal } = await temporaryStore();
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    await mkdir(proposalDirectory, { recursive: true });
    const partialPath = path.join(
      proposalDirectory,
      `${proposal.proposalId}.json`,
    );
    await writeFile(partialPath, '{"proposalId":', { flag: "wx" });
    const store = new FileRuntimeManagementProposalStore(directory);
    await store.create({
      ...proposal,
      proposalId: "20000000-0000-4000-8000-000000000002",
    });
    await expect(stat(partialPath)).resolves.toBeDefined();

    await utimes(partialPath, new Date(0), new Date(0));
    await store.create({
      ...proposal,
      proposalId: "30000000-0000-4000-8000-000000000003",
    });
    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an unexpired proposal abandoned inside an interrupted cleanup claim", async () => {
    const { directory, proposal } = await temporaryStore();
    const store = new FileRuntimeManagementProposalStore(directory);
    await store.create(proposal);
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    const cleanupPath = path.join(
      proposalDirectory,
      `${proposal.proposalId}.cleanup-20000000-0000-4000-8000-000000000002`,
    );
    await rename(
      path.join(proposalDirectory, `${proposal.proposalId}.json`),
      cleanupPath,
    );
    await utimes(cleanupPath, new Date(0), new Date(0));

    await store.create({
      ...proposal,
      proposalId: "30000000-0000-4000-8000-000000000003",
    });
    await expect(store.consume(proposal)).resolves.toBe(true);
    await expect(stat(cleanupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("advances a bounded cleanup cursor past more than 256 earlier entries", async () => {
    const { directory, proposal } = await temporaryStore();
    const proposalDirectory = path.join(
      directory,
      "runtime-management-proposals",
    );
    await mkdir(proposalDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(
          path.join(
            proposalDirectory,
            `unrelated-${index.toString().padStart(3, "0")}`,
          ),
          "retained",
        ),
      ),
    );
    const bootstrap = new FileRuntimeManagementProposalStore(directory);
    await bootstrap.create(proposal);
    const consumedPath = path.join(
      proposalDirectory,
      `${proposal.proposalId}.consumed-20000000-0000-4000-8000-000000000002`,
    );
    await rename(
      path.join(proposalDirectory, `${proposal.proposalId}.json`),
      consumedPath,
    );
    await utimes(consumedPath, new Date(0), new Date(0));

    const restarted = new FileRuntimeManagementProposalStore(directory);
    for (let index = 1; index <= 8; index += 1) {
      await restarted.create({
        ...proposal,
        proposalId: `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      });
    }
    await expect(stat(consumedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "never follows a proposal symlink outside the state directory",
    async () => {
      const { directory, proposal } = await temporaryStore();
      const proposalDirectory = path.join(
        directory,
        "runtime-management-proposals",
      );
      await mkdir(proposalDirectory, { recursive: true });
      const outside = path.join(directory, "outside.json");
      await writeFile(
        outside,
        JSON.stringify({
          proposalId: proposal.proposalId,
          nonceDigest: "0".repeat(64),
          clientId: proposal.clientId,
          requestKey: proposal.requestKey,
          expiresAt: proposal.expiresAt,
        }),
      );
      await symlink(
        outside,
        path.join(proposalDirectory, `${proposal.proposalId}.json`),
      );

      const store = new FileRuntimeManagementProposalStore(directory);
      await expect(store.consume(proposal)).resolves.toBe(false);
      await expect(readFile(outside, "utf8")).resolves.toContain(
        proposal.proposalId,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a linked proposal directory before writing authority",
    async () => {
      const { directory, proposal } = await temporaryStore();
      const outside = path.join(directory, "outside-directory");
      await mkdir(outside);
      await symlink(
        outside,
        path.join(directory, "runtime-management-proposals"),
      );

      const store = new FileRuntimeManagementProposalStore(directory);
      await expect(store.create(proposal)).rejects.toThrow(
        "real local directory",
      );
      await expect(readdir(outside)).resolves.toEqual([]);
    },
  );
});
