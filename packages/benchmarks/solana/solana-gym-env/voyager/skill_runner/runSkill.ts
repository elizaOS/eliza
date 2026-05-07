import path from "path";

type TupleSkillResult = [number, string, string | null];
type SkillExecutionResult = string | TupleSkillResult;

const DEFAULT_AGENT_PUBKEY = "11111111111111111111111111111111";
const DEFAULT_BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

function createSurfpoolEnv(agentPubkey?: string, latestBlockhash?: string) {
  let transactionCount = 0;
  const resolvedAgentPubkey = agentPubkey ?? DEFAULT_AGENT_PUBKEY;
  const resolvedBlockhash = latestBlockhash ?? DEFAULT_BLOCKHASH;

  return {
    wallet_balances: [2.5, 100.0, 0.0, 0.0, 0.0],
    simulateTransaction: async (
      success: boolean = true,
      protocol: string | null = null,
    ) => {
      transactionCount++;

      if (transactionCount > 1) {
        throw new Error(
          "SINGLE_TRANSACTION_LIMIT: Skills can only execute ONE transaction. " +
            "To perform multiple operations, create separate skills and chain them. " +
            "This transaction attempt was blocked.",
        );
      }

      return JSON.stringify({
        transaction: {
          message: {
            accountKeys: protocol ? [protocol] : [],
            instructions: protocol ? [{ programIdIndex: 0 }] : [],
          },
        },
        meta: {
          err: success ? null : { InstructionError: [0, { Custom: 1 }] },
          logMessages: ["Simulated transaction log"],
        },
      });
    },
    getWallet: () => ({
      balances: [2.5, 100.0, 0.0, 0.0, 0.0],
      publicKey: resolvedAgentPubkey,
    }),
    getRecentBlockhash: () => resolvedBlockhash,
    read: () => "some data",
    write: (_data: string) => {},
  };
}

function formatSuccess(result: SkillExecutionResult) {
  if (typeof result === "string") {
    return {
      success: true,
      reward: 0,
      reason: "serialized_tx",
      done_reason: "serialized_tx",
      tx_receipt_json_string: result,
      serialized_tx: result,
    };
  }

  if (Array.isArray(result) && result.length === 3) {
    const [reward, doneReason, txReceiptJsonString] = result;

    return {
      success: true,
      reward,
      reason: doneReason,
      done_reason: doneReason,
      tx_receipt_json_string: txReceiptJsonString,
      serialized_tx: txReceiptJsonString,
    };
  }

  throw new Error(
    "executeSkill must return either a serialized transaction string or [reward, reason, txReceipt].",
  );
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return {
      success: false,
      reward: 0,
      reason: error.message,
      done_reason: "error",
      error: error.message,
      tx_receipt_json_string: null,
      serialized_tx: null,
      details: error.stack ?? error.toString(),
      type: error.name,
    };
  }

  const message = String(error);
  return {
    success: false,
    reward: 0,
    reason: message,
    done_reason: "error",
    error: message,
    tx_receipt_json_string: null,
    serialized_tx: null,
    details: message,
    type: "UnknownError",
  };
}

async function runSkill(): Promise<void> {
  const [, , filePath, timeoutMsStr, agentPubkey, latestBlockhash] =
    process.argv;

  if (!filePath || !timeoutMsStr) {
    console.error(
      "Usage: bun runSkill.ts <file> <timeoutMs> [agentPubkey] [latestBlockhash]",
    );
    process.exit(1);
  }

  const timeoutMs = Number.parseInt(timeoutMsStr, 10);
  const absolutePath = path.resolve(filePath);

  try {
    const skillModule = await import(absolutePath);

    if (typeof skillModule.executeSkill !== "function") {
      throw new Error(
        "executeSkill function not found in the provided module.",
      );
    }

    const executionArg = latestBlockhash
      ? latestBlockhash
      : createSurfpoolEnv(agentPubkey, latestBlockhash);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const executionResult: SkillExecutionResult = await Promise.race([
        skillModule.executeSkill(executionArg),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("Skill execution timed out.")),
            timeoutMs,
          );
        }),
      ]);

      console.log(JSON.stringify(formatSuccess(executionResult)));
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  } catch (error) {
    console.error(error);
    console.log(JSON.stringify(formatError(error)));
    process.exit(1);
  }
}

runSkill();
