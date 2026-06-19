import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

const _actualShared = await import("@feed/shared");
const _actualZod = await import("zod");

import { isValidDeliveryChannel, isValidDigestFrequency } from "@feed/shared";

type ErrorHandlerModule = typeof import("../../../api/src/error-handler");

let AuthenticationError: new (message?: string) => Error;
let BadRequestError: new (message: string) => Error;
let ValidationError: new (message: string) => Error;
let setDefaultErrorCapture: ErrorHandlerModule["setDefaultErrorCapture"];
let successResponse: ErrorHandlerModule["successResponse"];
let withErrorHandling: ErrorHandlerModule["withErrorHandling"];

function createRequest(): import("next/server").NextRequest {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: {
      "x-user-id": "user-123",
      "x-request-id": "req-123",
    },
  }) as import("next/server").NextRequest;
}

describe("withErrorHandling + default Sentry capture", () => {
  beforeAll(async () => {
    mock.module("@feed/db", () => ({
      DatabaseError: class DatabaseError extends Error {
        code?: string;
      },
    }));

    mock.module("@feed/shared", () => ({
      ..._actualShared,
      logger: {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {},
      },
    }));

    mock.module("zod", () => {
      class ZodError extends Error {
        issues: Array<{ code: string; message: string; path: string[] }>;

        constructor(
          issues: Array<{ code: string; message: string; path: string[] }> = [],
        ) {
          super("ZodError");
          this.name = "ZodError";
          this.issues = issues;
        }
      }

      return {
        ..._actualZod,
        ZodError,
        z: { ..._actualZod.z, ZodError },
        default: { ..._actualZod.z, ZodError },
      };
    });

    const _actualNextServer = await import("next/server");
    mock.module("next/server", () => ({
      ..._actualNextServer,
      NextResponse: class NextResponse extends Response {
        static json(body: unknown, init?: ResponseInit): NextResponse {
          const headers = new Headers(init?.headers);
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }

          return new NextResponse(JSON.stringify(body), {
            ...init,
            headers,
          });
        }
      },
    }));

    ({ AuthenticationError, BadRequestError, ValidationError } = await import(
      "../../../api/src/errors"
    ));
  });

  beforeEach(async () => {
    // Load a fresh module instance so this suite is immune to cross-file mock.module
    // overrides of @feed/api exports (including withErrorHandling).
    const freshModule = (await import(
      `../../../api/src/error-handler.ts?isolation=${Date.now()}-${Math.random()}`
    )) as ErrorHandlerModule;
    setDefaultErrorCapture = freshModule.setDefaultErrorCapture;
    successResponse = freshModule.successResponse;
    withErrorHandling = freshModule.withErrorHandling;
  });

  afterEach(() => {
    setDefaultErrorCapture(undefined);
  });

  afterAll(() => {
    mock.restore();
  });

  it("captures unexpected errors through the global capture callback", async () => {
    const captureError = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    setDefaultErrorCapture(captureError);

    const handler = withErrorHandling(async () => {
      throw new Error("boom");
    });

    const response = await handler(createRequest());
    expect(response.status).toBe(500);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("keeps route-level captureError precedence over the global callback", async () => {
    const globalCapture = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    const routeCapture = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    setDefaultErrorCapture(globalCapture);

    const handler = withErrorHandling(
      async () => {
        throw new Error("route override");
      },
      { captureError: routeCapture },
    );

    const response = await handler(createRequest());
    expect(response.status).toBe(500);
    expect(routeCapture).toHaveBeenCalledTimes(1);
    expect(globalCapture).toHaveBeenCalledTimes(0);
  });

  it("does not capture expected validation errors", async () => {
    const captureError = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    setDefaultErrorCapture(captureError);

    const handler = withErrorHandling(async () => {
      throw new ValidationError("Validation failed");
    });

    const response = await handler(createRequest());
    expect(response.status).toBe(422);
    expect(captureError).toHaveBeenCalledTimes(0);
  });

  it("does not capture authentication errors", async () => {
    const captureError = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    setDefaultErrorCapture(captureError);

    const handler = withErrorHandling(async () => {
      throw new AuthenticationError("Authentication required");
    });

    const response = await handler(createRequest());
    expect(response.status).toBe(401);
    expect(captureError).toHaveBeenCalledTimes(0);
  });

  it("does not capture expected 4xx operational errors", async () => {
    const captureError = mock(
      (_error: Error, _context: Record<string, unknown>) => {},
    );
    setDefaultErrorCapture(captureError);

    const handler = withErrorHandling(async () => {
      throw new BadRequestError("Invalid request");
    });

    const response = await handler(createRequest());
    expect(response.status).toBe(400);
    expect(captureError).toHaveBeenCalledTimes(0);
  });
});

describe("Notification digest validation functions", () => {
  describe("isValidDigestFrequency", () => {
    it("returns true for valid frequencies", () => {
      expect(isValidDigestFrequency("hourly")).toBe(true);
      expect(isValidDigestFrequency("daily")).toBe(true);
      expect(isValidDigestFrequency("weekly")).toBe(true);
    });

    it("returns false for invalid frequencies", () => {
      expect(isValidDigestFrequency("monthly")).toBe(false);
      expect(isValidDigestFrequency("immediate")).toBe(false);
      expect(isValidDigestFrequency("both")).toBe(false);
      expect(isValidDigestFrequency("")).toBe(false);
      expect(isValidDigestFrequency("DAILY")).toBe(false);
    });
  });

  describe("isValidDeliveryChannel", () => {
    it("returns true for valid delivery channels", () => {
      expect(isValidDeliveryChannel("in-app")).toBe(true);
      expect(isValidDeliveryChannel("email")).toBe(true);
      expect(isValidDeliveryChannel("both")).toBe(true);
    });

    it("returns false for invalid delivery channels", () => {
      expect(isValidDeliveryChannel("sms")).toBe(false);
      expect(isValidDeliveryChannel("slack")).toBe(false);
      expect(isValidDeliveryChannel("push")).toBe(false);
      expect(isValidDeliveryChannel("in_app")).toBe(false);
      expect(isValidDeliveryChannel("")).toBe(false);
      expect(isValidDeliveryChannel("EMAIL")).toBe(false);
    });
  });
});

describe("successResponse", () => {
  it("serializes bigint payload values as strings", async () => {
    const response = successResponse({
      id: "position-1",
      amount: 42n,
      nested: {
        total: 9007199254740993n,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "position-1",
      amount: "42",
      nested: {
        total: "9007199254740993",
      },
    });
  });

  it("preserves non-serializable top-level payload failures", () => {
    expect(() => successResponse(undefined)).toThrow(
      "Value is not JSON serializable",
    );
  });
});
