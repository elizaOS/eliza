import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkProgress } from "../src/work-progress.js";

describe("work progress", () => {
  it("summarizes item progress by cycle and module", () => {
    const progress = buildWorkProgress({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      cycles: [
        {
          id: "cycle:elizaos/eliza:july",
          repo: "elizaos/eliza",
          state: "active",
          title: "July",
        },
      ],
      modules: [
        {
          id: "module:elizaos/eliza:runtime",
          repo: "elizaos/eliza",
          state: "active",
          title: "Runtime",
          packages: ["core"],
        },
      ],
      workItems: [
        {
          id: "work:one",
          repo: "elizaos/eliza",
          state: "done",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:runtime",
          ownerAgentId: "agent-runtime",
          packages: ["core"],
          updatedAt: "2026-07-07T00:01:00.000Z",
        },
        {
          id: "work:two",
          repo: "elizaos/eliza",
          state: "blocked",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:runtime",
          ownerAgentId: "agent-runtime",
          packages: ["core"],
          updatedAt: "2026-07-07T00:02:00.000Z",
        },
        {
          id: "work:three",
          repo: "elizaos/eliza",
          state: "ready",
        },
      ],
    });

    assert.equal(progress.computedAt, "2026-07-07T00:00:00.000Z");
    assert.equal(progress.summary.total, 3);
    assert.equal(progress.summary.done, 1);
    assert.equal(progress.summary.blocked, 1);
    assert.equal(progress.summary.ready, 1);
    assert.equal(progress.summary.percentComplete, 33);
    assert.deepEqual(progress.summary.ownerAgentIds, ["agent-runtime"]);
    assert.deepEqual(progress.summary.packages, ["core"]);
    assert.equal(progress.cycles[0].progress.total, 2);
    assert.equal(progress.cycles[0].progress.percentComplete, 50);
    assert.equal(progress.modules[0].progress.blocked, 1);
    assert.equal(progress.unscoped.all.total, 1);
    assert.equal(progress.unscoped.cycles.total, 1);
    assert.equal(progress.unscoped.modules.total, 1);
  });
});
