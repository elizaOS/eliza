import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createDocumentImageDescriber } from "./document-image-describer.mjs";
import { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
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
      uiMode: data.uiMode === "embedded" ? "embedded" : "elements",
      clientSecret: data.clientSecret,
      publishableKey: data.publishableKey,
      ...(Number.isSafeInteger(data.amountDueCents) &&
      typeof data.currency === "string"
        ? { amountDueCents: data.amountDueCents, currency: data.currency }
        : {}),
      ...(typeof data.interval === "string" ? { interval: data.interval } : {}),
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
  if (
    !hostPolicy ||
    [
      "projectAccountAccess",
      "createNativeCloudAuth",
      "requireNonSensitiveText",
      "pickMessage",
      "fundingError",
    ].some((key) => typeof hostPolicy[key] !== "function") ||
    !Array.isArray(hostPolicy.planKeys) ||
    !hostPolicy.planKeys.length ||
    typeof hostPolicy.planCurrency !== "string" ||
    typeof hostPolicy.planInterval !== "string" ||
    hostPolicy.planKeys.some((key) => typeof key !== "string" || !key) ||
    !/^[A-Za-z0-9-]{1,32}$/.test(hostPolicy.multipartPrefix ?? "") ||
    !/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/.test(hostPolicy.speechLanguage ?? "") ||
    !speechVoice ||
    typeof speechVoice.voiceId !== "string" ||
    typeof speechVoice.modelId !== "string"
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
      if (saved.kind === "revocation")
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
      if (saved.kind === "revocation")
        throw fail(message("finishDisconnectingBeforeUsingCloudServices"), 401);
    }
    return store.read();
  };
  const attempts = new Map(),
    checkoutKeys = new Map();
  let generation = 0;
  const responseEpoch = new WeakMap();
  const nativeAuth = pendingCredentialStore
    ? createNativeCloudAuth({
        fetchImpl,
        api,
        pendingStore: pendingCredentialStore,
        readActive: async () => {
          await credentialWrites;
          return store.read();
        },
        clearActive: () => mutateCredential(() => store.clear()),
        beforeStart: async () => {
          generation++;
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
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
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
    current(epoch);
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
  async function accountAccess() {
    await ready;
    const epoch = generation;
    await credentialWrites;
    const pending = await pendingCredentialStore?.read();
    current(epoch);
    if (pending && JSON.parse(pending).kind === "revocation")
      return { state: "signed_out", disconnectPending: true };
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
      let method = req.method,
        requestInput;
      if (path === "/gmail/status" || path === "/gmail/connect")
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
                ? { allowance: { amountUsd: p.allowance.amountUsd } }
                : {}),
            })),
        });
        return true;
      }
      // Billing uses a short-lived signed-in session held only by the native
      // enrollment host; the inference key is never sent to billing routes.
      const billingMatch = path.match(
        /^\/cloud\/account\/billing\/(start|verify)$/,
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
        const authority = nativeAuth?.billingAuthority?.();
        if (!authority || !(authority.expiresAt > Date.now())) {
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
        generation++;
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
          generation++;
          attempts.clear();
          send(res, 200, await nativeAuth.cancel({ disconnect: true }));
          return true;
        }
        send(res, 200, await nativeAuth.handle(operation, input));
        return true;
      }
      if (method === "POST" && path === "/cloud/login") {
        await body(req);
        const epoch = ++generation;
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
      if (method === "POST" && path === "/voice/tts") {
        // Cloud accepts at most 5000 characters per request; the renderer sends sentence groups.
        const input = await body(req);
        if (
          typeof input.text !== "string" ||
          !input.text.trim() ||
          input.text.length > 5000
        )
          throw fail(message("speechTextRequiredMaximum5000Characters"));
        requireNonSensitiveText(input.text);
        const response = await request("/api/v1/voice/tts", {
          method: "POST",
          json: {
            text: input.text,
            voiceId: speechVoice.voiceId,
            modelId: speechVoice.modelId,
          },
          key,
          signal,
          authorityGeneration: credentialEpoch,
          headers: { Accept: "audio/mpeg" },
        });
        if (!response.ok) await parse(response);
        const mimeType = response.headers.get("content-type") || "";
        if (!mimeType.startsWith("audio/"))
          throw fail(message("invalidSpeechAudio"), 502);
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
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="languageCode"\r\n\r\n${hostPolicy.speechLanguage}\r\n--${boundary}--\r\n`,
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
        send(res, 200, {
          connected: value.connected === true,
          configured: value.configured === true,
          reason,
          identity: email ? { email } : null,
          grantedCapabilities:
            Array.isArray(value.grantedCapabilities) &&
            value.grantedCapabilities.includes("google.gmail.triage")
              ? ["google.gmail.triage"]
              : [],
        });
        return true;
      }
      if (method === "POST" && path === "/cloud/gmail/connect") {
        await body(req);
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
            `/api/v1/eliza/google/gmail/search?side=owner&maxResults=${maxResults}&query=${encodeURIComponent(query)}`,
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
            `/api/v1/eliza/google/gmail/read?side=owner&messageId=${encodeURIComponent(read[1])}`,
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
  handleCloudRoute.ready = ready;
  handleCloudRoute.accountAccess = accountAccess;
  handleCloudRoute.requirePaidAccess = async () => {
    const access = await accountAccess();
    if (access.state !== "active") throw hostPolicy.fundingError(access);
  };
  // This port is never exposed as a renderer route. It shares login/logout epochs.
  handleCloudRoute.googleForAccount = ({ actorId, accountId }) => {
    if (typeof credentialGate !== "function" || typeof actorId !== "string")
      throw fail(message("taskAccountBindingUnavailable"), 503);
    const epoch = generation;
    const check = async () => {
      await ready;
      current(epoch);
      await credentialWrites;
      current(epoch);
      if ((await credentialGate()) !== actorId)
        throw fail(message("taskAccountChanged"), 409);
      current(epoch);
    };
    return createManagedGoogleReadPort({
      accountId,
      request: async (path, maxBytes) => {
        await check();
        const key = await usableCredential();
        await check();
        if (!key) throw fail(message("cloudAccountUnavailable"), 401);
        const response = await request(path, {
          key,
          authorityGeneration: epoch,
        });
        if (!response.ok)
          throw fail(
            `Cloud request failed (HTTP ${response.status})`,
            response.status,
          );
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          await check();
          size += chunk.length;
          if (size > maxBytes)
            throw fail(message("cloudResponseTooLarge"), 502);
          chunks.push(chunk);
        }
        await check();
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw fail(message("invalidCloudResponse"), 502);
        }
        return value;
      },
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
