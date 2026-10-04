/**
 * Capture complete model HTTP bodies for isolated GEPA evaluation workers.
 * The caller supplies the transport to wrap and must await close before using
 * evidence. Headers are deliberately excluded; bodies remain byte-exact base64.
 * This records application HTTP payloads, not TLS packets or serving provenance.
 * Redirects are rejected so an unobserved follow-up request cannot qualify.
 */
import { ElizaError } from "@elizaos/core";

export interface GepaWireAttempt {
  ordinal: number;
  url: string;
  method: string;
  requestBase64: string;
  response: { status: number; bodyBase64: string } | null;
  transportFailed: boolean;
}

export type GepaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A process-local recorder; it never installs or restores global fetch. */
export class GepaWireRecorder {
  private readonly attempts: GepaWireAttempt[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: ElizaError[] = [];
  private closed = false;

  constructor(private readonly transport: GepaFetch) {}

  private observe(work: Promise<void>): void {
    const settled = work.catch((cause: unknown) => {
      // error-policy:J1 close is the evaluation boundary and rejects incomplete evidence.
      this.failures.push(
        new ElizaError("GEPA HTTP recording failed; discard this evaluation", {
          code: "GEPA_WIRE_CAPTURE_FAILED",
          cause,
        }),
      );
    });
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
  }

  readonly fetch: GepaFetch = async (input, init) => {
    if (this.closed) {
      throw new ElizaError(
        "Create a new GEPA recorder for the next evaluation",
        {
          code: "GEPA_WIRE_RECORDER_CLOSED",
        },
      );
    }
    const request = new Request(input, { ...init, redirect: "error" });
    const url = new URL(request.url);
    if (url.username || url.password || url.search || url.hash) {
      throw new ElizaError(
        "Use a model endpoint without URL credentials or query parameters",
        {
          code: "GEPA_WIRE_ENDPOINT_INVALID",
        },
      );
    }
    const row: GepaWireAttempt = {
      ordinal: this.attempts.length,
      url: request.url,
      method: request.method,
      requestBase64: "",
      response: null,
      transportFailed: false,
    };
    this.attempts.push(row);
    const response = (async () => {
      // Capture before dispatch so an unreadable request never produces unrecorded effects.
      row.requestBase64 = Buffer.from(
        await request.clone().arrayBuffer(),
      ).toString("base64");
      try {
        return await this.transport(request);
      } catch (cause) {
        // error-policy:J2 Preserve transport failure for the caller and the attempt inventory.
        row.transportFailed = true;
        throw new ElizaError("GEPA model transport failed", {
          code: "GEPA_WIRE_TRANSPORT_FAILED",
          cause,
        });
      }
    })();
    this.observe(
      response.then(async (value) => {
        row.response = {
          status: value.status,
          bodyBase64: Buffer.from(await value.clone().arrayBuffer()).toString(
            "base64",
          ),
        };
      }),
    );
    return response;
  };

  /** Diagnostic inventory, including failed attempts; never a completion certificate. */
  snapshot(): readonly GepaWireAttempt[] {
    return structuredClone(this.attempts);
  }

  /** Stop admission and await complete bodies; a failed capture invalidates the run. */
  async close(): Promise<readonly GepaWireAttempt[]> {
    this.closed = true;
    await Promise.all(this.pending);
    if (this.failures.length) throw this.failures[0];
    return this.snapshot();
  }
}
