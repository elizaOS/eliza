import {
  SolanaParsedInstruction,
  SolanaParsedTransaction,
} from "../helius";

function collectProgramIds(
  instructions: SolanaParsedInstruction[] | undefined,
  programIds: Set<string>,
): void {
  if (!Array.isArray(instructions)) {
    return;
  }

  for (const instruction of instructions) {
    if (typeof instruction.programId === "string") {
      programIds.add(instruction.programId);
    }

    collectProgramIds(instruction.innerInstructions, programIds);
  }
}

export function collectProgramIdsFromTransaction(
  transaction: SolanaParsedTransaction,
): Set<string> {
  const programIds = new Set<string>();

  collectProgramIds(transaction.instructions, programIds);

  return programIds;
}
