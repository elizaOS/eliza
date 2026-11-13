/** Private Google tool transport shared by browser and signed native hosts. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CalendarAgentWriteRefused } from "../../../../../plugins/plugin-calendar/src/service/managed-calendar-host.ts";
import { calendarReadBrokerDiagnosticHeader } from "../../../../contracts/src/calendar.ts";
import {
  type createManagedGoogleAgentHost,
  GOOGLE_AGENT_RESULT_MAX,
  GoogleAgentRefusal,
} from "./managed-google-agent-host.ts";
import { CloudProtocolError } from "./managed-google-client.ts";
import {
  type ManagedGoogleFailureStage,
  type ManagedGoogleTransportCode,
  type ManagedGoogleTransportMessageFamily,
  managedGoogleFailureStage,
  managedGoogleTransportCodes,
} from "./managed-google-failure-stage.ts";
import { GMAIL_QUERY_MAX, isObject } from "./managed-google-route-policy.ts";

type BrokerOperation =
  | "request"
  | "gmail.list"
  | "gmail.message"
  | "gmail.mailbox"
  | "gmail.send.prepare"
  | "gmail.send.dispatch"
  | "gmail.send.receipt"
  | "calendar.sources"
  | "calendar.feed"
  | "calendar.write-capabilities"
  | "calendar.write-target"
  | "calendar.write-execute"
  | "calendar.linked-sync";
export type ManagedGoogleBrokerDiagnostic = {
  operation: BrokerOperation;
  errorClass:
    | "CloudProtocolError"
    | "CalendarAgentWriteRefused"
    | "AbortError"
    | "TypeError"
    | "Error"
    | "unknown";
  code:
    | "invalid-response"
    | "http"
    | "expired"
    | "credentials-missing"
    | "credential-consumed"
    | "login-active"
    | "account-changed"
    | "unclassified";
  status?: number;
  stage?: ManagedGoogleFailureStage;
  transportCode?: ManagedGoogleTransportCode;
  causeTransportCode?: ManagedGoogleTransportCode;
  transportMessageFamily?: ManagedGoogleTransportMessageFamily;
  causeTransportMessageFamily?: ManagedGoogleTransportMessageFamily;
  capabilities: { abortAny: boolean; abortTimeout: boolean; fetch: boolean };
};
function reportBrokerFailure(
  error: unknown,
  operation: BrokerOperation,
  report: (value: ManagedGoogleBrokerDiagnostic) => void,
) {
  try {
    const cloud = error instanceof CloudProtocolError;
    const allowed = [
      "invalid-response",
      "http",
      "expired",
      "credentials-missing",
      "credential-consumed",
      "login-active",
      "account-changed",
    ];
    const code =
      cloud && allowed.includes(error.code) ? error.code : "unclassified";
    const status =
      cloud &&
      typeof error.status === "number" &&
      Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? error.status
        : undefined;
    const errorClass = cloud
      ? "CloudProtocolError"
      : error instanceof CalendarAgentWriteRefused
        ? "CalendarAgentWriteRefused"
        : typeof DOMException !== "undefined" &&
            error instanceof DOMException &&
            error.name === "AbortError"
          ? "AbortError"
          : error instanceof TypeError
            ? "TypeError"
            : error instanceof Error
              ? "Error"
              : "unknown";
    const stage = managedGoogleFailureStage(error);
    const capabilities = {
      abortAny:
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.any === "function",
      abortTimeout:
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function",
      fetch: typeof fetch === "function",
    };
    report({
      operation,
      errorClass,
      code,
      ...(status === undefined ? {} : { status }),
      ...(stage ? { stage } : {}),
      ...(stage === "fetch" ? managedGoogleTransportCodes(error) : {}),
      capabilities,
    });
  } catch {
    /* Diagnostics cannot change the broker's refusal or response. */
  }
}
export function createManagedGoogleAgentBroker(options: {
  host: ReturnType<typeof createManagedGoogleAgentHost>;
  authorized(value: string | undefined): Promise<boolean>;
  diagnostic?: (value: ManagedGoogleBrokerDiagnostic) => void;
}) {
  const reader = options.host;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, data: unknown, readDiagnostic?: string) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(status === 409 && readDiagnostic
          ? { [calendarReadBrokerDiagnosticHeader.name]: readDiagnostic }
          : {}),
      });
      res.end(JSON.stringify(data));
    };
    const controller = new AbortController();
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", closed);
    let operation: BrokerOperation = "request";
    try {
      if (
        req.method !== "POST" ||
        !["", "/", "/__alpha-owner-gmail"].includes(req.url || "") ||
        req.headers.origin ||
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")
      ) {
        send(403, { error: "Private agent request required" });
        return;
      }
      if (!(await options.authorized(req.headers.authorization))) {
        send(401, { error: "Agent authentication required" });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const part = Buffer.from(chunk);
        bytes += part.length;
        if (bytes > 256 * 1024)
          throw new GoogleAgentRefusal(
            "request-too-large",
            "Agent request too large",
          );
        chunks.push(part);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new GoogleAgentRefusal(
          "invalid-request",
          "Invalid Google tool request",
        );
      }
      if (
        !isObject(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "limit",
              "query",
              "since",
              "messageId",
              "calendar",
              "send",
              "mailbox",
            ].includes(key),
        ) ||
        (input.query !== undefined &&
          (typeof input.query !== "string" ||
            input.query.length > GMAIL_QUERY_MAX)) ||
        (input.since !== undefined && typeof input.since !== "string")
      )
        throw new GoogleAgentRefusal(
          "invalid-request",
          "Invalid Google tool request",
        );
      // Sends and Calendar event writes carry email or event text; everything else is a small read.
      const writesContent =
        input.send !== undefined ||
        (isObject(input.calendar) &&
          (input.calendar.operation === "write-execute" ||
            input.calendar.operation === "linked-sync"));
      if (!writesContent && bytes > 8192)
        throw new GoogleAgentRefusal(
          "request-too-large",
          "Agent request too large",
        );
      controller.signal.throwIfAborted();
      let result: unknown;
      if (input.mailbox !== undefined) {
        if (
          Object.keys(input).length !== 1 ||
          !isObject(input.mailbox) ||
          Object.keys(input.mailbox).sort().join() !==
            "kind,messageId,requestId" ||
          typeof input.mailbox.kind !== "string" ||
          typeof input.mailbox.messageId !== "string" ||
          typeof input.mailbox.requestId !== "string"
        )
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Invalid mailbox operation",
          );
        operation = "gmail.mailbox";
        result = {
          mailbox: await reader.mailbox(
            input.mailbox as Parameters<typeof reader.mailbox>[0],
            controller.signal,
          ),
        };
      } else if (input.send !== undefined) {
        if (Object.keys(input).length !== 1 || !isObject(input.send))
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Invalid send operation",
          );
        const s = input.send,
          keys = Object.keys(s).sort().join();
        if (
          s.operation === "prepare" &&
          keys === "bodyText,operation,requestId,subject,to"
        ) {
          operation = "gmail.send.prepare";
          result = {
            send: await reader.prepareSend(
              s as Parameters<typeof reader.prepareSend>[0],
              controller.signal,
            ),
          };
        } else if (
          s.operation === "dispatch" &&
          keys === "bodyText,id,operation,reviewDigest,subject,to"
        ) {
          operation = "gmail.send.dispatch";
          result = {
            send: await reader.dispatchSend(
              s as Parameters<typeof reader.dispatchSend>[0],
              controller.signal,
            ),
          };
        } else if (
          s.operation === "receipt" &&
          keys === "id,operation" &&
          typeof s.id === "string"
        ) {
          operation = "gmail.send.receipt";
          result = { send: await reader.sendReceipt(s.id, controller.signal) };
        } else
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Unsupported send operation",
          );
      } else if (input.calendar !== undefined) {
        if (Object.keys(input).length !== 1 || !isObject(input.calendar))
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Invalid Calendar read",
          );
        const c = input.calendar;
        if (
          typeof c.operation === "string" &&
          [
            "write-capabilities",
            "write-target",
            "write-execute",
            "linked-sync",
          ].includes(c.operation)
        ) {
          operation = `calendar.${c.operation}` as BrokerOperation;
          result = await reader.calendarWrite(c, controller.signal);
        } else if (c.operation === "sources" && Object.keys(c).length === 1) {
          operation = "calendar.sources";
          result = {
            calendars: await reader.calendarSources(controller.signal),
          };
        } else if (
          c.operation === "feed" &&
          Object.keys(c).sort().join() ===
            [
              "operation",
              "grantId",
              "calendarId",
              "timeMin",
              "timeMax",
              "timeZone",
            ]
              .sort()
              .join() &&
          ["grantId", "calendarId", "timeMin", "timeMax", "timeZone"].every(
            (key) =>
              ((value) => typeof value === "string" && value.length <= 1024)(
                c[key],
              ),
          )
        ) {
          operation = "calendar.feed";
          result = {
            feed: await reader.calendarFeed(
              c as Parameters<typeof reader.calendarFeed>[0],
              controller.signal,
            ),
          };
        } else
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Unsupported Calendar operation",
          );
      } else if (input.messageId !== undefined) {
        if (
          typeof input.messageId !== "string" ||
          Object.keys(input).length !== 1
        )
          throw new GoogleAgentRefusal(
            "invalid-request",
            "Invalid exact-message read",
          );
        operation = "gmail.message";
        result = {
          message: await reader.message(input.messageId, controller.signal),
        };
      } else {
        operation = "gmail.list";
        result = {
          items: await reader.list(
            input as Parameters<typeof reader.list>[0],
            controller.signal,
          ),
        };
      }
      controller.signal.throwIfAborted();
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > GOOGLE_AGENT_RESULT_MAX)
        throw new GoogleAgentRefusal(
          "result-too-large",
          "Google result too large",
        );
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (error) {
      let readDiagnostic: string | undefined;
      reportBrokerFailure(error, operation, (value) => {
        // Operation is classified only after private host authentication. Keep this
        // finite projection on Calendar read refusals; never expose error payloads.
        if (operation === "calendar.sources" || operation === "calendar.feed") {
          try {
            readDiagnostic = calendarReadBrokerDiagnosticHeader.encode({
              version: 1,
              operation: operation === "calendar.sources" ? "sources" : "feed",
              stage: value.stage ?? null,
              code: value.code,
              status: value.status ?? null,
              errorClass: value.errorClass,
              capabilities: value.capabilities,
            });
          } catch {
            /* Diagnostics cannot change the original refusal. */
          }
        }
        (
          options.diagnostic ??
          ((diagnostic) =>
            console.warn("[managed-google-agent-broker]", diagnostic))
        )(value);
      });
      if (
        error instanceof CalendarAgentWriteRefused &&
        !res.writableEnded &&
        !res.destroyed
      ) {
        send(200, { calendarFailure: error.refusal });
        return;
      }
      // A typed refusal names its closed reason only; its message and any other error text stay here.
      if (error instanceof GoogleAgentRefusal) {
        if (!res.writableEnded && !res.destroyed)
          send(409, { reason: error.reason }, readDiagnostic);
        return;
      }
      const failure = error as {
        code?: unknown;
        status?: unknown;
        data?: { error?: unknown };
      } | null;
      const unavailable =
        failure?.code === "http" &&
        failure.status === 404 &&
        failure.data?.error === "Not found";
      if (!res.writableEnded && !res.destroyed)
        send(
          409,
          {
            error:
              "Google request could not be verified. Check the current account, permissions, and any saved operation receipt before retrying.",
            ...(unavailable ? { reason: "provider-route-unavailable" } : {}),
          },
          readDiagnostic,
        );
    } finally {
      res.removeListener("close", closed);
    }
  };
}
