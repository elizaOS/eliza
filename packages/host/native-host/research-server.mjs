import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { NativeHostError } from "./errors.mjs";
export function createResearchServer({ store, operators, readAsset }) {
  if (
    !Array.isArray(operators) ||
    !operators.length ||
    operators.some(
      (o) =>
        !/^[A-Za-z0-9_-]{1,80}$/.test(o.name) ||
        !["admin", "engineer", "researcher", "partner", "device"].includes(
          o.role,
        ) ||
        (o.role === "device" &&
          (!/^[A-Za-z0-9_-]{1,80}$/.test(o.participantId ?? "") ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(o.deviceId ?? ""))) ||
        !/^[a-f0-9]{64}$/.test(o.tokenSha256),
    ) ||
    new Set(operators.map((o) => o.name)).size !== operators.length ||
    new Set(operators.map((o) => o.tokenSha256)).size !== operators.length
  )
    throw new NativeHostError("Invalid named pilot operators");
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const send = (res, status, body) => {
    res.writeHead(status, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return http.createServer(async (req, res) => {
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ""))
        return send(res, 403, { error: "Host rejected" });
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        return send(res, 403, { error: "Origin rejected" });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (
        typeof readAsset === "function" &&
        req.method === "GET" &&
        ["/", "/console.js", "/console.css"].includes(url.pathname)
      ) {
        const name =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const content = readAsset(name);
        res.writeHead(200, {
          ...headers,
          "Content-Type": name.endsWith(".html")
            ? "text/html"
            : name.endsWith(".js")
              ? "text/javascript"
              : "text/css",
        });
        return res.end(content);
      }
      const token = req.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]{32,256})$/,
      )?.[1];
      const hash = createHash("sha256")
        .update(token ?? "")
        .digest();
      const actor = operators.find((o) =>
        timingSafeEqual(hash, Buffer.from(o.tokenSha256, "hex")),
      );
      if (!token || !actor)
        return send(res, 401, {
          error: "Named operator authentication required",
        });
      if (url.pathname === "/api/me" && req.method === "GET")
        return send(res, 200, { name: actor.name, role: actor.role });
      let body;
      if (req.method === "POST") {
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")
        )
          return send(res, 415, { error: "JSON required" });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024)
            return send(res, 413, { error: "Request too large" });
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return send(res, 400, { error: "Invalid JSON" });
        }
      }
      const route = `${req.method} ${url.pathname}`;
      let value;
      if (url.search && route !== "GET /api/traces")
        return send(res, 400, { error: "Unexpected query" });
      switch (route) {
        case "GET /api/enrollments":
          value = store.enrollments(actor);
          break;
        case "POST /api/enrollments":
          value = store.enroll(actor, body);
          break;
        case "GET /api/capture":
          value = store.captureState(actor);
          break;
        case "POST /api/capture":
          value = store.capture(actor, body);
          break;
        case "POST /api/traces":
          value = store.ingest(actor, body);
          break;
        case "GET /api/traces": {
          const filter = Object.fromEntries(url.searchParams);
          for (const k of ["from", "to"])
            if (k in filter) filter[k] = Number(filter[k]);
          value = store.traces(actor, filter);
          break;
        }
        case "POST /api/traces/export":
          value = store.exportTraces(actor, body);
          break;
        case "GET /api/measurements":
          value = store.readDataset(actor);
          break;
        case "POST /api/measurements":
          value = store.dataset(actor, body);
          break;
        case "GET /api/report":
          value = store.report(actor);
          break;
        case "GET /api/audit":
          value = store.audit(actor);
          break;
        default:
          return send(res, 404, { error: "Route unavailable" });
      }
      send(res, 200, value);
    } catch (error) {
      send(res, error.status ?? 400, {
        error:
          error.status === 403
            ? "Pilot access denied"
            : error.status === 409
              ? error.message
              : error.status === 507
                ? error.message
                : "Pilot request could not be completed",
      });
    }
  });
}
