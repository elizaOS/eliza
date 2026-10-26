import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./context-assembly.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf(
  "  const authenticatedDeviceTurn = getDeviceActionTurn();",
);
const end = source.indexOf("  const responseDecision =", start);
const fn = new Function(
  "args",
  "getDeviceActionTurn",
  "deviceOperationSupportedByCapabilities",
  "CLOCK_ALARMS_CAPABILITY",
  ts.transpileModule(
    "const events=[];\n" + source.slice(start, end) + "\nreturn events;",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText,
);
const runtime = {};
function render(capabilities: string[], matching = true) {
  const turn = {
    runtime: matching ? runtime : {},
    credential: { capabilities },
  };
  return fn(
    { runtime },
    () => turn,
    (operation: string, caps: string[]) =>
      caps.includes("native.all") || caps.includes(operation),
    "clock.alarms.v1",
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
    expect(text).toContain("do not substitute PROPOSE_DEVICE_ACTION open_view");
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
