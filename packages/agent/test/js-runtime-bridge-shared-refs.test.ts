/** Evaluates code in the host-node JS runtime bridge and checks the returned wire values: shared (non-cyclic) references are marshalled in full at every position and only a reference back to an ancestor becomes "[cycle]". */
import { afterAll, expect, it } from "vitest";
import {
  __resetJsRuntimeBridgeForTests,
  type JsValue,
  resolveJsRuntimeBridge,
} from "../src/services/js-runtime-bridge.ts";

afterAll(() => {
  __resetJsRuntimeBridgeForTests();
});

function plain(value: JsValue): unknown {
  switch (value.kind) {
    case "object":
      return Object.fromEntries(
        value.entries.map(([key, entry]) => [key, plain(entry)]),
      );
    case "array":
      return value.items.map(plain);
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "function":
      return `fn`;
    default:
      return value.value;
  }
}

it("marshals shared references in full and marks only true cycles", async () => {
  const bridge = await resolveJsRuntimeBridge();
  expect(bridge.kind).toBe("host-node");

  const shared = await bridge.evaluate({
    code: `const s = { id: 1 }; const branch = { s }; ({ a: s, b: s, list: [s, s], left: branch, right: { branch } })`,
  });
  expect(plain(shared)).toEqual({
    a: { id: 1 },
    b: { id: 1 },
    list: [{ id: 1 }, { id: 1 }],
    left: { s: { id: 1 } },
    right: { branch: { s: { id: 1 } } },
  });

  const cyclic = await bridge.evaluate({
    code: `const o = { name: "root" }; o.self = o; o.child = { parent: o }; const arr = [1]; arr.push(arr); o.arr = arr; o`,
  });
  expect(plain(cyclic)).toEqual({
    name: "root",
    self: "[cycle]",
    child: { parent: "[cycle]" },
    arr: [1, "[cycle]"],
  });
});
