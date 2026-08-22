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

  it("flags a ledger write of the read target by stem, with or without extension", () => {
    expect(
      detectFabricatedInput(
        TASK,
        ["/ws/read_version.py", "/ws/nubs-secret-config.yaml"],
        [],
      ),
    ).toEqual({
      target: "/etc/nubs-secret-config.yaml",
      wrote: "/ws/nubs-secret-config.yaml",
    });
    expect(
      detectFabricatedInput(
        TASK,
        ["/ws/read_version.py"],
        ["python3 -c \"print('version: 1.2.3')\" > /ws/nubs-secret-config"],
      ),
    ).toEqual({
      target: "/etc/nubs-secret-config.yaml",
      wrote: "/ws/nubs-secret-config",
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

  it("does not treat produced files as read targets, nor a same-stem script as the input", () => {
    expect(
      readTargetsFromTask("read sales.csv and write a summary to report.json"),
    ).toEqual(["sales.csv"]);
    expect(
      detectFabricatedInput(
        "write a script that reads config.json and prints it",
        ["/ws/config.py"],
        [],
      ),
    ).toBeUndefined();
    expect(
      detectFabricatedInput(
        "write a script that reads config.json and prints it",
        ["/ws/config.json"],
        [],
      ),
    ).toEqual({ target: "config.json", wrote: "/ws/config.json" });
  });
});
