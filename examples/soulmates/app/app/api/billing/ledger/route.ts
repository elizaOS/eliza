import { ok, unauthorized } from "@/lib/api-utils";
import { requireSessionUser } from "@/lib/session";
import { listCreditLedger } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireSessionUser();
  if (!user) return unauthorized();
  const ledger = await listCreditLedger(user.id);
  return ok(ledger);
}
