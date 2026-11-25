// spec/agent/plugins/bundle.md, "A host module is named only for a bundled package that is not an agent module, and runs with its entry's services over the resident's platform layer"
import type { Action } from "@elizaos/core";
import { Context, Effect } from "effect";
import type { ModuleFactory } from "../../../src/host/module.vibe";
// As a real plugin does, this one imports agent-host's root, which also exports the bundle builder and its Vite.
import "../../../src/index.vibe";

export const hostedFixtureName = "hosted-fixture";

export class FixtureSocket extends Context.Service<FixtureSocket, { readonly path: string }>()("test/FixtureSocket") {}

const hostedAction = (path: string): Action => ({
  name: `HOSTED_${path}`,
  description: "Report the device socket the host gave this module.",
  validate: () => Promise.resolve(true),
  handler: () => Promise.resolve({ success: true, text: path }),
});

export const hostedFixtureModule: ModuleFactory<FixtureSocket> = () => Effect.gen(function* () {
  const socket = yield* FixtureSocket;
  return { name: hostedFixtureName, plugin: { name: hostedFixtureName, description: "A host module fixture over a device socket.", actions: [hostedAction(socket.path)] } };
});
