/** Atomically removes Redis keys only while their value still names this owner. */
export interface OwnershipRedis {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export class RedisOwnershipError extends Error {
  readonly code = "REDIS_OWNERSHIP_CLEANUP_FAILED";
}

export class RedisPublicationError extends Error {
  readonly code = "REDIS_PUBLICATION_FAILED";
}

/** MULTI can resolve successfully while individual commands failed. */
export function requireRedisWriteReceipts(
  receipts: unknown,
  expected: number,
  context: string,
  failure: (message: string, cause?: unknown) => Error = (message, cause) =>
    new RedisPublicationError(message, { cause }),
): void {
  if (!Array.isArray(receipts) || receipts.length !== expected) {
    throw failure(`Redis ${context} transaction was not acknowledged`);
  }
  for (const receipt of receipts) {
    if (
      !Array.isArray(receipt) ||
      receipt.length !== 2 ||
      receipt[0] !== null ||
      receipt[1] !== "OK"
    ) {
      throw failure(
        `Redis ${context} command failed`,
        Array.isArray(receipt) ? receipt[0] : receipt,
      );
    }
  }
}

const REMOVE_OWNED_KEYS = `
local removed = 0
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    removed = removed + redis.call('DEL', key)
  end
end
return removed
`;

export async function removeOwnedRedisKeys(
  redis: OwnershipRedis,
  owner: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  const removed = await redis.eval(
    REMOVE_OWNED_KEYS,
    keys.length,
    ...keys,
    owner,
  );
  if (
    typeof removed !== "number" ||
    !Number.isInteger(removed) ||
    removed < 0 ||
    removed > keys.length
  ) {
    throw new RedisOwnershipError(
      "Redis ownership cleanup was not acknowledged",
    );
  }
}
