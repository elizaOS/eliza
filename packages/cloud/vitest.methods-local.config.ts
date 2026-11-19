import { mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default mergeConfig(base, {
  plugins: [{ name: "stub-device-keys", enforce: "pre", resolveId(source: string) { return source.endsWith("native-clients/device-keys.vibe") ? "/private/tmp/claude-501/-Users-nubs-Documents-ChatGPT-eliza-agent-repos-eliza/450426ed-fd8f-4055-afb9-01d2be3f1126/scratchpad/stub/device-keys.ts" : undefined; } }],
});
