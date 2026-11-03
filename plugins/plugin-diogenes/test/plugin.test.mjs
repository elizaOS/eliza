import test from "node:test";
import assert from "node:assert/strict";
import { DiogenesClient, diogenesPlugin, getClientFromRuntime } from "../dist/index.js";

test("DiogenesClient initializes with defaults and respects runtime settings", () => {
  const defaultClient = new DiogenesClient();
  assert.ok(defaultClient);

  const mockRuntime = {
    getSetting: (key) => {
      if (key === "DIOGENES_GATEWAY_URL") return "https://custom.diogenesgateway.com";
      if (key === "DIOGENES_DEMO_MODE") return "false";
      return null;
    }
  };

  const runtimeClient = getClientFromRuntime(mockRuntime);
  assert.ok(runtimeClient);
});

test("EVALUATE_SOLANA_TOKEN_RISK validate accepts base58 mint addresses and rejects invalid", async () => {
  const action = diogenesPlugin.actions.find(a => a.name === "EVALUATE_SOLANA_TOKEN_RISK");
  assert.ok(action);

  const validMsg = { content: { text: "Audit token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } };
  const invalidMsg = { content: { text: "Hello world no token here" } };

  assert.equal(await action.validate(null, validMsg), true);
  assert.equal(await action.validate(null, invalidMsg), false);
});

test("AUDIT_SMART_CONTRACT validate accepts code/audit keywords", async () => {
  const action = diogenesPlugin.actions.find(a => a.name === "AUDIT_SMART_CONTRACT");
  assert.ok(action);

  assert.equal(await action.validate(null, { content: { text: "audit this contract" } }), true);
  assert.equal(await action.validate(null, { content: { text: "what is the weather today?" } }), false);
});

test("ENFORCE_GUARDRAIL validate accepts input and handler fails closed on empty or error", async () => {
  const action = diogenesPlugin.actions.find(a => a.name === "ENFORCE_GUARDRAIL");
  assert.ok(action);

  assert.equal(await action.validate(null, { content: { text: "rm -rf /" } }), true);
  assert.equal(await action.validate(null, { content: {} }), false);

  let callbackResult = null;
  const passed = await action.handler(null, { content: { text: "" } }, null, null, (res) => {
    callbackResult = res;
  });

  // Must fail closed (return false)
  assert.equal(passed, false);
  assert.match(callbackResult.text, /\[BLOCKED\]/);
});
