import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./context-assembly.ts", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile(
  "context-assembly.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
let statements: readonly ts.Statement[] = [];
function visit(node: ts.Node) {
  if (ts.isBlock(node)) {
    const start = node.statements.findIndex(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            declaration.name.getText(parsed) === "authenticatedDeviceTurn",
        ),
    );
    if (start >= 0) statements = node.statements.slice(start, start + 2);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
if (statements.length !== 2)
  throw new Error("Authenticated capability context block is missing");
const fn = new Function(
  "args",
  "getDeviceActionTurn",
  "deviceOperationSupportedByCapabilities",
  "CLOCK_ALARMS_CAPABILITY",
  "currentAppRecordSource",
  "deviceActionToolGuidance",
  ts.transpileModule(
    "const events=[];\n" +
      statements.map((statement) => statement.getText(parsed)).join("\n") +
      "\nreturn events;",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText,
);
const runtime = { actions: [{ name: "PROPOSE_DEVICE_ACTION" }] };
function render(capabilities: string[], matching = true) {
  const turn = {
    runtime: matching ? runtime : {},
    credential: { capabilities },
  };
  return fn(
    { runtime, includeTools: true },
    () => turn,
    (operation: string, caps: string[]) =>
      caps.includes("native.all") || caps.includes(operation),
    "clock.alarms.v1",
    () => "runtime",
    () => "",
  ) as Array<{ content: string }>;
}
for (const capabilities of [
  ["native.all"],
  ["clock.alarms.v1"],
  ["clock.handoff.v1"],
])
  test(`actual authenticated context separates renderer navigation from native approval for ${capabilities[0]}`, () => {
    const text = render(capabilities)[0].content;
    expect(text).toContain("registered VIEWS or VIEWS_SHOW action");
    expect(text).toContain("do not substitute a native open_view proposal");
    expect(text).toContain(
      "native device and external-app handoffs retain their existing capability and approval requirements",
    );
    expect(text).toContain("phone owner must separately approve");
    expect(text).toContain("only a native receipt establishes completion");
    if (capabilities[0] === "native.all")
      expect(text).toContain("authenticated enrolled phone");
    else expect(text).toContain("Clock-only executor");
  });
test("another runtime's enrollment cannot add native capability or navigation guidance", () => {
  expect(render(["native.all"], false)).toEqual([]);
});
