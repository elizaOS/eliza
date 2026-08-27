const apiBase = process.env.ELIZAOS_CLOUD_BASE_URL?.trim();
const bearer = process.env.ELIZAOS_CLOUD_API_KEY?.trim();

if (!apiBase || !bearer) {
  throw new Error("staging diagnostic requires protected API base and bearer");
}

const requestJson = async (url) => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    cache: "no-store",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.toLowerCase().includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  return { response, body, contentType };
};

const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const safeCode = (value) =>
  typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value)
    ? value
    : null;

const personalUrl = new URL("/api/v1/eliza/personal", apiBase).toString();
const personalResult = await requestJson(personalUrl);
const personalRoot = asRecord(personalResult.body);
const personalData = asRecord(personalRoot?.data);
const identity = asRecord(personalData?.identity);
const personalId =
  typeof identity?.id === "string" &&
  /^personal:[0-9a-f-]{36}$/i.test(identity.id)
    ? identity.id
    : null;

const receipt = {
  schema: "elizaos.staging-personal-readonly-diagnostic/v1",
  personal: {
    status: personalResult.response.status,
    json: personalResult.contentType.toLowerCase().includes("application/json"),
    success: personalRoot?.success === true,
    identityPresent: Boolean(identity),
    personalIdValid: Boolean(personalId),
    runtime:
      identity?.runtime === "shared" || identity?.runtime === "dedicated"
        ? identity.runtime
        : "unknown",
    activeAgentIdPresent:
      typeof identity?.activeAgentId === "string" &&
      identity.activeAgentId.length > 0,
    errorCode: safeCode(personalRoot?.error),
  },
  quote: null,
};

if (personalId) {
  const quoteUrl = new URL(
    `/api/v1/eliza/agents/${encodeURIComponent(personalId)}/upgrade-tier`,
    apiBase,
  ).toString();
  const quoteResult = await requestJson(quoteUrl);
  const quoteRoot = asRecord(quoteResult.body);
  const quote = asRecord(quoteRoot?.data);
  receipt.quote = {
    status: quoteResult.response.status,
    json: quoteResult.contentType.toLowerCase().includes("application/json"),
    success: quoteRoot?.success === true,
    quoteIdPresent:
      typeof quote?.quoteId === "string" && quote.quoteId.length > 0,
    canActivate:
      quote?.canActivate === true
        ? true
        : quote?.canActivate === false
          ? false
          : null,
    unavailableReasonPresent:
      typeof quote?.unavailableReason === "string" &&
      quote.unavailableReason.length > 0,
    errorCode: safeCode(quoteRoot?.error),
  };
}

console.log(JSON.stringify(receipt));

