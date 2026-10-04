import { createHash, randomBytes } from "node:crypto";

const fail = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, code });
const opaque = () => randomBytes(24).toString("base64url");
const string = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const phone = /^\+[1-9]\d{7,14}$/;
const fields = (input, allowed) => {
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw fail("Unexpected account method fields");
};
// This is a conservative presentation/admission check, not signature verification.
// Auth independently checks the session and the MFA timestamp on every mutation.
function recentMfa(token, now) {
  try {
    const at = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).mfaVerifiedAt;
    return Number.isSafeInteger(at) && at > 0 && at <= now && now - at < 270000;
  } catch {
    return false;
  }
}
function inventory(value) {
  const data = value?.data;
  if (
    value?.ok !== true ||
    !Array.isArray(data?.accounts) ||
    !Array.isArray(data.primaryLoginMethods)
  )
    throw fail("Sign-in methods are unavailable", 502);
  const ids = new Set();
  for (const item of data.accounts) {
    if (
      !string(item?.id) ||
      ids.has(item.id) ||
      !string(item.provider) ||
      !string(item.providerAccountId)
    )
      throw fail("Sign-in methods are unavailable", 502);
    ids.add(item.id);
  }
  for (const item of data.primaryLoginMethods) {
    if (
      !["email", "wallet"].includes(item?.provider) ||
      !string(item.providerAccountId)
    )
      throw fail("Sign-in methods are unavailable", 502);
  }
  return data;
}
function label(provider, id) {
  if (provider === "email" && id.includes("@"))
    return `${id[0]}•••${id.slice(id.indexOf("@"))}`;
  if (provider === "phone" || provider === "whatsapp") return "Phone sign-in";
  if (provider === "google") return "Google sign-in";
  if (provider === "passkey") return "Passkey";
  return "Linked sign-in method";
}
/** Private host adapter. No token, provider account identifier or OTP is returned. */
export function createNativeAccountMethods({
  getAuthority,
  request,
  clearAuthority,
  replaceAuthority,
  now = Date.now,
  accountLinkRedirectUri,
}) {
  let oauthOutcome = null;
  let oauthAttempt = null,
    oauthEpoch = 0;
  let review = null,
    attempt = null,
    security = null,
    enrollment = null,
    resendAt = 0;
  const reset = () => {
    oauthAttempt = null;
    oauthOutcome = null;
    oauthEpoch++;
    review = null;
    attempt = null;
    security = null;
    enrollment = null;
    resendAt = 0;
  };
  async function authority(expected) {
    const value = await getAuthority();
    if (
      !value ||
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.token.length > 16384 ||
      !(Date.parse(value.expiresAt) > now()) ||
      (expected && value.token !== expected.token)
    ) {
      reset();
      throw fail(
        "Confirm your identity before managing sign-in methods",
        428,
        "account_verification_required",
      );
    }
    return value;
  }
  async function call(path, input, current, method, ticket) {
    await authority(current);
    const result = await request(path, input, current.token, method, ticket);
    await authority(current);
    return result;
  }
  const requireMfa = (current) => {
    if (!recentMfa(current.token, now()))
      throw fail(
        "A recent security check is required before changing sign-in methods",
        428,
        "account_mfa_required",
      );
  };
  return {
    reset,
    async handle(operation, input = {}, ticket) {
      const current = await authority();
      const send = (path, input, method) =>
        call(path, input, current, method, ticket);
      if (operation === "account-google-status") {
        fields(input, []);
        if (oauthAttempt?.token === current.token) {
          if (oauthAttempt.expiresAt <= now()) {
            oauthAttempt = null;
            return { status: "expired" };
          }
          return {
            status: "pending",
            expiresAt: new Date(oauthAttempt.expiresAt).toISOString(),
          };
        }
        return {
          status:
            oauthOutcome?.token === current.token
              ? oauthOutcome.status
              : "idle",
        };
      }
      if (operation === "account-google-cancel") {
        fields(input, []);
        oauthAttempt = null;
        oauthEpoch++;
        oauthOutcome = { token: current.token, status: "cancelled" };
        return { status: "cancelled" };
      }
      if (operation === "account-google-start") {
        fields(input, []);
        requireMfa(current);
        let redirect;
        try {
          redirect = new URL(accountLinkRedirectUri);
        } catch {}
        if (
          redirect?.protocol !== "https:" ||
          redirect.username ||
          redirect.password ||
          redirect.search ||
          redirect.hash
        )
          throw fail("Google sign-in linking is not configured", 503);
        const generation = ++oauthEpoch;
        oauthAttempt = null;
        oauthOutcome = null;
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const response = await send(
          "/user/me/accounts/oauth/google/challenge",
          {
            redirectUri: redirect.href,
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
          },
        );
        if (generation !== oauthEpoch)
          throw fail("Google linking was cancelled", 409);
        const data = response?.data;
        let url;
        try {
          url = new URL(data?.authorizationUrl);
        } catch {}
        const params = url?.searchParams;
        const required = {
          state: data?.state,
          redirect_uri: redirect.href,
          code_challenge: challenge,
          code_challenge_method: "S256",
          response_type: "code",
        };
        const scopes = params?.get("scope")?.split(/ +/) ?? [];
        if (
          response?.ok !== true ||
          !string(data?.state) ||
          data.redirectUri !== redirect.href ||
          !Number.isSafeInteger(data.expiresIn) ||
          data.expiresIn <= 0 ||
          data.expiresIn > 300 ||
          !url ||
          url.origin !== "https://accounts.google.com" ||
          url.pathname !== "/o/oauth2/v2/auth" ||
          url.username ||
          url.password ||
          url.hash ||
          [...params.keys()].some(
            (key) =>
              ![...Object.keys(required), "client_id", "scope"].includes(key),
          ) ||
          !string(params.get("client_id")) ||
          params.getAll("client_id").length !== 1 ||
          Object.entries(required).some(
            ([key, value]) =>
              params.getAll(key).length !== 1 || params.get(key) !== value,
          ) ||
          scopes.length !== 3 ||
          new Set(scopes).size !== 3 ||
          scopes.some(
            (scope) => !["openid", "email", "profile"].includes(scope),
          ) ||
          params.getAll("scope").length !== 1
        )
          throw fail(
            "Google sign-in linking response could not be verified",
            502,
          );
        const id = opaque(),
          expiresAt = Math.min(
            now() + data.expiresIn * 1000,
            Date.parse(current.expiresAt),
          );
        oauthAttempt = {
          id,
          verifier,
          state: data.state,
          redirect: redirect.href,
          expiresAt,
          token: current.token,
          generation,
        };
        return {
          sessionId: id,
          authorizationUrl: url.href,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }
      if (
        operation === "account-google-complete" ||
        operation === "account-google-return"
      ) {
        fields(
          input,
          operation === "account-google-return"
            ? ["callbackUrl"]
            : ["sessionId", "callbackUrl"],
        );
        requireMfa(current);
        const pending = oauthAttempt;
        if (
          !pending ||
          (operation === "account-google-complete" &&
            pending.id !== input.sessionId) ||
          pending.token !== current.token ||
          pending.expiresAt <= now()
        ) {
          oauthAttempt = null;
          throw fail("Google linking expired. Start again", 410);
        }
        let callback;
        try {
          callback = new URL(input.callbackUrl);
        } catch {}
        const expected = new URL(pending.redirect);
        if (
          !callback ||
          callback.origin !== expected.origin ||
          callback.pathname !== expected.pathname ||
          callback.username ||
          callback.password ||
          callback.hash ||
          callback.searchParams.getAll("state").length !== 1 ||
          callback.searchParams.get("state") !== pending.state
        )
          throw fail("Google linking return could not be verified", 400);
        const params = callback.searchParams;
        if (params.has("error")) {
          if (params.getAll("error").length !== 1 || params.has("code"))
            throw fail("Google linking return could not be verified", 400);
          oauthAttempt = null;
          oauthOutcome = { token: current.token, status: "cancelled" };
          return { status: "cancelled" };
        }
        const code = params.get("code");
        if (
          !code ||
          code.length > 4096 ||
          /[\p{Cc}\p{Cf}]/u.test(code) ||
          params.getAll("code").length !== 1
        )
          throw fail("Google linking return could not be verified", 400);
        // Consume before exchange: lost responses must never replay a provider code.
        oauthAttempt = null;
        review = null;
        try {
          const response = await send("/user/me/accounts/oauth/google/token", {
            code,
            state: pending.state,
            redirectUri: pending.redirect,
            codeVerifier: pending.verifier,
          });
          if (pending.generation !== oauthEpoch)
            throw fail("Google linking outcome needs review", 502);
          if (
            response?.ok !== true ||
            response.data?.account?.provider !== "google" ||
            !string(response.data.account.id) ||
            !string(response.data.account.providerAccountId)
          )
            throw fail("Google linking was not confirmed", 502);
          oauthOutcome = { token: current.token, status: "linked" };
          return { status: "linked" };
        } catch (error) {
          if (pending.generation === oauthEpoch)
            oauthOutcome = {
              token: current.token,
              status: [400, 401, 403, 409, 429].includes(error.status)
                ? "failed"
                : "unknown",
            };
          if (![400, 401, 403, 409, 429].includes(error.status))
            throw fail(
              "Check your sign-in methods before trying again",
              502,
              "account_outcome_unknown",
            );
          throw error;
        }
      }
      if (operation === "account-methods") {
        fields(input, []);
        const data = inventory(await send("/user/me/accounts"));
        const id = opaque(),
          expiresAt = new Date(
            Math.min(now() + 60000, Date.parse(current.expiresAt)),
          ).toISOString();
        review = {
          id,
          expiresAt,
          token: current.token,
          accounts: data.accounts.map((item) => ({
            id: item.id,
            provider: item.provider,
            providerAccountId: item.providerAccountId,
            removable: item.providerApp === undefined,
          })),
        };
        const total =
          data.accounts.filter((item) => item.providerApp === undefined)
            .length + data.primaryLoginMethods.length;
        return {
          reviewId: id,
          expiresAt,
          securityCheckRequired: !recentMfa(current.token, now()),
          methods: [
            ...data.primaryLoginMethods.map((item, index) => ({
              id: `primary-${index}`,
              provider: item.provider,
              label: label(item.provider, item.providerAccountId),
              primary: true,
              removable: false,
            })),
            ...data.accounts.map((item) => ({
              id: item.id,
              provider: item.provider,
              label: label(item.provider, item.providerAccountId),
              primary: false,
              removable: item.providerApp === undefined && total > 1,
            })),
          ],
        };
      }
      if (operation === "account-security-enroll-start") {
        fields(input, ["phone"]);
        if (typeof input.phone !== "string" || !phone.test(input.phone))
          throw fail("Enter a phone number with its country calling code");
        if (now() < resendAt)
          throw fail(
            "Wait before requesting another code",
            429,
            "account_code_cooldown",
          );
        enrollment = null;
        // Auth checks recent factor-enrollment authority and any existing durable
        // factor. Enrollment never substitutes an ordinary login for required MFA.
        for (const method of ["totp", "sms"]) {
          const status = await send(`/auth/mfa/${method}/status`);
          if (status?.ok !== true || typeof status.enabled !== "boolean")
            throw fail("Security methods are unavailable", 502);
          if (status.enabled)
            throw fail(
              "Use your existing security method",
              409,
              "account_security_already_enabled",
            );
        }
        resendAt = now() + 60000;
        const value = await send("/auth/mfa/sms/enroll", {
          phone: input.phone,
        });
        const expiry = Date.parse(value?.expiresAt);
        if (
          value?.ok !== true ||
          !Number.isFinite(expiry) ||
          expiry <= now() ||
          value.phone !== `***${input.phone.slice(-4)}`
        )
          throw fail("Security code delivery was not confirmed", 502);
        enrollment = {
          id: opaque(),
          token: current.token,
          destination: value.phone,
          expiresAt: Math.min(expiry, now() + 300000),
        };
        return {
          status: "code",
          sessionId: enrollment.id,
          destination: enrollment.destination,
          expiresAt: new Date(enrollment.expiresAt).toISOString(),
          resendAt,
        };
      }
      if (operation === "account-security-enroll-verify") {
        fields(input, ["sessionId", "code"]);
        if (
          !enrollment ||
          enrollment.id !== input.sessionId ||
          enrollment.token !== current.token ||
          enrollment.expiresAt <= now()
        )
          throw fail(
            "Start security setup again",
            410,
            "account_security_expired",
          );
        if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
          throw fail("Enter the six-digit code");
        const pending = enrollment;
        try {
          const value = await send("/auth/mfa/sms/verify", {
            code: input.code,
          });
          if (
            value?.ok !== true ||
            value.enabled !== true ||
            value.phone !== pending.destination
          )
            throw fail("Security setup was not confirmed", 502);
          clearAuthority();
          reset();
          return { status: "enabled", reauthenticationRequired: true };
        } catch (error) {
          if (![400, 401, 403, 409, 429].includes(error.status)) {
            // Auth may have enabled the factor and revoked this session. Never
            // replay the code after losing the response; require fresh identity.
            clearAuthority();
            reset();
            throw fail(
              "Confirm your identity and check your security methods before trying again",
              502,
              "account_security_enrollment_unknown",
            );
          }
          throw error;
        }
      }
      if (operation === "account-security-status") {
        fields(input, []);
        const methods = [];
        for (const method of ["totp", "sms"]) {
          const value = await send(`/auth/mfa/${method}/status`);
          if (value?.ok !== true || typeof value.enabled !== "boolean")
            throw fail("Security methods are unavailable", 502);
          if (value.enabled) methods.push(method);
        }
        return { methods, recentlyVerified: recentMfa(current.token, now()) };
      }
      if (operation === "account-security-start") {
        fields(input, ["method"]);
        if (!["totp", "sms"].includes(input.method))
          throw fail("Choose an available security method");
        const status = await send(`/auth/mfa/${input.method}/status`);
        if (status?.ok !== true || status.enabled !== true)
          throw fail(
            "This security method is not enabled",
            409,
            "account_security_not_enabled",
          );
        security = null;
        let expiresAt = now() + 300000;
        if (input.method === "sms") {
          if (now() < resendAt)
            throw fail(
              "Wait before requesting another code",
              429,
              "account_code_cooldown",
            );
          resendAt = now() + 60000;
          const value = await send("/auth/mfa/sms/send", {});
          if (
            value?.ok !== true ||
            !Number.isFinite(Date.parse(value.expiresAt)) ||
            Date.parse(value.expiresAt) <= now()
          )
            throw fail("Security code delivery was not confirmed", 502);
          expiresAt = Math.min(expiresAt, Date.parse(value.expiresAt));
        }
        security = {
          id: opaque(),
          method: input.method,
          token: current.token,
          expiresAt,
        };
        return {
          status: "code",
          method: security.method,
          sessionId: security.id,
          expiresAt: new Date(expiresAt).toISOString(),
          ...(input.method === "sms" ? { resendAt } : {}),
        };
      }
      if (operation === "account-security-verify") {
        fields(input, ["sessionId", "code"]);
        if (
          !security ||
          security.id !== input.sessionId ||
          security.token !== current.token ||
          security.expiresAt <= now()
        )
          throw fail(
            "Start the security check again",
            410,
            "account_security_expired",
          );
        if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
          throw fail("Enter the six-digit code");
        try {
          const value = await send(`/auth/mfa/${security.method}/step-up`, {
            code: input.code,
          });
          if (
            value?.ok !== true ||
            typeof value.token !== "string" ||
            value.token.length < 20 ||
            value.token.length > 16384 ||
            !recentMfa(value.token, now())
          )
            throw fail("Security check was not confirmed", 502);
          security = null;
          await replaceAuthority(value.token, current.token, ticket);
          reset();
          return { status: "verified" };
        } catch (error) {
          if (![400, 401, 403, 409, 429].includes(error.status)) {
            security = null;
            throw fail(
              "Security check was not confirmed. Start it again.",
              502,
              "account_security_unknown",
            );
          }
          throw error;
        }
      }
      if (operation === "account-phone-start") {
        fields(input, ["phone"]);
        if (typeof input.phone !== "string" || !phone.test(input.phone))
          throw fail("Enter a phone number with its country calling code");
        requireMfa(current);
        if (now() < resendAt)
          throw fail(
            "Wait before requesting another code",
            429,
            "account_code_cooldown",
          );
        attempt = null;
        resendAt = now() + 60000;
        const result = await send("/user/me/accounts/phone/sms/send", {
          phone: input.phone,
        });
        const expiry = Date.parse(result?.data?.expiresAt);
        if (result?.ok !== true || !Number.isFinite(expiry) || expiry <= now())
          throw fail("The sign-in code request was not confirmed", 502);
        attempt = {
          id: opaque(),
          phone: input.phone,
          token: current.token,
          expiresAt: Math.min(expiry, now() + 900000),
        };
        return {
          status: "code",
          sessionId: attempt.id,
          destination: `•••${input.phone.slice(-4)}`,
          expiresAt: new Date(attempt.expiresAt).toISOString(),
          resendAt,
        };
      }
      if (operation === "account-phone-verify") {
        fields(input, ["sessionId", "code"]);
        requireMfa(current);
        if (
          !attempt ||
          input.sessionId !== attempt.id ||
          attempt.token !== current.token ||
          now() >= attempt.expiresAt
        )
          throw fail("Request a new sign-in code", 410, "account_code_expired");
        if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
          throw fail("Enter the six-digit code");
        const pending = attempt;
        try {
          const result = await send("/user/me/accounts/phone/sms/verify", {
            phone: pending.phone,
            code: input.code,
          });
          if (
            result?.ok !== true ||
            !string(result?.data?.account?.id) ||
            result.data.account.provider !== "phone" ||
            result.data.account.providerAccountId !==
              `phone:${createHash("sha256").update(pending.phone).digest("hex")}`
          )
            throw fail("The sign-in method change was not confirmed", 502);
          attempt = null;
          review = null;
          return { status: "linked" };
        } catch (error) {
          // A definite rejected code may be corrected. An ambiguous mutation may only
          // be reconciled through inventory; it must never automatically resend.
          if (![400, 401, 403, 409, 429].includes(error.status)) {
            attempt = null;
            review = null;
            throw fail(
              "Check your sign-in methods before trying again",
              502,
              "account_outcome_unknown",
            );
          }
          throw error;
        }
      }
      if (operation === "account-unlink") {
        fields(input, ["reviewId", "methodId"]);
        requireMfa(current);
        if (
          !review ||
          input.reviewId !== review.id ||
          current.token !== review.token ||
          Date.parse(review.expiresAt) <= now()
        )
          throw fail(
            "Review your current sign-in methods again",
            409,
            "account_review_expired",
          );
        const selected = review.accounts.find(
          (item) => item.id === input.methodId,
        );
        if (!selected?.removable)
          throw fail(
            "Choose a linked sign-in method from the current review",
            409,
          );
        const data = inventory(await send("/user/me/accounts"));
        const live = data.accounts.find(
          (item) =>
            item.id === selected.id &&
            item.provider === selected.provider &&
            item.providerAccountId === selected.providerAccountId,
        );
        if (
          !live ||
          live.providerApp !== undefined ||
          data.accounts.filter((item) => item.providerApp === undefined)
            .length +
            data.primaryLoginMethods.length <=
            1
        )
          throw fail(
            "Keep another sign-in method before removing this one",
            409,
          );
        review = null;
        try {
          const result = await send(
            `/user/me/accounts/${encodeURIComponent(selected.provider)}/${encodeURIComponent(selected.providerAccountId)}`,
            undefined,
            "DELETE",
          );
          if (
            result?.ok !== true ||
            result.data?.deleted !== true ||
            !Number.isSafeInteger(result.data?.issuedBefore)
          )
            throw fail("The sign-in method change was not confirmed", 502);
          clearAuthority();
          reset();
          return { status: "removed", reauthenticationRequired: true };
        } catch (error) {
          if (![400, 401, 403, 404, 409, 429].includes(error.status))
            throw fail(
              "Check your sign-in methods before trying again",
              502,
              "account_outcome_unknown",
            );
          throw error;
        }
      }
      throw fail("Account method operation is unavailable", 404);
    },
  };
}
