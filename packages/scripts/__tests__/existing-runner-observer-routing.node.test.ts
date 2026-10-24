import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { validateHetznerFleetRouting } from "../hetzner-fleet-routing-contract.ts";

const workflowPath = fileURLToPath(
  new URL(
    "../../../.github/workflows/cloud-existing-runner-qualification.yml",
    import.meta.url,
  ),
);

test("existing-host observer exception accepts only the reviewed manual job", () => {
  const root = mkdtempSync(path.join(tmpdir(), "existing-host-routing-"));
  const directory = path.join(root, ".github/workflows");
  mkdirSync(directory, { recursive: true });
  const original = readFileSync(workflowPath, "utf8");
  const check = (mutate, name = "cloud-existing-runner-qualification.yml") => {
    const workflow = parse(original);
    mutate(workflow);
    const target = path.join(directory, name);
    writeFileSync(target, stringify(workflow));
    try {
      return validateHetznerFleetRouting(root);
    } finally {
      rmSync(target);
    }
  };
  const job = (workflow) => workflow.jobs["qualify-existing-host"];
  try {
    assert.doesNotThrow(() => check(() => {}));
    for (const mutate of [
      (workflow) => {
        delete job(workflow).if;
      },
      (workflow) => {
        job(workflow).if = job(workflow).if.replace(
          " && github.run_attempt == 1",
          "",
        );
      },
      (workflow) => {
        job(workflow).environment = "staging";
      },
      (workflow) => {
        job(workflow)["runs-on"][3] = "hetzner-robot";
      },
      (workflow) => {
        workflow.on.push = { branches: ["main"] };
      },
    ])
      assert.throws(
        () => check(mutate),
        /explicit HETZNER_FLEET_ONLINE opt-in/,
      );
    assert.throws(
      () => check(() => {}, "unrelated.yml"),
      /explicit HETZNER_FLEET_ONLINE opt-in/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
