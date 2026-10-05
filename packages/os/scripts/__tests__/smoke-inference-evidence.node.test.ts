import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectFreshLocalGeneration,
  inspectFreshNativeGeneration,
  inspectSmokeResponse,
} from "../aosp/lib/smoke-inference-evidence.ts";

test("historical generation and model-load lines cannot qualify a new chat", () => {
  const old = "[aosp-llama] Loaded model.gguf\n[aosp-llama] gen done\n";
  assert.equal(inspectFreshLocalGeneration(old, old).ok, false);
  assert.equal(
    inspectFreshLocalGeneration(old, `${old}[aosp-llama] Loaded model.gguf\n`)
      .ok,
    false,
  );
});

test("current Bionic completion qualifies while failed or zero-token calls do not", () => {
  const old = "startup\n";
  assert.equal(
    inspectFreshLocalGeneration(
      old,
      old +
        "[mobile-device-bridge] bionic host generate failed: missing bundle\n",
    ).ok,
    false,
  );
  assert.equal(
    inspectFreshLocalGeneration(
      old,
      `${old}[mobile-device-bridge] bionic GPU generate: 0 tok @ 3.2 tok/s\n`,
    ).ok,
    false,
  );
  assert.deepEqual(
    inspectFreshLocalGeneration(
      old,
      `${old}[mobile-device-bridge] bionic GPU generate: 23 tok @ 3.2 tok/s\n`,
    ),
    { ok: true, bionicCompletions: 1, ffiCompletions: 0 },
  );
});

test("fresh FFI generation remains supported and log replacement fails closed", () => {
  assert.equal(
    inspectFreshLocalGeneration("startup\n", "startup\n[aosp-llama] gen done\n")
      .ok,
    true,
  );
  assert.equal(
    inspectFreshLocalGeneration("old\n", "[aosp-llama] gen done\n").ok,
    false,
  );
});

test("HTTP success with the observed canned error is not a successful reply", () => {
  const response = (content) => ({ choices: [{ message: { content } }] });
  assert.equal(
    inspectSmokeResponse(
      response(
        "Something went wrong before I could answer. Try again in a moment.",
      ),
    ).ok,
    false,
  );
  assert.equal(
    inspectSmokeResponse({
      ...response("hello"),
      error: { message: "failure" },
    }).ok,
    false,
  );
  assert.equal(inspectSmokeResponse(response(" ")).ok, false);
  assert.deepEqual(inspectSmokeResponse(response("I'm Eliza.")), {
    ok: true,
    text: "I'm Eliza.",
  });
});

test("native proof binds the reply to a fresh request thread in the same process", () => {
  const old = "--------- beginning of main\n";
  const line = (thread, message, pid = "4289") =>
    `09-25 03:07:20.523 ${pid} ${thread} I ElizaBionicInfer: ${message}\n`;
  const start = line("5110", "GENERATE from agent: 23059 prompt chars");
  const body = {
    ok: true,
    tokens: 5,
    ms: 4496,
    text: "I'm Eliza.",
    incomplete: false,
  };
  const result = (value = body, thread = "5110", pid = "4289") =>
    line(thread, `GENERATE result (resident): ${JSON.stringify(value)}`, pid);
  const inspect = (fresh, overrides = {}) =>
    inspectFreshNativeGeneration({
      before: old,
      after: old + fresh,
      pidBefore: "4289",
      pidAfter: "4289",
      responseText: "I'm Eliza.",
      ...overrides,
    });
  assert.equal(inspect(start + result()).ok, true);
  assert.equal(inspect(result()).ok, false);
  assert.equal(inspect(start + result(body, "9999")).ok, false);
  assert.equal(inspect(start + result(body, "5110", "9999")).ok, false);
  assert.equal(inspect(start + result(), { pidAfter: "9999" }).ok, false);
  assert.equal(
    inspect(start + result(), { responseText: "Another reply" }).ok,
    false,
  );
  assert.equal(
    inspect(start + result(), { before: old + start + result() }).ok,
    false,
  );
  assert.equal(
    inspect(start + result(), { before: "replaced log\n" }).ok,
    false,
  );
  for (const changes of [
    { ok: false },
    { tokens: 0 },
    { incomplete: true },
    { text: "" },
  ]) {
    assert.equal(inspect(start + result({ ...body, ...changes })).ok, false);
  }
  assert.equal(
    inspect(start + line("5110", 'GENERATE result (resident): {"ok":true, …'))
      .ok,
    false,
  );
});
