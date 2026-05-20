import assert from "node:assert/strict";
import { ModelType, type Content, type HandlerCallback } from "@elizaos/core";
import { starterPlugin } from "./src/plugin";

const helloWorldAction = starterPlugin.actions?.find(
  (action) => action.name === "HELLO_WORLD",
);
assert.ok(helloWorldAction, "HELLO_WORLD action must be registered");

const message = {
  content: {
    text: "hello",
    source: "test",
  },
};
const state = {
  values: {},
  data: {},
  text: "",
};

assert.equal(
  await helloWorldAction.validate({} as never, message as never, state as never),
  true,
  "HELLO_WORLD action should validate a greeting",
);

let callbackContent: Content | undefined;
const callback: HandlerCallback = async (content) => {
  callbackContent = content;
  return [];
};

const actionResult = await helloWorldAction.handler(
  {} as never,
  message as never,
  state as never,
  {},
  callback,
  [],
);

assert.equal(actionResult.success, true, "HELLO_WORLD action should succeed");
assert.equal(actionResult.text, "Hello world!");
assert.equal(callbackContent?.text, "Hello world!");
assert.deepEqual(callbackContent?.actions, ["HELLO_WORLD"]);

const provider = starterPlugin.providers?.find(
  (candidate) => candidate.name === "HELLO_WORLD_PROVIDER",
);
assert.ok(provider, "HELLO_WORLD_PROVIDER must be registered");
const providerResult = await provider.get(
  {} as never,
  message as never,
  state as never,
);
assert.equal(providerResult.text, "I am a provider");

const textSmall = await starterPlugin.models?.[ModelType.TEXT_SMALL]?.(
  {} as never,
  { prompt: "test" },
);
assert.equal(typeof textSmall, "string");
assert.ok(textSmall.length > 0, "TEXT_SMALL model must return text");

const service = starterPlugin.services?.[0];
assert.equal(service?.serviceType, "starter");
const serviceInstance = await service?.start({} as never);
assert.match(serviceInstance?.capabilityDescription ?? "", /starter service/);
await serviceInstance?.stop();

console.log("plugin starter smoke test passed");
