import { afterEach, expect, test } from "bun:test";
import { collectPluginNames } from "../src/runtime/plugin-collector";
const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
function plugins(optIn: string | undefined, config = {}) {
  process.env.ELIZA_PLUGIN_SET = "lean-chat";
  delete process.env.ELIZA_PLATFORM;
  if (optIn === undefined) delete process.env.ELIZA_LEAN_CHAT_WORKFLOWS;
  else process.env.ELIZA_LEAN_CHAT_WORKFLOWS = optIn;
  return collectPluginNames(config);
}
test("lean chat stays workflow-free unless explicitly enabled", () => {
  expect(plugins(undefined).has("@elizaos/plugin-workflow")).toBe(false);
  expect(plugins("0").has("@elizaos/plugin-workflow")).toBe(false);
});
test("phone workflow opt-in preserves desktop actuator exclusions", () => {
  const selected = plugins("1");
  expect(selected.has("@elizaos/plugin-workflow")).toBe(true);
  for (const name of ["coding-tools", "browser", "agent-orchestrator", "gitpathologist", "pty", "wallet"])
    expect(selected.has(`@elizaos/plugin-${name}`)).toBe(false);
});
test("explicit user workflow disable still wins", () => {
  expect(plugins("1", { workflow: { enabled: false } }).has("@elizaos/plugin-workflow")).toBe(false);
  expect(plugins("1", { plugins: { entries: { workflow: { enabled: false } } } }).has("@elizaos/plugin-workflow")).toBe(false);
});
