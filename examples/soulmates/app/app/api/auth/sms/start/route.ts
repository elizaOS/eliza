import { NextResponse } from "next/server";
import { badRequest, ok, parseBody, serverError } from "@/lib/api-utils";
import { generateRequestId, logger } from "@/lib/logger";
import { normalizePhone } from "@/lib/phone";
import { checkPhoneRateLimit, checkSmsRateLimit } from "@/lib/rate-limit";
import { startSmsVerification } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getClientIp = (request: Request): string =>
  request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
  request.headers.get("x-real-ip") ??
  "unknown";

const rateLimited = (seconds: number, msg: string) =>
  NextResponse.json(
    { ok: false, error: `${msg} Try again in ${seconds}s.` },
    { status: 429 },
  );

export async function POST(request: Request) {
  const reqId = generateRequestId();
  const ip = getClientIp(request);

  const ipLimit = await checkSmsRateLimit(ip);
  if (!ipLimit.allowed) {
    logger.warn("SMS rate limited by IP", { ip }, reqId);
    return rateLimited(ipLimit.resetInSeconds, "Too many requests.");
  }

  const body = await parseBody<{ phone?: string }>(request);
  const phone = normalizePhone(body?.phone ?? "");
  if (!phone) {
    logger.warn("SMS invalid phone", { rawPhone: body?.phone }, reqId);
    return badRequest("Enter a valid phone number.");
  }

  const phoneLimit = await checkPhoneRateLimit(phone);
  if (!phoneLimit.allowed) {
    logger.warn("SMS rate limited by phone", { phone }, reqId);
    return rateLimited(
      phoneLimit.resetInSeconds,
      "Too many requests for this number.",
    );
  }

  try {
    await startSmsVerification(phone);
    logger.info("SMS verification started", { phone }, reqId);
    return ok(null);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to send code.";
    logger.error("SMS verification failed", { phone, error: message }, reqId);
    return serverError(message);
  }
}
