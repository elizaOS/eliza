import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ensureWorkerSecretAbsent } from "./ensure-worker-secret-absent.ts";

const workflow = readFileSync(
  new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
  "utf8",
);
const retirementLoop = workflow.match(
  /for name in FORCE_REDIS_EVENTS[\s\S]*?; do/,
)?.[0];
if (!retirementLoop) throw new Error("Missing staging binding retirement loop");
const retiredNames = retirementLoop.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [];

test("post-cutover retirement removes only the three legacy native secrets in either environment", async () => {
  const names = [
    "ELIZA_MOBILE_APP_AUTH_APP_ID",
    "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
    "ELIZA_ANDROID_ASSET_LINKS_JSON",
  ];
  const loop = workflow.match(
    /for name in ELIZA_MOBILE_APP_AUTH_APP_ID[^\n]*; do[\s\S]*?done/,
  )?.[0];
  expect(loop?.split("; do")[0]?.match(/\b[A-Z][A-Z0-9_]+\b/g)).toEqual(names);
  expect(loop).toContain(
    '--versions --binding-type secret_text "$name" --env "$DEPLOY_ENVIRONMENT"',
  );
  for (const environment of ["staging", "production"]) {
    const retained = [
      { name: "ELIZA_MOBILE_APP_AUTH_ENABLED", type: "plain_text" },
      { name: "STRIPE_SECRET_KEY", type: "secret_text" },
      { name: "STRIPE_WEBHOOK_SECRET", type: "secret_text" },
      { name: "STRIPE_PLUS_PRODUCT_ID", type: "secret_text" },
      { name: "STRIPE_PLUS_MONTHLY_PRICE_ID", type: "secret_text" },
      { name: "STRIPE_PRO_PRODUCT_ID", type: "secret_text" },
      { name: "STRIPE_PRO_MONTHLY_PRICE_ID", type: "secret_text" },
    ];
    const bindings = [
      ...retained,
      ...names.map((name) => ({ name, type: "secret_text" })),
    ];
    const deleted: string[] = [];
    const run = async (args: string[]) => {
      expect(args).toContain(environment);
      if (args[1] === "list")
        return JSON.stringify([{ id: "version", number: 1 }]);
      if (args[1] === "view")
        return JSON.stringify({ resources: { bindings } });
      expect(args.slice(0, 3)).toEqual(["versions", "secret", "delete"]);
      deleted.push(args[3]);
      bindings.splice(
        bindings.findIndex((binding) => binding.name === args[3]),
        1,
      );
      return "";
    };
    for (const name of names) {
      const options = {
        name,
        versioned: true,
        strictBindingType: true,
        wranglerArgs: ["--env", environment],
        attempts: 1,
        run,
      };
      expect(await ensureWorkerSecretAbsent(options)).toBe("removed");
      expect(await ensureWorkerSecretAbsent(options)).toBe("already-absent");
    }
    expect(deleted).toEqual(names);
    expect(bindings).toEqual(retained);
  }
});

test.each(["plain_text", "json"])(
  "strict secret retirement refuses an unexpected %s binding",
  async (type) => {
    let deletions = 0;
    await expect(
      ensureWorkerSecretAbsent({
        name: "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
        versioned: true,
        strictBindingType: true,
        attempts: 1,
        run: async (args: string[]) => {
          if (args[1] === "list")
            return JSON.stringify([{ id: "version", number: 1 }]);
          if (args[1] === "view")
            return JSON.stringify({
              resources: {
                bindings: [
                  { name: "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON", type },
                ],
              },
            });
          deletions++;
          return "";
        },
      }),
    ).rejects.toThrow(
      "Could not confirm Worker secret ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON is absent",
    );
    expect(deletions).toBe(0);
  },
);

test("staging retirement preserves every other binding, including the complete Stripe catalog", async () => {
  const retained = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PLUS_PRODUCT_ID",
    "STRIPE_PLUS_MONTHLY_PRICE_ID",
    "STRIPE_PRO_PRODUCT_ID",
    "STRIPE_PRO_MONTHLY_PRICE_ID",
    "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
  ].map((name) => ({ name, type: "secret_text", text: "configured" }));
  const bindings = [
    ...retained,
    { name: "ACTIVE_SETTING", type: "plain_text", text: "preserved" },
    ...retiredNames.map((name) => ({
      name,
      type: "plain_text",
      text: "retired",
    })),
  ];
  const expected = bindings.filter(
    (binding) => !retiredNames.includes(binding.name),
  );
  const deleted: string[] = [];
  const run = async (args: string[]) => {
    expect(args).toContain("--env");
    expect(args).toContain("staging");
    if (args[1] === "list")
      return JSON.stringify([{ id: "version", number: 1 }]);
    if (args[1] === "view") return JSON.stringify({ resources: { bindings } });
    expect(args.slice(0, 3)).toEqual(["versions", "secret", "delete"]);
    const name = args[3];
    deleted.push(name);
    bindings.splice(
      bindings.findIndex((binding) => binding.name === name),
      1,
    );
    return "";
  };
  for (const name of retiredNames) {
    expect(
      await ensureWorkerSecretAbsent({
        name,
        versioned: true,
        bindingType: "plain_text",
        wranglerArgs: ["--env", "staging"],
        attempts: 1,
        run,
      }),
    ).toBe("removed");
  }
  expect(deleted).toEqual(retiredNames);
  expect(bindings).toEqual(expected);
});

test("plain-text retirement refuses a same-name secret without deleting it", async () => {
  let deletions = 0;
  await expect(
    ensureWorkerSecretAbsent({
      name: "RETIRED_SETTING",
      versioned: true,
      bindingType: "plain_text",
      attempts: 1,
      run: async (args: string[]) => {
        if (args[1] === "list")
          return JSON.stringify([{ id: "version", number: 1 }]);
        if (args[1] === "view")
          return JSON.stringify({
            resources: {
              bindings: [{ name: "RETIRED_SETTING", type: "secret_text" }],
            },
          });
        deletions++;
        return "";
      },
    }),
  ).rejects.toThrow(
    "Could not confirm Worker secret RETIRED_SETTING is absent",
  );
  expect(deletions).toBe(0);
});

test("legacy secret retirement preserves the configured plain-text onboarding URL", async () => {
  let deletions = 0;
  const result = await ensureWorkerSecretAbsent({
    name: "ELIZA_ONBOARDING_LOGIN_APP_URL",
    versioned: true,
    attempts: 1,
    run: async (args: string[]) => {
      if (args[1] === "list")
        return JSON.stringify([{ id: "version", number: 1 }]);
      if (args[1] === "view")
        return JSON.stringify({
          resources: {
            bindings: [
              {
                name: "ELIZA_ONBOARDING_LOGIN_APP_URL",
                type: "plain_text",
                text: "https://staging.example",
              },
            ],
          },
        });
      deletions++;
      return "";
    },
  });
  expect(result).toBe("already-absent");
  expect(deletions).toBe(0);
});

test("retirement does not report success if the name remains under a different type", async () => {
  let deleted = false;
  await expect(
    ensureWorkerSecretAbsent({
      name: "RETIRED_SETTING",
      versioned: true,
      bindingType: "plain_text",
      attempts: 1,
      run: async (args: string[]) => {
        if (args[1] === "list")
          return JSON.stringify([{ id: "version", number: 1 }]);
        if (args[1] === "view")
          return JSON.stringify({
            resources: {
              bindings: [
                {
                  name: "RETIRED_SETTING",
                  type: deleted ? "secret_text" : "plain_text",
                },
              ],
            },
          });
        deleted = true;
        return "";
      },
    }),
  ).rejects.toThrow(
    "Could not confirm Worker secret RETIRED_SETTING is absent",
  );
  expect(deleted).toBe(true);
});
