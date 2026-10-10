import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createDocumentImageDescriber } from "./document-image-describer.mjs";
import { NativeCloudServiceError } from "./errors.mjs";
import { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";
import { executePlanChange, validatePlanChangeInput } from "./plan-change.mjs";
import { projectRenewalReview } from "./subscription-review.mjs";
import { createSpeechStreamSessions } from "./timed-speech.mjs";

const fail = (message, status = 400) =>
  new NativeCloudServiceError(message, { status });
// Renderer-safe invoice facts. Merchant metadata and provider identifiers stay private.
function invoiceProjection(value, id) {
  if (
    !value ||
    value.id !== id ||
    !["draft", "open", "paid", "void", "uncollectible"].includes(value.status)
  )
    throw fail("Invoice details are unavailable.", 502);
  const currency =
    typeof value.currency === "string" ? value.currency.toUpperCase() : "";
  if (!Intl.supportedValuesOf("currency").includes(currency))
    throw fail("Invoice currency is unavailable.", 502);
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  const amount = (input) => {
    // Legacy APIs return binary floating-point values. Above this conservative
    // ceiling adjacent decimal minor units may round to the same number before
    // this projection receives them. Decimal strings retain the full safe-unit
    // range checked below; do not present a guessed cent from a large number.
    if (
      typeof input === "number" &&
      digits > 0 &&
      input > Number.MAX_SAFE_INTEGER / (2 * 10 ** digits)
    )
      throw fail("Invoice numeric amount exceeds exact precision.", 502);
    const source =
      typeof input === "number" && Number.isFinite(input)
        ? String(input)
        : input;
    if (
      typeof source !== "string" ||
      !/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$/.test(source)
    )
      throw fail("Invoice amount is unavailable.", 502);
    const [whole, fraction = ""] = source.split(".");
    if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits)))
      throw fail("Invoice amount has unsupported precision.", 502);
    const units =
      BigInt(whole) * 10n ** BigInt(digits) +
      BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
    if (units > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail("Invoice amount is too large.", 502);
    return digits
      ? `${whole}.${fraction.slice(0, digits).padEnd(digits, "0")}`
      : whole;
  };
  const date = (input, required = false) => {
    if (input == null && !required) return null;
    if (
      typeof input !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input) ||
      !Number.isFinite(Date.parse(input)) ||
      new Date(input).toISOString().slice(0, 19) !== input.slice(0, 19)
    )
      throw fail("Invoice date is unavailable.", 502);
    return new Date(input).toISOString();
  };
  const invoiceNumber =
    value.invoiceNumber == null ? null : value.invoiceNumber;
  if (
    invoiceNumber !== null &&
    (typeof invoiceNumber !== "string" ||
      !invoiceNumber.trim() ||
      invoiceNumber.length > 128 ||
      [...invoiceNumber].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ))
  )
    throw fail("Invoice number is unavailable.", 502);
  let merchantUrl = null;
  if (
    typeof value.hostedInvoiceUrl === "string" &&
    value.hostedInvoiceUrl.length <= 4096
  ) {
    try {
      const u = new URL(value.hostedInvoiceUrl);
      if (
        u.origin === "https://invoice.stripe.com" &&
        u.pathname.startsWith("/i/") &&
        !u.username &&
        !u.password &&
        !u.hash
      )
        merchantUrl = u.href;
    } catch {}
  }
  let pdfUrl = null;
  if (typeof value.invoicePdf === "string" && value.invoicePdf.length <= 4096) {
    try {
      const u = new URL(value.invoicePdf);
      if (
        u.origin === "https://pay.stripe.com" &&
        /^\/invoice\/acct_[A-Za-z0-9]+\/[A-Za-z0-9_-]+\/pdf$/.test(
          u.pathname,
        ) &&
        !u.username &&
        !u.password &&
        !u.hash
      )
        pdfUrl = u.href;
    } catch {}
  }
  const amountDue = amount(value.amountDue),
    amountPaid = amount(value.amountPaid);
  // Only the supported paid USD auto-top-up receipt, bound to this invoice.
  // Missing/malformed optional lines must not hide otherwise valid invoice facts.
  let chargeBreakdown = null;
  const breakdown = value.chargeBreakdown;
  if (
    value.invoiceType === "auto_top_up" &&
    value.status === "paid" &&
    currency === "USD" &&
    breakdown &&
    typeof breakdown === "object" &&
    !Array.isArray(breakdown)
  ) {
    const keys = [
      "creditedBaseUsd",
      "affiliateMarkupUsd",
      "platformFeeUsd",
      "totalChargeUsd",
    ];
    const cents = keys.map((key) => {
      const v = breakdown[key];
      if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,13})\.[0-9]{2}$/.test(v))
        return null;
      const n = BigInt(v.replace(".", ""));
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : null;
    });
    if (
      cents.every((n) => n !== null) &&
      cents[0] + cents[1] + cents[2] === cents[3] &&
      breakdown.totalChargeUsd === amountPaid &&
      amountPaid === amountDue
    ) {
      chargeBreakdown = Object.fromEntries(
        keys.map((key) => [key, breakdown[key]]),
      );
    }
  }
  return {
    id,
    invoiceNumber,
    status: value.status,
    currency,
    amountDue,
    amountPaid,
    createdAt: date(value.createdAt, true),
    dueDate: date(value.dueDate),
    paidAt: date(value.paidAt),
    merchantUrl,
    pdfUrl,
    chargeBreakdown,
  };
}

const googleGrantId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const googleScopes = (value) =>
  Array.isArray(value)
    ? value.filter(
        (scope) =>
          typeof scope === "string" &&
          /^(?:https:\/\/www\.googleapis\.com\/auth\/[a-z.]{1,64}|https:\/\/mail\.google\.com\/|openid|email|profile)$/.test(
            scope,
          ),
      )
    : [];
// The Cloud Gmail search and read routes need one of these scopes.
const gmailBodyRead = (scopes) =>
  [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ].some((scope) => scopes.includes(scope));
/**
 * Typed task-read failure. `code` is one fixed reason; no provider text.
 * reauth_required: the Google connection must be reconnected.
 * cloud_sign_in_required: Eliza Cloud refused the saved sign-in itself.
 */
const googleReadFailure = (code) =>
  new NativeCloudServiceError(`Google task read failed (${code})`, {
    status:
      {
        reauth_required: 401,
        cloud_sign_in_required: 401,
        insufficient_scope: 403,
        account_changed: 409,
        timeout: 504,
      }[code] ?? 503,
    code,
  });
const CHECKOUT_SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]+$/;
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function bytes(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fail("Request too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req, maximum = 65536) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw fail("JSON required", 415);
  try {
    const value = JSON.parse((await bytes(req, maximum)).toString());
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw fail("JSON object required");
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw fail("Invalid JSON");
  }
}
function origin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw fail("Cloud origin must be HTTPS");
  return url.origin;
}
function allowedQuery(url, fields) {
  if (
    [...url.searchParams.keys()].some((key) => !fields.includes(key)) ||
    fields.some((key) => url.searchParams.getAll(key).length > 1)
  )
    throw fail("Unexpected query parameters");
}
/** Only the fields the app needs; card data never passes through the gateway. */
export function projectCheckout(data, presentation, forget) {
  if (!data || typeof data !== "object")
    throw fail("Invalid payment response", 502);
  const status = ["open", "completed", "expired", "stale_intent"].includes(
    data.status,
  )
    ? data.status
    : null;
  if (!status) throw fail("Invalid payment response", 502);
  if (status === "expired" || status === "stale_intent") {
    forget();
    return { status };
  }
  if (status === "completed") return { status };
  if (presentation === "embedded") {
    if (
      data.uiMode !== "embedded" ||
      !Number.isSafeInteger(data.amountDueCents) ||
      data.amountDueCents < 0 ||
      data.currency !== "usd" ||
      data.interval !== "month" ||
      typeof data.sessionId !== "string" ||
      !CHECKOUT_SESSION_ID.test(data.sessionId) ||
      typeof data.clientSecret !== "string" ||
      !/^cs_(live|test)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(
        data.clientSecret,
      ) ||
      typeof data.publishableKey !== "string" ||
      !/^pk_(live|test)_[A-Za-z0-9]+$/.test(data.publishableKey)
    )
      throw fail("Invalid payment response", 502);
    return {
      status,
      uiMode: data.uiMode,
      // Native confirmation reconciles this session; payment is never inferred from the form.
      sessionId: data.sessionId,
      clientSecret: data.clientSecret,
      publishableKey: data.publishableKey,
      amountDueCents: data.amountDueCents,
      currency: data.currency,
      interval: data.interval,
    };
  }
  let url;
  try {
    url = new URL(data.checkoutUrl);
  } catch {
    throw fail("Invalid payment link", 502);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "checkout.stripe.com" ||
    url.username ||
    url.password
  )
    throw fail("Invalid payment link", 502);
  return {
    status,
    checkoutUrl: url.href,
    ...(Number.isFinite(Date.parse(data.expiresAt))
      ? { expiresAt: data.expiresAt }
      : {}),
  };
}
/** Narrow management review; the server remains the mutation authority. */
export function projectSubscriptionManagement(
  envelope,
  planKeys,
  now = Date.now(),
) {
  const invalid = () => {
    throw fail("Subscription management is unavailable", 502);
  };
  const v = envelope?.data?.v2;
  const observed = Date.parse(v?.snapshotCompletedAt);
  if (
    envelope?.success !== true ||
    !Number.isFinite(observed) ||
    observed > now + 300000 ||
    now - observed > 60000
  )
    return invalid();
  const block = v.subscription;
  if (
    block?.status === "not_applicable" &&
    block.reason === "no_organization_subscription"
  )
    return { status: "not_applicable", observedAt: v.snapshotCompletedAt };
  if (block?.status !== "available") return invalid();
  const sub = block.value,
    control = sub?.cancellationControl;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const blockers = [
    "interactive_session_required",
    "billing_account_ineligible",
    "owner_or_admin_role_required",
    "subscription_state_unsupported",
  ];
  const periodEnd = Date.parse(sub?.currentPeriodEnd);
  if (
    !sub ||
    typeof sub.subscriptionId !== "string" ||
    !uuid.test(sub.subscriptionId) ||
    !planKeys.includes(sub.planKey) ||
    !(
      sub.pendingPlanKey === null ||
      (planKeys.includes(sub.pendingPlanKey) &&
        sub.pendingPlanKey !== sub.planKey)
    ) ||
    ![
      "pending",
      "incomplete",
      "active",
      "grace",
      "past_due",
      "unpaid",
      "canceled",
      "incomplete_expired",
    ].includes(sub.state) ||
    !Number.isFinite(periodEnd) ||
    typeof sub.cancelAtPeriodEnd !== "boolean" ||
    !control ||
    control.subscriptionId !== sub.subscriptionId ||
    control.action !== (sub.cancelAtPeriodEnd ? "undo" : "cancel") ||
    control.method !== "POST" ||
    control.endpoint !==
      `/api/v1/subscriptions/cancel${control.action === "undo" ? "/undo" : ""}` ||
    !Number.isSafeInteger(control.expectedSubscriptionRevision) ||
    control.expectedSubscriptionRevision <= 0 ||
    !Array.isArray(control.blockers) ||
    control.blockers.some((x) => !blockers.includes(x)) ||
    new Set(control.blockers).size !== control.blockers.length ||
    control.eligible !== (control.blockers.length === 0) ||
    (control.eligible &&
      (sub.state !== "active" ||
        periodEnd <= now ||
        sub.dunningStartedAt !== null ||
        sub.graceExpiresAt !== null))
  )
    return invalid();
  return {
    status: "available",
    observedAt: v.snapshotCompletedAt,
    expiresAt: new Date(
      Math.min(
        observed + 60000,
        periodEnd > now ? periodEnd : observed + 60000,
      ),
    ).toISOString(),
    subscription: {
      id: sub.subscriptionId,
      planKey: sub.planKey,
      status: sub.state,
      periodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      pendingPlanKey: sub.pendingPlanKey,
    },
    control: {
      action: control.action,
      revision: control.expectedSubscriptionRevision,
      eligible: control.eligible,
      blockers: [...control.blockers],
    },
  };
}
/** Narrow Cloud services for a locally owned agent. Never provisions a Cloud runtime. */
export function createCloudRoutes({
  fetchImpl = fetch,
  cloudSiteBase = "https://cloud.eliza.app",
  cloudApiBase = "https://api.eliza.app",
  speechVoice,
  hostPolicy,
  initialApiKey,
  credentialStore,
  credentialGate,
  pendingCredentialStore,
} = {}) {
  const billingEnabled = hostPolicy?.accountBilling !== false;
  if (
    !hostPolicy ||
    ["requireNonSensitiveText", "pickMessage"].some(
      (key) => typeof hostPolicy[key] !== "function",
    ) ||
    (pendingCredentialStore &&
      typeof hostPolicy.createNativeCloudAuth !== "function") ||
    (billingEnabled &&
      (["projectAccountAccess", "fundingError"].some(
        (key) => typeof hostPolicy[key] !== "function",
      ) ||
        !Array.isArray(hostPolicy.planKeys) ||
        !hostPolicy.planKeys.length ||
        typeof hostPolicy.planCurrency !== "string" ||
        typeof hostPolicy.planInterval !== "string" ||
        hostPolicy.planKeys.some((key) => typeof key !== "string" || !key))) ||
    !/^[A-Za-z0-9-]{1,32}$/.test(hostPolicy.multipartPrefix ?? "") ||
    !(
      hostPolicy.speechLanguage === null ||
      /^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/.test(hostPolicy.speechLanguage ?? "")
    ) ||
    !(
      (speechVoice === undefined && hostPolicy.providerDefaultVoice === true) ||
      (speechVoice &&
        typeof speechVoice.voiceId === "string" &&
        typeof speechVoice.modelId === "string")
    )
  )
    throw new TypeError("Explicit Cloud service host policy is required");
  const {
    projectAccountAccess,
    createNativeCloudAuth,
    requireNonSensitiveText,
    pickMessage,
  } = hostPolicy;
  const message = (key) =>
    hostPolicy.messages?.[key] ?? `Cloud service request failed (${key})`;
  const site = origin(cloudSiteBase),
    api = origin(cloudApiBase);
  let memory = initialApiKey || null;
  const store = credentialStore || {
    read: async () => memory,
    write: async (value) => {
      memory = value;
    },
    clear: async () => {
      memory = null;
    },
  };
  // Native/custom stores need the same ordering as the host file store. A
  // logout must finish clearing a credential whose write was already pending.
  let credentialWrites = Promise.resolve();
  const mutateCredential = (work) => {
    const next = credentialWrites.then(work);
    credentialWrites = next.catch(() => {});
    return next;
  };
  const ready = (async () => {
    const raw = await pendingCredentialStore?.read();
    if (raw) {
      let saved;
      try {
        saved = JSON.parse(raw);
      } catch {
        throw fail(message("savedSignInNeedsAccountRecovery"), 409);
      }
      // A JSON-null or primitive journal carries no revocation to apply; the
      // per-request readers treat the same bytes as benign ("/cloud/status").
      if (saved?.kind === "revocation")
        await mutateCredential(() => store.clear());
    }
  })();
  ready.catch(() => {});
  const usableCredential = async () => {
    const pending = await pendingCredentialStore?.read();
    if (pending) {
      let saved;
      try {
        saved = JSON.parse(pending);
      } catch {
        throw fail(message("savedSignInNeedsAccountRecovery"), 409);
      }
      if (saved?.kind === "revocation")
        throw fail(message("finishDisconnectingBeforeUsingCloudServices"), 401);
    }
    return store.read();
  };
  const attempts = new Map(),
    checkoutKeys = new Map();
  let generation = 0;
  // Advanced by Gmail disconnect; fences task reads that started before it.
  let googleGeneration = 0;
  let speechStreams;
  function advanceGeneration() {
    generation++;
    speechStreams?.cancelAll();
    return generation;
  }
  const responseEpoch = new WeakMap();
  const nativeAuth = pendingCredentialStore
    ? createNativeCloudAuth({
        fetchImpl,
        api,
        // Google account linking stays off until the host enables it.
        accountLinkReady: hostPolicy.accountLinkReady === true,
        pendingStore: pendingCredentialStore,
        readActive: async () => {
          await credentialWrites;
          return store.read();
        },
        clearActive: () => mutateCredential(() => store.clear()),
        beforeStart: async () => {
          advanceGeneration();
          attempts.clear();
          await mutateCredential(() => store.clear());
        },
        activate: (value, guard) =>
          mutateCredential(async () => {
            guard();
            await store.write(value);
          }),
      })
    : null;
  function current(epoch) {
    if (epoch !== generation) throw fail(message("accountSessionChanged"), 409);
  }
  async function request(
    path,
    {
      signal,
      key,
      json,
      method = "GET",
      rawBody,
      headers = {},
      authorityGeneration = generation,
    } = {},
  ) {
    const epoch = authorityGeneration;
    current(epoch);
    const response = await fetchImpl(
      `${path.startsWith("/api/auth/") ? site : api}${path}`,
      {
        method,
        redirect: "error",
        signal,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(json
          ? { body: JSON.stringify(json) }
          : rawBody
            ? { body: rawBody }
            : {}),
      },
    );
    if (epoch !== generation) {
      // A response arriving after account replacement must not retain its stream.
      void response.body?.cancel().catch(() => {});
      current(epoch);
    }
    responseEpoch.set(response, epoch);
    return response;
  }
  async function parse(response) {
    if (!response.ok)
      throw fail(
        `Cloud request failed (HTTP ${response.status})`,
        response.status,
      );
    try {
      const value = await response.json();
      current(responseEpoch.get(response));
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw fail(message("invalidCloudResponse"), 502);
    }
  }
  /** The enrollment host's short-lived billing session; its expiry may be an ISO string or epoch ms. */
  async function currentBillingAuthority(epoch) {
    const authority = await nativeAuth?.billingAuthority?.();
    current(epoch);
    if (
      !authority ||
      typeof authority.token !== "string" ||
      !authority.token ||
      !(new Date(authority.expiresAt).getTime() > Date.now())
    )
      return null;
    return authority;
  }
  async function accountAccess() {
    if (!billingEnabled)
      throw fail("Account billing is unavailable in this host", 404);
    await ready;
    const epoch = generation;
    await credentialWrites;
    const pending = await pendingCredentialStore?.read();
    current(epoch);
    if (pending) {
      let saved;
      try {
        saved = JSON.parse(pending);
      } catch {
        // error-policy:J3 an unparseable saved sign-in is an explicit invalid
        // state (account recovery), never a fake-valid default or an outage.
        throw fail(message("savedSignInNeedsAccountRecovery"), 409);
      }
      if (saved?.kind === "revocation")
        return { state: "signed_out", disconnectPending: true };
    }
    const key = await usableCredential();
    current(epoch);
    if (!key) return { state: "signed_out" };
    try {
      const user = await parse(
        await request("/api/v1/user", { key, authorityGeneration: epoch }),
      );
      const snapshot = await parse(
        await request("/api/v1/billing/limits", {
          key,
          authorityGeneration: epoch,
        }),
      );
      current(epoch);
      return projectAccountAccess(user, snapshot);
    } catch (error) {
      current(epoch);
      if (error.status === 401) {
        await mutateCredential(async () => {
          current(epoch);
          await store.clear();
        });
        current(epoch);
        return { state: "signed_out" };
      }
      return { state: "unavailable" };
    }
  }
  function speechInput(input) {
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 5000
    )
      throw fail(message("speechTextRequiredMaximum5000Characters"));
    requireNonSensitiveText(input.text);
    const rendering = {};
    if (input.speed !== undefined) {
      if (
        typeof input.speed !== "number" ||
        !Number.isFinite(input.speed) ||
        input.speed < 0.7 ||
        input.speed > 1.2
      )
        throw fail("Invalid speech speed");
      rendering.speed = input.speed;
    }
    for (const field of ["previousText", "nextText"]) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== "string" || input[field].length > 5000)
        throw fail("Invalid speech context");
      requireNonSensitiveText(input[field]);
      rendering[field] = input[field];
    }
    if (input.applyTextNormalization !== undefined) {
      if (!["auto", "on", "off"].includes(input.applyTextNormalization))
        throw fail("Invalid speech normalization");
      rendering.applyTextNormalization = input.applyTextNormalization;
    }
    return {
      text: input.text,
      ...rendering,
      ...(speechVoice
        ? { voiceId: speechVoice.voiceId, modelId: speechVoice.modelId }
        : {}),
    };
  }
  const speechOwner = (epoch, key) =>
    `${epoch}:${createHash("sha256").update(key).digest("hex")}`;
  const checkSpeechOwner = async (owner) => {
    await credentialWrites;
    const epoch = generation,
      key = await usableCredential();
    current(epoch);
    if (!key || owner !== speechOwner(epoch, key))
      throw fail(message("accountSessionChanged"), 409);
    return { epoch, key };
  };
  speechStreams = createSpeechStreamSessions({
    assertOwner: checkSpeechOwner,
    open: async (input, signal, owner) => {
      const { epoch, key } = await checkSpeechOwner(owner);
      const response = await request("/api/v1/voice/tts", {
        method: "POST",
        json: { ...input, withTimestamps: true },
        key,
        signal,
        authorityGeneration: epoch,
        headers: { Accept: "application/x-ndjson, audio/mpeg" },
      });
      if (!response.ok) await parse(response);
      const mime = response.headers.get("content-type")?.split(";")[0];
      if (
        !(
          (mime === "application/x-ndjson" &&
            response.headers.get("x-eliza-tts-timing") === "character-v1") ||
          (mime === "audio/mpeg" && !response.headers.has("x-eliza-tts-timing"))
        )
      ) {
        await response.body?.cancel();
        throw fail("Speech stream is unavailable", 502);
      }
      const speed = response.headers.get("x-eliza-tts-speed");
      if (
        input.speed !== undefined &&
        speed !== null &&
        (!/^(?:0\.[0-9]+|1(?:\.[0-9]+)?)$/.test(speed) ||
          Number(speed) !== input.speed)
      ) {
        await response.body?.cancel();
        throw fail("Invalid rendered speech speed", 502);
      }
      return {
        response,
        renderedSpeed:
          input.speed !== undefined && speed !== null ? Number(speed) : null,
      };
    },
  });
  const handleCloudRoute = async (req, res, url, { signal } = {}) => {
    if (
      !url.pathname.startsWith("/cloud/") &&
      !url.pathname.startsWith("/gmail/") &&
      !url.pathname.startsWith("/voice/")
    )
      return false;
    try {
      await ready;
      let path = url.pathname;
      if (!billingEnabled && path.startsWith("/cloud/account/")) {
        send(res, 404, { error: "Cloud route not available" });
        return true;
      }
      let method = req.method,
        requestInput;
      if (
        path === "/gmail/status" ||
        path === "/gmail/connect" ||
        path === "/gmail/disconnect"
      )
        path = "/cloud" + path;
      if (path === "/gmail/list" && method === "POST") {
        requestInput = await body(req);
        path = "/cloud/gmail/messages";
        method = "GET";
        if (requestInput.query !== undefined) {
          if (typeof requestInput.query !== "string")
            throw fail(message("invalidQuery"));
          url.searchParams.set("query", requestInput.query);
        }
      }
      if (path === "/gmail/read" && method === "POST") {
        requestInput = await body(req);
        if (
          typeof requestInput.messageId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,256}$/.test(requestInput.messageId)
        )
          throw fail(message("invalidMessageID"));
        path = "/cloud/gmail/messages/" + requestInput.messageId;
        method = "GET";
      }
      // The renderer names the connection it shows (from /gmail/status), so
      // a list or read never falls back to another connected mailbox.
      if (
        requestInput?.grantId !== undefined &&
        !googleGrantId(requestInput.grantId)
      )
        throw fail(message("invalidGoogleConnection"));
      const grantQuery = requestInput?.grantId
        ? `&grantId=${encodeURIComponent(requestInput.grantId)}`
        : "";
      allowedQuery(
        url,
        path === "/cloud/login/status"
          ? ["sessionId"]
          : path === "/cloud/gmail/messages"
            ? ["query"]
            : [],
      );
      if (method === "GET" && path === "/cloud/account/access") {
        send(res, 200, await accountAccess());
        return true;
      }
      if (method === "GET" && path === "/cloud/account/plans") {
        const value = await parse(
          await request("/api/v1/subscriptions/plans", { signal }),
        );
        const plans = value.data?.plans;
        if (!Array.isArray(plans))
          throw fail(message("plansAreUnavailable"), 502);
        send(res, 200, {
          plans: plans
            .filter(
              (p) =>
                p.active === true &&
                hostPolicy.planKeys.includes(p.key) &&
                typeof p.name === "string" &&
                Number.isSafeInteger(p.amountCents) &&
                p.amountCents >= 0 &&
                p.currency === hostPolicy.planCurrency &&
                p.interval === hostPolicy.planInterval,
            )
            .map((p) => ({
              key: p.key,
              name: p.name,
              amountCents: p.amountCents,
              currency: p.currency,
              interval: p.interval,
              ...(typeof p.allowance?.amountUsd === "string" &&
              /^\d+(\.\d+)?$/.test(p.allowance.amountUsd)
                ? {
                    allowance: {
                      amountUsd: p.allowance.amountUsd,
                      // The catalog's own terms: what the allowance pays for,
                      // that it does not roll over, and when it ends.
                      ...(p.allowance.fundingClass === "allowance_eligible"
                        ? { fundingClass: p.allowance.fundingClass }
                        : {}),
                      ...(p.allowance.rollover === false
                        ? { rollover: false }
                        : {}),
                      ...(p.allowance.expiresAt === "billing_period_end"
                        ? { expiresAt: p.allowance.expiresAt }
                        : {}),
                    },
                  }
                : {}),
            })),
        });
        return true;
      }
      // Auth owns sign-in factors; keep this transport separate from Google
      // connector consent. Auth validates callback data against its private attempt;
      // callers never select an outbound destination or supply authority.
      const accountMethods = {
        "/cloud/account/methods": "account-methods",
        "/cloud/account/methods/google/start": "account-google-start",
        "/cloud/account/methods/google/return": "account-google-return",
        "/cloud/account/methods/google/status": "account-google-status",
        "/cloud/account/methods/google/complete": "account-google-complete",
        "/cloud/account/methods/google/cancel": "account-google-cancel",
        "/cloud/account/methods/unlink": "account-unlink",
        "/cloud/account/methods/phone/start": "account-phone-start",
        "/cloud/account/methods/phone/verify": "account-phone-verify",
        "/cloud/account/security/status": "account-security-status",
        "/cloud/account/security/enroll/start": "account-security-enroll-start",
        "/cloud/account/security/enroll/verify":
          "account-security-enroll-verify",
        "/cloud/account/security/start": "account-security-start",
        "/cloud/account/security/verify": "account-security-verify",
      };
      if (method === "POST" && Object.hasOwn(accountMethods, path)) {
        if (!nativeAuth?.handle)
          throw fail("Sign-in management is unavailable", 503);
        const input = await body(req, 4096);
        send(res, 200, await nativeAuth.handle(accountMethods[path], input));
        return true;
      }
      // Billing uses a short-lived signed-in session held only by the native
      // enrollment host; the inference key is never sent to billing routes.
      const billingMatch = path.match(
        /^\/cloud\/account\/billing\/(start|verify|mfa)$/,
      );
      if (method === "POST" && billingMatch) {
        if (!nativeAuth?.billingAuthority)
          throw fail(
            message("paymentConfirmationIsUnavailableInThisVersion"),
            503,
          );
        const input = await body(req, 4096),
          fields = billingMatch[1] === "start" ? [] : ["sessionId", "code"];
        if (Object.keys(input).some((key) => !fields.includes(key)))
          throw fail(message("unexpectedConfirmationFields"));
        send(
          res,
          200,
          await nativeAuth.handle(`billing-${billingMatch[1]}`, input),
        );
        return true;
      }
      if (method === "POST" && path === "/cloud/account/portal") {
        const input = await body(req, 4096);
        if (Object.keys(input).length)
          throw fail("Unexpected billing management fields");
        const authorityGeneration = generation;
        const authority = await currentBillingAuthority(authorityGeneration);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        const result = await parse(
          await request("/api/v1/subscriptions/portal", {
            method: "POST",
            json: {},
            key: authority.token,
            authorityGeneration,
            signal,
          }),
        );
        current(authorityGeneration);
        const value = result?.data ?? result;
        let destination;
        try {
          destination = new URL(value?.url);
        } catch {
          throw fail("Invalid billing management address", 502);
        }
        if (
          destination.origin !== "https://billing.stripe.com" ||
          destination.username ||
          destination.password ||
          !destination.pathname.startsWith("/p/session/")
        )
          throw fail("Invalid billing management address", 502);
        send(res, 200, { url: destination.href });
        return true;
      }
      const planChange = path.match(
        /^\/cloud\/account\/plan-change\/(review|confirm|status|pending|payment)$/,
      );
      if (method === "POST" && planChange) {
        allowedQuery(url, []);
        const input = await body(req, 4096),
          operation = planChange[1];
        validatePlanChangeInput(operation, input, hostPolicy);
        const authorityGeneration = generation;
        const authority = await currentBillingAuthority(authorityGeneration);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        const result = await executePlanChange(operation, input, {
          policy: hostPolicy,
          request: async (target, options = {}) =>
            parse(
              await request(target, {
                ...options,
                key: authority.token,
                authorityGeneration,
                signal,
              }),
            ),
        });
        current(authorityGeneration);
        send(res, 200, result);
        return true;
      }
      const lifecycle = path.match(
        /^\/cloud\/account\/subscription\/(cancel|undo|status|pending|renewal-review)$/,
      );
      if (method === "POST" && lifecycle) {
        const input = await body(req, 4096),
          operation = lifecycle[1];
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isId = (value) => typeof value === "string" && uuid.test(value);
        const mutation = operation === "cancel" || operation === "undo";
        const reviewRead = operation === "renewal-review";
        const fields = mutation
          ? [
              "subscriptionId",
              "revision",
              "retryOf",
              ...(operation === "undo" ? ["expectedRenewalTermsDigest"] : []),
            ]
          : reviewRead
            ? ["subscriptionId", "revision"]
            : operation === "status"
              ? ["action", "commandId"]
              : ["cursor"];
        if (
          Object.keys(input).some((key) => !fields.includes(key)) ||
          ((mutation || reviewRead) &&
            (!isId(input.subscriptionId) ||
              !Number.isSafeInteger(input.revision) ||
              input.revision <= 0 ||
              (input.retryOf !== undefined && !isId(input.retryOf)))) ||
          (operation === "undo" &&
            (typeof input.expectedRenewalTermsDigest !== "string" ||
              !/^[a-f0-9]{64}$/.test(input.expectedRenewalTermsDigest))) ||
          (operation === "status" &&
            (!["cancel", "undo"].includes(input.action) ||
              !isId(input.commandId))) ||
          (operation === "pending" &&
            input.cursor !== undefined &&
            (typeof input.cursor !== "string" ||
              !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)))
        )
          throw fail("Invalid subscription command");
        const authorityGeneration = generation;
        const authority = await currentBillingAuthority(authorityGeneration);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        const options = { key: authority.token, authorityGeneration, signal };
        const revision = (value) =>
          typeof value === "string" &&
          /^[1-9][0-9]*$/.test(value) &&
          Number.isSafeInteger(Number(value));
        const project = (value) => {
          if (
            !value ||
            !isId(value.commandId) ||
            !isId(value.subscriptionId) ||
            ![
              "PREPARED",
              "OUTCOME_UNKNOWN",
              "APPLIED",
              "FAILED",
              "SUPERSEDED",
            ].includes(value.status) ||
            !revision(value.expectedSubscriptionRevision) ||
            !(
              value.resultSubscriptionRevision === null ||
              revision(value.resultSubscriptionRevision)
            )
          )
            throw fail("Subscription command status is unavailable", 502);
          return {
            commandId: value.commandId,
            subscriptionId: value.subscriptionId,
            status: value.status,
            revision: value.expectedSubscriptionRevision,
            resultRevision: value.resultSubscriptionRevision,
          };
        };
        if (reviewRead) {
          const result = await parse(
            await request(
              `/api/v1/subscriptions/cancel/undo/review?subscriptionId=${encodeURIComponent(input.subscriptionId)}&expectedSubscriptionRevision=${input.revision}`,
              options,
            ),
          );
          const review = projectRenewalReview(result?.data, hostPolicy);
          if (
            review.subscriptionId !== input.subscriptionId ||
            review.expectedSubscriptionRevision !== String(input.revision)
          )
            throw fail("Subscription renewal review is unavailable", 502);
          current(authorityGeneration);
          send(res, 200, review);
        } else if (mutation) {
          const review = projectSubscriptionManagement(
            await parse(await request("/api/v1/billing/limits", options)),
            hostPolicy.planKeys,
          );
          if (
            review.status !== "available" ||
            !review.control.eligible ||
            review.control.action !== operation ||
            review.subscription.id !== input.subscriptionId ||
            review.control.revision !== input.revision
          )
            throw fail(
              "Your subscription changed. Review it again before continuing.",
              409,
            );
          if (input.retryOf !== undefined) {
            const previous = project(
              (
                await parse(
                  await request(
                    `/api/v1/subscriptions/cancel${operation === "undo" ? "/undo" : ""}/${input.retryOf}`,
                    options,
                  ),
                )
              )?.data,
            );
            if (
              previous.commandId !== input.retryOf ||
              previous.subscriptionId !== input.subscriptionId ||
              previous.revision !== String(input.revision) ||
              previous.status !== "FAILED"
            )
              throw fail(
                "The previous change is not confirmed failed. Check its status before retrying.",
                409,
              );
          }
          // Stable across restarts, tokens and retries. The server revalidates the
          // organization, actor and revision and owns durable command execution.
          const idempotencyKey =
            "native-lifecycle-v1-" +
            createHash("sha256")
              .update(
                `${input.subscriptionId}:${input.revision}:${operation}${operation === "undo" ? ":terms:" + input.expectedRenewalTermsDigest : ""}${input.retryOf ? ":retry:" + input.retryOf : ""}`,
              )
              .digest("hex");
          const result = await parse(
            await request(
              `/api/v1/subscriptions/cancel${operation === "undo" ? "/undo/confirm" : ""}`,
              {
                ...options,
                method: "POST",
                json: {
                  subscriptionId: input.subscriptionId,
                  expectedSubscriptionRevision: input.revision,
                  idempotencyKey,
                  ...(operation === "undo"
                    ? {
                        expectedRenewalTermsDigest:
                          input.expectedRenewalTermsDigest,
                      }
                    : {}),
                },
              },
            ),
          );
          const command = project(result?.data);
          if (
            command.subscriptionId !== input.subscriptionId ||
            command.revision !== String(input.revision)
          )
            throw fail("Subscription command status is unavailable", 502);
          current(authorityGeneration);
          send(res, 200, command);
        } else if (operation === "status") {
          const result = await parse(
            await request(
              `/api/v1/subscriptions/cancel${input.action === "undo" ? "/undo" : ""}/${input.commandId}`,
              options,
            ),
          );
          const command = project(result?.data);
          if (command.commandId !== input.commandId)
            throw fail("Subscription command status is unavailable", 502);
          current(authorityGeneration);
          send(res, 200, command);
        } else {
          const result = await parse(
            await request(
              `/api/v1/subscriptions/commands?limit=20${input.cursor ? "&cursor=" + encodeURIComponent(input.cursor) : ""}`,
              options,
            ),
          );
          const page = result?.data;
          if (
            !page ||
            !Number.isFinite(Date.parse(page.observedAt)) ||
            !Array.isArray(page.items) ||
            page.items.length > 20 ||
            !(
              page.nextCursor === null ||
              (typeof page.nextCursor === "string" &&
                /^[A-Za-z0-9_-]{1,1024}$/.test(page.nextCursor))
            )
          )
            throw fail("Subscription recovery is unavailable", 502);
          const items = page.items.map((item) => {
            if (
              !["cancel", "resume"].includes(item.kind) ||
              !["PREPARED", "OUTCOME_UNKNOWN"].includes(item.status)
            )
              throw fail("Subscription recovery is unavailable", 502);
            return {
              ...project({ ...item, resultSubscriptionRevision: null }),
              action: item.kind === "resume" ? "undo" : "cancel",
            };
          });
          current(authorityGeneration);
          send(res, 200, {
            observedAt: page.observedAt,
            items,
            nextCursor: page.nextCursor,
          });
        }
        return true;
      }
      if (method === "GET" && path === "/cloud/account/management") {
        const authorityGeneration = generation;
        const authority = await currentBillingAuthority(authorityGeneration);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        const result = await parse(
          await request("/api/v1/billing/limits", {
            method: "GET",
            key: authority.token,
            authorityGeneration,
            signal,
          }),
        );
        current(authorityGeneration);
        send(
          res,
          200,
          projectSubscriptionManagement(result, hostPolicy.planKeys),
        );
        return true;
      }
      if (method === "POST" && path === "/cloud/account/checkout") {
        const input = await body(req, 4096);
        if (
          Object.keys(input).some(
            (key) => !["planKey", "presentation"].includes(key),
          ) ||
          !hostPolicy.planKeys.includes(input.planKey) ||
          !["embedded", "shared"].includes(input.presentation)
        )
          throw fail(message("chooseAPlanToContinue"));
        const epoch = generation;
        const authority = await currentBillingAuthority(epoch);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        // One key per account/plan/presentation: a retry reconciles the same attempt.
        const attemptKey = `${generation}:${input.planKey}:${input.presentation}`;
        if (!checkoutKeys.has(attemptKey))
          checkoutKeys.set(attemptKey, randomUUID());
        const value = await parse(
          await request("/api/v1/subscriptions/checkout", {
            method: "POST",
            json: {
              planKey: input.planKey,
              idempotencyKey: checkoutKeys.get(attemptKey),
              presentation: input.presentation,
            },
            key: authority.token,
            signal,
            authorityGeneration: epoch,
          }),
        );
        send(
          res,
          200,
          projectCheckout(value?.data ?? value, input.presentation, () =>
            checkoutKeys.delete(attemptKey),
          ),
        );
        return true;
      }
      // Entitlement still comes only from Cloud's server-side reconciliation.
      if (method === "POST" && path === "/cloud/account/checkout/confirm") {
        const input = await body(req, 4096);
        if (
          Object.keys(input).some((key) => key !== "sessionId") ||
          typeof input.sessionId !== "string" ||
          !CHECKOUT_SESSION_ID.test(input.sessionId)
        )
          throw fail(message("invalidCheckoutSession"));
        const epoch = generation;
        const authority = await currentBillingAuthority(epoch);
        if (!authority) {
          send(res, 428, {
            error: message("confirmItSYouBeforePaying"),
            code: "billing_verification_required",
          });
          return true;
        }
        await parse(
          await request("/api/v1/subscriptions/checkout/confirm", {
            method: "POST",
            json: { sessionId: input.sessionId },
            key: authority.token,
            signal,
            authorityGeneration: epoch,
          }),
        );
        send(res, 200, { status: "submitted" });
        return true;
      }
      if (method === "GET" && path === "/cloud/status") {
        const epoch = generation;
        await credentialWrites;
        const key = await store.read();
        current(epoch);
        const pending = await pendingCredentialStore?.read();
        current(epoch);
        let disconnectPending = false;
        try {
          disconnectPending =
            JSON.parse(pending ?? "null")?.kind === "revocation";
        } catch {
          /* Recovery remains in the native sign-in panel. */
        }
        send(res, 200, {
          connected: Boolean(key) && !disconnectPending,
          disconnectPending,
          credentialPersistence: credentialStore
            ? "host-managed"
            : "process-memory",
        });
        return true;
      }
      if (method === "POST" && path === "/cloud/logout") {
        await body(req);
        advanceGeneration();
        attempts.clear();
        checkoutKeys.clear();
        if (nativeAuth) await nativeAuth.cancel({ disconnect: true });
        else await mutateCredential(() => store.clear());
        send(res, 200, { connected: false });
        return true;
      }
      const nativeMatch = path.match(
        /^\/cloud\/native\/(config|start|verify|mfa|resume|cancel)$/,
      );
      if (
        nativeMatch &&
        ((method === "GET" && nativeMatch[1] === "config") ||
          (method === "POST" && nativeMatch[1] !== "config"))
      ) {
        if (!nativeAuth)
          throw fail(message("nativeAccountStorageIsUnavailable"), 503);
        const operation = nativeMatch[1],
          input = method === "POST" ? await body(req, 4096) : {};
        const fields =
          operation === "start"
            ? ["email", "phone", "method"]
            : ["verify", "mfa"].includes(operation)
              ? ["sessionId", "code"]
              : [];
        if (Object.keys(input).some((key) => !fields.includes(key)))
          throw fail(message("unexpectedSignInFields"));
        if (operation === "cancel") {
          advanceGeneration();
          attempts.clear();
          send(res, 200, await nativeAuth.cancel({ disconnect: true }));
          return true;
        }
        send(res, 200, await nativeAuth.handle(operation, input));
        return true;
      }
      if (method === "POST" && path === "/cloud/login") {
        await body(req);
        const epoch = advanceGeneration();
        await nativeAuth?.cancel({ disconnect: true });
        attempts.clear();
        await mutateCredential(() => store.clear());
        current(epoch);
        const value = await parse(
          await request("/api/auth/cli-session", {
            method: "POST",
            json: { sessionId: randomUUID() },
            signal,
            authorityGeneration: epoch,
          }),
        );
        if (
          typeof value.sessionId !== "string" ||
          !/^[a-zA-Z0-9_-]{16,128}$/.test(value.sessionId)
        )
          throw fail(message("invalidCloudLoginSession"), 502);
        const providerExpiry = Date.parse(value.expiresAt);
        const expiresAt = Number.isFinite(providerExpiry)
          ? Math.min(providerExpiry, Date.now() + 15 * 60 * 1000)
          : Date.now() + 15 * 60 * 1000;
        attempts.clear();
        attempts.set(value.sessionId, { expiresAt, generation });
        send(res, 200, {
          sessionId: value.sessionId,
          browserUrl: `${site}/auth/cli-login?session=${encodeURIComponent(value.sessionId)}`,
          expiresAt,
        });
        return true;
      }
      if (method === "GET" && path === "/cloud/login/status") {
        const id = url.searchParams.get("sessionId"),
          attempt = attempts.get(id);
        if (!attempt || attempt.expiresAt < Date.now()) {
          attempts.delete(id);
          send(res, 410, { status: "expired" });
          return true;
        }
        if (!attempt.poll)
          attempt.poll = (async () => {
            if (attempt.authenticated)
              return { status: "authenticated", connected: true };
            // The provider result is single-use: finish private persistence even if
            // the browser closes its polling request during navigation.
            const value = await parse(
              await request(`/api/auth/cli-session/${encodeURIComponent(id)}`, {
                authorityGeneration: attempt.generation,
              }),
            );
            if (
              generation !== attempt.generation ||
              attempts.get(id) !== attempt
            )
              throw fail(message("loginCancelled"), 409);
            if (value.status === "authenticated") {
              if (typeof value.apiKey !== "string" || !value.apiKey.trim())
                throw fail(message("cloudLoginReturnedNoCredential"), 502);
              await mutateCredential(async () => {
                current(attempt.generation);
                await store.write(value.apiKey);
              });
              current(attempt.generation);
              attempt.authenticated = true;
              return { status: "authenticated", connected: true };
            }
            return {
              status: ["pending", "expired", "error"].includes(value.status)
                ? value.status
                : "pending",
            };
          })().finally(() => {
            attempt.poll = null;
          });
        const result = await attempt.poll;
        current(attempt.generation);
        send(res, 200, result);
        return true;
      }
      const credentialEpoch = generation;
      await credentialWrites;
      const key = await usableCredential();
      current(credentialEpoch);
      if (!key) throw fail(message("signInToElizaCloudFirst"), 401);
      const invoiceDetail = path.match(
        /^\/cloud\/account\/invoices\/([A-Za-z0-9_-]{1,128})$/,
      );
      if (method === "GET" && invoiceDetail) {
        if (url.search)
          throw fail("Invoice query parameters are not supported");
        const id = invoiceDetail[1];
        const value = await parse(
          await request(`/api/invoices/${id}`, {
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        current(credentialEpoch);
        send(res, 200, { invoice: invoiceProjection(value.invoice, id) });
        return true;
      }
      if (method === "GET" && path === "/cloud/account/invoices") {
        const value = await parse(
          await request("/api/invoices/list", {
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        if (
          !Array.isArray(value.invoices) ||
          value.invoices.some(
            (i) =>
              !i ||
              ["id", "date", "total", "status"].some(
                (field) => typeof i[field] !== "string",
              ),
          )
        )
          throw fail(message("invoicesUnavailable"), 502);
        send(res, 200, {
          invoices: value.invoices.map((i) => ({
            id: i.id,
            date: i.date,
            total: i.total,
            status: i.status,
          })),
        });
        return true;
      }
      const speechStreamRoute = path.match(
        /^\/voice\/tts\/stream\/(start|pull|cancel)$/,
      );
      if (method === "POST" && speechStreamRoute) {
        const input = await body(req),
          owner = speechOwner(credentialEpoch, key);
        const operation = speechStreamRoute[1];
        const fields =
          operation === "start"
            ? [
                "requestId",
                "text",
                "speed",
                "previousText",
                "nextText",
                "applyTextNormalization",
              ]
            : operation === "pull"
              ? ["streamId", "cursor"]
              : ["streamId", "requestId"];
        if (Object.keys(input).some((field) => !fields.includes(field)))
          throw fail("Unexpected speech stream fields");
        const result =
          operation === "start"
            ? await speechStreams.start({
                requestId: input.requestId,
                owner,
                input: speechInput(input),
              })
            : operation === "pull"
              ? await speechStreams.pull({
                  streamId: input.streamId,
                  cursor: input.cursor,
                  owner,
                })
              : await speechStreams.cancel({
                  streamId: input.streamId,
                  requestId: input.requestId,
                  owner,
                });
        await checkSpeechOwner(owner);
        send(res, 200, result);
        return true;
      }
      if (method === "POST" && path === "/voice/tts") {
        const input = speechInput(await body(req));
        const response = await request("/api/v1/voice/tts", {
          method: "POST",
          json: input,
          key,
          signal,
          authorityGeneration: credentialEpoch,
          headers: { Accept: "audio/mpeg" },
        });
        if (!response.ok) await parse(response);
        const mimeType = response.headers.get("content-type") || "";
        if (!mimeType.startsWith("audio/"))
          throw fail(message("invalidSpeechAudio"), 502);
        // Older Cloud deployments omit this acknowledgement. Clients retain
        // local pace adjustment until the provider confirms the exact speed.
        const speedHeader = response.headers.get("x-eliza-tts-speed");
        let renderedSpeed = null;
        if (input.speed !== undefined && speedHeader !== null) {
          if (
            !/^(?:0\.[0-9]+|1(?:\.[0-9]+)?)$/.test(speedHeader) ||
            Number(speedHeader) !== input.speed
          ) {
            await response.body?.cancel();
            throw fail("Invalid rendered speech speed", 502);
          }
          renderedSpeed = Number(speedHeader);
        }
        // Evidence of which provider actually rendered the pinned voice.
        const provider = /^[a-z0-9-]{1,32}$/.test(
          response.headers.get("x-eliza-tts-provider") || "",
        )
          ? response.headers.get("x-eliza-tts-provider")
          : null;
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          current(responseEpoch.get(response));
          size += chunk.length;
          if (size > 8 * 1024 * 1024)
            throw fail(message("speechAudioTooLarge"), 502);
          chunks.push(chunk);
        }
        current(responseEpoch.get(response));
        send(res, 200, {
          audioBase64: Buffer.concat(chunks).toString("base64"),
          mimeType,
          provider,
          renderedSpeed,
        });
        return true;
      }
      if (method === "POST" && path === "/voice/stt") {
        const input = await body(req, 12 * 1024 * 1024);
        if (
          typeof input.audioBase64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audioBase64) ||
          typeof input.mimeType !== "string" ||
          input.mimeType.length > 200 ||
          /[\r\n]/.test(input.mimeType) ||
          !/^audio\/[a-zA-Z0-9.+-]+(?:;.*)?$/.test(input.mimeType)
        )
          throw fail(message("validBase64AudioAndMIMETypeRequired"));
        const audio = Buffer.from(input.audioBase64, "base64");
        if (!audio.length || audio.length > 8 * 1024 * 1024)
          throw fail(message("audioMustContain1ByteTo8MiB"), 413);
        // Android's DNS transport buffers BodyInit without copying the boundary
        // header generated by Response(FormData). Send explicit bytes and framing.
        const boundary = `${hostPolicy.multipartPrefix}-${randomUUID()}`;
        const multipart = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
          ),
          // Language hint comes from the trusted application policy.
          audio,
          Buffer.from(
            hostPolicy.speechLanguage === null
              ? `\r\n--${boundary}--\r\n`
              : `\r\n--${boundary}\r\nContent-Disposition: form-data; name="languageCode"\r\n\r\n${hostPolicy.speechLanguage}\r\n--${boundary}--\r\n`,
          ),
        ]);
        const value = await parse(
          await request("/api/v1/voice/stt", {
            method: "POST",
            rawBody: multipart,
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        const text = value.text ?? value.transcript;
        if (typeof text !== "string")
          throw fail(message("invalidTranscriptionResponse"), 502);
        // The same host policy that screens typed text screens what was heard.
        // A spoken secret never reaches the renderer's draft.
        try {
          requireNonSensitiveText(text);
        } catch (error) {
          if (error?.code !== "SENSITIVE_TEXT") throw error;
          send(res, 200, { text: "", redacted: true });
          return true;
        }
        send(res, 200, { text });
        return true;
      }
      if (method === "GET" && path === "/cloud/gmail/status") {
        const value = await parse(
          await request("/api/v1/eliza/google/status?side=owner", {
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        const reason = [
          "connected",
          "disconnected",
          "config_missing",
          "token_missing",
          "needs_reauth",
        ].includes(value.reason)
          ? value.reason
          : "unknown";
        const email =
          value.connected === true &&
          typeof value.identity?.email === "string" &&
          value.identity.email.length <= 254 &&
          /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(
            value.identity.email,
          )
            ? value.identity.email
            : null;
        const connected = value.connected === true;
        send(res, 200, {
          connected,
          configured: value.configured === true,
          reason,
          identity: email ? { email } : null,
          // The connection the renderer shows; list, read and disconnect name it.
          connectionId:
            connected && googleGrantId(value.connectionId)
              ? value.connectionId
              : null,
          grantedCapabilities:
            Array.isArray(value.grantedCapabilities) &&
            value.grantedCapabilities.includes("google.gmail.triage")
              ? ["google.gmail.triage"]
              : [],
          // A metadata-only grant still reports triage. Message reads need a
          // body-read scope, so the app checks the scopes themselves.
          grantedScopes: connected ? googleScopes(value.grantedScopes) : [],
          canReadMessages:
            connected && gmailBodyRead(googleScopes(value.grantedScopes)),
        });
        return true;
      }
      if (method === "POST" && path === "/cloud/gmail/disconnect") {
        const input = await body(req, 1024);
        if (
          Object.keys(input).some((field) => field !== "connectionId") ||
          (input.connectionId !== undefined &&
            !googleGrantId(input.connectionId))
        )
          throw fail(message("invalidGoogleConnection"));
        // Fence task reads first. A read that started for this grant fails
        // closed even when the remote removal fails.
        googleGeneration++;
        await parse(
          await request("/api/v1/eliza/google/disconnect", {
            method: "POST",
            json: {
              side: "owner",
              ...(input.connectionId
                ? { connectionId: input.connectionId }
                : {}),
            },
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        googleGeneration++;
        send(res, 200, { disconnected: true });
        return true;
      }
      // One Google account at a time. After a new grant completes, the app
      // names the connection it shows; every other owner connection is
      // removed so task reads cannot use an older mailbox.
      if (method === "POST" && path === "/cloud/gmail/disconnect-others") {
        const input = await body(req, 1024);
        if (
          Object.keys(input).join(",") !== "connectionId" ||
          !googleGrantId(input.connectionId)
        )
          throw fail(message("invalidGoogleConnection"));
        const status = await parse(
          await request("/api/v1/eliza/google/status?side=owner", {
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        // Only the connection Cloud reports as current can be kept.
        if (
          status.connected !== true ||
          status.connectionId !== input.connectionId
        )
          throw fail(message("invalidGoogleConnection"), 409);
        const accounts = await parse(
          await request("/api/v1/eliza/google/accounts?side=owner", {
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        if (!Array.isArray(accounts))
          throw fail(message("invalidCloudResponse"), 502);
        const others = accounts
          .map((account) => account?.connectionId)
          .filter((id) => googleGrantId(id) && id !== input.connectionId);
        // Fence task reads first, as for a single disconnect.
        googleGeneration++;
        for (const connectionId of new Set(others))
          await parse(
            await request("/api/v1/eliza/google/disconnect", {
              method: "POST",
              json: { side: "owner", connectionId },
              key,
              signal,
              authorityGeneration: credentialEpoch,
            }),
          );
        googleGeneration++;
        send(res, 200, { disconnected: new Set(others).size });
        return true;
      }
      if (method === "POST" && path === "/cloud/gmail/connect") {
        await body(req);
        // A new consent can replace the active connection.
        googleGeneration++;
        const value = await parse(
          await request("/api/v1/eliza/google/connect/initiate", {
            method: "POST",
            json: { side: "owner", capabilities: ["google.gmail.triage"] },
            key,
            signal,
            authorityGeneration: credentialEpoch,
          }),
        );
        const auth = new URL(value.authUrl);
        if (
          auth.origin !== "https://accounts.google.com" ||
          !["/o/oauth2/v2/auth", "/o/oauth2/auth"].includes(auth.pathname) ||
          auth.username ||
          auth.password ||
          auth.hash
        )
          throw fail(message("invalidGoogleAuthorizationURL"), 502);
        send(res, 200, { browserUrl: auth.href });
        return true;
      }
      if (method === "GET" && path === "/cloud/gmail/messages") {
        const maxResults = requestInput?.maxResults ?? 50;
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)
          throw fail(message("maxresultsMustBe1To100"));
        const query = url.searchParams.get("query") || "in:inbox";
        if (query.length > 1000) throw fail(message("searchQueryTooLong"));
        const value = await parse(
          await request(
            `/api/v1/eliza/google/gmail/search?side=owner&maxResults=${maxResults}&query=${encodeURIComponent(query)}${grantQuery}`,
            { key, signal, authorityGeneration: credentialEpoch },
          ),
        );
        if (!Array.isArray(value.messages))
          throw fail(message("invalidGmailResponse"), 502);
        send(res, 200, {
          messages: value.messages.map(pickMessage),
          syncedAt: value.syncedAt,
        });
        return true;
      }
      const read = path.match(
        /^\/cloud\/gmail\/messages\/([a-zA-Z0-9_-]{1,256})$/,
      );
      if (method === "GET" && read) {
        const value = await parse(
          await request(
            `/api/v1/eliza/google/gmail/read?side=owner&messageId=${encodeURIComponent(read[1])}${grantQuery}`,
            { key, signal, authorityGeneration: credentialEpoch },
          ),
        );
        if (!value.message || typeof value.bodyText !== "string")
          throw fail(message("invalidGmailResponse"), 502);
        send(res, 200, { ...pickMessage(value.message), body: value.bodyText });
        return true;
      }
      send(res, 404, { error: message("cloudRouteNotAvailable") });
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        if (res.headersSent) res.destroy();
        else
          send(res, error.status || 502, {
            error: error.status ? error.message : "Cloud service unavailable",
          });
      }
    }
    return true;
  };
  handleCloudRoute.closeSpeechStreams = () => speechStreams.close();
  handleCloudRoute.ready = ready;
  handleCloudRoute.accountAccess = accountAccess;
  handleCloudRoute.requirePaidAccess = async () => {
    const access = await accountAccess();
    if (access.state !== "active") throw hostPolicy.fundingError(access);
  };
  // This port is never exposed as a renderer route. It shares login/logout
  // epochs. Each read first checks that the owner's connected Google account
  // is still the grant it reads, so a reconnect to another mailbox is noticed.
  // Without `accountId`, the caller binds each task to the grant that
  // `currentAccountId()` returned when the task started.
  handleCloudRoute.googleForAccount = ({
    actorId,
    accountId,
    timeoutMs = 20000,
    retryDelaysMs = [250, 1000],
  }) => {
    if (typeof credentialGate !== "function" || typeof actorId !== "string")
      throw fail(message("taskAccountBindingUnavailable"), 503);
    const epoch = generation;
    const check = async (googleEpoch) => {
      await ready;
      current(epoch);
      await credentialWrites;
      current(epoch);
      if ((await credentialGate()) !== actorId)
        throw fail(message("taskAccountChanged"), 409);
      current(epoch);
      if (googleEpoch !== googleGeneration)
        throw googleReadFailure("account_changed");
    };
    // Every task read is a GET. Retry only a timeout, 429 or 5xx, a bounded
    // number of times; never a refusal.
    const readJson = async (path, maxBytes, googleEpoch) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await check(googleEpoch);
          const key = await usableCredential();
          await check(googleEpoch);
          if (!key) throw googleReadFailure("cloud_sign_in_required");
          const response = await request(path, {
            key,
            authorityGeneration: epoch,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            // Cloud's own 401/403 rejects the Eliza Cloud sign-in, not Google.
            if (response.status === 401 || response.status === 403)
              throw googleReadFailure("cloud_sign_in_required");
            // The Google connection no longer exists.
            if (response.status === 404)
              throw googleReadFailure("account_changed");
            // Cloud's Google connector answers 409 when the Google token
            // cannot be refreshed, the grant was revoked or it is
            // metadata-only. The caller rechecks status to tell them apart.
            if (response.status === 409)
              throw Object.assign(googleReadFailure("reauth_required"), {
                googleConflict: true,
              });
            throw Object.assign(googleReadFailure("unavailable"), {
              retry: response.status === 429 || response.status >= 500,
            });
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            await check(googleEpoch);
            size += chunk.length;
            if (size > maxBytes)
              throw fail(message("cloudResponseTooLarge"), 502);
            chunks.push(chunk);
          }
          await check(googleEpoch);
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw fail(message("invalidCloudResponse"), 502);
          }
        } catch (error) {
          const timedOut = error?.name === "TimeoutError";
          if ((timedOut || error?.retry) && attempt < retryDelaysMs.length) {
            await new Promise((resolve) =>
              setTimeout(resolve, retryDelaysMs[attempt]),
            );
            continue;
          }
          throw timedOut ? googleReadFailure("timeout") : error;
        }
      }
    };
    const currentAccount = async (googleEpoch) => {
      const status = await readJson(
        "/api/v1/eliza/google/status?side=owner",
        65536,
        googleEpoch,
      );
      if (status?.connected !== true)
        throw googleReadFailure(
          ["needs_reauth", "token_missing"].includes(status?.reason)
            ? "reauth_required"
            : "account_changed",
        );
      if (!googleGrantId(status.connectionId))
        throw googleReadFailure("unavailable");
      if (!gmailBodyRead(googleScopes(status.grantedScopes)))
        throw googleReadFailure("insufficient_scope");
      const email = status.identity?.email;
      return {
        accountId: status.connectionId,
        ...(typeof email === "string" &&
        email.length <= 254 &&
        /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(
          email,
        )
          ? { email }
          : {}),
      };
    };
    const currentAccountId = async (googleEpoch) =>
      (await currentAccount(googleEpoch)).accountId;
    const port = createManagedGoogleReadPort({
      accountId,
      request: async (path, maxBytes, grantId) => {
        const googleEpoch = googleGeneration;
        if ((await currentAccountId(googleEpoch)) !== grantId)
          throw googleReadFailure("account_changed");
        try {
          return await readJson(path, maxBytes, googleEpoch);
        } catch (error) {
          if (!error?.googleConflict) throw error;
          // Name the Google conflict from the connection's current status:
          // gone or replaced, metadata-only, or a token that needs reconnect.
          if ((await currentAccountId(googleEpoch)) !== grantId)
            throw googleReadFailure("account_changed");
          throw googleReadFailure("reauth_required");
        }
      },
    });
    return Object.assign(port, {
      currentAccountId: () => currentAccountId(googleGeneration),
      /** The connected grant and, when Cloud reports it, its address. */
      currentAccount: () => currentAccount(googleGeneration),
    });
  };
  handleCloudRoute.documentImagesForAccount = ({
    actorId,
    model,
    documentRuntime,
    recordUsage,
  }) => {
    if (typeof credentialGate !== "function")
      throw fail(message("taskAccountBindingUnavailable"), 503);
    const epoch = generation;
    const assertOwner = async () => {
      await ready;
      current(epoch);
      await credentialWrites;
      current(epoch);
      if ((await credentialGate()) !== actorId)
        throw fail(message("taskAccountChanged"), 409);
      current(epoch);
    };
    return createDocumentImageDescriber({
      documentRuntime,
      model,
      assertOwner,
      recordUsage,
      readAuthority: async () => {
        await assertOwner();
        const apiKey = await usableCredential();
        await assertOwner();
        if (!apiKey) throw fail(message("cloudAccountUnavailable"), 401);
        return { apiKey, apiBaseUrl: `${api}/api/v1` };
      },
    });
  };
  return handleCloudRoute;
}

/** Private host credential file. Atomic replacement; never placed in renderer assets. */
export function createFileCredentialStore(path) {
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  return {
    read: () =>
      serialize(async () => {
        let file;
        try {
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              stat.uid !== process.getuid())
          )
            throw fail(
              "Cloud credential file must be private to the current user",
              503,
            );
          const value = (await file.readFile("utf8")).trim();
          return value || null;
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        } finally {
          await file?.close();
        }
      }),
    write: (value) =>
      serialize(async () => {
        if (typeof value !== "string" || !value.trim())
          throw fail("Invalid host credential", 503);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        let file;
        try {
          file = await open(temporary, "wx", 0o600);
          await file.writeFile(value, "utf8");
          await file.sync();
          await file.close();
          file = null;
          await rename(temporary, path);
        } finally {
          await file?.close();
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }),
    clear: () =>
      serialize(async () => {
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }),
  };
}

export { createDocumentImageDescriber } from "./document-image-describer.mjs";
export { loadDocumentRuntime } from "./document-runtime.mjs";
export { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";
