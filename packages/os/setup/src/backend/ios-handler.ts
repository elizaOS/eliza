import { randomUUID } from "node:crypto";
import type { SideloaderIosBackend } from "./ios-backend";
import type { IosInstallPlan } from "./ios-types";

/** The sideloader owns one host credential session, so attempts are serialized. */
export function createIosHandler(
  backend: SideloaderIosBackend,
  headers: HeadersInit,
) {
  let attempt:
    | { token: string; createdAt: number; busy: boolean; plan?: IosInstallPlan }
    | undefined;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  return async (request: Request, pathname: string): Promise<Response> => {
    if (
      attempt &&
      !attempt.busy &&
      Date.now() - attempt.createdAt >= 15 * 60 * 1000
    ) {
      backend.resetAuth();
      attempt = undefined;
    }
    if (request.method === "GET") {
      if (pathname === "/ios/devices") return json(await backend.listDevices());
      if (pathname === "/ios/apps") return json(await backend.listApps());
      if (pathname === "/ios/region")
        return json(await backend.getRegionNotice());
    }
    if (
      request.method !== "POST" ||
      ![
        "/ios/authenticate",
        "/ios/2fa",
        "/ios/plan",
        "/ios/execute",
        "/ios/cancel",
      ].includes(pathname)
    )
      return json({ error: "Not found" }, 404);
    let body: Record<string, unknown>;
    try {
      const value: unknown = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      body = value as Record<string, unknown>;
    } catch {
      return json({ error: "Expected a JSON object" }, 400);
    }
    const text = (key: string): string => {
      const value = body[key];
      if (typeof value !== "string" || !value.trim())
        throw new Error(`Missing ${key}`);
      return value;
    };
    if (attempt && (attempt.busy || body.attemptToken !== attempt.token))
      return json({ error: "Another iOS attempt is active" }, 409);
    if (pathname !== "/ios/authenticate" && !attempt)
      return json({ error: "iOS attempt expired or was consumed" }, 409);
    try {
      if (pathname === "/ios/authenticate") {
        const appleId = text("appleId");
        const password = text("password");
        attempt ??= { token: randomUUID(), createdAt: Date.now(), busy: false };
        const current = attempt;
        current.busy = true;
        delete current.plan;
        try {
          return json({
            ...(await backend.authenticate(appleId, password)),
            attemptToken: current.token,
          });
        } finally {
          current.busy = false;
        }
      }
      const current = attempt;
      if (!current) return json({ error: "iOS attempt expired" }, 409);
      if (pathname === "/ios/cancel") {
        backend.resetAuth();
        attempt = undefined;
        return json({ cancelled: true });
      }
      if (pathname === "/ios/2fa") {
        const code = text("code");
        if (!/^\d{6}$/.test(code))
          return json({ error: "Expected six verification digits" }, 400);
        current.busy = true;
        try {
          return json({
            ...(await backend.submit2fa(code)),
            attemptToken: current.token,
          });
        } finally {
          current.busy = false;
        }
      }
      if (pathname === "/ios/plan") {
        delete current.plan;
        const input = {
          deviceUdid: text("deviceUdid"),
          appId: text("appId"),
          appleId: text("appleId"),
        };
        current.busy = true;
        try {
          current.plan = await backend.createInstallPlan(input);
          return json(current.plan);
        } finally {
          current.busy = false;
        }
      }
      if (!current.plan || Object.hasOwn(body, "plan"))
        return json(
          { error: "A server-owned installation plan is required" },
          400,
        );
      const plan = current.plan;
      delete current.plan;
      current.busy = true;
      const encoder = new TextEncoder();
      let disconnected = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => {
            if (!disconnected)
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
          };
          let failed = false;
          let completed = false;
          try {
            await backend.executeInstallPlan(plan, (stepId, status, detail) => {
              failed ||= status === "failed";
              completed ||= stepId === "complete" && status === "complete";
              send({
                stepId,
                status,
                ...(detail === undefined ? {} : { detail }),
              });
            });
            if (failed || !completed)
              throw new Error("Installation did not complete successfully.");
            send({ done: true });
          } catch (error) {
            send({ error: String(error) });
          } finally {
            backend.resetAuth();
            attempt = undefined;
            if (!disconnected) controller.close();
          }
        },
        cancel() {
          disconnected = true;
        },
      });
      return new Response(stream, {
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      if (pathname === "/ios/authenticate" || pathname === "/ios/2fa") {
        backend.resetAuth();
        attempt = undefined;
      }
      return json({ error: String(error) }, 400);
    }
  };
}
