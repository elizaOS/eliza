/** Product identity uses the same admitted resources before either normal boot. */
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { loadNativeRuntimeModule } from "./native-runtime-module.js";
import { parseNativeCloudRuntimeDeclaration } from "./native-runtime-profile.js";

export async function installProductCharacterHost(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const module = await loadNativeRuntimeModule(env);
  // Older admitted Google hosts need not declare product presentation.
  if (!module || module.nativeCloudRuntime === undefined) return;
  const { productCharacter } = parseNativeCloudRuntimeDeclaration(
    module.nativeCloudRuntime,
  );
  if (!productCharacter) return;
  setAgentHostBridge({ ...getAgentHostBridge(), productCharacter });
}
