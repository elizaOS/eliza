// spec/agent/plugins/bundle.md, "A consumer entry ships only as a named package's code inside the source root, and passes the same load smoke as the generated entry"
import { Layer } from "effect";
import { runAgentCli } from "../../../src/cli.vibe";
import { FixtureSocket, hostedFixtureModule, hostedFixtureName } from "hosted-fixture";
import { productPlugin } from "./index.ts";

runAgentCli({
  bundled: [{ packageName: productPlugin.name, plugin: productPlugin }, { packageName: hostedFixtureName, plugin: undefined }],
  productPlugin: productPlugin.name,
  hostModules: new Map([[hostedFixtureName, hostedFixtureModule]]),
  hostServices: () => Layer.succeed(FixtureSocket, { path: "SOCKET" }),
});
