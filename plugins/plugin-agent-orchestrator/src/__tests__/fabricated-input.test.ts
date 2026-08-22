import { describe, expect, it } from "vitest";
import {
  detectFabricatedInput,
  readTargetsFromTask,
  shellWriteTargets,
} from "../services/fabricated-input.js";

const TASK =
  "write a python script that reads /etc/nubs-secret-config.yaml and prints the version field";

describe("fabricated input detection", () => {
  it("finds the file the task asks the worker to read", () => {
    expect(readTargetsFromTask(TASK)).toEqual(["/etc/nubs-secret-config.yaml"]);
    expect(
      readTargetsFromTask("load data from ./sales.csv and chart it"),
    ).toEqual(["./sales.csv"]);
    expect(
      readTargetsFromTask("write a script that picks a random card"),
    ).toEqual([]);
  });

  it("requires an exact normalized path, not a matching filename stem", () => {
    expect(
      detectFabricatedInput(
        TASK,
        ["/ws/read_version.py", "/ws/nubs-secret-config.yaml"],
        [],
      ),
    ).toBeUndefined();
    expect(
      detectFabricatedInput(
        TASK,
        ["/ws/read_version.py"],
        [
          "python3 -c \"print('version: 1.2.3')\" > /etc/nubs-secret-config.yaml",
        ],
      ),
    ).toEqual({
      target: "/etc/nubs-secret-config.yaml",
      wrote: "/etc/nubs-secret-config.yaml",
    });
  });

  it("does not flag the script itself or unrelated writes", () => {
    expect(
      detectFabricatedInput(
        TASK,
        ["/ws/read_version.py"],
        ["python3 /ws/read_version.py"],
      ),
    ).toBeUndefined();
    expect(
      detectFabricatedInput(
        TASK,
        [],
        ["cat /etc/nubs-secret-config.yaml", "ls > /dev/null"],
      ),
    ).toBeUndefined();
  });

  it("reads shell redirection and tee targets", () => {
    expect(
      shellWriteTargets("echo hi > out.txt && cat x | tee -a log.txt"),
    ).toEqual(["out.txt", "log.txt"]);
  });
});
