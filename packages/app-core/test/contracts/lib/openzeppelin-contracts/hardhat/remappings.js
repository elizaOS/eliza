const fs = require("node:fs");
const { task } = require("hardhat/config");
const {
  TASK_COMPILE_GET_REMAPPINGS,
} = require("hardhat/builtin-tasks/task-names");

task(TASK_COMPILE_GET_REMAPPINGS).setAction((_taskArgs, _env, runSuper) =>
  runSuper().then((remappings) =>
    Object.assign(
      remappings,
      Object.fromEntries(
        fs
          .readFileSync("remappings.txt", "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.trim().split("=")),
      ),
    ),
  ),
);
