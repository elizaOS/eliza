import { afterEach, assert, expect, it, vi } from "vitest";
import { createLogger } from "./logger.ts";

afterEach(() => vi.restoreAllMocks());

it("retains child namespace in client logging", () => {
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const logger = createLogger({
    level: "info",
    namespace: "parent",
  });

  logger
    .child({ namespace: "child" })
    .info({ src: "browser-test" }, "child message");

  expect(consoleInfo.mock.calls.flat().join(" ")).toContain("[child]");
  expect(consoleInfo.mock.calls.flat().join(" ")).toContain("child message");
});

it("masks a Buffer in the browser logger path", () => {
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  const logger = createLogger({ level: "trace" });
  logger.info({ payload: Buffer.from("browser-secret") }, "ctx");
  const out = infoSpy.mock.calls.flat().join(" ");
  expect(out).toContain("[BUFFER REDACTED 14 bytes]");
  expect(out).not.toContain('"type":"Buffer"');
});

it("detaches hostile built-ins and functions in the browser path", () => {
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  const dateSecret = "sk-browser-date-hook-secret";
  const functionSecret = "sk-browser-function-hook-secret";
  const date = new Date("2026-04-05T06:07:08.000Z");
  date.toJSON = () => dateSecret;
  const fn = Object.assign(() => {}, { toJSON: () => functionSecret });

  createLogger({ level: "trace" }).info(
    { date, values: new Set([fn]) },
    "ctx",
    fn,
  );

  const out = infoSpy.mock.calls.flat().join(" ");
  expect(out).not.toContain(dateSecret);
  expect(out).not.toContain(functionSecret);
  expect(out).toContain("2026-04-05T06:07:08.000Z");
});

it("bundles and runs in a browser without a runtime or Node dependency", async () => {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const result = await build({
    stdin: {
      contents: `export { logger } from "./logger.ts";
        export { isTruthyEnvValue } from "./env-utils.ts";
        export { formatError } from "./format-error.ts";
        export { sanitizeSpeechText } from "./spoken-text.ts";
        export { sanitizeForSettingsDebug } from "./settings-debug.ts";
        export { resolveApiBindHost } from "./runtime-env.ts";
        export { registerAppRoutePluginLoader, listAppRoutePluginLoaders } from "./api/app-route-plugin-registry.ts";`,
      resolveDir: new URL(".", import.meta.url).pathname,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ClientLogger",
    write: false,
    metafile: true,
  });
  assert(result.metafile, "Browser build must expose its dependency graph");
  expect(
    Object.keys(result.metafile.inputs).every(
      (file) => !file.includes("core/") && !file.includes("adze"),
    ),
  ).toBe(true);
  const output: unknown[] = [];
  const context = {
    console: { info: (...args: unknown[]) => output.push(...args) },
  };
  runInNewContext(
    result.outputFiles[0].text +
      '\nClientLogger.logger.info({apiKey: "sk-client-credential-value"}, "browser fixture");',
    context,
  );
  expect(output.join(" ")).toContain("browser fixture");
  expect(runInNewContext('ClientLogger.isTruthyEnvValue("YES")', context)).toBe(
    true,
  );
  expect(
    runInNewContext(
      'ClientLogger.sanitizeSpeechText("<think>private</think>Hello")',
      context,
    ),
  ).toBe("Hello");
  expect(
    runInNewContext('ClientLogger.formatError(new Error("fixture"))', context),
  ).toBe("fixture");
  expect(
    runInNewContext(
      'JSON.stringify(ClientLogger.sanitizeForSettingsDebug({api_key:"private-value"}))',
      context,
    ),
  ).not.toContain("private-value");
  expect(runInNewContext("ClientLogger.resolveApiBindHost({})", context)).toBe(
    "127.0.0.1",
  );
  expect(output.join(" ")).not.toContain("sk-client-credential-value");
  expect(
    runInNewContext(
      'ClientLogger.registerAppRoutePluginLoader("fixture", () => ({name:"fixture", description:"browser registration"})); ClientLogger.listAppRoutePluginLoaders()[0].id',
      context,
    ),
  ).toBe("fixture");
});
