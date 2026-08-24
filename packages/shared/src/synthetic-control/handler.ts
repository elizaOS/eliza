/** Translates authenticated HTTP requests into calls on the owning synthetic-state authority. */

import { createHash, timingSafeEqual } from "node:crypto";
import { parseSyntheticControlRequest, readBoundedJson } from "./codec.js";
import {
  SYNTHETIC_CONTROL_MAX_REQUEST_BYTES,
  SYNTHETIC_CONTROL_MAX_RESPONSE_BYTES,
  SYNTHETIC_CONTROL_PATH,
  type SyntheticControlAuthority,
  type SyntheticControlFailure,
  SyntheticControlProtocolError,
  type SyntheticControlResponse,
} from "./types.js";

export interface SyntheticControlHandlerOptions {
  token: string;
  namespace: string;
  authority: SyntheticControlAuthority;
}

function json(body: SyntheticControlResponse, status: number): Response {
  const serialized = JSON.stringify(body);
  if (
    new TextEncoder().encode(serialized).byteLength >
    SYNTHETIC_CONTROL_MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      `synthetic control response exceeds ${SYNTHETIC_CONTROL_MAX_RESPONSE_BYTES} bytes`,
    );
  }
  return new Response(serialized, {
    status,
    headers: { "content-type": "application/json" },
  });
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
): Promise<number | null> {
  try {
    const generation = await authority.generation();
    return Number.isSafeInteger(generation) && generation >= 0
      ? generation
      : null;
  } catch {
    // error-policy:J1 Generation lookup failure is translated at the HTTP boundary.
    return null;
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
  const namespace = options.namespace.trim();
  if (namespace.length === 0 || namespace.length > 512) {
    throw new Error(
      "synthetic control namespace must contain at most 512 characters",
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
          namespace,
          commandId: anonymousCommandId,
          ok: false,
          generation: null,
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
          namespace,
          commandId: anonymousCommandId,
          ok: false,
          generation: null,
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
      // error-policy:J1 Authority availability is translated into a redacted HTTP failure.
      return json(
        {
          version: 1,
          namespace,
          commandId: anonymousCommandId,
          ok: false,
          generation: null,
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
      parsed = parseSyntheticControlRequest(
        await readBoundedJson(
          request,
          SYNTHETIC_CONTROL_MAX_REQUEST_BYTES,
          "synthetic control request",
        ),
      );
    } catch {
      // error-policy:J3 Untrusted wire input is rejected as invalid without fabricating a command.
      return json(
        {
          version: 1,
          namespace,
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
    if (
      parsed.namespace !== namespace ||
      (parsed.command.type === "seed" &&
        parsed.command.manifest.namespace !== namespace) ||
      (parsed.command.type === "reset" &&
        parsed.command.receipt.namespace !== namespace)
    ) {
      return json(
        {
          version: 1,
          namespace,
          commandId: parsed.commandId,
          ok: false,
          generation: initialGeneration,
          error: {
            code: "AUTH_REQUIRED",
            message: publicFailureMessage("AUTH_REQUIRED"),
            retryable: false,
          },
        },
        401,
      );
    }

    const dispatch = async (): Promise<Response> => {
      if (request.signal.aborted) {
        return json(
          {
            version: 1,
            namespace,
            commandId: parsed.commandId,
            ok: false,
            generation: await safeGeneration(options.authority),
            error: {
              code: "COMMAND_FAILED",
              message: publicFailureMessage("COMMAND_FAILED"),
              retryable: true,
            },
          },
          400,
        );
      }
      try {
        const data = await options.authority.execute(parsed.command, {
          namespace,
          commandId: parsed.commandId,
          expectedGeneration: parsed.expectedGeneration,
          leaseId: parsed.leaseId,
          signal: request.signal,
        });
        return json(
          {
            version: 1,
            namespace,
            commandId: parsed.commandId,
            ok: true,
            generation: await options.authority.generation(),
            data,
          },
          200,
        );
      } catch (error) {
        // error-policy:J1 Authority errors are redacted and translated at the authenticated HTTP boundary.
        const normalized =
          error instanceof SyntheticControlProtocolError
            ? error
            : new SyntheticControlProtocolError({
                code: "COMMAND_FAILED",
                message: error instanceof Error ? error.message : String(error),
              });
        const failure: SyntheticControlFailure = {
          version: 1,
          namespace,
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
    return dispatch();
  };
}
