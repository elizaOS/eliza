import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

const MAX_BODY = 64 * 1024;
const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export async function readJsonBody(req, maximum = MAX_BODY) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw Object.assign(new Error("JSON required"), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error("Invalid JSON object"), { status: 400 });
  }
}

/** Restricted renderer bridge. Provider credentials never enter responses. */
export function createLocalAgentGateway({
  upstream = "http://127.0.0.1:12837",
  token,
  inboundToken,
  hostPolicy,
  origins = hostPolicy?.origins,
  cloudHandler,
  credentialGate,
  ownershipStore,
  taskGateway,
  websiteReputation,
  inferenceConfigured = async () => true,
  fetchImpl = fetch,
} = {}) {
  if (
    !hostPolicy ||
    !Array.isArray(origins) ||
    typeof hostPolicy.prepareMessage !== "function" ||
    typeof hostPolicy.validateTitle !== "function" ||
    typeof hostPolicy.isPaidAction !== "function" ||
    typeof hostPolicy.formatTaskContext !== "function" ||
    !Array.isArray(hostPolicy.resetPaths)
  )
    throw new TypeError("Explicit gateway host policy is required");
  const message = (key) =>
    hostPolicy.messages?.[key] ?? `Gateway request failed (${key})`;
  const target = new URL(upstream);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new Error(message("error1"));
  if (!token?.trim()) throw new Error(message("error2"));
  const allowed = new Set(origins);
  const inferenceAvailable = async () => {
    try {
      return (await inferenceConfigured()) === true;
    } catch {
      return false;
    }
  };
  const pending = new Set();
  const rooms = new Map();
  let epoch = 0,
    writeQueue = Promise.resolve();
  const ready = (async () => {
    const value = await ownershipStore?.read();
    if (value) {
      const records = JSON.parse(value);
      if (!Array.isArray(records)) throw new Error(message("error3"));
      for (const entry of records) {
        if (
          typeof entry.id !== "string" ||
          typeof entry.roomId !== "string" ||
          typeof entry.owner !== "string"
        )
          throw new Error(message("error4"));
        rooms.set(entry.id, { roomId: entry.roomId, owner: entry.owner });
      }
    }
  })();
  const persist = () => {
    const snapshot = JSON.stringify(
      [...rooms].map(([id, record]) => ({ id, ...record })),
    );
    const job = writeQueue.then(() => ownershipStore?.write(snapshot));
    writeQueue = job.catch(() => {});
    return job;
  };
  const ownershipError = () =>
    Object.assign(new Error(message("error5")), {
      status: 409,
      code: "CONVERSATION_NOT_OWNED",
    });
  const corsGrant = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Renderers authenticate with a bearer token, so they must be allowed to send it.
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    // Host validation also rejects DNS rebinding requests without an Origin.
    const trustedCaller =
      /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(
        req.headers.host || "",
      ) &&
      (!origin || allowed.has(origin));
    // Browsers never attach credentials to a CORS preflight. Answer one from an
    // allowlisted origin before bearer authentication, or the renderer can
    // never send its authenticated request. It reaches no route.
    if (
      req.method === "OPTIONS" &&
      origin &&
      req.headers["access-control-request-method"]
    ) {
      if (!trustedCaller) return json(res, 403, { error: message("error7") });
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        ...corsGrant,
      });
      return res.end();
    }
    if (inboundToken) {
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${inboundToken}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return json(res, 401, { error: message("error6") });
    }
    if (!trustedCaller) return json(res, 403, { error: message("error7") });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsGrant);
      return res.end();
    }
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      await ready;
      const url = new URL(req.url, "http://localhost");
      // Native startup liveness only. No provider, cloud, agent or task call is
      // made here. Full OTA health still needs independently checked evidence.
      if (url.pathname === "/local-health") {
        if (!inboundToken || origin)
          return json(res, 403, { error: message("error8") });
        if (req.method !== "GET")
          return json(res, 405, { error: message("error9") });
        if (url.search) return json(res, 400, { error: message("error10") });
        return json(res, 200, {
          schemaVersion: 1,
          gatewayResponsive: true,
          ownershipLoaded: true,
        });
      }

      if (url.pathname === "/local-storage") {
        if (!inboundToken || origin)
          return json(res, 403, { error: message("error11") });
        if (req.method !== "GET")
          return json(res, 405, { error: message("error9") });
        if (url.search) return json(res, 400, { error: message("error10") });
        let taskStorage = "unavailable";
        try {
          const observed = taskGateway?.inspectStorage?.();
          if (["ok", "unavailable", "deferred"].includes(observed))
            taskStorage = observed;
        } catch {}
        return json(res, 200, { schemaVersion: 1, taskStorage });
      }

      if (
        req.method === "POST" &&
        hostPolicy.resetPaths.includes(url.pathname)
      ) {
        epoch++;
        rooms.clear();
        for (const request of pending) {
          request.controller.abort();
          if (request.roomId)
            void fetchImpl(
              new URL(`/api/turns/${request.roomId}/abort`, target),
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ reason: "cloud-logout" }),
                signal: AbortSignal.timeout(5000),
              },
            ).catch(() => {});
        }
        await taskGateway?.revoke();
        await persist();
      }
      const taskEventRead =
        req.method === "GET" &&
        /^\/tasks\/[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}\/events$/.test(
          url.pathname,
        );
      if (url.search && !url.pathname.startsWith("/cloud/") && !taskEventRead)
        return json(res, 400, { error: message("error10") });
      if (req.method === "POST" && url.pathname === "/browser/check") {
        const input = await readJsonBody(req, 8192);
        if (Object.keys(input).length !== 1 || typeof input.url !== "string")
          return json(res, 400, { error: message("error12") });
        return json(res, 200, await websiteReputation(input.url));
      }
      const paidAction = hostPolicy.isPaidAction(req.method, url.pathname);
      if (paidAction && cloudHandler?.requirePaidAccess)
        await cloudHandler.requirePaidAccess();
      if (url.pathname === "/tasks" || url.pathname.startsWith("/tasks/")) {
        if (!taskGateway)
          return json(res, 503, { code: "TASK_HELPER_UNAVAILABLE" });
        const input =
          req.method === "POST" ? await readJsonBody(req, 2048) : undefined;
        const response = await taskGateway.handle(
          new Request(url, {
            method: req.method,
            headers: { "Content-Type": "application/json" },
            ...(input ? { body: JSON.stringify(input) } : {}),
            signal: controller.signal,
          }),
        );
        return json(res, response.status, await response.json());
      }
      let route;
      let body;
      let chatTask;
      if (req.method === "GET" && url.pathname === "/health")
        route = "/api/status";
      else if (req.method === "POST" && url.pathname === "/conversations") {
        const input = await readJsonBody(req);
        if (
          input.title !== undefined &&
          (typeof input.title !== "string" || input.title.length > 200)
        )
          return json(res, 400, { error: message("error13") });
        if (input.title) hostPolicy.validateTitle(input.title);
        body = { title: input.title || hostPolicy.conversationTitle };
        route = "/api/conversations";
      } else if (
        req.method === "POST" &&
        new RegExp(`^/conversations/${uuid}/messages$`).test(url.pathname)
      ) {
        const input = await readJsonBody(req);
        ({ body, chatTask } = hostPolicy.prepareMessage(input));
        route = `/api${url.pathname}`;
      } else if (
        req.method === "POST" &&
        new RegExp(`^/turns/${uuid}/abort$`).test(url.pathname)
      ) {
        await readJsonBody(req);
        body = { reason: hostPolicy.abortReason };
        route = `/api${url.pathname}`;
      } else if (
        cloudHandler &&
        (await cloudHandler(req, res, url, {
          signal: controller.signal,
          readJsonBody,
          json,
        }))
      )
        return;
      else return json(res, 404, { error: message("error14") });
      const isMessage = route.endsWith("/messages"),
        isCreate = route === "/api/conversations",
        isAbort = route.endsWith("/abort");
      if (isMessage && !(await inferenceAvailable()))
        return json(res, 503, {
          code: "INFERENCE_UNAVAILABLE",
          error: message("error15"),
        });
      const requestEpoch = epoch;
      const owner =
        isMessage || isCreate || isAbort
          ? (await credentialGate?.()) || "local:gateway"
          : null;
      if (requestEpoch !== epoch) throw ownershipError();
      const id = url.pathname.split("/")[2];
      const record = isMessage
        ? rooms.get(id)
        : isAbort
          ? [...rooms.values()].find(
              (record) => record.roomId === id && record.owner === owner,
            )
          : null;
      if ((isMessage || isAbort) && (!record || record.owner !== owner))
        throw ownershipError();
      const taskPresentation = async () => {
        if (!chatTask) return null;
        if (!taskGateway?.presentationForConversation)
          throw Object.assign(new Error(message("error16")), { status: 503 });
        try {
          return await taskGateway.presentationForConversation({
            ...chatTask,
            actorId: owner,
          });
        } catch {
          throw Object.assign(new Error(message("error17")), { status: 409 });
        }
      };
      let requestedPresentation = null;
      if (isMessage && chatTask) {
        const presentation = await taskPresentation();
        requestedPresentation = JSON.stringify(presentation);
        body.text += hostPolicy.formatTaskContext(presentation);
      }
      const active = { controller, roomId: record?.roomId };
      if (isMessage || isCreate) pending.add(active);
      let response;
      let data;
      try {
        if (isMessage || isCreate || isAbort) {
          const currentOwner = (await credentialGate?.()) || "local:gateway";
          if (
            controller.signal.aborted ||
            requestEpoch !== epoch ||
            currentOwner !== owner
          )
            throw ownershipError();
        }
        response = await fetchImpl(new URL(route, target), {
          method: req.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        data = await response.json();
        if (isMessage || isCreate || isAbort) {
          const currentOwner = (await credentialGate?.()) || "local:gateway";
          if (requestEpoch !== epoch || currentOwner !== owner)
            throw ownershipError();
        }
      } finally {
        pending.delete(active);
      }
      // Forward status and structured errors, never upstream authentication headers.
      if (isMessage && response.ok && data.assistantEphemeral === true) {
        // Fixed categories only: upstream text, identifiers and failure details
        // can contain private conversation or account data.
        const category =
          typeof data.text === "string" && data.text.trim()
            ? "ephemeral-nonempty"
            : "ephemeral-empty";
        console.warn(`Conversation reply unavailable: ${category}`);
        return json(res, 503, {
          code: "ASSISTANT_RESPONSE_UNAVAILABLE",
          error: message("error18"),
        });
      }
      if (response.ok && route === "/api/status") {
        return json(res, response.status, {
          state: data.state,
          canRespond: data.canRespond === true && (await inferenceAvailable()),
          agentName: data.agentName,
          model: data.model,
          cloud: {
            connectionStatus: data.cloud?.connectionStatus,
            cloudProvisioned: data.cloud?.cloudProvisioned === true,
          },
        });
      }
      if (response.ok && route === "/api/conversations") {
        const c = data.conversation || {};
        if (
          !new RegExp(`^${uuid}$`).test(c.id) ||
          !new RegExp(`^${uuid}$`).test(c.roomId)
        )
          throw Object.assign(new Error(message("error19")), { status: 502 });
        rooms.set(c.id, { roomId: c.roomId, owner });
        await persist();
        if (requestEpoch !== epoch) throw ownershipError();
        return json(res, response.status, {
          conversation: {
            id: c.id,
            roomId: c.roomId,
            title: c.title,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          },
        });
      }
      if (isMessage && response.ok) {
        const presentation = await taskPresentation();
        if (controller.signal.aborted || requestEpoch !== epoch)
          throw ownershipError();
        if (chatTask && JSON.stringify(presentation) !== requestedPresentation)
          throw Object.assign(new Error(message("error20")), { status: 409 });
        // Only the authenticated host can supply actionable task presentation.
        return json(res, response.status, {
          ...data,
          taskChoices: presentation?.choice ? [presentation.choice] : [],
        });
      }
      json(res, response.status, data);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error.code === "TASK_CLEANUP_UNCONFIRMED")
        return json(res, 503, { code: error.code, error: message("error21") });
      json(res, error.status || 502, {
        error: error.status ? error.message : "Local agent unavailable",
        ...(error.code === "CONVERSATION_NOT_OWNED"
          ? { code: error.code }
          : {}),
      });
    }
  });
}

export function createCredentialGate({
  readBinding,
  readCredential,
  verifyProcess = true,
  localMode,
  localOwner,
  staleMessage = "Runtime account binding changed",
  stoppedMessage = "Runtime process unavailable",
}) {
  if (
    typeof localMode !== "string" ||
    !localMode ||
    typeof localOwner !== "string" ||
    !localOwner
  )
    throw new TypeError("Explicit local runtime identity is required");
  return async () => {
    const binding = await readBinding();
    const key = await readCredential();
    const owner = key
      ? `cloud:${createHash("sha256").update(key).digest("hex")}`
      : localOwner;
    if (binding?.mode === localMode) {
      const fingerprint = key
        ? createHash("sha256").update(key).digest("hex")
        : null;
      if ((binding.fingerprint ?? null) !== fingerprint)
        throw Object.assign(new Error(staleMessage), { status: 409 });
      return owner;
    }
    if (
      !binding ||
      binding.mode !== "cloud" ||
      !key ||
      createHash("sha256").update(key).digest("hex") !== binding.fingerprint
    ) {
      throw Object.assign(new Error(staleMessage), { status: 409 });
    }
    if (verifyProcess) {
      try {
        process.kill(binding.pid, 0);
      } catch {
        throw Object.assign(new Error(stoppedMessage), { status: 409 });
      }
    }
    return owner;
  };
}
