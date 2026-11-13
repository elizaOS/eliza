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
