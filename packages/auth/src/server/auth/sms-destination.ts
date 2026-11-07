/**
 * SMS destination policy — the deployment-wide guard against SMS pumping
 * (toll fraud). Pumping farms trigger OTP sends to premium-rate numbers in
 * countries the product never serves; per-IP and per-destination limits do not
 * stop them because they rotate both. This policy runs inside PhoneAuth.sendOtp,
 * so every send path (login, WhatsApp, MFA enrollment/challenge, account link)
 * is covered regardless of tenant configuration.
 *
 * STEWARD_SMS_ALLOWED_COUNTRY_CODES — comma-separated calling-code prefixes
 * (digits, no "+"). Default "1". "*" disables the policy. The bare "1" entry
 * means US + Canada (and US territories): +1 numbers in the other NANP
 * countries (Caribbean, Bermuda) and non-geographic +1 codes (toll-free,
 * premium 900, personal 5XX) are refused unless their own longer prefix is
 * listed, e.g. "1,1876" also allows Jamaica.
 */

/** Errors a caller maps to a client response; no provider call was made. */
export class SmsDestinationNotAllowedError extends Error {
  constructor() {
    super("SMS is not available for this phone number");
    this.name = "SmsDestinationNotAllowedError";
  }
}

export class SmsSendBudgetExceededError extends Error {
  constructor(readonly retryAfterSecs = 60) {
    super("SMS verification is temporarily unavailable");
    this.name = "SmsSendBudgetExceededError";
  }
}

/**
 * NANP area codes that are not US/Canada geographic numbers: the other NANP
 * countries (Caribbean, Atlantic — classic pumping destinations), then the
 * non-geographic codes (personal communications, toll-free, premium).
 */
const NANP_NOT_US_CA = new Set(
  (
    "242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876 " +
    "500 521 522 523 524 525 526 527 528 529 532 533 535 538 542 543 544 545 546 547 549 " +
    "550 552 553 554 556 566 569 577 578 588 589 600 622 700 710 800 833 844 855 866 877 888 900"
  ).split(" "),
);

function isUsOrCanadaNumber(digits: string): boolean {
  if (digits.length !== 11 || !digits.startsWith("1")) return false;
  const area = digits.slice(1, 4);
  const exchange = digits.slice(4, 7);
  return (
    /^[2-9]\d\d$/.test(area) &&
    /^[2-9]\d\d$/.test(exchange) &&
    !NANP_NOT_US_CA.has(area) &&
    !/^[2-9]11$/.test(area) &&
    !/^[2-9]9\d$/.test(area) &&
    !/^(37|96)\d$/.test(area)
  );
}

export function parseAllowedSmsCountryCodes(
  raw: string | undefined,
): string[] | "*" {
  const value = raw?.trim();
  if (!value) return ["1"];
  if (value === "*") return "*";
  const codes = value
    .split(",")
    .map((entry) => entry.trim().replace(/^\+/, ""))
    .filter((entry) => /^\d{1,7}$/.test(entry));
  // A malformed value must not silently open every country.
  return codes.length ? codes : ["1"];
}

/** True when an E.164 number may receive an OTP under the deployment policy. */
export function isSmsDestinationAllowed(
  phone: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const allowed = parseAllowedSmsCountryCodes(
    env.STEWARD_SMS_ALLOWED_COUNTRY_CODES,
  );
  if (allowed === "*") return true;
  const digits = phone.replace(/^\+/, "");
  return allowed.some((code) =>
    code === "1" ? isUsOrCanadaNumber(digits) : digits.startsWith(code),
  );
}

/** Deployment-wide OTP send ceiling per hour. 0 disables the ceiling. */
export function smsSendGlobalMaxPerHour(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR?.trim();
  if (!raw) return 300;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 300;
}
