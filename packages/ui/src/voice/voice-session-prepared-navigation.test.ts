import { expect, test } from "vitest";
import { parseServerControl } from "./voice-session-protocol";

const id = "11111111-1111-4111-8111-111111111111";
const binding = {
  requestId: id,
  clientId: "22222222-2222-4222-8222-222222222222",
  installationId: "33333333-3333-4333-8333-333333333333",
  viewId: "notes",
  viewType: "gui",
};
const frame = {
  t: "navigate_view",
  viewId: "notes",
  viewPath: "/notes",
  traceId: "owned-turn",
  navigationPrepared: true,
  completedActionHandoffId: id,
  navigationBinding: binding,
};
test("existing navigate_view preserves exactly the canonical prepared binding", () => {
  expect(parseServerControl(JSON.stringify(frame))).toEqual(frame);
});
test("malformed prepared metadata suppresses the entire frame rather than returning a legacy visual effect", () => {
  for (const value of [
    { ...frame, navigationPrepared: false },
    { ...frame, completedActionHandoffId: undefined },
    { ...frame, navigationBinding: undefined },
    { ...frame, navigationBinding: { ...binding, viewId: "chat" } },
    {
      ...frame,
      navigationBinding: {
        ...binding,
        requestId: "44444444-4444-4444-8444-444444444444",
      },
    },
    { ...frame, navigationBinding: { ...binding, viewType: "native" } },
    { ...frame, navigationBinding: { ...binding, installationId: "" } },
    { ...frame, navigationPrepared: undefined },
  ])
    expect(parseServerControl(JSON.stringify(value))).toBeNull();
});
test("genuinely legacy navigate_view omits prepared metadata and retains its old shape", () => {
  const legacy = {
    t: "navigate_view",
    viewId: "notes",
    viewPath: "/notes",
    traceId: "owned-turn",
  };
  expect(parseServerControl(JSON.stringify(legacy))).toEqual(legacy);
});
