/** Unit tests for the coding-agent-context Zod schemas. */
import { describe, expect, it } from "vitest";
import {
  addIteration,
  type CapturedError,
  type CodingIteration,
  createCodingAgentContext,
  getUnresolvedErrors,
  type HumanFeedback,
  hasReachedMaxIterations,
  injectFeedback,
  isLastIterationClean,
  shouldContinueLoop,
  validateCodingAgentContext,
  validateConnectorConfig,
} from "./coding-agent-context.js";

/**
 * The coding-agent context drives the autonomous self-correction loop (#9146).
 * The loop-termination decision (inactive / max iterations / clean / rejected)
 * is the safety boundary that stops a runaway agent, so its branches are pinned.
 */

const err: CapturedError = { category: "compile", message: "boom" };
const iter = (errors: CapturedError[] = []): CodingIteration =>
  ({
    index: 0,
    startedAt: 1,
    fileOperations: [],
    commandResults: [],
    errors,
    feedback: [],
    selfCorrected: false,
  }) as CodingIteration;

const baseCtx = () =>
  createCodingAgentContext({
    sessionId: "s1",
    taskDescription: "do the thing",
    workingDirectory: "/work",
    connectorType: "git-repo",
    connectorBasePath: "/repo",
  });

describe("createCodingAgentContext", () => {
  it("applies sane defaults", () => {
    const ctx = baseCtx();
    expect(ctx).toMatchObject({
      maxIterations: 10,
      active: true,
      interactionMode: "fully-automated",
      iterations: [],
      connector: { type: "git-repo", basePath: "/repo", available: true },
    });
  });
});

describe("iteration helpers", () => {
  it("hasReachedMaxIterations compares count to the cap", () => {
    const ctx = { ...baseCtx(), maxIterations: 1 };
    expect(hasReachedMaxIterations(ctx)).toBe(false);
    expect(hasReachedMaxIterations(addIteration(ctx, iter()))).toBe(true);
  });

  it("isLastIterationClean / getUnresolvedErrors reflect the last iteration", () => {
    const ctx = baseCtx();
    expect(isLastIterationClean(ctx)).toBe(true); // no iterations
    expect(getUnresolvedErrors(ctx)).toEqual([]);

    const dirty = addIteration(ctx, iter([err]));
    expect(isLastIterationClean(dirty)).toBe(false);
    expect(getUnresolvedErrors(dirty)).toEqual([err]);

    const clean = addIteration(dirty, iter([]));
    expect(isLastIterationClean(clean)).toBe(true);
  });

  it("addIteration / injectFeedback are immutable appends", () => {
    const ctx = baseCtx();
    const next = addIteration(ctx, iter([err]));
    expect(ctx.iterations).toHaveLength(0); // original untouched
    expect(next.iterations).toHaveLength(1);

    const fb: HumanFeedback = {
      id: "f1",
      timestamp: 1,
      text: "no",
      type: "rejection",
    };
    const withFb = injectFeedback(next, fb);
    expect(next.allFeedback).toHaveLength(0);
    expect(withFb.allFeedback).toEqual([fb]);
  });
});

describe("shouldContinueLoop", () => {
  it("halts an inactive session", () => {
    expect(shouldContinueLoop({ ...baseCtx(), active: false })).toMatchObject({
      shouldContinue: false,
    });
  });

  it("halts at the iteration cap", () => {
    const ctx = addIteration({ ...baseCtx(), maxIterations: 1 }, iter([err]));
    expect(shouldContinueLoop(ctx).reason).toMatch(/maximum iterations/);
  });

  it("halts when the last iteration is error-free", () => {
    const ctx = addIteration(baseCtx(), iter([]));
    expect(shouldContinueLoop(ctx).reason).toMatch(/without errors/);
  });

  it("halts when the user rejected the last iteration", () => {
    const ctx = injectFeedback(addIteration(baseCtx(), iter([err])), {
      id: "f1",
      timestamp: 1,
      text: "stop",
      type: "rejection",
    });
    expect(shouldContinueLoop(ctx)).toMatchObject({ shouldContinue: false });
    expect(shouldContinueLoop(ctx).reason).toMatch(/rejected/);
  });

  it("continues while there are errors to resolve", () => {
    const ctx = addIteration(baseCtx(), iter([err]));
    expect(shouldContinueLoop(ctx).shouldContinue).toBe(true);
  });
});

describe("validators", () => {
  it("accepts a well-formed context/connector and rejects malformed ones", () => {
    expect(validateCodingAgentContext(baseCtx()).ok).toBe(true);
    expect(validateCodingAgentContext({}).ok).toBe(false);
    expect(
      validateConnectorConfig({ type: "git-repo", basePath: "/x" }).ok,
    ).toBe(true);
    expect(validateConnectorConfig({ type: "nope", basePath: "/x" }).ok).toBe(
      false,
    );
  });
});
