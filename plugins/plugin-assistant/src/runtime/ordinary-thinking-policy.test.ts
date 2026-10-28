import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Evaluate the actual adapter and option expression in isolation. Transport,
// model output and tool execution are outside this policy regression.
function source(relative: string) {
  const text = readFileSync(new URL(relative, import.meta.url), "utf8");
  return ts.createSourceFile(
    relative,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
function find(file: ts.Node, match: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (!found && match(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw Error("Production policy expression not found");
  return found;
}
function expression(node: ts.Node, file: ts.SourceFile, names: string[]) {
  const js = ts.transpileModule(`return (${node.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...names, js);
}

describe("ordinary message thinking policy", () => {
  it.each([
    { codingMode: false, explicit: false },
    { codingMode: true, explicit: false },
    { codingMode: false, explicit: true },
  ])("planner preserves caller options: %j", ({ codingMode, explicit }) => {
    const file = source("../services/message/pipeline.ts");
    const declaration = find(
      file,
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(file) === "plannerRuntime",
    ) as ts.VariableDeclaration;
    const adapter = find(
      declaration,
      (node) =>
        ts.isPropertyAssignment(node) && node.name.getText(file) === "useModel",
    ) as ts.PropertyAssignment;
    const options = {
      eliza: {
        thinking: "off",
        preferLosslessToolArguments: true,
        ...(codingMode || explicit ? { preferToolReasoning: true } : {}),
      },
    };
    const params = {
      providerOptions: options,
      tools: [{ name: "SAVE_LITERAL" }],
    };
    let received: unknown[] = [];
    const runtime = {
      useModel(...args: unknown[]) {
        received = args;
        return "result";
      },
    };
    const call = expression(adapter.initializer, file, [
      "args",
      "directMessageChannel",
      "ModelType",
      "isRecord",
    ])(
      { runtime, codingMode },
      true,
      { ACTION_PLANNER: "ACTION_PLANNER" },
      (v: unknown) => !!v && typeof v === "object",
    );
    expect(call("ACTION_PLANNER", params, "cerebras")).toBe("result");
    expect(received).toEqual(["ACTION_PLANNER", params, "cerebras"]);
    expect((received[1] as typeof params).providerOptions).toBe(options);
    expect(options.eliza.preferToolReasoning).toBe(
      codingMode || explicit ? true : undefined,
    );
  });
  it.each([
    { codingMode: false, explicit: false },
    { codingMode: true, explicit: false },
    { codingMode: false, explicit: true },
  ])("evaluator preserves thinking policy: %j", ({ codingMode, explicit }) => {
    const file = source("./evaluator.ts");
    const assignment = find(
      file,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.left.getText(file) === "providerOptions.eliza",
    ) as ts.BinaryExpression;
    const evaluate = expression(assignment.right, file, [
      "providerOptions",
      "params",
      "evaluatorEvidenceSteps",
    ]);
    const value = evaluate(
      {
        eliza: {
          cacheTag: "keep",
          ...(explicit ? { preferToolReasoning: true } : {}),
        },
      },
      { trajectory: { codingMode } },
      () => [
        { step: { toolCall: { name: "READ_NOTES" }, terminalOnly: false } },
      ],
    );
    expect(value.thinking).toBe("off");
    expect(value.cacheTag).toBe("keep");
    expect(value.preferToolReasoning).toBe(
      codingMode || explicit ? true : undefined,
    );
  });
});
