/** Personal room prewarm must use its verified owner and share the cron dedup set. */
import { expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
const { prewarmPersonalSharedRoom } = await import("./prewarm-shared-agent");

test("personal room prewarm warms each verified owner's global rate gate once per sweep", async () => {
  const owners = ["prewarm-owner-one", "prewarm-owner-one", "prewarm-owner-two"];
  const conversations: Array<{ agentId: string; roomId: string; startEmpty: boolean }> = [];
  const gates: Array<{ name: string; path: string }> = [];
  const namespace = {
    getByName() {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/prewarm");
          conversations.push((await request.json()) as (typeof conversations)[number]);
          return Response.json({ organizationId: owners[conversations.length - 1] });
        },
      };
    },
  };
  const warmedOrganizations = new Set<string>();
  await runWithCloudBindingsAsync(
    {
      INFERENCE_ADMISSION_GATES: {
        getByName(name: string) {
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const request = new Request(input, init);
              gates.push({ name, path: new URL(request.url).pathname });
              return Response.json({ warmed: true });
            },
          };
        },
      },
    },
    async () => {
      for (let index = 0; index < owners.length; index += 1) {
        await prewarmPersonalSharedRoom(
          `personal-agent-${index}`,
          `room-${index}`,
          namespace,
          warmedOrganizations,
        );
      }
    },
  );
  expect(conversations).toEqual(
    owners.map((_, index) => ({
      operation: "prewarm",
      agentId: `personal-agent-${index}`,
      roomId: `room-${index}`,
      startEmpty: true,
    })),
  );
  expect([...warmedOrganizations]).toEqual(["prewarm-owner-one", "prewarm-owner-two"]);
  expect(gates).toEqual([
    { name: "rate-limit:v2:prewarm-owner-one", path: "/rate-limit-warm" },
    { name: "rate-limit:v2:prewarm-owner-two", path: "/rate-limit-warm" },
  ]);
});

test("a personal room without a verified owner does not select an organization rate gate", async () => {
  let gateCalls = 0;
  const warmedOrganizations = new Set<string>();
  await runWithCloudBindingsAsync(
    {
      INFERENCE_ADMISSION_GATES: {
        getByName() {
          gateCalls += 1;
          throw new Error("An unowned room must not select an organization gate");
        },
      },
    },
    () =>
      prewarmPersonalSharedRoom(
        "unowned-personal-agent",
        "unowned-room",
        {
          getByName() {
            return {
              async fetch() {
                return Response.json({});
              },
            };
          },
        },
        warmedOrganizations,
      ),
  );
  expect(gateCalls).toBe(0);
  expect(warmedOrganizations.size).toBe(0);
});
