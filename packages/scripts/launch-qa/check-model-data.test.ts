import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkModelData } from "./check-model-data.mjs";

const tempRoots: string[] = [];

async function makeRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "model-data-gate-"));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, "plugins", "app-training", "datasets"), {
    recursive: true,
  });
  return repoRoot;
}

async function writeDataset(repoRoot: string, name: string, rows: unknown[]) {
  const datasetPath = path.join(
    repoRoot,
    "plugins",
    "app-training",
    "datasets",
    `${name}.jsonl`,
  );
  await fs.writeFile(
    datasetPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return datasetPath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("model/data gate", () => {
  it("passes a valid app-training JSONL dataset with matching metadata", async () => {
    const repoRoot = await makeRepo();
    await writeDataset(repoRoot, "valid", [
      {
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hello" },
          { role: "model", content: "hi" },
        ],
        reward: 1,
        metadata: { caseId: "c-1" },
      },
    ]);
    await fs.writeFile(
      path.join(
        repoRoot,
        "plugins",
        "app-training",
        "datasets",
        "valid.meta.json",
      ),
      JSON.stringify({
        rowCount: 1,
        caseCount: 1,
        passCount: 1,
        failCount: 0,
        rejectedCount: 0,
      }),
    );

    const result = checkModelData({ repoRoot });

    expect(result.ok).toBe(true);
    expect(result.totals.rows).toBe(1);
    expect(result.files[0]?.metadataFile).toBe(
      "plugins/app-training/datasets/valid.meta.json",
    );
  });

  it("fails invalid JSONL rows", async () => {
    const repoRoot = await makeRepo();
    await fs.writeFile(
      path.join(
        repoRoot,
        "plugins",
        "app-training",
        "datasets",
        "invalid.jsonl",
      ),
      '{"messages": [}\n',
    );

    const result = checkModelData({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "invalid-jsonl",
        file: "plugins/app-training/datasets/invalid.jsonl",
        line: 1,
      }),
    );
  });

  it("fails rows missing required messages fields", async () => {
    const repoRoot = await makeRepo();
    await writeDataset(repoRoot, "missing-fields", [
      {
        messages: [{ role: "system", content: "No user or answer." }],
      },
    ]);

    const result = checkModelData({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invalid-row-schema",
          message: expect.stringContaining("user message"),
        }),
        expect.objectContaining({
          type: "invalid-row-schema",
          message: expect.stringContaining("model or assistant message"),
        }),
      ]),
    );
  });

  it("fails secret-like strings in dataset rows", async () => {
    const repoRoot = await makeRepo();
    await writeDataset(repoRoot, "secret", [
      {
        messages: [
          { role: "user", content: "use api_key=abcdefghijklmnop1234567890" },
          { role: "assistant", content: "I will not store that." },
        ],
      },
    ]);

    const result = checkModelData({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.totals.secretHits).toBeGreaterThan(0);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "secret-like-string",
        label: "credential-assignment",
      }),
    );
  });

  it("fails metadata row-count mismatches", async () => {
    const repoRoot = await makeRepo();
    await writeDataset(repoRoot, "mismatch", [
      {
        messages: [
          { role: "user", content: "one" },
          { role: "model", content: "two" },
        ],
      },
    ]);
    await fs.writeFile(
      path.join(
        repoRoot,
        "plugins",
        "app-training",
        "datasets",
        "mismatch.meta.json",
      ),
      JSON.stringify({ rowCount: 2 }),
    );

    const result = checkModelData({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "metadata-row-count-mismatch",
        field: "rowCount",
        expected: 1,
        actual: 2,
      }),
    );
  });
});
