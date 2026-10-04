import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createDocumentImageDescriber } from "./document-image-describer.mjs";
import { NativeHostError } from "./errors.mjs";
import { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";
import { requireNonSensitiveText } from "./sensitive-text.mjs";

const fail = (message, status = 400) =>
  new NativeHostError(message, { status });
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
const pickMessage = (m) => ({
  id: m.externalId,
  provider: "gmail",
  sender: m.from,
  subject: m.subject,
  receivedAt: m.receivedAt,
  body: m.snippet || "",
});

/** Narrow Cloud services for a locally owned agent. Never provisions a Cloud runtime. */
export function createCloudRoutes({
  fetchImpl = fetch,
  cloudSiteBase = "https://cloud.eliza.app",
  cloudApiBase = "https://api.eliza.app",
  initialApiKey,
  credentialStore,
  credentialGate,
} = {}) {
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
  const attempts = new Map();
  let generation = 0;
  const responseEpoch = new WeakMap();
  function current(epoch) {
    if (epoch !== generation) throw fail("Account session changed", 409);
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
      throw fail("Invalid Cloud response", 502);
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
            throw fail("Invalid query");
          url.searchParams.set("query", requestInput.query);
        }
      }
      if (path === "/gmail/read" && method === "POST") {
        requestInput = await body(req);
        if (
          typeof requestInput.messageId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,256}$/.test(requestInput.messageId)
        )
          throw fail("Invalid message ID");
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
      if (method === "GET" && path === "/cloud/status") {
        send(res, 200, {
          connected: Boolean(await store.read()),
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
        await store.clear();
        send(res, 200, { connected: false });
        return true;
      }
      if (method === "POST" && path === "/cloud/login") {
        await body(req);
        generation++;
        attempts.clear();
        await store.clear();
        const value = await parse(
          await request("/api/auth/cli-session", {
            method: "POST",
            json: { sessionId: randomUUID() },
            signal,
          }),
        );
        if (
          typeof value.sessionId !== "string" ||
          !/^[a-zA-Z0-9_-]{16,128}$/.test(value.sessionId)
        )
          throw fail("Invalid Cloud login session", 502);
        const expiresAt = Date.now() + 15 * 60 * 1000;
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
        const value = await parse(
          await request(`/api/auth/cli-session/${encodeURIComponent(id)}`, {
            signal,
          }),
        );
        if (generation !== attempt.generation || attempts.get(id) !== attempt)
          throw fail("Login cancelled", 409);
        if (value.status === "authenticated") {
          if (typeof value.apiKey !== "string" || !value.apiKey.trim())
            throw fail("Cloud login returned no credential", 502);
          await store.write(value.apiKey);
          attempts.delete(id);
          send(res, 200, { status: "authenticated", connected: true });
        } else {
          const status = ["pending", "expired", "error"].includes(value.status)
            ? value.status
            : "pending";
          if (status !== "pending") attempts.delete(id);
          send(res, 200, { status });
        }
        return true;
      }
      const credentialEpoch = generation;
      const key = await store.read();
      current(credentialEpoch);
      if (!key) throw fail("Sign in to Eliza Cloud first", 401);
      if (method === "POST" && path === "/voice/tts") {
        const input = await body(req);
        if (
          typeof input.text !== "string" ||
          !input.text.trim() ||
          input.text.length > 16000
        )
          throw fail("Speech text required (maximum 16000 characters)");
        requireNonSensitiveText(input.text);
        const response = await request("/api/v1/voice/tts", {
          method: "POST",
          json: { text: input.text },
          key,
          signal,
          authorityGeneration: credentialEpoch,
          headers: { Accept: "audio/mpeg" },
        });
        if (!response.ok) await parse(response);
        const mimeType = response.headers.get("content-type") || "";
        if (!mimeType.startsWith("audio/"))
          throw fail("Invalid speech audio", 502);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          current(responseEpoch.get(response));
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw fail("Speech audio too large", 502);
          chunks.push(chunk);
        }
        current(responseEpoch.get(response));
        send(res, 200, {
          audioBase64: Buffer.concat(chunks).toString("base64"),
          mimeType,
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
          throw fail("Valid base64 audio and MIME type required");
        const audio = Buffer.from(input.audioBase64, "base64");
        if (!audio.length || audio.length > 8 * 1024 * 1024)
          throw fail("Audio must contain 1 byte to 8 MiB", 413);
        // Android's DNS transport buffers BodyInit without copying the boundary
        // header generated by Response(FormData). Send explicit bytes and framing.
        const boundary = `eliza-${randomUUID()}`;
        const multipart = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
          ),
          audio,
          Buffer.from(`\r\n--${boundary}--\r\n`),
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
          throw fail("Invalid transcription response", 502);
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
        send(res, 200, {
          connected: value.connected === true,
          configured: value.configured === true,
          reason: value.reason,
          grantedCapabilities: value.grantedCapabilities || [],
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
        if (auth.protocol !== "https:" || auth.username || auth.password)
          throw fail("Invalid Google authorization URL", 502);
        send(res, 200, { browserUrl: auth.href });
        return true;
      }
      if (method === "GET" && path === "/cloud/gmail/messages") {
        const maxResults = requestInput?.maxResults ?? 50;
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)
          throw fail("maxResults must be 1 to 100");
        const query = url.searchParams.get("query") || "in:inbox";
        if (query.length > 1000) throw fail("Search query too long");
        const value = await parse(
          await request(
            `/api/v1/eliza/google/gmail/search?side=owner&maxResults=${maxResults}&query=${encodeURIComponent(query)}`,
            { key, signal, authorityGeneration: credentialEpoch },
          ),
        );
        if (!Array.isArray(value.messages))
          throw fail("Invalid Gmail response", 502);
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
          throw fail("Invalid Gmail response", 502);
        send(res, 200, { ...pickMessage(value.message), body: value.bodyText });
        return true;
      }
      send(res, 404, { error: "Cloud route not available" });
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
  // This port is never exposed as a renderer route. It shares login/logout epochs.
  handleCloudRoute.googleForAccount = ({ actorId, accountId }) => {
    if (typeof credentialGate !== "function" || typeof actorId !== "string")
      throw fail("Task account binding unavailable", 503);
    const epoch = generation;
    const check = async () => {
      current(epoch);
      if ((await credentialGate()) !== actorId)
        throw fail("Task account changed", 409);
      current(epoch);
    };
    return createManagedGoogleReadPort({
      accountId,
      request: async (path, maxBytes) => {
        await check();
        const key = await store.read();
        await check();
        if (!key) throw fail("Cloud account unavailable", 401);
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
          if (size > maxBytes) throw fail("Cloud response too large", 502);
          chunks.push(chunk);
        }
        await check();
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw fail("Invalid Cloud response", 502);
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
      throw fail("Task account binding unavailable", 503);
    const epoch = generation;
    const assertOwner = async () => {
      current(epoch);
      if ((await credentialGate()) !== actorId)
        throw fail("Task account changed", 409);
      current(epoch);
    };
    return createDocumentImageDescriber({
      documentRuntime,
      model,
      assertOwner,
      recordUsage,
      readAuthority: async () => {
        await assertOwner();
        const apiKey = await store.read();
        await assertOwner();
        if (!apiKey) throw fail("Cloud account unavailable", 401);
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
