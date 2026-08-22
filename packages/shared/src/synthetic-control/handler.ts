/** Translates authenticated HTTP requests into calls on the owning synthetic-state authority. */

import { createHash, timingSafeEqual } from "node:crypto";
import { parseSyntheticControlRequest } from "./codec.js";
import {
  SYNTHETIC_CONTROL_PATH,
  type SyntheticControlAuthority,
  type SyntheticControlFailure,
  SyntheticControlProtocolError,
  type SyntheticControlResponse,
} from "./types.js";

export interface SyntheticControlHandlerOptions {
  token: string;
  authority: SyntheticControlAuthority;
}

function json(body: SyntheticControlResponse, status: number): Response {
  return Response.json(body, { status });
}

function publicFailureMessage(
  code: SyntheticControlFailure["error"]["code"],
): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "control authorization failed";
    case "INVALID_REQUEST":
      return "control request is invalid";
    case "LEASE_CONFLICT":
      return "control lease is already held";
    case "LEASE_REQUIRED":
      return "an active control lease is required";
    case "STALE_GENERATION":
      return "control generation fence rejected the command";
    case "UNSUPPORTED_COMMAND":
      return "control command is unsupported";
    case "COMMAND_FAILED":
      return "control authority failed the command";
  }
}

async function safeGeneration(
  authority: SyntheticControlAuthority,
): Promise<number> {
  try {
    const generation = await authority.generation();
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  } catch {
    return 0;
  }
}

export function createSyntheticControlHandler(
  options: SyntheticControlHandlerOptions,
): (request: Request) => Promise<Response | null> {
  if (options.token.trim().length < 16) {
    throw new Error(
      "synthetic control token must contain at least 16 characters",
    );
  }
  const expectedTokenHash = createHash("sha256").update(options.token).digest();
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== SYNTHETIC_CONTROL_PATH) return null;
    const anonymousCommandId = "invalid-request";
    if (request.method !== "POST") {
      return json(
        {
          version: 1,
          commandId: anonymousCommandId,
          ok: false,
          generation: 0,
          error: {
            code: "INVALID_REQUEST",
            message: "control endpoint accepts POST only",
            retryable: false,
          },
        },
        405,
      );
    }
    const presented = request.headers.get("authorization");
    const presentedToken = presented?.startsWith("Bearer ")
      ? presented.slice("Bearer ".length)
      : "";
    const presentedTokenHash = createHash("sha256")
      .update(presentedToken)
      .digest();
    if (!timingSafeEqual(expectedTokenHash, presentedTokenHash)) {
      return json(
        {
          version: 1,
          commandId: anonymousCommandId,
          ok: false,
          generation: 0,
          error: {
            code: "AUTH_REQUIRED",
            message: "control authorization failed",
            retryable: false,
          },
        },
        401,
      );
    }
    let initialGeneration: number;
    try {
      initialGeneration = await options.authority.generation();
      if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 0) {
        throw new Error("authority generation is invalid");
      }
    } catch {
      return json(
        {
          version: 1,
          commandId: anonymousCommandId,
          ok: false,
          generation: 0,
          error: {
            code: "COMMAND_FAILED",
            message: publicFailureMessage("COMMAND_FAILED"),
            retryable: true,
          },
        },
        503,
      );
    }
    let parsed: ReturnType<typeof parseSyntheticControlRequest>;
    try {
      parsed = parseSyntheticControlRequest(await request.json());
    } catch {
      return json(
        {
          version: 1,
          commandId: anonymousCommandId,
          ok: false,
          generation: initialGeneration,
          error: {
            code: "INVALID_REQUEST",
            message: publicFailureMessage("INVALID_REQUEST"),
            retryable: false,
          },
        },
        400,
      );
    }
    try {
      const data = await options.authority.execute(parsed.command, {
        commandId: parsed.commandId,
        expectedGeneration: parsed.expectedGeneration,
        leaseId: parsed.leaseId,
        signal: request.signal,
      });
      return json(
        {
          version: 1,
          commandId: parsed.commandId,
          ok: true,
          generation: await options.authority.generation(),
          data,
        },
        200,
      );
    } catch (error) {
      const normalized =
        error instanceof SyntheticControlProtocolError
          ? error
          : new SyntheticControlProtocolError({
              code: "COMMAND_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
      const failure: SyntheticControlFailure = {
        version: 1,
        commandId: parsed.commandId,
        ok: false,
        generation: await safeGeneration(options.authority),
        error: {
          code: normalized.code,
          message: publicFailureMessage(normalized.code),
          retryable: normalized.retryable,
        },
      };
      const status =
        normalized.code === "STALE_GENERATION" ||
        normalized.code === "LEASE_CONFLICT"
          ? 409
          : 400;
      return json(failure, status);
    }
  };
}
