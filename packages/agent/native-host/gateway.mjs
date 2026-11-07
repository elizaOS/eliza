import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  SURFACE_CHANNEL_BYTES,
  SURFACE_CHANNEL_PATHS,
  SurfaceChannelError,
} from "./surface-channel.mjs";
import { TASK_ID_PATTERN } from "./task-id.mjs";

const taskEventsPath = new RegExp(
  `^/tasks/${TASK_ID_PATTERN.source.slice(1, -1)}/events$`,
);
const MAX_BODY = 64 * 1024;
const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const messagePath = new RegExp(`^/conversations/(${uuid})/messages$`);
const messageStreamPath = new RegExp(
  `^/conversations/(${uuid})/messages/stream/(start|pull|cancel)$`,
);
const STREAM_LIMITS = {
  // Unfinished or unreleased streams one account may hold at once. Each one
  // can hold one waiting pull, and so one native bridge worker.
  maxStreams: 2,
  // Text the renderer has not yet confirmed with a later pull cursor.
  maxBufferedChars: 256 * 1024,
  // A stream nobody pulls for this long is cancelled and released.
  idleMs: 30000,
  // A pull with nothing new waits at most this long before it answers.
  holdMs: 2000,
  // New text waits this long for more before a pull answers, unless it ends
  // a phrase or reaches PHRASE_CHARS. Speech starts per phrase, not per token.
  coalesceMs: 150,
};
const PHRASE_CHARS = 120;
const phraseEnd =
  /[.!?;:,\n\u3001\u3002\uff01\uff0c\uff1f]["')\]\u201d\u2019]*\s*$/u;
// The fixed error body of an expected refusal, kept apart from upstream fields.
const refusalBody = Symbol("refusalBody");
const refusal = (status, body) =>
  Object.assign(new Error(body.error), { status, [refusalBody]: body });

/** Parses `data:` frames from the agent's server-sent event stream. */
async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buffered = "";
  const frame = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    return data.length ? JSON.parse(data.join("\n")) : null;
  };
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    let end = buffered.indexOf("\n\n");
    while (end !== -1) {
      const value = frame(buffered.slice(0, end));
      buffered = buffered.slice(end + 2);
      if (value) yield value;
      end = buffered.indexOf("\n\n");
    }
  }
  const value = frame(buffered + decoder.decode());
  if (value) yield value;
}

/**
 * The buffered route's reply body (`buildConversationJsonOutcome` in
 * `src/api/conversation-routes.ts`) from the stream's terminal `done` frame,
 * which carries the same outcome with `fullText` for `text`.
 */
function bufferedReplyFromDone({ fullText, ...outcome }) {
  return {
    text: fullText,
    agentName: outcome.agentName,
    ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
    ...(outcome.userMessageId ? { userMessageId: outcome.userMessageId } : {}),
    ...(outcome.assistantEphemeral ? { assistantEphemeral: true } : {}),
    ...(outcome.historyRefreshRequired ? { historyRefreshRequired: true } : {}),
    ...(outcome.transcriptVisibility
      ? { transcriptVisibility: outcome.transcriptVisibility }
      : {}),
    ...(outcome.actionResults?.length
      ? { actionResults: outcome.actionResults }
      : {}),
    ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
    ...(outcome.terminalFailure
      ? { terminalFailure: outcome.terminalFailure }
      : {}),
    ...(outcome.replyRecoveryAvailable ? { replyRecoveryAvailable: true } : {}),
    ...(outcome.accountConnect
      ? { accountConnect: outcome.accountConnect }
      : {}),
    ...(outcome.localInference
      ? { localInference: outcome.localInference }
      : {}),
    ...(outcome.noResponseReason
      ? { noResponseReason: outcome.noResponseReason }
      : {}),
    ...(outcome.interrupted ? { interrupted: true } : {}),
  };
}
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
  isAllowedOrigin = hostPolicy?.isAllowedOrigin,
  cloudHandler,
  credentialGate,
  ownershipStore,
  taskGateway,
  websiteReputation,
  surfaceChannel,
  inferenceConfigured = async () => true,
  fetchImpl = fetch,
  requestScope = (_req, _res, next) => next(),
  messageStream,
} = {}) {
  if (typeof requestScope !== "function")
    throw new TypeError("requestScope must be a function");
  const limits = { ...STREAM_LIMITS, ...messageStream };
  if (
    Object.keys(limits).length !== Object.keys(STREAM_LIMITS).length ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    limits.coalesceMs >= limits.holdMs ||
    limits.holdMs >= limits.idleMs
  )
    throw new TypeError(
      "messageStream limits must be positive integers, coalesceMs < holdMs < idleMs",
    );
  if (
    !hostPolicy ||
    Array.isArray(origins) === (typeof isAllowedOrigin === "function") ||
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
  const allowed =
    typeof isAllowedOrigin === "function"
      ? isAllowedOrigin
      : Set.prototype.has.bind(new Set(origins));
  const inferenceAvailable = async () => {
    try {
      return (await inferenceConfigured()) === true;
    } catch {
      return false;
    }
  };
  const pending = new Set();
  const rooms = new Map();
  // Turns this gateway started since the last sign-out, by room, until the
  // agent answered them. A turn keeps running upstream after its request
  // closed, so only a reply ends it here; a sign-out stops the rest.
  const turnRooms = new Map();
  const turnEnded = (admission) => {
    if (admission.requestEpoch !== epoch) return;
    const open = turnRooms.get(admission.roomId) - 1;
    if (open > 0) turnRooms.set(admission.roomId, open);
    else turnRooms.delete(admission.roomId);
  };
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
  const currentOwner = async () =>
    (await credentialGate?.()) || "local:gateway";
  // The account and reset fence every admitted request holds to.
  const ensureCurrent = async ({ owner, requestEpoch }, signal) => {
    const current = await currentOwner();
    if (signal?.aborted || requestEpoch !== epoch || current !== owner)
      throw ownershipError();
  };
  const errorResponse = (error) => {
    if (error[refusalBody])
      return { status: error.status, body: error[refusalBody] };
    if (error instanceof SurfaceChannelError)
      return {
        status: error.status,
        body: { code: error.code, error: error.message },
      };
    if (error.code === "TASK_CLEANUP_UNCONFIRMED")
      return {
        status: 503,
        body: { code: error.code, error: message("error21") },
      };
    return {
      status: error.status || 502,
      body: {
        error: error.status ? error.message : "Local agent unavailable",
        ...(error.code === "CONVERSATION_NOT_OWNED"
          ? { code: error.code }
          : {}),
      },
    };
  };

  // Message admission, shared by the buffered and the streamed routes.
  const admitMessage = async (conversationId, input) => {
    const { body, chatTask } = hostPolicy.prepareMessage(input);
    if (!(await inferenceAvailable()))
      throw refusal(503, {
        code: "INFERENCE_UNAVAILABLE",
        error: message("error15"),
      });
    const requestEpoch = epoch;
    const owner = await currentOwner();
    if (requestEpoch !== epoch) throw ownershipError();
    const record = rooms.get(conversationId);
    if (!record || record.owner !== owner) throw ownershipError();
    const presentation = async () => {
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
    if (chatTask) {
      const value = await presentation();
      requestedPresentation = JSON.stringify(value);
      body.text += hostPolicy.formatTaskContext(value);
    }
    return {
      body,
      chatTask,
      owner,
      requestEpoch,
      roomId: record.roomId,
      presentation,
      requestedPresentation,
    };
  };
  const sendMessage = async (admission, route, signal) => {
    await ensureCurrent(admission, signal);
    turnRooms.set(admission.roomId, (turnRooms.get(admission.roomId) ?? 0) + 1);
    return fetchImpl(new URL(route, target), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(admission.body),
      signal,
    });
  };
  // The reply body of a successful turn, after its account was re-checked.
  const finalReply = async (admission, data, signal) => {
    if (data.assistantEphemeral === true) {
      // Fixed categories only: upstream text, identifiers and failure details
      // can contain private conversation or account data.
      const category =
        typeof data.text === "string" && data.text.trim()
          ? "ephemeral-nonempty"
          : "ephemeral-empty";
      console.warn(`Conversation reply unavailable: ${category}`);
      throw refusal(503, {
        code: "ASSISTANT_RESPONSE_UNAVAILABLE",
        error: message("error18"),
      });
    }
    const presentation = await admission.presentation();
    if (signal.aborted || admission.requestEpoch !== epoch)
      throw ownershipError();
    if (
      admission.chatTask &&
      JSON.stringify(presentation) !== admission.requestedPresentation
    )
      throw Object.assign(new Error(message("error20")), { status: 409 });
    // Only the authenticated host can supply actionable task presentation.
    return {
      ...data,
      taskChoices: presentation?.choice ? [presentation.choice] : [],
    };
  };

  // Streamed replies. The renderer bridge cannot read a streamed response, so
  // `start` opens the agent's event stream here and the renderer pulls the
  // text it has not seen yet. A pull cursor also confirms the text before it,
  // which is then released.
  const streams = new Map();
  // At most one pull waits on a stream: a newer pull answers the older one.
  const wake = (stream) => {
    const waiter = stream.waiter;
    stream.waiter = null;
    waiter?.();
  };
  const holdPull = (stream, ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (stream.waiter === finish) stream.waiter = null;
        resolve();
      }
      stream.waiter = finish;
      signal.addEventListener("abort", finish);
    });
  // Unsent text is ready at a phrase end, at PHRASE_CHARS, or after coalesceMs.
  const phraseDelay = (stream) => {
    const last = stream.events.at(-1);
    if (
      stream.chars >= PHRASE_CHARS ||
      phraseEnd.test(last.text ?? last.fullText)
    )
      return 0;
    return stream.events[0].at + limits.coalesceMs - Date.now();
  };
  const settleStream = (stream, outcome) => {
    if (stream.outcome) return;
    stream.outcome = outcome;
    if (outcome.status !== 200) {
      stream.controller.abort();
      stream.events = [];
      stream.chars = 0;
    }
    wake(stream);
  };
  const dropStream = (stream) => {
    clearTimeout(stream.timer);
    streams.delete(stream.id);
    stream.controller.abort();
    pending.delete(stream.active);
    wake(stream);
  };
  const touchStream = (stream) => {
    clearTimeout(stream.timer);
    stream.timer = setTimeout(() => dropStream(stream), limits.idleMs);
    stream.timer.unref?.();
  };
  const pushStreamEvent = (stream, event) => {
    stream.seq++;
    stream.events.push({ seq: stream.seq, ...event, at: Date.now() });
    stream.chars += (event.text ?? event.fullText).length;
    if (stream.chars > limits.maxBufferedChars)
      throw refusal(503, {
        code: "MESSAGE_STREAM_BUFFER_FULL",
        error: message("error26"),
      });
    wake(stream);
  };
  const pumpStream = async (stream, body) => {
    try {
      let done = null;
      for await (const frame of sseFrames(body)) {
        if (frame?.type === "token") {
          const provisional =
            frame.provisional === true ? { provisional: true } : {};
          if (typeof frame.text === "string")
            pushStreamEvent(stream, { text: frame.text, ...provisional });
          else if (typeof frame.fullText === "string")
            pushStreamEvent(stream, {
              fullText: frame.fullText,
              ...provisional,
            });
        } else if (frame?.type === "error") {
          turnEnded(stream.admission);
          throw refusal(502, {
            error:
              typeof frame.message === "string"
                ? frame.message
                : "Local agent unavailable",
            ...(typeof frame.code === "string" ? { code: frame.code } : {}),
          });
        } else if (frame?.type === "done") {
          turnEnded(stream.admission);
          done = frame;
          break;
        }
      }
      if (!done || typeof done.fullText !== "string")
        throw new Error("Agent stream ended without a reply");
      await ensureCurrent(stream.admission);
      settleStream(stream, {
        status: 200,
        body: await finalReply(
          stream.admission,
          bufferedReplyFromDone(done),
          stream.controller.signal,
        ),
      });
    } catch (error) {
      settleStream(stream, errorResponse(error));
    } finally {
      pending.delete(stream.active);
    }
  };
  const startStream = async (conversationId, input, requestSignal) => {
    const admission = await admitMessage(conversationId, input);
    let held = 0;
    for (const stream of streams.values())
      if (
        stream.admission.owner === admission.owner &&
        stream.admission.requestEpoch === epoch
      )
        held++;
    if (held >= limits.maxStreams)
      throw refusal(429, {
        code: "MESSAGE_STREAM_LIMIT",
        error: message("error22"),
      });
    const controller = new AbortController();
    const stream = {
      id: randomUUID(),
      conversationId,
      admission,
      controller,
      active: { controller, roomId: admission.roomId },
      events: [],
      seq: 0,
      acknowledged: 0,
      chars: 0,
      outcome: null,
      waiter: null,
      latestPull: 0,
      timer: null,
    };
    // Reserved before the agent call, so parallel starts share the limit.
    streams.set(stream.id, stream);
    pending.add(stream.active);
    const abortStart = () => controller.abort();
    requestSignal.addEventListener("abort", abortStart);
    let opened = false;
    try {
      const response = await sendMessage(
        admission,
        `/api/conversations/${conversationId}/messages/stream`,
        controller.signal,
      );
      if (!response.ok) {
        const data = await response.json();
        turnEnded(admission);
        await ensureCurrent(admission);
        return { status: response.status, body: data };
      }
      if (
        !/^text\/event-stream(?:\s*;|$)/i.test(
          response.headers.get("content-type") || "",
        )
      )
        throw new Error("Agent stream unavailable");
      await ensureCurrent(admission);
      opened = true;
      touchStream(stream);
      void pumpStream(stream, response.body);
      return { status: 200, body: { streamId: stream.id } };
    } finally {
      requestSignal.removeEventListener("abort", abortStart);
      if (!opened) dropStream(stream);
    }
  };
  const streamFor = (conversationId, input, keys) => {
    if (
      Object.keys(input).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(input, key)) ||
      typeof input.streamId !== "string" ||
      (keys.includes("cursor") &&
        (!Number.isSafeInteger(input.cursor) || input.cursor < 0))
    )
      throw refusal(400, { error: message("error23") });
    const stream = streams.get(input.streamId);
    if (!stream || stream.conversationId !== conversationId)
      throw refusal(404, {
        code: "MESSAGE_STREAM_NOT_FOUND",
        error: message("error24"),
      });
    return stream;
  };
  // Text of one account never reaches another, nor survives a reset.
  const ensureStreamCurrent = async (stream) => {
    try {
      await ensureCurrent(stream.admission);
    } catch (error) {
      dropStream(stream);
      throw error;
    }
  };
  const pullStream = async (conversationId, input, requestSignal) => {
    const stream = streamFor(conversationId, input, ["streamId", "cursor"]);
    if (input.cursor > stream.seq)
      throw refusal(400, { error: message("error23") });
    if (input.cursor < stream.acknowledged)
      throw refusal(409, {
        code: "MESSAGE_STREAM_CURSOR_EXPIRED",
        error: message("error25"),
      });
    touchStream(stream);
    stream.acknowledged = input.cursor;
    while (stream.events.length && stream.events[0].seq <= input.cursor) {
      const event = stream.events.shift();
      stream.chars -= (event.text ?? event.fullText).length;
    }
    const pullId = ++stream.latestPull;
    wake(stream);
    const deadline = Date.now() + limits.holdMs;
    while (
      !stream.outcome &&
      streams.has(stream.id) &&
      stream.latestPull === pullId &&
      !requestSignal.aborted
    ) {
      let wait = deadline - Date.now();
      if (stream.events.length) wait = Math.min(wait, phraseDelay(stream));
      if (wait <= 0) break;
      await holdPull(stream, wait, requestSignal);
    }
    if (!streams.has(stream.id))
      throw refusal(404, {
        code: "MESSAGE_STREAM_NOT_FOUND",
        error: message("error24"),
      });
    // One account check per pull, just before any text leaves the gateway.
    await ensureStreamCurrent(stream);
    touchStream(stream);
    if (stream.outcome && stream.outcome.status !== 200) return stream.outcome;
    const finished = stream.outcome !== null;
    return {
      status: 200,
      body: {
        events: stream.events.map(({ at: _at, ...event }) => event),
        cursor: stream.seq,
        done: finished,
        ...(finished ? { message: stream.outcome.body } : {}),
      },
    };
  };
  // Cancel needs no account check: it only discards, as a failed check does.
  const cancelStream = async (conversationId, input) => {
    dropStream(streamFor(conversationId, input, ["streamId"]));
    return { status: 200, body: { cancelled: true } };
  };

  const corsGrant = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Renderers authenticate with a bearer token, so they must be allowed to send it.
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };
  const handle = async (req, res) => {
    const origin = req.headers.origin;
    // Host validation also rejects DNS rebinding requests without an Origin.
    let originAllowed = !origin;
    if (origin) {
      try {
        originAllowed = allowed(origin) === true;
      } catch {
        // A host policy failure must deny the request, not escape the HTTP handler.
        originAllowed = false;
      }
    }
    const trustedCaller =
      /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(
        req.headers.host || "",
      ) && originAllowed;
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
        surfaceChannel?.revoke();
        epoch++;
        // Stop the turn of every room sent a message, not only the rooms
        // with an open request: a turn keeps running upstream after its
        // renderer request closed, and must not survive the sign-out.
        const roomIds = new Set(turnRooms.keys());
        turnRooms.clear();
        rooms.clear();
        for (const request of pending) {
          request.controller.abort();
          if (request.roomId) roomIds.add(request.roomId);
        }
        for (const roomId of roomIds)
          void fetchImpl(new URL(`/api/turns/${roomId}/abort`, target), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "cloud-logout" }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        await taskGateway?.revoke();
        await persist();
      }
      const taskEventRead =
        req.method === "GET" && taskEventsPath.test(url.pathname);
      if (url.search && !url.pathname.startsWith("/cloud/") && !taskEventRead)
        return json(res, 400, { error: message("error10") });
      if (SURFACE_CHANNEL_PATHS.has(url.pathname)) {
        if (!surfaceChannel || !inboundToken)
          return json(res, 503, { code: "SURFACE_UNAVAILABLE" });
        if (req.method !== "POST")
          return json(res, 405, { error: message("error9") });
        const input = await readJsonBody(
          req,
          url.pathname.endsWith("/reply") ? SURFACE_CHANNEL_BYTES : 4096,
        );
        return json(res, 200, await surfaceChannel.handle(url.pathname, input));
      }
      if (req.method === "POST" && url.pathname === "/browser/check") {
        const input = await readJsonBody(req, 8192);
        if (Object.keys(input).length !== 1 || typeof input.url !== "string")
          return json(res, 400, { error: message("error12") });
        return json(res, 200, await websiteReputation(input.url));
      }
      const streamRoute =
        req.method === "POST" ? messageStreamPath.exec(url.pathname) : null;
      // Starting a streamed turn is the same action as sending a message.
      const paidAction = hostPolicy.isPaidAction(
        req.method,
        streamRoute?.[2] === "start"
          ? `/conversations/${streamRoute[1]}/messages`
          : url.pathname,
      );
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
      if (streamRoute) {
        const [, conversationId, step] = streamRoute;
        const input = await readJsonBody(req);
        const { status, body } =
          step === "start"
            ? await startStream(conversationId, input, controller.signal)
            : step === "pull"
              ? await pullStream(conversationId, input, controller.signal)
              : await cancelStream(conversationId, input);
        return json(res, status, body);
      }
      const messageRoute =
        req.method === "POST" ? messagePath.exec(url.pathname) : null;
      if (messageRoute) {
        const admission = await admitMessage(
          messageRoute[1],
          await readJsonBody(req),
        );
        const active = { controller, roomId: admission.roomId };
        pending.add(active);
        let response;
        let data;
        try {
          response = await sendMessage(
            admission,
            `/api${url.pathname}`,
            controller.signal,
          );
          data = await response.json();
          turnEnded(admission);
          await ensureCurrent(admission);
        } finally {
          pending.delete(active);
        }
        // Forward status and structured errors, never upstream authentication headers.
        if (!response.ok) return json(res, response.status, data);
        return json(
          res,
          response.status,
          await finalReply(admission, data, controller.signal),
        );
      }
      let route;
      let body;
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
      const isCreate = route === "/api/conversations",
        isAbort = route.endsWith("/abort");
      const requestEpoch = epoch;
      const owner = isCreate || isAbort ? await currentOwner() : null;
      if (requestEpoch !== epoch) throw ownershipError();
      const id = url.pathname.split("/")[2];
      if (
        isAbort &&
        ![...rooms.values()].some(
          (record) => record.roomId === id && record.owner === owner,
        )
      )
        throw ownershipError();
      const active = { controller };
      if (isCreate) pending.add(active);
      let response;
      let data;
      try {
        if (isCreate || isAbort)
          await ensureCurrent({ owner, requestEpoch }, controller.signal);
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
        if (isCreate || isAbort) await ensureCurrent({ owner, requestEpoch });
      } finally {
        pending.delete(active);
      }
      // Forward status and structured errors, never upstream authentication headers.
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
      json(res, response.status, data);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const { status, body } = errorResponse(error);
      json(res, status, body);
    }
  };
  // `requestScope(req, res, next)` lets a host run each request inside its
  // own context (for example an AsyncLocalStorage scope). It must call
  // `next()` once; `next` returns the handler's promise. The hook runs
  // synchronously, so an AsyncLocalStorage scope it opens covers the whole
  // handler. A hook that throws, or returns a promise that rejects, before
  // `next` fails only that request with one 500, and `next` can no longer
  // start the handler afterwards. A failure after `next` never answers again.
  const server = http.createServer((req, res) => {
    let started = false;
    const next = () => {
      if (started) throw new Error("Request handler already started");
      started = true;
      return handle(req, res);
    };
    const fail = () => {
      const answer = !started;
      started = true;
      if (answer && !res.headersSent && !res.destroyed && !res.writableEnded)
        json(res, 500, { error: "Local agent unavailable" });
    };
    let scoped;
    try {
      scoped = requestScope(req, res, next);
    } catch {
      return fail();
    }
    if (scoped && typeof scoped.then === "function")
      Promise.resolve(scoped).then(undefined, fail);
  });
  server.on("close", () => {
    surfaceChannel?.close();
    for (const stream of streams.values()) dropStream(stream);
  });
  return server;
}

/**
 * The stable owner of a verified Cloud account: `cloud-owner-v1:` and the
 * SHA-256 of the JSON tuple `[authority, userId, organizationId]`. The owner
 * must come from an authenticated record (see `createCredentialGate`), never
 * from a renderer value or a decoded token claim. Throws a TypeError for an
 * invalid owner.
 */
export function verifiedOwnerIdentity(owner) {
  if (!owner || typeof owner !== "object" || Object.keys(owner).length !== 3)
    throw new TypeError("Invalid verified account owner");
  const tuple = [owner.authority, owner.userId, owner.organizationId];
  if (
    tuple.some(
      (v) =>
        typeof v !== "string" ||
        !v ||
        Array.from(v).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        ) ||
        !v.isWellFormed(),
    )
  )
    throw new TypeError("Invalid verified account owner");
  const authority = new URL(tuple[0]);
  if (
    authority.origin !== tuple[0] ||
    !(
      authority.protocol === "https:" ||
      (authority.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname))
    )
  )
    throw new TypeError("Invalid verified account authority");
  return `cloud-owner-v1:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}

export function createCredentialGate({
  readBinding,
  readCredential,
  readVerifiedAccount,
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
  if (
    readVerifiedAccount !== undefined &&
    typeof readVerifiedAccount !== "function"
  )
    throw new TypeError(
      "Verified account reader must be a native host function",
    );
  return async () => {
    const binding = await readBinding();
    const key = await readCredential();
    let owner = key
      ? `cloud:${createHash("sha256").update(key).digest("hex")}`
      : localOwner;
    if (readVerifiedAccount) {
      try {
        const record = await readVerifiedAccount();
        if (key === null || key === undefined) {
          if (record !== null) throw Error();
        } else {
          if (
            record?.version !== 1 ||
            Object.keys(record).length !== 4 ||
            typeof record.credentialId !== "string" ||
            !record.credentialId ||
            record.credential !== key
          )
            throw Error();
          owner = verifiedOwnerIdentity(record.owner);
        }
      } catch {
        throw Object.assign(new Error(staleMessage), { status: 409 });
      }
    }
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
