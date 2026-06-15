/**
 * WorkflowStepRegistry unit tests.
 *
 * Covers the registry contract that replaces the closed 9-branch `step.kind`
 * switch in `service-mixin-workflows.ts` (audit `rigidity-hunt-audit.md`
 * top-2). The dispatcher behaviour itself is integration-tested elsewhere;
 * these tests verify:
 *   - the default pack registers all 10 built-in step kinds,
 *   - a synthetic third-party step kind can be registered + dispatched,
 *   - `UnknownWorkflowStepError` carries the offending kind + the current
 *     known set,
 *   - duplicate registration is rejected.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  __resetWorkflowStepRegistryForTests,
  type AnyWorkflowStepContribution,
  APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS,
  createWorkflowStepRegistry,
  getWorkflowStepRegistry,
  registerDefaultWorkflowStepPack,
  registerWorkflowStepRegistry,
  UnknownWorkflowStepError,
  type WorkflowStepExecuteArgs,
  type WorkflowStepExecuteContext,
} from "../src/lifeops/registries/index.ts";

const EXPECTED_DEFAULT_KINDS = [
  "create_task",
  "relock_website_access",
  "resolve_website_access_callback",
  "get_calendar_feed",
  "get_gmail_triage",
  "get_gmail_unresponded",
  "get_health_summary",
  "dispatch_workflow",
  "summarize",
  "browser",
] as const;

function makeRuntimeStub(): IAgentRuntime {
  // The registry is per-runtime via WeakMap; we only need a stable object
  // identity, not a working runtime.
  return {} as IAgentRuntime;
}

function makeStubArgs(): WorkflowStepExecuteArgs {
  return {
    definition: {
      id: "wf-1",
      agentId: "agent",
      domain: "personal",
      subjectType: "agent",
      subjectId: "agent",
      visibilityScope: "owner_only",
      contextPolicy: "default",
      title: "stub",
      triggerType: "manual",
      schedule: { kind: "manual" },
      actionPlan: { steps: [] },
      permissionPolicy: {
        allowBrowserActions: false,
        trustedBrowserActions: false,
      },
      status: "active",
      createdBy: "user",
      metadata: {},
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    } as unknown as WorkflowStepExecuteArgs["definition"],
    startedAt: "2026-05-09T00:00:00.000Z",
    confirmBrowserActions: false,
    request: {},
    outputs: {},
    previousStepValue: null,
  };
}

function makeStubCtx(): WorkflowStepExecuteContext {
  return {} as WorkflowStepExecuteContext;
}

describe("WorkflowStepRegistry", () => {
  it("default pack registers all 10 built-in step kinds", () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    const kinds = registry.list().map((c) => c.kind);
    expect(kinds.sort()).toEqual([...EXPECTED_DEFAULT_KINDS].sort());
    expect(APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS).toHaveLength(
      EXPECTED_DEFAULT_KINDS.length,
    );
  });

  it("rejects duplicate registration", () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    expect(() =>
      registry.register(APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS[0]!),
    ).toThrow(/already registered/);
  });

  it("registers a synthetic third-party step kind and dispatches it via execute", async () => {
    const acmeStepSchema = z.object({
      kind: z.literal("acme_step"),
      id: z.string().optional(),
      resultKey: z.string().optional(),
      payload: z.object({ greeting: z.string() }),
    });
    type AcmeStep = z.infer<typeof acmeStepSchema>;

    let received: AcmeStep | null = null;
    const acmeContribution: AnyWorkflowStepContribution = {
      kind: "acme_step",
      describe: {
        label: "Acme step",
        description: "Test contribution",
        provider: "test:acme",
      },
      paramSchema: acmeStepSchema as unknown as z.ZodType<{ kind: string }>,
      async execute(step) {
        received = step as AcmeStep;
        return { ok: true, kind: (step as AcmeStep).kind };
      },
    };

    const registry = createWorkflowStepRegistry();
    registry.register(acmeContribution);
    expect(registry.has("acme_step")).toBe(true);

    const contribution = registry.get("acme_step");
    expect(contribution).not.toBeNull();
    const validated = contribution!.paramSchema.parse({
      kind: "acme_step",
      payload: { greeting: "hi" },
    });
    const result = await contribution!.execute(
      validated,
      makeStubArgs(),
      makeStubCtx(),
    );
    expect(received).toEqual({
      kind: "acme_step",
      payload: { greeting: "hi" },
    });
    expect(result).toEqual({ ok: true, kind: "acme_step" });
  });

  it("UnknownWorkflowStepError carries kind + known set", () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    expect(registry.get("nonexistent")).toBeNull();
    const err = new UnknownWorkflowStepError(
      "nonexistent",
      registry.list().map((c) => c.kind),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownWorkflowStepError");
    expect(err.kind).toBe("nonexistent");
    expect(err.knownKinds).toContain("create_task");
    expect(err.knownKinds).toContain("browser");
    expect(err.message).toContain("nonexistent");
    expect(err.message).toContain("create_task");
  });

  it("paramSchema rejects malformed steps", () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    const relock = registry.get("relock_website_access");
    expect(relock).not.toBeNull();
    expect(() =>
      relock!.paramSchema.parse({
        kind: "relock_website_access",
        request: {},
      }),
    ).toThrow();
    const ok = relock!.paramSchema.parse({
      kind: "relock_website_access",
      request: { groupKey: "social" },
    });
    expect(ok).toMatchObject({
      kind: "relock_website_access",
      request: { groupKey: "social" },
    });
  });

  it("per-runtime WeakMap binding isolates registries", () => {
    const r1 = makeRuntimeStub();
    const r2 = makeRuntimeStub();
    const reg1 = createWorkflowStepRegistry();
    const reg2 = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(reg1);
    registerWorkflowStepRegistry(r1, reg1);
    registerWorkflowStepRegistry(r2, reg2);

    expect(getWorkflowStepRegistry(r1)?.list()).toHaveLength(
      EXPECTED_DEFAULT_KINDS.length,
    );
    expect(getWorkflowStepRegistry(r2)?.list()).toHaveLength(0);

    __resetWorkflowStepRegistryForTests(r1);
    expect(getWorkflowStepRegistry(r1)).toBeNull();
    expect(getWorkflowStepRegistry(r2)).not.toBeNull();
  });

  it("default summarize contribution describes previousStepValue when no sourceKey is set", async () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    const summarize = registry.get("summarize");
    expect(summarize).not.toBeNull();
    const args: WorkflowStepExecuteArgs = {
      ...makeStubArgs(),
      previousStepValue: { count: 7 },
    };
    const validated = summarize!.paramSchema.parse({
      kind: "summarize",
      prompt: "stat",
    });
    const result = (await summarize!.execute(
      validated,
      args,
      makeStubCtx(),
    )) as { text: string };
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("default browser contribution short-circuits when permissionPolicy.allowBrowserActions=false", async () => {
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    const browser = registry.get("browser");
    expect(browser).not.toBeNull();
    const validated = browser!.paramSchema.parse({
      kind: "browser",
      sessionTitle: "noop",
      actions: [{ kind: "open" }],
    });
    const result = await browser!.execute(
      validated,
      makeStubArgs(),
      makeStubCtx(),
    );
    expect(result).toEqual({
      blocked: true,
      reason: "browser_actions_disabled",
    });
  });
});
