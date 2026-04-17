import { describe, expect, it } from "vitest";
import { parseTrainArgs } from "../src/cli/train.js";

describe("parseTrainArgs", () => {
  it("returns 'help' when --help is passed", () => {
    expect(parseTrainArgs(["--help"]))
      .toBe("help");
  });

  it("requires --backend", () => {
    expect(() => parseTrainArgs(["--dataset", "x"])).toThrow(/--backend/);
  });

  it("rejects unknown backends", () => {
    expect(() => parseTrainArgs(["--backend", "rocket", "--dataset", "x"])).toThrow(/atropos/);
  });

  it("requires --dataset", () => {
    expect(() => parseTrainArgs(["--backend", "atropos"])).toThrow(/dataset/);
  });

  it("rejects unknown tasks", () => {
    expect(() =>
      parseTrainArgs([
        "--backend",
        "atropos",
        "--dataset",
        "x",
        "--task",
        "nope",
      ]),
    ).toThrow(/task/);
  });

  it("parses a complete vertex invocation", () => {
    const parsed = parseTrainArgs([
      "--backend",
      "vertex",
      "--dataset",
      "/tmp/x.jsonl",
      "--task",
      "should_respond",
      "--project",
      "proj",
      "--bucket",
      "buck",
      "--region",
      "us-east1",
      "--epochs",
      "5",
      "--display-name",
      "demo",
    ]);
    expect(parsed).not.toBe("help");
    if (parsed === "help") return;
    expect(parsed.backend).toBe("vertex");
    expect(parsed.task).toBe("should_respond");
    expect(parsed.epochs).toBe(5);
    expect(parsed.region).toBe("us-east1");
    expect(parsed.displayName).toBe("demo");
  });

  it("rejects non-positive epoch counts", () => {
    expect(() =>
      parseTrainArgs([
        "--backend",
        "vertex",
        "--dataset",
        "x",
        "--epochs",
        "0",
      ]),
    ).toThrow(/epochs/);
  });
});
