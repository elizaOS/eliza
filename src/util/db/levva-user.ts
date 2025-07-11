import { eq } from "drizzle-orm";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { getDb } from "./client";
import { levvaUserTable } from "../../schema/levva-user";
import { getAddress } from "viem";

// todo move to services/levva

interface GetUserParams {
  address?: `0x${string}`;
  id?: UUID;
}

export const getLevvaUser = async (
  runtime: IAgentRuntime,
  params: GetUserParams
) => {
  const db = getDb(runtime);

  if (params.address) {
    const address = getAddress(params.address);

    return await db
      .select()
      .from(levvaUserTable)
      .where(eq(levvaUserTable.address, address));
  } else if (params.id) {
    return await db
      .select()
      .from(levvaUserTable)
      .where(eq(levvaUserTable.id, params.id));
  }

  throw new Error("No address or id provided");
};

export const createLevvaUser = async (
  runtime: IAgentRuntime,
  params: { address: `0x${string}` }
) => {
  const address = getAddress(params.address);
  const db = getDb(runtime);

  const result = await db
    .insert(levvaUserTable)
    .values({ address })
    .returning();

  return result[0];
};
