import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nativeSignInCallbackFallback,
  onRequest,
} from "../../app/functions/_middleware.ts";
import {
  callbacks,
  prepareConfig,
  verifyCallbacks,
} from "./pages-native-auth-callbacks.ts";

const binding = "ELIZA_NATIVE_AUTH_CALLBACKS_JSON";
const stage = {
  redirectUri: "https://cloud-staging.eliza.app/auth/example/callback",
  androidPackage: "app.example.native",
  appName: "Example",
};
const production = {
  ...stage,
  redirectUri: "https://cloud.eliza.app/auth/example/callback",
};
const directory = path.resolve(import.meta.dirname, "../../app");
const canonical = Bun.TOML.parse(
  await readFile(path.join(directory, "wrangler.toml"), "utf8"),
) as Record<string, unknown> & {
  vars: Record<string, string>;
  env: { production: { vars: Record<string, string> } };
};

describe("Pages native callback deployment", () => {
  test("protected workflow configuration reaches the bare deployment job through actual step outputs", async () => {
    type Step = { id: string; env: Record<string, string>; run: string };
    type Job = {
      environment?: string;
      needs: string[];
      outputs: Record<string, string>;
      steps: Step[];
    };
    const workflow = Bun.YAML.parse(
      await readFile(
        path.resolve(directory, "../../.github/workflows/cloud-cf-release.yml"),
        "utf8",
      ),
    ) as { jobs: Record<string, Job> };
    const protectedJob = workflow.jobs["resolve-pages-environment-config"];
    const deployment = workflow.jobs["deploy-app"];
    expect(protectedJob.environment).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal GitHub Actions expression.
      "${{ inputs.target_environment == 'production' && 'production' || 'staging' }}",
    );
    expect(deployment.environment).toBeUndefined();
    expect(deployment.needs).toContain("resolve-pages-environment-config");
    const resolver = protectedJob.steps.find(
      (step) => step.id === "native-callbacks",
    );
    const prepare = deployment.steps.find(
      (step) => step.id === "native-callbacks",
    );
    if (!resolver || !prepare)
      throw new Error("native callback workflow steps missing");
    // Evaluate the actual dotted context/output expressions used by these steps.
    // The bare job intentionally has no protected vars or secrets of its own.
    const interpolate = (value: string, context: Record<string, unknown>) =>
      value.replace(
        /\$\{\{\s*(.*?)\s*\}\}/g,
        (_match: string, expression: string) => {
          for (const candidate of expression.split("||")) {
            const resolved = candidate
              .trim()
              .split(".")
              .reduce<unknown>(
                (current, key) =>
                  current && typeof current === "object"
                    ? (current as Record<string, unknown>)[key]
                    : undefined,
                context,
              );
            if (typeof resolved === "string" && resolved) return resolved;
          }
          return "";
        },
      );
    const environmentFor = (step: Step, context: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(step.env).map(([key, value]) => [
          key,
          interpolate(value, context),
        ]),
      );
    const outputs = async (file: string): Promise<Record<string, string>> =>
      Object.fromEntries(
        (await readFile(file, "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => {
            const equals = line.indexOf("=");
            return [line.slice(0, equals), line.slice(equals + 1)];
          }),
      );
    const temporary = await mkdtemp(
      path.join(tmpdir(), "pages-workflow-scope-"),
    );
    try {
      const appDirectory = path.join(temporary, "packages/app");
      await mkdir(appDirectory, { recursive: true });
      await writeFile(
        path.join(appDirectory, "wrangler.toml"),
        await readFile(path.join(directory, "wrangler.toml")),
      );
      expect(
        (
          await Bun.build({
            entrypoints: [
              path.join(import.meta.dirname, "pages-native-auth-callbacks.ts"),
            ],
            target: "bun",
            conditions: ["eliza-source"],
            outdir: appDirectory,
            naming: "pages-native-auth-callbacks.mjs",
          })
        ).success,
      ).toBe(true);
      const run = (step: Step, env: Record<string, string>, output: string) =>
        spawnSync("bash", ["-c", step.run], {
          cwd: temporary,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            CHECKOUT_DIR: temporary,
            RUNNER_TEMP: temporary,
            GITHUB_OUTPUT: output,
            ...env,
          },
        });
      for (const [environment, callback] of [
        ["staging", stage],
        ["production", production],
      ] as const) {
        const context = {
          inputs: { target_environment: environment },
          vars: { [binding]: JSON.stringify([callback], null, 2) },
          secrets: {},
        };
        const resolvedFile = path.join(temporary, `${environment}-resolved`);
        const resolved = run(
          resolver,
          environmentFor(resolver, context),
          resolvedFile,
        );
        expect(resolved.status).toBe(0);
        expect(resolved.stderr).toBe("");
        const stepOutputs = await outputs(resolvedFile);
        const jobOutputs = Object.fromEntries(
          Object.entries(protectedJob.outputs).map(([key, value]) => [
            key,
            interpolate(value, {
              steps: { "native-callbacks": { outputs: stepOutputs } },
            }),
          ]),
        );
        const bareContext = {
          inputs: context.inputs,
          vars: {},
          secrets: {},
          needs: {
            "resolve-pages-environment-config": { outputs: jobOutputs },
          },
        };
        const preparedFile = path.join(temporary, `${environment}-prepared`);
        const prepared = run(
          prepare,
          environmentFor(prepare, bareContext),
          preparedFile,
        );
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).toBe("");
        expect(JSON.parse(prepared.stdout).nativeCallbacks).toBe(1);
        const preparedOutputs = await outputs(preparedFile);
        expect(
          JSON.stringify(
            JSON.parse(
              await readFile(
                path.join(preparedOutputs.directory, "wrangler.json"),
                "utf8",
              ),
            ),
          ),
        ).toContain(callback.redirectUri);
        const missing = run(
          prepare,
          { ...environmentFor(prepare, bareContext), [binding]: "" },
          path.join(temporary, "missing"),
        );
        expect(missing.status).toBe(1);
        expect(missing.stdout).toContain("configuration did not transfer");
      }
      const invalid = run(
        resolver,
        {
          TARGET_ENVIRONMENT: "staging",
          [binding]: JSON.stringify([
            { ...stage, privateKey: "must-not-be-output" },
          ]),
        },
        path.join(temporary, "invalid"),
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).not.toContain("must-not-be-output");
      const emptyFile = path.join(temporary, "empty");
      expect(
        run(
          resolver,
          { TARGET_ENVIRONMENT: "staging", [binding]: "" },
          emptyFile,
        ).status,
      ).toBe(0);
      expect(await outputs(emptyFile)).toEqual({
        configured: "false",
        callbacks: "",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("the immutable helper runs without workspace dependencies in the deployment directory", async () => {
    const temporary = await mkdtemp(
      path.join(tmpdir(), "pages-native-bundle-"),
    );
    try {
      const bundle = path.join(temporary, "pages-native-auth-callbacks.mjs");
      const build = await Bun.build({
        entrypoints: [
          path.join(import.meta.dirname, "pages-native-auth-callbacks.ts"),
        ],
        target: "bun",
        conditions: ["eliza-source"],
        outdir: temporary,
        naming: "pages-native-auth-callbacks.mjs",
      });
      expect(build.success).toBe(true);
      const config = path.join(temporary, "wrangler.toml");
      await writeFile(
        config,
        await readFile(path.join(directory, "wrangler.toml")),
      );
      for (const [environment, callback] of [
        ["staging", stage],
        ["production", production],
      ] as const) {
        const output = path.join(temporary, `${environment}-output`);
        const result = spawnSync(
          process.execPath,
          [
            bundle,
            "prepare",
            "--canonical",
            config,
            "--environment",
            environment,
            "--output-root",
            temporary,
          ],
          {
            cwd: temporary,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              GITHUB_OUTPUT: output,
              [binding]: JSON.stringify([callback]),
            },
            timeout: 30_000,
          },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          nativeCallbacks: 1,
          source: "configured",
          prepared: true,
        });
        const generated = (await readFile(output, "utf8"))
          .trim()
          .slice("directory=".length);
        const prepared = JSON.parse(
          await readFile(path.join(generated, "wrangler.json"), "utf8"),
        );
        expect(prepared.pages_build_output_dir).toBe(
          path.join(temporary, "web-dist"),
        );
        expect(
          await verifyCallbacks(prepared, environment, async (url) =>
            nativeSignInCallbackFallback(url, callback),
          ),
        ).toBe(1);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("selected callback reaches the real middleware while other bindings and environment stay unchanged", async () => {
    const source = JSON.stringify([stage]);
    const { config, count } = prepareConfig(
      canonical,
      directory,
      "staging",
      source,
      {},
    );
    expect(count).toBe(1);
    expect(config).toEqual({
      ...canonical,
      pages_build_output_dir: path.join(directory, "web-dist"),
      vars: { ...canonical.vars, [binding]: source },
    });
    expect(canonical.vars).not.toHaveProperty(binding);
    let spaCalls = 0;
    const request = async (input: URL) =>
      onRequest({
        request: new Request(input),
        env: config.vars as Record<string, string>,
        next: async () => {
          spaCalls += 1;
          return new Response("Eliza SPA");
        },
      });
    expect(await verifyCallbacks(config, "staging", request)).toBe(1);
    expect(spaCalls).toBe(0);
    const unrelated = await request(
      new URL("https://cloud-staging.eliza.app/auth/unregistered/callback"),
    );
    expect(await unrelated.text()).toBe("Eliza SPA");
  });

  test("production injection preserves preview and every other production binding", () => {
    const source = JSON.stringify([production]);
    const { config } = prepareConfig(
      canonical,
      directory,
      "production",
      source,
      {},
    );
    expect(config).toEqual({
      ...canonical,
      pages_build_output_dir: path.join(directory, "web-dist"),
      env: {
        ...canonical.env,
        production: {
          ...canonical.env.production,
          vars: { ...canonical.env.production.vars, [binding]: source },
        },
      },
    });
  });

  test("absent protected value preserves the existing selected callback and supports explicit empty list", () => {
    const existing = {
      vars: { [binding]: JSON.stringify([stage]) },
      env: {
        production: { vars: { [binding]: JSON.stringify([production]) } },
      },
    };
    for (const environment of ["staging", "production"] as const) {
      const preserved = prepareConfig(
        canonical,
        directory,
        environment,
        undefined,
        existing,
      );
      expect(preserved.source).toBe("preserved");
      expect(preserved.count).toBe(1);
      expect(
        prepareConfig(canonical, directory, environment, "[]", existing).count,
      ).toBe(0);
    }
    expect(prepareConfig(canonical, directory, "staging", "", {}).count).toBe(
      0,
    );
  });

  test("invalid config, cross-environment callbacks and duplicates fail before deployment", () => {
    for (const value of [
      "no-json",
      "{}",
      JSON.stringify([{ ...stage, extra: true }]),
      JSON.stringify([stage, stage]),
      JSON.stringify([
        { ...stage, redirectUri: "https://attacker.example/auth/callback" },
      ]),
      JSON.stringify([production]),
    ]) {
      expect(() => callbacks(value, "staging")).toThrow();
      expect(() =>
        prepareConfig(canonical, directory, "staging", undefined, {
          vars: { [binding]: value },
        }),
      ).toThrow();
    }
  });

  test("public proof rejects SPA, redirects, missing privacy headers and code reflection", async () => {
    const { config } = prepareConfig(
      canonical,
      directory,
      "staging",
      JSON.stringify([stage]),
      {},
    );
    const responses = [
      () => new Response("Eliza SPA"),
      () => Response.redirect("https://example.com"),
      () => {
        const response = nativeSignInCallbackFallback(
          new URL(stage.redirectUri),
          stage,
        );
        response.headers.delete("referrer-policy");
        return response;
      },
      () => {
        const response = nativeSignInCallbackFallback(
          new URL(stage.redirectUri),
          stage,
        );
        return new Response("native-callback-deployment-probe", {
          headers: response.headers,
        });
      },
    ];
    for (const response of responses)
      await expect(
        verifyCallbacks(config, "staging", async () => response()),
      ).rejects.toThrow();
  });
});
