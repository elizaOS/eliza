import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { findViewActionHandoff } from "../../../../../packages/core/src/views/view-action-handoff.ts";

// Execute the production reply helpers with the real core handoff parser.
const file = ts.createSourceFile(
  "reply-policy.ts",
  readFileSync(new URL("./reply-policy.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  "structuredEffectFromToolResult",
  "replyNamesStructuredEffectDestination",
  "preparedViewReply",
];
const code = names
  .map((name) => {
    const node = file.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    if (!node) throw Error(name + " missing");
    return node.getText(file).replace(/^export\s+/, "");
  })
  .join("\n");
const js = ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const preparedViewReply = new Function(
  "findViewActionHandoff",
  "isObjectRecord",
  js + "\nreturn preparedViewReply;",
)(
  findViewActionHandoff,
  (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v),
);
function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
  const values = {
    mode: "show",
    viewId: "chat",
    completedActionHandoffId: id,
    navigationPrepared: true,
    navigationBinding: {
      requestId: id,
      clientId: "client-1",
      installationId: "install-1",
      viewId: "chat",
      viewType: "gui",
    },
  };
  const step = {
    toolCall: { name: "VIEWS_SHOW" },
    result: {
      success: true,
      text: JSON.stringify({
        effect: "view_navigation",
        status: "prepared",
        label: "Home",
        viewId: "chat",
      }),
      data: { values, navigation: { handoffId: id } },
    },
  };
  return {
    stageOne: {
      visualContinuation: { disposition: "direct", viewId: "chat" },
      intents: ["go home"],
    },
    effectStatus: "pending",
    reply: "Heading home.",
    steps: [step] as unknown[],
    allow: () => true,
  };
}
it("retains pending navigation prose after effect-free terminal synthesis", () => {
  const a = fixture();
  expect(preparedViewReply(a)).toBe("Heading home.");
  a.steps.push({ terminalOnly: true, terminalMessage: "You are on Home." });
  expect(preparedViewReply(a)).toBe("Heading home.");
});
it("rejects another real action, including terminal-marked actions/results", () => {
  for (const extra of [
    { toolCall: { name: "WRITE" } },
    { terminalOnly: true, toolCall: { name: "REPLY" } },
    { terminalOnly: true, result: { success: false } },
    {},
  ]) {
    const a = fixture();
    a.steps.push(extra);
    expect(preparedViewReply(a)).toBeUndefined();
  }
});
it("retains binding, pending-state and egress approval boundaries", () => {
  for (const mutate of [
    (a: any) => (a.steps[0].result.data.navigation.handoffId = "changed"),
    (a: any) => (a.stageOne.visualContinuation.viewId = "notes"),
    (a: any) => (a.effectStatus = "delivered"),
    (a: any) => (a.allow = () => false),
  ]) {
    const a = fixture();
    a.steps.push({ terminalOnly: true });
    mutate(a);
    expect(preparedViewReply(a)).toBeUndefined();
  }
});
