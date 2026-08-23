/** Exercises the real filesystem proposal store across restart and concurrent consumers. */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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
});
