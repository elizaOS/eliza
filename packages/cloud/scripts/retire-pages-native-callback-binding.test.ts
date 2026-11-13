import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RETIRED_NATIVE_CALLBACK_BINDING as name,
  PagesNativeBindingRetirementError,
  type PagesRetirementFetch,
  retirePagesNativeCallbackBinding,
} from "./retire-pages-native-callback-binding";

function fixture(environment: "staging" | "production") {
  const selected = environment === "staging" ? "preview" : "production";
  const project = {
    name: "eliza-app",
    canonical_deployment: { id: "current-deployment" },
    deployment_configs: Object.fromEntries(
      ["preview", "production"].map((key) => [
        key,
        {
          env_vars: {
            [name]: { type: "plain_text", value: "retired-callback" },
            KEEP_SECRET: {
              type: "secret_text",
              value: "synthetic-secret-value",
            },
            API_UPSTREAM: {
              type: "plain_text",
              value: `https://${key}.example`,
            },
          } as Record<string, unknown>,
          wrangler_config_hash: "a".repeat(64),
          services: { API_WORKER: { service: `api-${key}` } },
        },
      ]),
    ),
  };
  const deployment = {
    id: "current-deployment",
    project_name: "eliza-app",
    environment: selected,
    deployment_trigger: {
      metadata: {
        branch: environment === "staging" ? "staging" : "main",
        commit_hash: "b".repeat(40),
      },
    },
    latest_stage: { name: "deploy", status: "success" },
    aliases: ["https://staging.eliza-app.pages.dev"],
    env_vars: structuredClone(project.deployment_configs[selected].env_vars),
  };
  const patches: unknown[] = [];
  const fetchImpl: PagesRetirementFetch = async (url, init) => {
    const root = `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/pages/projects/eliza-app`,
      target = String(url);
    expect(target.startsWith(root)).toBe(true);
    expect(init?.redirect).toBe("error");
    if (target === `${root}/deployments?env=preview&page=1`)
      return Response.json({
        success: true,
        result: [deployment],
        result_info: { total_pages: 1 },
      });
    if (target === `${root}/deployments/current-deployment`)
      return Response.json({ success: true, result: deployment });
    expect(target).toBe(root);
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      delete project.deployment_configs[selected].env_vars[name];
    }
    return Response.json({ success: true, result: project });
  };
  return {
    project,
    deployment,
    patches,
    selected,
    input: {
      accountId: "a".repeat(32),
      token: "synthetic-token",
      project: "eliza-app",
      environment,
      expectedCommit: "b".repeat(40),
      fetchImpl,
    },
  };
}

test("retires only the selected Pages callback field and preserves other variables, bindings and config hash", async () => {
  for (const environment of ["staging", "production"] as const) {
    const f = fixture(environment);
    const other = f.selected === "preview" ? "production" : "preview";
    const untouched = structuredClone(f.project.deployment_configs[other]);
    expect(await retirePagesNativeCallbackBinding(f.input)).toBe("removed");
    expect(f.patches).toEqual([
      {
        deployment_configs: {
          [f.selected]: {
            env_vars: { [name]: null },
            wrangler_config_hash: "a".repeat(64),
          },
        },
      },
    ]);
    expect(f.project.deployment_configs[other]).toEqual(untouched);
    expect(f.project.deployment_configs[f.selected].services).toEqual({
      API_WORKER: { service: `api-${f.selected}` },
    });
    expect(await retirePagesNativeCallbackBinding(f.input)).toBe(
      "already-absent",
    );
    expect(f.patches).toHaveLength(1);
  }
});

test("verifies the exact deployed source and both retired-name inventories without mutation", async () => {
  for (const environment of ["staging", "production"] as const) {
    const f = fixture(environment);
    delete f.project.deployment_configs[f.selected].env_vars[name];
    delete f.deployment.env_vars[name];
    expect(
      await retirePagesNativeCallbackBinding({ ...f.input, verifyOnly: true }),
    ).toBe("verified");
    expect(f.patches).toHaveLength(0);
    f.deployment.deployment_trigger.metadata.commit_hash = "c".repeat(40);
    await expect(
      retirePagesNativeCallbackBinding({ ...f.input, verifyOnly: true }),
    ).rejects.toThrow("(verify)");
    f.deployment.deployment_trigger.metadata.commit_hash = "b".repeat(40);
    f.deployment.env_vars[name] = { type: "plain_text", value: "still-active" };
    await expect(
      retirePagesNativeCallbackBinding({ ...f.input, verifyOnly: true }),
    ).rejects.toThrow("(verify)");
  }
});

test("refuses ambiguous current staging deployments before any mutation", async () => {
  const f = fixture("staging");
  const fetchImpl: PagesRetirementFetch = async (url, init) =>
    String(url).includes("?env=preview")
      ? Response.json({
          success: true,
          result: [f.deployment, { ...f.deployment, id: "other" }],
          result_info: { total_pages: 1 },
        })
      : f.input.fetchImpl(url, init);
  await expect(
    retirePagesNativeCallbackBinding({ ...f.input, fetchImpl }),
  ).rejects.toThrow("(shape)");
  expect(f.patches).toHaveLength(0);
});

test("refuses malformed Pages binding types without mutation", async () => {
  const f = fixture("staging");
  f.project.deployment_configs.preview.env_vars[name] = {
    type: "service",
    service: "wrong-kind",
  };
  await expect(
    retirePagesNativeCallbackBinding(f.input),
  ).rejects.toBeInstanceOf(PagesNativeBindingRetirementError);
  expect(f.patches).toHaveLength(0);
});

test("refuses unverified Pages removal or changes to other variables", async () => {
  for (const changeOther of [false, true]) {
    const f = fixture("production");
    const fetchImpl: PagesRetirementFetch = async (url, init) => {
      const response = await f.input.fetchImpl(url, init);
      if (init?.method === "PATCH") {
        if (changeOther)
          delete f.project.deployment_configs.production.env_vars.KEEP_SECRET;
        else
          f.project.deployment_configs.production.env_vars[name] = {
            type: "plain_text",
            value: "retained",
          };
      }
      return response;
    };
    await expect(
      retirePagesNativeCallbackBinding({ ...f.input, fetchImpl }),
    ).rejects.toThrow("(verify)");
  }
});

test("Pages provider failures disclose no response, token or binding value", async () => {
  const f = fixture("staging");
  try {
    await retirePagesNativeCallbackBinding({
      ...f.input,
      fetchImpl: async () =>
        Response.json(
          {
            success: false,
            errors: [{ message: "synthetic-secret-value synthetic-token" }],
          },
          { status: 500 },
        ),
    });
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(PagesNativeBindingRetirementError);
    expect(String(error)).toContain("(read)");
    expect(String(error)).not.toContain("synthetic-secret-value");
    expect(String(error)).not.toContain("synthetic-token");
  }
});

test("Pages retirement runs after source and production checks before canonical upload", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("      - name: Deploy to Cloudflare Pages");
  const end = workflow.indexOf(
    "      - name: Verify Pages frontend freshness",
    start,
  );
  const phase = workflow.slice(start, end);
  const cleanup = phase.indexOf("retire-pages-native-callback-binding.ts");
  expect(cleanup).toBeGreaterThan(
    phase.indexOf("production-effect-certification.ts main-validation"),
  );
  expect(cleanup).toBeGreaterThan(
    phase.indexOf(
      "recheck_canonical_source\n",
      phase.indexOf("for attempt in"),
    ),
  );
  expect(cleanup).toBeLessThan(
    phase.indexOf("bunx wrangler@4.100.0 pages deploy"),
  );
  expect(phase.slice(0, cleanup)).toContain(
    'if [ "$EVENT_NAME" != "pull_request" ]; then',
  );
});
