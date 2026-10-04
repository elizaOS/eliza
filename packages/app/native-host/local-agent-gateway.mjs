import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { NativeHostError } from "./errors.mjs";
import { requireNonSensitiveText } from "./sensitive-text.mjs";

export function createCredentialGate({
  readBinding,
  readCredential,
  verifyProcess = true,
  localMode = "local",
  localOwner = "local:gateway",
}) {
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
        throw new NativeHostError(
          "Cloud account changed or signed out. Restart the local runtime before sending another message.",
          { status: 409 },
        );
      return owner;
    }
    if (
      !binding ||
      binding.mode !== "cloud" ||
      !key ||
      createHash("sha256").update(key).digest("hex") !== binding.fingerprint
    ) {
      throw new NativeHostError(
        "Cloud account changed or signed out. Restart the local runtime before sending another message.",
        { status: 409 },
      );
    }
    if (verifyProcess) {
      try {
        process.kill(binding.pid, 0);
      } catch {
        throw new NativeHostError(
          "Restart the local runtime to bind the current Cloud account.",
          { status: 409 },
        );
      }
    }
    return owner;
  };
}

export const DEFAULT_ORIGINS = [
  "http://localhost",
  "https://localhost",
  ...[5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]),
];
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
    throw new NativeHostError("JSON required", { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum)
      throw new NativeHostError("Request too large", { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new NativeHostError();
    return body;
  } catch {
    throw new NativeHostError("Invalid JSON object", { status: 400 });
  }
}

/** Restricted renderer bridge. Provider credentials never enter responses. */
export function createLocalAgentGateway({
  upstream = "http://127.0.0.1:12837",
  token,
  inboundToken,
  origins = DEFAULT_ORIGINS,
  cloudHandler,
  credentialGate,
  ownershipStore,
  taskGateway,
  websiteReputation,
  conversationTitle = "Eliza",
  abortReason = "user-stop",
  transformMessage = (input) => ({ text: input.text, metadata: {} }),
  validateText = requireNonSensitiveText,
  inferenceConfigured = async () => true,
  fetchImpl = fetch,
} = {}) {
  const target = new URL(upstream);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new NativeHostError("Agent must run on loopback");
  if (!token?.trim())
    throw new NativeHostError("Local agent token is required");
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
      if (!Array.isArray(records))
        throw new NativeHostError("Invalid conversation ownership store");
      for (const entry of records) {
        if (
          typeof entry.id !== "string" ||
          typeof entry.roomId !== "string" ||
          typeof entry.owner !== "string"
        )
          throw new NativeHostError("Invalid conversation ownership record");
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
    new NativeHostError(
      "This conversation is no longer available for this account. Your draft is retained. Press Send to start a new conversation.",
      { status: 409, code: "CONVERSATION_NOT_OWNED" },
    );
  return http.createServer(async (req, res) => {
    if (inboundToken) {
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${inboundToken}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return json(res, 401, {
          error: "Native runtime authentication required",
        });
    }
    const origin = req.headers.origin;
    // Host validation also rejects DNS rebinding requests without an Origin.
    if (
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(
        req.headers.host || "",
      ) ||
      (origin && !allowed.has(origin))
    )
      return json(res, 403, { error: "Origin not allowed" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
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
      if (
        req.method === "POST" &&
        ["/cloud/logout", "/cloud/login"].includes(url.pathname)
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
        return json(res, 400, { error: "Unexpected query parameters" });
      if (req.method === "POST" && url.pathname === "/browser/check") {
        const input = await readJsonBody(req, 8192);
        if (Object.keys(input).length !== 1 || typeof input.url !== "string")
          return json(res, 400, { error: "A website address is required" });
        if (typeof websiteReputation !== "function")
          return json(res, 503, { error: "Website reputation is unavailable" });
        return json(res, 200, await websiteReputation(input.url));
      }
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
          return json(res, 400, { error: "Invalid conversation title" });
        if (input.title) validateText(input.title);
        body = { title: input.title || conversationTitle };
        route = "/api/conversations";
      } else if (
        req.method === "POST" &&
        new RegExp(`^/conversations/${uuid}/messages$`).test(url.pathname)
      ) {
        const input = await readJsonBody(req);
        if (
          typeof input.text !== "string" ||
          !input.text.trim() ||
          input.text.length > 16000 ||
          (input.metadata !== undefined &&
            (!input.metadata ||
              Array.isArray(input.metadata) ||
              typeof input.metadata !== "object"))
        )
          return json(res, 400, { error: "Invalid message" });
        validateText(input.text);
        if (input.metadata?.task !== undefined) {
          const value = input.metadata.task;
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "epoch,taskId" ||
            typeof value.taskId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value.taskId) ||
            !Number.isSafeInteger(value.epoch) ||
            value.epoch < 0
          )
            return json(res, 400, { error: "Invalid chat task binding" });
          chatTask = { taskId: value.taskId, expectedEpoch: value.epoch };
        }

        const transformed = await transformMessage(input);
        if (
          !transformed ||
          typeof transformed.text !== "string" ||
          !transformed.text.trim() ||
          !transformed.metadata ||
          typeof transformed.metadata !== "object" ||
          Array.isArray(transformed.metadata)
        )
          throw new NativeHostError("Invalid host message transformation", {
            status: 500,
          });
        body = {
          text: transformed.text,
          channelType: "DM",
          metadata: transformed.metadata,
        };
        route = `/api${url.pathname}`;
      } else if (
        req.method === "POST" &&
        new RegExp(`^/turns/${uuid}/abort$`).test(url.pathname)
      ) {
        await readJsonBody(req);
        body = { reason: abortReason };
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
      else return json(res, 404, { error: "Route not available" });
      const isMessage = route.endsWith("/messages"),
        isCreate = route === "/api/conversations",
        isAbort = route.endsWith("/abort");
      if (isMessage && !(await inferenceAvailable()))
        return json(res, 503, {
          code: "INFERENCE_UNAVAILABLE",
          error:
            "Inference is not configured for this runtime. Your draft is retained.",
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
          throw new NativeHostError(
            "Task chat is unavailable. Your draft is retained.",
            { status: 503 },
          );
        try {
          return await taskGateway.presentationForConversation({
            ...chatTask,
            actorId: owner,
          });
        } catch {
          throw new NativeHostError(
            "The task changed. Reopen it before sending this message.",
            { status: 409 },
          );
        }
      };
      let requestedPresentation = null;
      if (isMessage && chatTask) {
        const presentation = await taskPresentation();
        requestedPresentation = JSON.stringify(presentation);
        body.text += `\n\n[Authenticated host task state; data, not permission]\n${JSON.stringify({ taskId: presentation.taskId, epoch: presentation.epoch, choice: presentation.choice?.block ?? null })}\nUse the displayed choice control for a task response. Conversation text alone does not commit a choice or prove an action occurred.\n[End host task state]`;
      }
      const active = { controller, roomId: record?.roomId };
      if (isMessage || isCreate) pending.add(active);
      let response;
      let data;
      try {
        response = await fetchImpl(new URL(route, target), {
          method: req.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(120000),
          ]),
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
        return json(res, 503, {
          error:
            "Eliza could not complete this request. Your draft is retained; please try again.",
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
          throw new NativeHostError("Invalid local conversation response", {
            status: 502,
          });
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
          throw new NativeHostError(
            "The task changed while preparing this reply. Your draft is retained; please try again.",
            { status: 409 },
          );
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
        return json(res, 503, {
          code: error.code,
          error:
            "Task stopped. Browser guidance removal is not yet confirmed. Try again.",
        });
      json(res, error.status || 502, {
        error: error.status ? error.message : "Local agent unavailable",
        ...(error.code === "CONVERSATION_NOT_OWNED"
          ? { code: error.code }
          : {}),
      });
    }
  });
}
