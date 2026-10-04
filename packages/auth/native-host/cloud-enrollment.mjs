import { createHash, randomBytes } from "node:crypto";

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const opaque = () => randomBytes(32).toString("base64url");
const validTime = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) > Date.now();
/** Private gateway enrollment. JWTs, PKCE material and app credentials never leave this module. */
export function createNativeCloudAuth({
  fetchImpl = fetch,
  api = "https://api.eliza.app",
  auth = "https://eliza.steward.fi",
  tenant = "elizacloud",
  binding,
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
  let attempt = null,
    busy = false,
    cancelling = false,
    epoch = 0,
    settled = Promise.resolve(),
    settle;
  const check = (ticket) => {
    if (ticket !== epoch)
      throw fail(message("error1", "Sign-in cancelled. Start again."), 409);
  };
  async function call(base, path, input, token, ticket) {
    check(ticket);
    const response = await fetchImpl(base + path, {
      method: input === undefined ? "GET" : "POST",
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
      "/api/v1/app-auth/mobile/config?" + new URLSearchParams(binding),
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
  async function finish(ticket, pending) {
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
    return { status: "authenticated", connected: true };
  }
  async function exchange(value, ticket) {
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
    return finish(ticket, pending);
  }
  return {
    async cancel({ disconnect = false } = {}) {
      if (cancelling)
        throw fail(
          message("error15", "Cancellation is already in progress."),
          409,
        );
      cancelling = true;
      epoch++;
      attempt = null;
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
          if (typeof saved.proof?.secret !== "string")
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
              if (saved.proof?.secret !== active)
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
          if (typeof saved.proof?.secret !== "string")
            throw fail(
              message("error16", "Saved sign-in needs account recovery."),
              409,
            );
          const response = await fetchImpl(api + "/api/v1/api-keys/current", {
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
      const ticket = epoch;
      try {
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
          if (pending.kind === "revocation")
            throw fail(
              message(
                "error21",
                "Disconnect is not confirmed. Select Cancel to retry disconnecting.",
              ),
              409,
            );
          if (
            pending.version !== 1 ||
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
