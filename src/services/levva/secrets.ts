import { eq } from "drizzle-orm";
import { isHex, sha256, toBytes } from "viem";
import { IAgentRuntime } from "@elizaos/core";
import { secretsTable } from "../../schema";
import { getDb } from "../../util/db";

export async function checkSecret(runtime: IAgentRuntime, secret: string) {
  if (!isHex(secret)) {
    throw new Error("Invalid secret");
  }

  const hash = sha256(toBytes(secret));
  const db = getDb(runtime);

  const [item] = await db
    .select()
    .from(secretsTable)
    .where(eq(secretsTable.hash, hash));

  if (!item) {
    throw new Error("Invalid secret");
  }

  return item;
}
