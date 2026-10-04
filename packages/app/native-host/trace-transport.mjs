import { NativeHostError } from "./errors.mjs";
export function createTraceTransport({
  url,
  token,
  validateEvent,
  fetchImpl = fetch,
  signal,
}) {
  if (typeof validateEvent !== "function")
    throw new TypeError("Explicit trace event validation is required");
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname) ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      )) ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token)
  )
    throw new NativeHostError("Invalid protected pilot transport");
  async function request(path, body) {
    const response = await fetchImpl(new URL(path, endpoint), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new NativeHostError("Pilot collector unavailable");
    }
    const chunks = [];
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > 262144)
        throw new NativeHostError("Pilot collector response exceeded limit");
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return {
    captureState: () => request("/api/capture"),
    upload: (events) => {
      if (!Array.isArray(events) || events.length < 1 || events.length > 100)
        throw new NativeHostError("Invalid pilot batch");
      for (const event of events) validateEvent(event);
      return request("/api/traces", events);
    },
  };
}
