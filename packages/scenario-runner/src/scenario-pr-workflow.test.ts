import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  import.meta.dirname,
  "../../../.github/workflows/scenario-pr.yml",
);

describe("scenario PR workflow contract", () => {
  it("runs deterministic zero-cost coverage on every PR without path filtering", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toMatch(/\n\s+paths:\s*\n/);
    expect(workflow).toContain('SCENARIO_USE_LLM_PROXY: "1"');
    expect(workflow).toContain(
      "bunx vitest run --config test/mocks/vitest.config.ts test/mocks/__tests__/llm-proxy-plugin.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/ui test:slow -- src/onboarding/__e2e__/assistant-view-manager-flow.test.tsx src/onboarding/__e2e__/assistant-voice-flow.test.tsx",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/scenario-runner test:pr:e2e",
    );
    expect(workflow).toContain(
      "bun run --cwd plugins/plugin-app-control test -- src/actions/views-management.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app-core/platforms/electrobun test src/native/desktop-window.test.ts src/rpc-handlers.test.ts src/dynamic-view-rpc-schema.test.ts src/surface-windows.test.ts src/dynamic-views/host.test.ts",
    );
  });
});
