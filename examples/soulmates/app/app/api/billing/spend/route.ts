import { randomUUID } from "node:crypto";
import { badRequest, ok, unauthorized } from "@/lib/api-utils";
import { getSpendOption } from "@/lib/credits";
import { readEnv } from "@/lib/env";
import { requireSessionUser } from "@/lib/session";
import { spendCredits } from "@/lib/store";
import {
  type OutboundChannel,
  sendOutboundMessage,
} from "@/lib/twilio-messaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SpendRequest = {
  optionId?: string;
};

export async function POST(request: Request) {
  const user = await requireSessionUser();
  if (!user) return unauthorized();

  const body = (await request.json()) as SpendRequest | null;
  const option = getSpendOption(body?.optionId ?? "");
  if (!option) {
    return badRequest("Invalid spend option.");
  }

  const reference = `spend:${option.id}:${randomUUID()}`;
  const updated = await spendCredits(
    user.id,
    option.cost,
    option.reason,
    reference,
  );
  if (!updated) {
    return badRequest("Not enough credits.");
  }

  if (option.reason === "spend_insight") {
    const channel = (readEnv("SOULMATES_MATCHING_CHANNEL") ??
      "sms") as OutboundChannel;
    const name = user.name ?? "there";
    const location = user.location ?? "your community";
    const insight = `Insight for you, ${name}: consistency matters more than frequency. We'll prioritize matches in ${location} who show up and follow through.`;
    await sendOutboundMessage({ to: user.phone, body: insight, channel });
  }

  return ok(updated);
}
