/** Exercises mock-server option parsing and rejects retired corpus loading before opening listeners. */
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, startMocks } from "../scripts/start-mocks.ts";

const originalCorpusDir = process.env.ELIZA_CORPUS_DIR;

afterEach(() => {
  if (originalCorpusDir === undefined) delete process.env.ELIZA_CORPUS_DIR;
  else process.env.ELIZA_CORPUS_DIR = originalCorpusDir;
});

describe("mock server options", () => {
  it.each([["--corpus-dir", "/tmp/corpus"], ["--corpus-dir=/tmp/corpus"]])(
    "rejects retired corpus arguments: %j",
    (...args) => {
      expect(() => parseCliArgs(args)).toThrow(
        "Corpus directory loading has been removed",
      );
    },
  );

  it("rejects a corpus environment setting before starting servers", async () => {
    process.env.ELIZA_CORPUS_DIR = "/tmp/corpus";
    await expect(startMocks({ envs: ["google"] })).rejects.toThrow(
      "unset ELIZA_CORPUS_DIR",
    );
  });

  it("retains environment selection and simulator seeding", () => {
    expect(parseCliArgs(["--envs", "google,github", "--simulator"])).toEqual({
      envs: ["google", "github"],
      simulator: true,
    });
  });
});
