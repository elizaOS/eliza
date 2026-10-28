import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  invocationSessionKey,
  listenerStartsVoice,
  parseAssistantInvocation,
  parseListenerStatus,
} from "../src/sense.ts";

const root = path.resolve(import.meta.dirname, "..");
test("native caller, owner, lock, age and replay policy", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-invocation-"));
  const java = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  try {
    execFileSync(java("javac"), [
      "--release",
      "11",
      "-d",
      temp,
      path.join(
        root,
        "android/src/main/java/ai/eliza/plugins/system/SenseInvocation.java",
      ),
      path.join(root, "test/SenseInvocationTest.java"),
    ]);
    assert.match(
      execFileSync(
        java("java"),
        ["-cp", temp, "ai.eliza.plugins.system.SenseInvocationTest"],
        { encoding: "utf8" },
      ),
      /^PASS/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("wire parser fails closed and live state remains authoritative", () => {
  assert.deepEqual(parseListenerStatus({ available: true, state: "OTHER" }), {
    available: false,
  });
  assert.deepEqual(
    parseListenerStatus({ available: true, state: "OFF", listening: true }),
    {
      available: true,
      state: "OFF",
      label: "Listening off",
      consented: false,
      listening: false,
      microphoneOpen: false,
    },
  );
  const base = {
    invocation: "listener",
    unlocked: true,
    hidden: false,
    dialogOpen: false,
    connectionOpen: false,
    voiceActive: false,
  };
  assert.equal(listenerStartsVoice(base), true);
  for (const key of ["hidden", "dialogOpen", "connectionOpen", "voiceActive"])
    assert.equal(listenerStartsVoice({ ...base, [key]: true }), false);
  assert.equal(listenerStartsVoice({ ...base, unlocked: false }), false);
  // A system assistant gesture (platform system UI caller) starts voice under the same rules.
  const system = { ...base, invocation: "system" };
  assert.equal(listenerStartsVoice(system), true);
  for (const key of ["hidden", "dialogOpen", "connectionOpen", "voiceActive"])
    assert.equal(listenerStartsVoice({ ...system, [key]: true }), false);
  assert.equal(listenerStartsVoice({ ...system, unlocked: false }), false);
  assert.equal(listenerStartsVoice({ ...base, invocation: "assist" }), false);
  assert.equal(listenerStartsVoice({ ...base, invocation: null }), false);
  // The wire parser admits only the two native voice origins; anything else only opens.
  assert.equal(
    parseAssistantInvocation({ assistant: true, invocation: "listener" }),
    "listener",
  );
  assert.equal(
    parseAssistantInvocation({ assistant: true, invocation: "system" }),
    "system",
  );
  for (const invocation of ["assist", "hardware", "SYSTEM", null, 1])
    assert.equal(
      parseAssistantInvocation({ assistant: true, invocation }),
      "assist",
    );
  assert.equal(
    parseAssistantInvocation({ assistant: false, invocation: "system" }),
    null,
  );
});
test("bridge receives only an opaque fixed-length session digest", async () => {
  const first = await invocationSessionKey("owner-a/session-a");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, await invocationSessionKey("owner-b/session-a"));
});

test("renderer rejects an invocation after authority changes during its native read", async () => {
  const { createSenseInvocationController } = await import("../src/sense.ts");
  const previousWindow = globalThis.window,
    previousDocument = globalThis.document;
  const events = new EventTarget();
  let hidden = false;
  globalThis.window = events;
  globalThis.document = new EventTarget();
  Object.defineProperty(globalThis.document, "hidden", { get: () => hidden });
  globalThis.document.querySelector = () => null;
  let authority = "owner-a/session-a",
    started = 0,
    takeResolve;
  let reads = 0;
  const bindings = [];
  const native = {
    bindInvocationSession: async ({ sessionKey }) => {
      bindings.push(sessionKey);
    },
    takeInvocation: async () => {
      reads++;
      return reads === 1
        ? new Promise((resolve) => {
            takeResolve = resolve;
          })
        : { assistant: false, invocation: null, locked: false };
    },
  };
  const controller = createSenseInvocationController(native, {
    authority: () => authority,
    ready: () => true,
    voiceActive: () => false,
    startVoice: () => started++,
  });
  const until = async (check) => {
    for (let i = 0; i < 100 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };
  try {
    await until(() => !!takeResolve);
    authority = "owner-b/session-b";
    controller.check();
    takeResolve({ assistant: true, invocation: "listener", locked: false });
    await until(() => bindings.length >= 2);
    assert.equal(started, 0);
    assert.notEqual(bindings[0], bindings[1]);
    hidden = true;
    const before = reads;
    controller.check();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reads, before);
  } finally {
    controller.dispose();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("same-owner remount fences delayed old bind, take and cleanup", async () => {
  const { createSenseInvocationController } = await import("../src/sense.ts");
  const savedWindow = globalThis.window,
    savedDocument = globalThis.document;
  const until = async (check) => {
    for (let i = 0; i < 100 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };
  try {
    for (const delayed of ["bind", "take", "clear"]) {
      globalThis.window = new EventTarget();
      globalThis.document = new EventTarget();
      globalThis.document.hidden = false;
      globalThis.document.querySelector = () => null;
      let owner,
        generation = 0,
        held,
        delayedOnce = false,
        receipt = false,
        oldStarts = 0,
        newStarts = 0;
      const native = {
        async bindInvocationSession(input) {
          const apply = () => {
            if (input.generation < generation) return;
            if (input.sessionKey === null) {
              if (owner === input.bindingId) owner = undefined;
              return;
            }
            generation = input.generation;
            owner = input.bindingId;
          };
          if (
            !delayedOnce &&
            delayed === (input.sessionKey === null ? "clear" : "bind")
          ) {
            delayedOnce = true;
            await new Promise((resolve) => {
              held = () => {
                apply();
                resolve();
              };
            });
          } else apply();
        },
        async takeInvocation(input) {
          if (!delayedOnce && delayed === "take") {
            delayedOnce = true;
            await new Promise((resolve) => {
              held = resolve;
            });
          }
          const accepted =
            receipt &&
            input.bindingId === owner &&
            input.generation === generation;
          if (accepted) receipt = false;
          return {
            assistant: accepted,
            invocation: accepted ? "listener" : null,
            locked: false,
          };
        },
      };
      const host = (startVoice) => ({
        authority: () => "same-owner/same-session",
        ready: () => true,
        voiceActive: () => false,
        startVoice,
      });
      const old = createSenseInvocationController(
        native,
        host(() => oldStarts++),
      );
      if (delayed === "clear") {
        await until(() => owner);
        old.dispose();
      }
      await until(() => held);
      const oldOwner = owner;
      const current = createSenseInvocationController(
        native,
        host(() => newStarts++),
      );
      if (delayed !== "clear") old.dispose();
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(
        owner,
        oldOwner,
        "new binding waits for old native operation completion",
      );
      held();
      await until(() => owner && owner !== oldOwner);
      receipt = true;
      current.check();
      await until(() => newStarts === 1);
      assert.equal(oldStarts, 0);
      current.dispose();
      await until(() => !owner);
    }
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
});

test("an abandoned bridge request cannot hold the next mount indefinitely", async (t) => {
  const { createSenseInvocationController, SENSE_BRIDGE_TIMEOUT_MS } =
    await import("../src/sense.ts");
  const savedWindow = globalThis.window,
    savedDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.document.hidden = false;
  globalThis.document.querySelector = () => null;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  };
  let release,
    first = true,
    generation = 0,
    owner;
  const native = {
    async bindInvocationSession(input) {
      if (first) {
        first = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (input.generation < generation) return;
      generation = input.generation;
      if (input.sessionKey !== null) owner = input.bindingId;
      else if (input.bindingId === owner) owner = undefined;
    },
    async takeInvocation() {
      return { assistant: false, locked: false };
    },
  };
  const host = {
    authority: () => "same-owner",
    ready: () => true,
    voiceActive: () => false,
    startVoice() {
      throw Error("Unexpected voice start");
    },
  };
  const old = createSenseInvocationController(native, host);
  let current;
  try {
    await flush();
    assert.ok(release);
    current = createSenseInvocationController(native, host);
    old.dispose();
    t.mock.timers.tick(SENSE_BRIDGE_TIMEOUT_MS);
    await flush();
    assert.ok(owner, "replacement progresses when abandoned request times out");
    const currentOwner = owner;
    release();
    await flush();
    assert.equal(
      owner,
      currentOwner,
      "late older-generation mutation remains fenced",
    );
  } finally {
    old.dispose();
    current?.dispose();
    await flush();
    t.mock.timers.reset();
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
});

test("native client and plugin compile against the Android 36 APIs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-control-android-"));
  const java = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  try {
    const stubs = {
      "Plugin.java":
        "package com.getcapacitor; public class Plugin { protected void handleOnDestroy(){} public android.content.Context getContext(){return null;} public android.app.Activity getActivity(){return null;} }",
      "PluginCall.java":
        "package com.getcapacitor; public class PluginCall { public void resolve(JSObject value){} public void resolve(){} public void reject(String value){} public String getString(String value){return null;} public Integer getInt(String value){return null;} }",
      "JSObject.java":
        "package com.getcapacitor; public class JSObject extends java.util.HashMap<String,Object> {}",
      "PluginMethod.java":
        "package com.getcapacitor; @java.lang.annotation.Target(java.lang.annotation.ElementType.METHOD) public @interface PluginMethod {}",
      "CapacitorPlugin.java":
        "package com.getcapacitor.annotation; @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE) public @interface CapacitorPlugin {String name();}",
    };
    const files = Object.entries(stubs).map(([name, text]) => {
      const file = path.join(temp, name);
      fs.writeFileSync(file, text);
      return file;
    });
    const sdk = path.join(
      process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
      "platforms/android-36/android.jar",
    );
    const source = path.join(
      root,
      "android/src/main/java/ai/eliza/plugins/system",
    );
    execFileSync(java("javac"), [
      "--release",
      "21",
      "-cp",
      sdk,
      "-d",
      path.join(temp, "out"),
      ...files,
      ...["SenseInvocation", "SenseListenerClient", "SensePlugin"].map((name) =>
        path.join(source, `${name}.java`),
      ),
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("native client keeps package, permission, component and reset fences", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-client-"));
  const java = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  try {
    const files = Object.entries(
      JSON.parse(
        fs.readFileSync(path.join(root, "test/sense-client-stubs.json")),
      ),
    ).map(([name, text]) => {
      const file = path.join(temp, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    });
    const source = path.join(
      root,
      "android/src/main/java/ai/eliza/plugins/system",
    );
    execFileSync(java("javac"), [
      "--release",
      "11",
      "-d",
      path.join(temp, "out"),
      ...files,
      ...["SenseListenerClient", "SenseInvocation"].map((name) =>
        path.join(source, `${name}.java`),
      ),
    ]);
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          path.join(temp, "out"),
          "ai.eliza.plugins.system.SenseListenerClientTest",
        ],
        { encoding: "utf8" },
      ),
      /^PASS/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
