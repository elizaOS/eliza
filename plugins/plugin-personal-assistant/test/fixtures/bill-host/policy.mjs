import { createHash } from "node:crypto";

const blocked = (reason) => ({ kind: "blocked", reason });
function mismatch(bill, snapshot, name, expected, observed) {
  const source = new URL(snapshot.url);
  source.search = "";
  source.hash = "";
  if (
    ![expected, observed].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 300,
    )
  )
    return blocked(`The ${name.toLowerCase()} cannot be compared safely.`);
  return {
    ...blocked(
      `The website ${name.toLowerCase()} does not match the source bill. Check both sources before continuing.`,
    ),
    conflict: {
      field: name,
      expected,
      observed,
      billSource: bill.sourceRef,
      websiteSource: source.href,
    },
  };
}
function field(text, label, optional = false) {
  const values = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${label}:`))
    .map((line) => line.slice(label.length + 1).trim());
  if (values.length !== 1 || !values[0]) {
    if (optional && values.length === 0) return null;
    throw new Error(`The page does not show one clear ${label.toLowerCase()}.`);
  }
  return values[0];
}
function money(value, currency, digits) {
  const parts = value.split(" ");
  if (
    parts.length !== 2 ||
    parts[0] !== currency ||
    !Number.isSafeInteger(digits) ||
    digits < 0 ||
    digits > 4
  )
    throw new Error("The currency cannot be matched.");
  const pattern = new RegExp(
    `^([0-9]+)${digits ? `(?:\\.([0-9]{${digits}}))?` : ""}$`,
  );
  const match = pattern.exec(parts[1]);
  if (!match) throw new Error("The page amount is not unambiguous.");
  const result = Number(match[1]) * 10 ** digits + Number(match[2] || 0);
  if (!Number.isSafeInteger(result))
    throw new Error("The page amount is outside the supported range.");
  return result;
}
function date(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("The payment date is unclear.");
  return value;
}

/** Reviewed controlled-biller text contract. This is not a generic web-page extractor. */
export function deriveBillDecision(bill, snapshot) {
  try {
    if (
      !bill ||
      typeof bill.sourceRef !== "string" ||
      !bill.sourceRef ||
      !Number.isSafeInteger(bill.amountMinor) ||
      bill.amountMinor < 0
    )
      throw new Error("A verified source bill is required.");
    if (
      new URL(bill.origin).protocol !== "https:" ||
      new URL(bill.origin).origin !== bill.origin ||
      new URL(snapshot.url).origin !== bill.origin
    )
      return blocked("This is not the verified biller website.");
    const text = snapshot.text;
    if (
      typeof text !== "string" ||
      field(text, "Environment") !== "Controlled test biller"
    )
      return blocked("This page has no supported biller observation contract.");
    if (field(text, "Company") !== bill.company)
      return mismatch(
        bill,
        snapshot,
        "Company",
        bill.company,
        field(text, "Company"),
      );
    const session = field(text, "Session");
    if (session === "Signed out") {
      const problem = field(text, "Sign-in problem", true);
      if (problem === "Wrong password")
        return {
          kind: "human-sign-in",
          message:
            "The website rejected the password. Correct it on the website yourself, or close this task. Eliza cannot see or enter your password.",
        };
      if (problem === "CAPTCHA")
        return {
          kind: "human-sign-in",
          message:
            "The website requires a human check. Complete it on the website yourself, or close this task. Eliza will not bypass it.",
        };
      if (problem && problem !== "None")
        return {
          kind: "human-sign-in",
          message:
            "Sign-in needs your attention on the website. You can continue there or close this task.",
        };
      return {
        kind: "human-sign-in",
        message: "Sign in on the website. Enter the test password yourself.",
      };
    }
    if (session !== "Signed in") return blocked("Sign-in status is unclear.");
    const verification = field(text, "Verification");
    if (verification === "Required")
      return {
        kind: "human-verification",
        message: "Complete verification on the website yourself.",
      };
    if (!["Complete", "Not required"].includes(verification))
      return blocked("Verification status is unclear.");
    if (field(text, "Account") !== bill.accountLabel)
      return mismatch(
        bill,
        snapshot,
        "Account",
        bill.accountLabel,
        field(text, "Account"),
      );
    if (
      bill.serviceAddress != null &&
      (typeof bill.serviceAddress !== "string" ||
        !bill.serviceAddress.trim() ||
        bill.serviceAddress.length > 300)
    )
      return blocked("The source bill service address is unclear.");
    const serviceAddress = field(text, "Service address", true);
    if (
      bill.serviceAddress != null &&
      serviceAddress != null &&
      serviceAddress !== bill.serviceAddress
    )
      return mismatch(
        bill,
        snapshot,
        "Service address",
        bill.serviceAddress,
        serviceAddress,
      );
    if (
      money(field(text, "Bill amount"), bill.currency, bill.currencyDigits) !==
      bill.amountMinor
    )
      return mismatch(
        bill,
        snapshot,
        "Bill amount",
        `${bill.currency} ${(bill.amountMinor / 10 ** bill.currencyDigits).toFixed(bill.currencyDigits)}`,
        field(text, "Bill amount"),
      );
    const paymentStatus = field(text, "Payment status");
    if (["Paid", "Scheduled"].includes(paymentStatus)) {
      const reference = field(text, "Confirmation");
      if (reference.length > 128)
        return blocked("The confirmation reference is unclear.");
      // Missing receipt details do not erase an observed provider status.
      // These fields are read from this outcome page, never copied from a prior review.
      let totalMinor = null,
        paymentDate = null;
      try {
        totalMinor = money(
          field(text, "Total"),
          bill.currency,
          bill.currencyDigits,
        );
      } catch {}
      try {
        paymentDate = date(field(text, "Payment date"));
      } catch {}
      const source = new URL(snapshot.url);
      source.search = "";
      source.hash = "";
      return {
        kind: "outcome",
        status: paymentStatus.toLowerCase(),
        reference,
        source: source.href,
        billSource: bill.sourceRef,
        totalMinor,
        paymentDate,
        currency: bill.currency,
        currencyDigits: bill.currencyDigits,
      };
    }
    if (paymentStatus === "Processing") {
      const source = new URL(snapshot.url);
      source.search = "";
      source.hash = "";
      return {
        kind: "submission-pending",
        source: source.href,
        billSource: bill.sourceRef,
        message: `Submitted; waiting for ${bill.company}. Check the website for its result. Do not submit another payment.`,
      };
    }
    if (paymentStatus !== "Unpaid")
      return blocked(
        "Payment status is unclear. Do not prepare another payment.",
      );
    const autopay = field(text, "Autopay");
    if (autopay === "On")
      return {
        kind: "human-review",
        message:
          "Autopay is active. Check the scheduled payment before preparing anything else.",
      };
    if (autopay !== "Off") return blocked("Autopay status is unclear.");
    const method = field(text, "Existing method");
    if (method === "None")
      return {
        kind: "human-review",
        message:
          "This website has no saved payment method. Complete payment manually on the website, or use a supported test account with an existing method. Eliza will not add or store a payment method.",
      };
    if (["Unavailable", "Unknown", "Multiple"].includes(method))
      return {
        kind: "human-review",
        message:
          "The existing payment method is unclear. Check the saved methods on the website yourself before continuing. Eliza will not choose or add a method for you.",
      };
    if (/(?:[0-9][ -]?){12,}/.test(method))
      return blocked("The page does not provide a masked payment method.");
    const feeMinor = money(
      field(text, "Fee"),
      bill.currency,
      bill.currencyDigits,
    );
    const totalMinor = money(
      field(text, "Total"),
      bill.currency,
      bill.currencyDigits,
    );
    if (
      !Number.isSafeInteger(bill.amountMinor + feeMinor) ||
      totalMinor !== bill.amountMinor + feeMinor
    )
      return blocked("The review total does not match the bill and fee.");
    const paymentDate = date(field(text, "Payment date"));
    const period = field(text, "Service period", true);
    const selected = field(text, "Method selected");
    if (!["Yes", "No"].includes(selected))
      return blocked("The selected payment method is unclear.");
    const review = {
      serviceAddress,
      company: bill.company,
      accountLabel: bill.accountLabel,
      amountMinor: bill.amountMinor,
      currency: bill.currency,
      currencyDigits: bill.currencyDigits,
      feeMinor,
      totalMinor,
      paymentDate,
      method,
      servicePeriod: period,
      source: snapshot.url,
      billSource: bill.sourceRef,
    };
    const reviewKey = createHash("sha256")
      .update(JSON.stringify(review))
      .digest("hex");
    return selected === "Yes"
      ? {
          kind: "human-submit",
          review,
          reviewKey,
          message:
            "Review the amount, fee, date and method. Only you can press Pay on the test website.",
        }
      : { kind: "choose-existing-method", review, reviewKey };
  } catch (error) {
    return blocked(
      error instanceof Error
        ? error.message
        : "The page cannot be matched to the bill.",
    );
  }
}

export const controls = {
  signIn: { label: "Sign in (test)" },
  verification: { label: "Verify (test)" },
  submit: { label: "Pay (test)" },
  existingMethod: { selector: "#method", label: "Use existing method" },
};

const unavailable = () => new Error("Unsupported synthetic bill fixture");
/** Controlled test bill text only. Real providers need a reviewed parser or document extractor. */
export function parseControlledBillMessage(detail) {
  if (
    typeof detail?.bodyText !== "string" ||
    !detail.bodyText.startsWith("Controlled test bill\n")
  )
    return null;
  const fields = new Map();
  for (const line of detail.bodyText.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw unavailable();
    const key = line.slice(0, colon),
      value = line.slice(colon + 1).trim();
    if (fields.has(key)) throw unavailable();
    fields.set(key, value);
  }
  const amount = fields
    .get("Amount")
    ?.match(/^([A-Z]{3}) ([0-9]+)(?:\.([0-9]{1,4}))?$/);
  if (!amount) throw unavailable();
  const digits = (amount[3] || "").length;
  const parsed = {
    invoiceId: fields.get("Invoice"),
    company: fields.get("Company"),
    origin: fields.get("Website"),
    accountLabel: fields.get("Account"),
    amountMinor: Number(amount[2]) * 10 ** digits + Number(amount[3] || 0),
    currency: amount[1],
    currencyDigits: digits,
    dueDate: fields.get("Due date"),
  };
  if (fields.has("Service address"))
    parsed.serviceAddress = fields.get("Service address");
  if (fields.has("Service starts") || fields.has("Service ends"))
    parsed.servicePeriod = {
      startsOn: fields.get("Service starts"),
      endsOn: fields.get("Service ends"),
    };
  return parsed;
}

/** Reviewed synthetic bill format only. Unrecognized PDF text cannot be treated as no bill. */
export function parseControlledPdfBill(document) {
  const text = document.pages
    .map((page) =>
      page.visionText
        .split("\n")
        .filter(
          (line) =>
            !/^Test fixture - page [1-9][0-9]* of [1-9][0-9]*$/.test(line),
        )
        .join("\n"),
    )
    .join("\n");
  const bill = parseControlledBillMessage({ bodyText: text });
  if (!bill) throw unavailable();
  return bill;
}
