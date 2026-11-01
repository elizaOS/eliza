import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
