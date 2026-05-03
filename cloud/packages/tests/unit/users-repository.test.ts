import { describe, expect, test } from "bun:test";
import { UsersRepository } from "@/db/repositories/users";

describe("UsersRepository user lookup", () => {
  test("hydrates organizations from the canonical users row without schema probing", async () => {
    const repository = new UsersRepository() as any;
    const selectCalls: unknown[][] = [];
    let organizationLookupArgs: unknown;
    let executeCalled = false;

    const fakeDatabase = {
      execute: async () => {
        executeCalled = true;
        throw new Error("schema probes should not run");
      },
      select: (...args: unknown[]) => {
        selectCalls.push(args);
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  id: "user-1",
                  email: "lifeops@example.com",
                  organization_id: "org-1",
                  whatsapp_id: "wa-1",
                  whatsapp_name: "Ada",
                },
              ],
            }),
          }),
        };
      },
      query: {
        users: {
          findFirst: async (args: unknown) => {
            organizationLookupArgs = args;
            return {
              organization: {
                id: "org-1",
                name: "LifeOps",
              },
            };
          },
        },
      },
    };

    const user = await repository.findUserWithOrganizationById(fakeDatabase, "user-1");

    expect(executeCalled).toBe(false);
    expect(selectCalls).toEqual([[]]);
    expect(user).toMatchObject({
      id: "user-1",
      organization: { id: "org-1", name: "LifeOps" },
      whatsapp_id: "wa-1",
      whatsapp_name: "Ada",
    });
    expect(organizationLookupArgs).toMatchObject({
      columns: { id: true },
      with: { organization: true },
    });
  });
});
