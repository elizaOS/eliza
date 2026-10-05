import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";

const loadElizaConfig = vi.fn();

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig,
  buildConfigSchema: () => ({ uiHints: {} }),
  resolveConfigPath: () => "/tmp/eliza.json",
}));

const { registerConfigCli } = await import("./register.config");

const SECRETS = {
  env: { OPENAI_API_KEY: "sk-live-openai", MY_SERVICE_TOKEN: "tok-dynamic" },
  cloud: { apiKey: "ck-cloud-secret", enabled: true },
  ui: { theme: "dark" },
};

afterEach(() => {
  vi.restoreAllMocks();
  loadElizaConfig.mockReset();
});

async function run(...args: string[]): Promise<string> {
  loadElizaConfig.mockReturnValue(structuredClone(SECRETS));
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const program = new Command();
  registerConfigCli(program);
  await program.parseAsync(["node", "eliza", "config", ...args]);
  return lines.join("\n");
}

function expectNoSecrets(output: string) {
  expect(output).not.toContain("sk-live-openai");
  expect(output).not.toContain("tok-dynamic");
  expect(output).not.toContain("ck-cloud-secret");
}

it("masks dynamic env.* secrets and cloud.apiKey in `config show`", async () => {
  const output = await run("show");
  expectNoSecrets(output);
  expect(output).toContain("dark");
  expect(output).toContain("●●●●●●●●");
});

it("masks secrets in `config show --json`", async () => {
  const output = await run("show", "--json");
  expectNoSecrets(output);
  const parsed = JSON.parse(output);
  expect(parsed.cloud.enabled).toBe(true);
  expect(parsed.ui.theme).toBe("dark");
});

it("masks secrets in `config get` for leaves and subtrees", async () => {
  expectNoSecrets(await run("get", "cloud.apiKey"));
  expectNoSecrets(await run("get", "env.MY_SERVICE_TOKEN"));
  expectNoSecrets(await run("get", "env"));
  expect(await run("get", "ui.theme")).toBe("dark");
});
