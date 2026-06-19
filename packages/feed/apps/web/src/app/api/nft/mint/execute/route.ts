import { withErrorHandling } from "@feed/api";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

type MintStep =
  | "auth"
  | "user_context"
  | "prepare"
  | "send_transaction"
  | "confirm";

type MintNftResult = {
  status: "error";
  error: string;
  step: MintStep;
  errorId: string;
};

export const POST = withErrorHandling(async (request: NextRequest) => {
  void request;

  const errorId = crypto.randomUUID();
  return NextResponse.json(
    {
      status: "error",
      error: "NFT minting is currently disabled.",
      step: "prepare",
      errorId,
    } satisfies MintNftResult,
    { status: 410 },
  );
});
