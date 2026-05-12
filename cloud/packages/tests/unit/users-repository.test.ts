import { describe, expect, test } from "bun:test";
import { UsersRepository, type UserWithOrganization } from "@/db/repositories/users";

type FakeUserRow = {
  id: string;
  email: string;
  organization_id: string;
  whatsapp_id: string;
  whatsapp_name: string;
};

type FakeOrganizationRow = {
  id: string;
  name: string;
};

type FakeDatabase = {
  execute: () => Promise<never>;
  select: (...args: unknown[]) => {
    from: () => {
      where: () => {
        limit: () => Promise<FakeUserRow[]>;
      };
    };
  };
  query: {
    users: {
      findFirst: (args: unknown) => Promise<{ organization: FakeOrganizationRow }>;
    };
  };
};

type FindUserWithOrganizationById = (
  this: UsersRepository,
  database: FakeDatabase,
  userId: string,
) => Promise<UserWithOrganization | undefined>;

describe("UsersRepository user lookup", () => {
  test("hydrates organizations from the canonical users row without schema probing", async () => {
    const repository = new UsersRepository();
    const findUserWithOrganizationById = Reflect.get(
      repository,
      "findUserWithOrganizationById",
    ) as FindUserWithOrganizationById;
    const selectCalls: unknown[][] = [];
    let organizationLookupArgs: unknown;
    let executeCalled = false;

    const fakeDatabase: FakeDatabase = {
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

    const user = await findUserWithOrganizationById.call(repository, fakeDatabase, "user-1");

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
