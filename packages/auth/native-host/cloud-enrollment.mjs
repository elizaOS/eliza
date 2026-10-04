import { createHash, randomBytes } from "node:crypto";
import { createNativeAccountMethods } from "./account-methods.mjs";

const fail = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const opaque = () => randomBytes(32).toString("base64url");
const validTime = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) > Date.now();
const fingerprint = (secret) =>
  createHash("sha256").update(secret).digest("hex");
const EMAIL_RE =
  /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const BILLING_OPERATIONS = [
  "billing-status",
  "billing-start",
  "billing-verify",
  "billing-mfa",
];
/** Billing authority is never held longer than this, whatever the session claims. */
const BILLING_MAX_MS = 60 * 60 * 1000;
/** Without a readable `exp`, assume a short interactive session. */
const BILLING_DEFAULT_MS = 10 * 60 * 1000;
/** Treat authority as expired slightly early so an in-flight request never carries a dead token. */
const BILLING_SKEW_MS = 30 * 1000;
function sessionExpiry(token) {
  try {
    const exp = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
// Admission only: Auth and Cloud still verify the signature and account ownership.
function personalSessionUser(token) {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof claims.userId === "string" &&
      claims.userId &&
      claims.tenantId === `personal-${claims.userId}`
      ? claims.userId
      : null;
  } catch {
    return null;
  }
}
const maskDestination = (method, value) =>
  method === "phone"
    ? `\u2022\u2022\u2022${value.slice(-4)}`
    : `${value[0]}\u2022\u2022\u2022${value.slice(value.indexOf("@"))}`;
/**
 * Private gateway enrollment. PKCE material and app credentials never leave this module.
 * The Steward session from an interactive code check is kept only in memory as billing
 * authority for the trusted host (`billingAuthority()`); it is never persisted, logged or
 * returned through `handle()`, and the stored app credential stays inference-only.
 */
export function createNativeCloudAuth({
  fetchImpl = fetch,
  api = "https://api.eliza.app",
  auth = "https://eliza.steward.fi",
  tenant = "elizacloud",
  binding,
  accountLinkRedirectUri,
  appName,
  deviceName = appName,
  messages = {},
  pendingStore,
  activate,
  readActive = async () => null,
  clearActive = async () => {},
  beforeStart = async () => {},
}) {
  if (
    !binding ||
    Object.keys(binding).sort().join(",") !==
      "clientId,environment,redirectUri" ||
    Object.values(binding).some(
      (value) => typeof value !== "string" || !value.length,
    ) ||
    typeof appName !== "string" ||
    !appName.length ||
    typeof deviceName !== "string" ||
    !deviceName.length
  )
    throw new TypeError(
      "Explicit native application configuration is required",
    );
  const redirect = new URL(binding.redirectUri);
  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  )
    throw new TypeError("Invalid application callback");
  binding = Object.freeze({ ...binding });
  const message = (key, fallback) => messages[key] ?? fallback;
  let accountMethods,
    attempt = null,
    billingAttempt = null,
    billing = null,
    // A clear invalidates pending billing work without cancelling enrollment activation.
    billingScope = {},
    busy = false,
    cancelling = false,
    epoch = 0,
    settled = Promise.resolve(),
    settle;
  const check = (ticket) => {
    if (ticket !== epoch)
      throw fail(message("error1", "Sign-in cancelled. Start again."), 409);
  };
  async function call(base, path, input, token, ticket, method) {
    check(ticket);
    const response = await fetchImpl(base + path, {
      method: method ?? (input === undefined ? "GET" : "POST"),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        ...(input === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    check(ticket);
    if (!response.ok) {
      if (response.status === 429)
        throw fail(
          message(
            "error2",
            "Too many attempts. Please wait before trying again.",
          ),
          429,
        );
      if (response.status === 400 || response.status === 401)
        throw fail(
          message(
            "error3",
            "Sign-in could not be verified. Check the code or start again.",
          ),
          response.status,
        );
      if (response.status === 403)
        throw fail(
          message(
            "error4",
            "This sign-in needs an additional account check. Use account recovery or contact support.",
          ),
          403,
        );
      if (
        response.status === 409 &&
        (path.startsWith("/user/me/accounts") || path.startsWith("/auth/mfa/"))
      )
        throw fail(
          "The account changed or this method cannot be linked. Review your sign-in methods again.",
          409,
          "account_method_conflict",
        );
      throw fail(
        message("error5", "Account service is unavailable. Please try again."),
        502,
      );
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw fail(message("error6", "Invalid account service response."), 502);
    }
    check(ticket);
    if (
      !value ||
      typeof value !== "object" ||
      value.ok === false ||
      value.success === false
    )
      throw fail(message("error7", "Sign-in could not be completed."), 502);
    return value;
  }
  async function config(ticket) {
    const value = await call(
      api,
      `/api/v1/app-auth/mobile/config?${new URLSearchParams(binding)}`,
      undefined,
      undefined,
      ticket,
    );
    if (
      Object.entries(binding).some(([key, v]) => value[key] !== v) ||
      value.codeChallengeMethod !== "S256" ||
      !Array.isArray(value.scopes) ||
      value.scopes.length !== 1 ||
      value.scopes[0] !== "cloud:user"
    )
      throw fail(
        message("error8", "Application account registration is unavailable."),
        503,
      );
    return {
      available: true,
      pending: Boolean(await pendingStore.read()),
      appName: typeof value.app?.name === "string" ? value.app.name : appName,
      scopes: ["cloud:user"],
    };
  }
  const checkBilling = (scope, ticket) => {
    check(ticket);
    if (scope !== billingScope)
      throw fail(
        "Account verification was cleared. Start again.",
        409,
        "billing_session_changed",
      );
  };
  const clearBilling = () => {
    billingScope = {};
    accountMethods?.reset();
    billing = null;
    billingAttempt = null;
  };
  /** Binds an interactive session to the exact active credential it was verified for. */
  function retainBilling(token, credential) {
    const now = Date.now();
    const expiresAt = Math.min(
      sessionExpiry(token) ?? now + BILLING_DEFAULT_MS,
      now + BILLING_MAX_MS,
    );
    billing =
      expiresAt - BILLING_SKEW_MS > now
        ? Object.freeze({
            token,
            expiresAt,
            credential: fingerprint(credential),
          })
        : null;
    return billing;
  }
  async function account(token, ticket) {
    const value = await call(api, "/api/v1/user", undefined, token, ticket);
    if (
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.organization_id !== "string" ||
      !value.organization_id
    )
      throw fail(
        message("error32", "Account service returned no account."),
        502,
      );
    return {
      id: value.id,
      organizationId: value.organization_id,
      email: typeof value.email === "string" ? value.email : null,
      phone: typeof value.phone_number === "string" ? value.phone_number : null,
    };
  }
  async function confirmBilling(value, ticket, scope) {
    checkBilling(scope, ticket);
    if (value.mfaRequired === true) {
      if (
        !value.mfa ||
        !["totp", "sms", "passkey"].includes(value.mfa.type) ||
        typeof value.mfa.challengeId !== "string" ||
        !validTime(value.mfa.expiresAt)
      )
        throw fail(
          message("error11", "Invalid account verification response."),
          502,
        );
      billingAttempt.mfa = value.mfa;
      billingAttempt.expiresAt = Math.min(
        billingAttempt.expiresAt,
        Date.parse(value.mfa.expiresAt),
      );
      return {
        status: "mfa",
        method: value.mfa.type,
        sessionId: billingAttempt.id,
        expiresAt: new Date(billingAttempt.expiresAt).toISOString(),
      };
    }
    if (
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.token.length > 16384
    )
      throw fail(
        message("error12", "Account service returned no session."),
        502,
      );
    const expected = billingAttempt;
    const verified = await account(value.token, ticket);
    const active = await readActive();
    checkBilling(scope, ticket);
    if (!active || fingerprint(active) !== expected.credential) {
      clearBilling();
      throw fail(
        message(
          "error33",
          "The connected account changed. Start the payment check again.",
        ),
        409,
        "billing_account_changed",
      );
    }
    if (
      verified.id !== expected.account.id ||
      verified.organizationId !== expected.account.organizationId ||
      (expected.purpose === "account" &&
        personalSessionUser(value.token) !== verified.id)
    ) {
      clearBilling();
      throw fail(
        message(
          "error34",
          "That code belongs to a different account than the one connected here.",
        ),
        403,
        "billing_account_mismatch",
      );
    }
    billingAttempt = null;
    const retained = retainBilling(value.token, active);
    if (!retained)
      throw fail(
        message("error9", "Sign-in expired. Start again."),
        410,
        "billing_session_expired",
      );
    return {
      status: "authorized",
      expiresAt: new Date(retained.expiresAt).toISOString(),
    };
  }
  /** Re-verifies the connected person for billing without touching the stored credential. */
  async function billingOperation(operation, input, ticket, scope) {
    if (operation === "billing-status") {
      const authority = await currentBilling();
      return authority
        ? { status: "authorized", expiresAt: authority.expiresAt }
        : { status: "required" };
    }
    if (operation === "billing-start") {
      if (
        input.purpose !== undefined &&
        !["billing", "account"].includes(input.purpose)
      )
        throw fail("Choose a supported verification purpose.");
      const purpose = input.purpose ?? "billing";
      const active = await readActive();
      checkBilling(scope, ticket);
      if (!active)
        throw fail(
          message("error35", "Connect an account before managing billing."),
          409,
          "billing_not_enrolled",
        );
      if (billingAttempt && Date.now() < billingAttempt.resendAt)
        throw fail(
          message(
            "error28",
            "Please wait a minute before requesting another code.",
          ),
          429,
        );
      if (
        input.method !== undefined &&
        !["email", "phone"].includes(input.method)
      )
        throw fail(message("error25", "Choose email or phone sign-in."));
      const owner = await account(active, ticket);
      checkBilling(scope, ticket);
      const method =
        input.method ??
        (input.phone !== undefined
          ? "phone"
          : input.email !== undefined || owner.email
            ? "email"
            : "phone");
      const destination =
        method === "phone"
          ? (input.phone ?? owner.phone)
          : (input.email ?? owner.email);
      if (
        method === "phone" &&
        (typeof destination !== "string" || !PHONE_RE.test(destination))
      )
        throw fail(
          message(
            "error26",
            "Enter a phone number with its country calling code.",
          ),
          400,
          "billing_destination_required",
        );
      if (
        method === "email" &&
        (typeof destination !== "string" ||
          destination.length > 254 ||
          !EMAIL_RE.test(destination))
      )
        throw fail(
          message("error27", "Enter a valid email address."),
          400,
          "billing_destination_required",
        );
      const identity =
        method === "phone" ? { phone: destination } : { email: destination };
      const value = await call(
          auth,
          method === "phone" ? "/auth/sms/send" : "/auth/email/send",
          {
            ...identity,
            ...(purpose === "account" ? {} : { tenantId: tenant }),
          },
          undefined,
          ticket,
        ),
        data = value.data ?? value;
      checkBilling(scope, ticket);
      if (!validTime(data.expiresAt))
        throw fail(
          message("error29", "Account service returned no code expiry."),
          502,
        );
      billingAttempt = {
        purpose,
        id: opaque(),
        method,
        identity,
        account: { id: owner.id, organizationId: owner.organizationId },
        credential: fingerprint(active),
        expiresAt: Math.min(
          Date.parse(data.expiresAt),
          Date.now() + 15 * 60 * 1000,
        ),
        resendAt: Date.now() + 60000,
      };
      return {
        status: "code",
        method,
        destination: maskDestination(method, destination),
        sessionId: billingAttempt.id,
        expiresAt: new Date(billingAttempt.expiresAt).toISOString(),
        resendAt: billingAttempt.resendAt,
      };
    }
    if (
      !billingAttempt ||
      input.sessionId !== billingAttempt.id ||
      Date.now() >= billingAttempt.expiresAt
    )
      throw fail(
        message("error9", "Sign-in expired. Start again."),
        410,
        "billing_session_expired",
      );
    if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
      throw fail(message("error30", "Enter the six-digit code."));
    if (operation === "billing-verify" && !billingAttempt.mfa)
      return await confirmBilling(
        await call(
          auth,
          billingAttempt.method === "phone"
            ? "/auth/sms/verify"
            : "/auth/email/code/verify",
          {
            ...billingAttempt.identity,
            code: input.code,
            ...(billingAttempt.purpose === "account"
              ? {}
              : { tenantId: tenant }),
          },
          undefined,
          ticket,
        ),
        ticket,
        scope,
      );
    if (
      operation === "billing-mfa" &&
      ["totp", "sms"].includes(billingAttempt.mfa?.type)
    )
      return await confirmBilling(
        await call(
          auth,
          `/auth/mfa/${billingAttempt.mfa.type}/complete`,
          { challengeId: billingAttempt.mfa.challengeId, code: input.code },
          undefined,
          ticket,
        ),
        ticket,
        scope,
      );
    throw fail(
      message("error31", "This verification method requires account recovery."),
      409,
      "billing_method_unsupported",
    );
  }
  async function currentBilling() {
    const held = billing;
    if (!held) return null;
    if (Date.now() >= held.expiresAt - BILLING_SKEW_MS) {
      if (billing === held) billing = null;
      return null;
    }
    const active = await readActive();
    if (billing !== held) return null;
    if (!active || fingerprint(active) !== held.credential) {
      billing = null;
      return null;
    }
    return {
      token: held.token,
      expiresAt: new Date(held.expiresAt).toISOString(),
    };
  }
  async function replaceAccountAuthority(token, expectedToken, ticket) {
    const held = await currentBilling();
    check(ticket);
    if (!held || held.token !== expectedToken)
      throw fail("Account session changed", 409);
    const active = await readActive();
    check(ticket);
    const original = await account(active, ticket),
      replacement = await account(token, ticket);
    const latest = await currentBilling();
    check(ticket);
    if (
      !latest ||
      latest.token !== expectedToken ||
      original.id !== replacement.id ||
      original.organizationId !== replacement.organizationId ||
      personalSessionUser(token) !== replacement.id
    ) {
      clearBilling();
      throw fail(
        "Account security check did not match the connected account",
        409,
        "account_verification_mismatch",
      );
    }
    if (!retainBilling(token, active))
      throw fail("Account security check expired", 410);
  }
  accountMethods = createNativeAccountMethods({
    accountLinkRedirectUri,
    getAuthority: async () => {
      const held = await currentBilling();
      return held && personalSessionUser(held.token) ? held : null;
    },
    clearAuthority: clearBilling,
    replaceAuthority: replaceAccountAuthority,
    request: (path, input, token, method, ticket) =>
      call(auth, path, input, token, ticket, method),
  });
  async function finish(ticket, pending, session, scope) {
    if (!validTime(pending.acknowledgeBy))
      throw fail(message("error9", "Sign-in expired. Start again."), 410);
    const result = await call(
      api,
      "/api/v1/app-auth/mobile/ack",
      pending.proof,
      undefined,
      ticket,
    );
    if (
      result.status !== "acknowledged" ||
      result.credentialId !== pending.proof.credentialId ||
      !validTime(result.expiresAt)
    )
      throw fail(
        message("error10", "Account activation was not confirmed. Try again."),
        502,
      );
    check(ticket);
    await activate(pending.proof.secret, () => check(ticket));
    check(ticket);
    await pendingStore.clear();
    check(ticket);
    attempt = null;
    // The session that just minted this credential is also current billing authority.
    if (session && scope === billingScope)
      retainBilling(session, pending.proof.secret);
    return { status: "authenticated", connected: true };
  }
  async function exchange(value, ticket, scope) {
    if (value.mfaRequired === true) {
      if (
        !value.mfa ||
        !["totp", "sms", "passkey"].includes(value.mfa.type) ||
        typeof value.mfa.challengeId !== "string" ||
        !validTime(value.mfa.expiresAt)
      )
        throw fail(
          message("error11", "Invalid account verification response."),
          502,
        );
      attempt.mfa = value.mfa;
      attempt.expiresAt = Math.min(
        attempt.expiresAt,
        Date.parse(value.mfa.expiresAt),
      );
      return {
        status: "mfa",
        method: value.mfa.type,
        sessionId: attempt.id,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      };
    }
    if (
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.token.length > 16384
    )
      throw fail(
        message("error12", "Account service returned no session."),
        502,
      );
    // The Cloud API verifies the interactive session and tenant; a renderer never supplies it.
    const state = opaque(),
      verifier = opaque();
    const grant = await call(
      api,
      "/api/v1/app-auth/connect",
      {
        flow: "mobile_pkce",
        ...binding,
        state,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        codeChallengeMethod: "S256",
        deviceName,
      },
      value.token,
      ticket,
    );
    if (
      grant.codeType !== "mobile_app_auth_code" ||
      typeof grant.code !== "string" ||
      !validTime(grant.expiresAt)
    )
      throw fail(
        message("error13", "Account authorization was not confirmed."),
        502,
      );
    const proof = {
      ...binding,
      state,
      code: grant.code,
      codeVerifier: verifier,
    };
    const credential = await call(
      api,
      "/api/v1/app-auth/mobile/token",
      { ...proof, grantType: "authorization_code" },
      undefined,
      ticket,
    );
    if (
      credential.acknowledgementRequired !== true ||
      credential.tokenType !== "Bearer" ||
      typeof credential.secret !== "string" ||
      credential.secret.length < 20 ||
      credential.secret.length > 512 ||
      typeof credential.credentialId !== "string" ||
      !validTime(credential.acknowledgeBy)
    )
      throw fail(
        message("error14", "Invalid account credential response."),
        502,
      );
    const pending = {
      version: 1,
      acknowledgeBy: credential.acknowledgeBy,
      proof: {
        ...proof,
        credentialId: credential.credentialId,
        secret: credential.secret,
      },
    };
    check(ticket);
    await pendingStore.write(JSON.stringify(pending));
    check(ticket);
    // Durable encrypted receipt precedes activation; an interrupted acknowledgement can be retried.
    return finish(ticket, pending, value.token, scope);
  }
  return {
    /**
     * Trusted-host only: the in-memory Steward session for organization billing routes,
     * or null when absent, expired or no longer bound to the active credential. Never
     * forward it to a renderer.
     */
    billingAuthority: currentBilling,
    clearBillingAuthority() {
      clearBilling();
    },
    async cancel({ disconnect = false } = {}) {
      if (cancelling)
        throw fail(
          message("error15", "Cancellation is already in progress."),
          409,
        );
      cancelling = true;
      epoch++;
      attempt = null;
      clearBilling();
      try {
        await settled;
        let raw = await pendingStore.read();
        if (raw) {
          let saved;
          try {
            saved = JSON.parse(raw);
          } catch {
            throw fail(
              message("error16", "Saved sign-in needs account recovery."),
              409,
            );
          }
          if (typeof saved?.proof?.secret !== "string")
            throw fail(
              message("error16", "Saved sign-in needs account recovery."),
              409,
            );
          if (saved.kind !== "revocation") {
            // Cancellation is irreversible locally once journaled, even if the
            // remote response is lost. Never offer this receipt for activation.
            raw = JSON.stringify({ ...saved, kind: "revocation" });
            await pendingStore.write(raw);
          }
        }
        if (disconnect) {
          const active = await readActive();
          if (active && /^eliza_(?:mobile_)?[0-9a-f]{64}$/.test(active)) {
            if (raw) {
              let saved;
              try {
                saved = JSON.parse(raw);
              } catch {
                throw fail(
                  message("error16", "Saved sign-in needs account recovery."),
                  409,
                );
              }
              if (saved?.proof?.secret !== active)
                throw fail(
                  message(
                    "error17",
                    "Finish the saved sign-in cancellation before disconnecting.",
                  ),
                  409,
                );
            } else {
              // Journal first: a crash or lost revoke response must not lose the
              // only authority that can retrieve Cloud's exact-key tombstone.
              raw = JSON.stringify({
                version: 1,
                kind: "revocation",
                proof: { secret: active },
              });
              await pendingStore.write(raw);
            }
          }
          await clearActive();
        }
        if (raw) {
          let saved;
          try {
            saved = JSON.parse(raw);
          } catch {
            throw fail(
              message("error16", "Saved sign-in needs account recovery."),
              409,
            );
          }
          if (typeof saved?.proof?.secret !== "string")
            throw fail(
              message("error16", "Saved sign-in needs account recovery."),
              409,
            );
          const response = await fetchImpl(`${api}/api/v1/api-keys/current`, {
            method: "DELETE",
            redirect: "error",
            signal: AbortSignal.timeout(30000),
            headers: {
              Authorization: `Bearer ${saved.proof.secret}`,
              Accept: "application/json",
            },
          });
          if (!response.ok)
            throw fail(
              saved.kind === "revocation"
                ? "Cloud revocation is not confirmed. Reconnect and select Finish disconnecting."
                : "Cancellation is not confirmed. Reconnect and try Cancel again.",
              502,
            );
          const result = await response.json();
          if (
            result.success !== true ||
            result.status !== "revoked" ||
            (saved.proof.credentialId
              ? result.credentialId !== saved.proof.credentialId
              : saved.kind !== "revocation" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  result.credentialId ?? "",
                )) ||
            !Number.isFinite(Date.parse(result.revokedAt))
          )
            throw fail(
              message("error18", "Cancellation is not confirmed."),
              502,
            );
          // The superseded attempt may have activated this key before cancel
          // caught up with it. Cloud has now confirmed it is revoked, so it
          // must not stay the host's active credential. (Until confirmation,
          // an outage keeps it, as for any unconfirmed revocation.)
          if (!disconnect && (await readActive()) === saved.proof.secret)
            await clearActive();
        }
        await pendingStore.clear();
        return { status: "cancelled" };
      } finally {
        cancelling = false;
      }
    },
    async handle(operation, input = {}) {
      if (operation === "cancel") return this.cancel();
      if (busy || cancelling)
        throw fail(
          message("error19", "A sign-in request is already in progress."),
          409,
        );
      busy = true;
      settled = new Promise((resolve) => {
        settle = resolve;
      });
      const ticket = epoch,
        scope = billingScope;
      try {
        if (typeof operation === "string" && operation.startsWith("account-"))
          return await accountMethods.handle(operation, input, ticket);
        if (BILLING_OPERATIONS.includes(operation))
          return await billingOperation(operation, input, ticket, scope);
        if (operation === "config") return await config(ticket);
        if (operation === "resume") {
          const raw = await pendingStore.read();
          check(ticket);
          if (!raw) return { status: "none" };
          let pending;
          try {
            pending = JSON.parse(raw);
          } catch {
            throw fail(
              message("error20", "Saved sign-in is invalid. Start again."),
              409,
            );
          }
          if (pending?.kind === "revocation")
            throw fail(
              message(
                "error21",
                "Disconnect is not confirmed. Select Cancel to retry disconnecting.",
              ),
              409,
            );
          if (
            pending?.version !== 1 ||
            !pending.proof ||
            Object.entries(binding).some(([k, v]) => pending.proof[k] !== v)
          )
            throw fail(
              message(
                "error22",
                "Saved sign-in does not match this application.",
              ),
              409,
            );
          return await finish(ticket, pending);
        }
        if (operation === "start") {
          clearBilling();
          if (await readActive())
            throw fail(
              message(
                "error23",
                "Disconnect the current account before signing in again.",
              ),
              409,
            );
          if (await pendingStore.read())
            throw fail(
              message(
                "error24",
                "A saved sign-in needs to be finished or cancelled first.",
              ),
              409,
            );
          check(ticket);
          const method = input.method ?? "email";
          if (!["email", "phone"].includes(method))
            throw fail(message("error25", "Choose email or phone sign-in."));
          if (
            method === "phone" &&
            (typeof input.phone !== "string" ||
              !/^\+[1-9]\d{7,14}$/.test(input.phone))
          )
            throw fail(
              message(
                "error26",
                "Enter a phone number with its country calling code.",
              ),
            );
          if (
            method === "email" &&
            (typeof input.email !== "string" ||
              input.email.length > 254 ||
              !/^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(
                input.email,
              ))
          )
            throw fail(message("error27", "Enter a valid email address."));
          if (attempt && Date.now() < attempt.resendAt)
            throw fail(
              message(
                "error28",
                "Please wait a minute before requesting another code.",
              ),
              429,
            );
          await config(ticket);
          await beforeStart();
          check(ticket);
          const identity =
            method === "phone"
              ? { phone: input.phone }
              : { email: input.email };
          const value = await call(
              auth,
              method === "phone" ? "/auth/sms/send" : "/auth/email/send",
              { ...identity, tenantId: tenant },
              undefined,
              ticket,
            ),
            data = value.data ?? value;
          if (!validTime(data.expiresAt))
            throw fail(
              message("error29", "Account service returned no code expiry."),
              502,
            );
          attempt = {
            id: opaque(),
            method,
            ...identity,
            expiresAt: Math.min(
              Date.parse(data.expiresAt),
              Date.now() + 15 * 60 * 1000,
            ),
            resendAt: Date.now() + 60000,
          };
          return {
            status: "code",
            sessionId: attempt.id,
            expiresAt: new Date(attempt.expiresAt).toISOString(),
            resendAt: attempt.resendAt,
          };
        }
        if (
          !attempt ||
          input.sessionId !== attempt.id ||
          Date.now() >= attempt.expiresAt
        )
          throw fail(message("error9", "Sign-in expired. Start again."), 410);
        if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
          throw fail(message("error30", "Enter the six-digit code."));
        if (operation === "verify" && !attempt.mfa)
          return await exchange(
            await call(
              auth,
              attempt.method === "phone"
                ? "/auth/sms/verify"
                : "/auth/email/code/verify",
              {
                ...(attempt.method === "phone"
                  ? { phone: attempt.phone }
                  : { email: attempt.email }),
                code: input.code,
                tenantId: tenant,
              },
              undefined,
              ticket,
            ),
            ticket,
            scope,
          );
        if (operation === "mfa" && ["totp", "sms"].includes(attempt.mfa?.type))
          return await exchange(
            await call(
              auth,
              `/auth/mfa/${attempt.mfa.type}/complete`,
              { challengeId: attempt.mfa.challengeId, code: input.code },
              undefined,
              ticket,
            ),
            ticket,
            scope,
          );
        throw fail(
          message(
            "error31",
            "This verification method requires account recovery.",
          ),
          409,
        );
      } finally {
        busy = false;
        settle();
      }
    },
  };
}
