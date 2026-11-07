import { BillHostError } from "./errors.mjs";

const invalid = () =>
  new BillHostError("Bill extraction profile or source is unavailable");
const required = ["invoiceId", "company", "origin", "accountLabel", "amount"];
// Some bills (for example autopay notices) carry no due date.
const optional = ["dueDate", "serviceAddress", "serviceStarts", "serviceEnds"];
const bounded = (v, max) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Reviewed product mapping, never supplied by a message, model, or renderer. */
export function validateBillExtractionProfile(input) {
  const p = structuredClone(input);
  if (
    !p ||
    Object.keys(p).sort().join(",") !==
      "currency,currencyDigits,dateFormat,fields,kind,schemaVersion" ||
    p.schemaVersion !== 1 ||
    p.kind !== "labelled-invoice-v1" ||
    !["iso", "us"].includes(p.dateFormat) ||
    !/^[A-Z]{3}$/.test(p.currency) ||
    !Number.isInteger(p.currencyDigits) ||
    p.currencyDigits < 0 ||
    p.currencyDigits > 4 ||
    !p.fields ||
    Array.isArray(p.fields)
  )
    throw invalid();
  const labels = new Set();
  for (const name of required)
    if (!Object.hasOwn(p.fields, name)) throw invalid();
  for (const [name, label] of Object.entries(p.fields)) {
    if (
      ![...required, ...optional].includes(name) ||
      !bounded(label, 120) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in provider and host data.
      /[\r\n\u0000-\u001f]/.test(label) ||
      labels.has(label.trim())
    )
      throw invalid();
    labels.add(label.trim());
  }
  if (
    Object.hasOwn(p.fields, "serviceStarts") !==
    Object.hasOwn(p.fields, "serviceEnds")
  )
    throw invalid();
  // Prefix-overlap makes one source line look like two different fields.
  for (const a of labels)
    for (const b of labels)
      if (a !== b && (a.startsWith(b) || b.startsWith(a))) throw invalid();
  return Object.freeze({ ...p, fields: Object.freeze(p.fields) });
}
function calendarDate(raw, format) {
  let iso = raw;
  if (format === "us") {
    const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) throw invalid();
    iso = `${match[3]}-${match[1]}-${match[2]}`;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
    !Number.isFinite(Date.parse(iso)) ||
    new Date(iso).toISOString().slice(0, 10) !== iso
  )
    throw invalid();
  return iso;
}
function amountMinor(raw, digits) {
  // No rounding, floating-point parsing, signs, currency guessing or locale guessing.
  const match = raw.match(/^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) !== digits) throw invalid();
  const value =
    BigInt(match[1].replaceAll(",", "")) * 10n ** BigInt(digits) +
    BigInt(match[2] ?? "0");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
}

/** All required fields must be explicitly present; repeated conflicts reject. */
export function createLabelledBillExtractor(profile) {
  const p = validateBillExtractionProfile(profile);
  const parseText = (text, { allowPartial = false, context } = {}) => {
    if (typeof text !== "string" || text.length > 200000 || text.includes("\0"))
      throw invalid();
    const values = new Map();
    let recognized = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      for (const [name, label] of Object.entries(p.fields)) {
        if (!line.startsWith(label)) continue;
        recognized = true;
        const value = line.slice(label.length).trim();
        if (!bounded(value, name === "invoiceId" ? 128 : 300)) throw invalid();
        if (values.has(name) && values.get(name) !== value) throw invalid();
        values.set(name, value);
      }
    }
    if (!recognized) return null;
    if (required.some((name) => !values.has(name))) {
      // A cover email can contain only account/header fields while its PDF is the bill.
      // Preserve any observed identity mismatch instead of silently dropping it.
      if (
        !allowPartial ||
        !context ||
        [...values.keys()].some(
          (key) => !["company", "accountLabel", "origin"].includes(key),
        )
      )
        throw invalid();
      for (const [field, expected] of Object.entries({
        company: context.company,
        accountLabel: context.accountLabel,
        origin: context.providerOrigin,
      }))
        if (values.has(field) && values.get(field) !== expected)
          throw invalid();
      return null;
    }
    const origin = values.get("origin");
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw invalid();
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      throw invalid();
    const bill = {
      invoiceId: values.get("invoiceId"),
      company: values.get("company"),
      origin,
      accountLabel: values.get("accountLabel"),
      amountMinor: amountMinor(values.get("amount"), p.currencyDigits),
      currency: p.currency,
      currencyDigits: p.currencyDigits,
    };
    if (values.has("dueDate"))
      bill.dueDate = calendarDate(values.get("dueDate"), p.dateFormat);
    if (values.has("serviceAddress"))
      bill.serviceAddress = values.get("serviceAddress");
    if (values.has("serviceStarts") || values.has("serviceEnds")) {
      if (!values.has("serviceStarts") || !values.has("serviceEnds"))
        throw invalid();
      bill.servicePeriod = {
        startsOn: calendarDate(values.get("serviceStarts"), p.dateFormat),
        endsOn: calendarDate(values.get("serviceEnds"), p.dateFormat),
      };
      if (bill.servicePeriod.startsOn > bill.servicePeriod.endsOn)
        throw invalid();
    }
    return bill;
  };
  return Object.freeze({
    parseMessage: (detail, context) =>
      parseText(detail?.bodyText, {
        allowPartial:
          Array.isArray(detail?.attachments) &&
          detail.attachments.some(
            (file) => file.mimeType === "application/pdf",
          ),
        context,
      }),
    parseDocument: (document) => {
      if (
        document?.complete !== true ||
        !Array.isArray(document.pages) ||
        document.pages.length !== document.pageCount
      )
        throw invalid();
      const text = document.pages
        .map((page, index) => {
          if (
            page.pageNumber !== index + 1 ||
            typeof page.visionText !== "string"
          )
            throw invalid();
          return page.visionText;
        })
        .join("\n");
      const bill = parseText(text);
      if (!bill) throw invalid();
      return bill;
    },
  });
}
