/** Independent mock API evidence, scoped around one actual action invocation. */
import { ElizaError } from "@elizaos/core";
import type { MockRequestLedgerEntry } from "../../scripts/mocks/start-mocks.ts";
import type { ActionEffectCapture } from "./interceptor.ts";

function mutationRequests(
  requests: readonly MockRequestLedgerEntry[],
): string[] {
  return requests
    .filter(
      (request) =>
        !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) &&
        !["openai", "anthropic", "cerebras"].includes(
          request.service ?? request.environment,
        ),
    )
    .map(
      (request) =>
        `${request.service ?? request.environment}: ${request.method} ${request.path}`,
    );
}

export function createMockEffectCapture(source: {
  requestLedger(): readonly MockRequestLedgerEntry[];
  snapshot(): unknown;
}): ActionEffectCapture {
  return async () => {
    const before = JSON.stringify(source.snapshot());
    const beforeRequests = source.requestLedger();
    const count = beforeRequests.length;
    const prefix = JSON.stringify(beforeRequests);
    return async () => {
      const requests = source.requestLedger();
      if (
        requests.length < count ||
        JSON.stringify(requests.slice(0, count)) !== prefix
      )
        throw new ElizaError(
          "Mock request evidence was reset during an action",
          { code: "SCENARIO_EFFECT_EVIDENCE_RESET" },
        );
      const effects = mutationRequests(requests.slice(count));
      if (JSON.stringify(source.snapshot()) !== before)
        effects.push("mock API state changed");
      return effects;
    };
  };
}

/** Remote leased worlds expose the same complete ledger through a read-only route. */
export function createRemoteMockEffectCapture(
  endpoints: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): ActionEffectCapture {
  const read = async (callerSignal?: AbortSignal) =>
    Promise.all(
      Object.entries(endpoints).map(async ([service, endpoint]) => {
        const activeSignal = callerSignal ?? signal;
        const response = await fetch(`${endpoint}/__mock/requests`, {
          signal: activeSignal,
        });
        if (!response.ok)
          throw new ElizaError(
            `Cannot read ${service} effect evidence: HTTP ${response.status}`,
            { code: "SCENARIO_EFFECT_EVIDENCE_UNAVAILABLE" },
          );
        const body: unknown = await response.json();
        const requests =
          body && typeof body === "object" && "requests" in body
            ? body.requests
            : undefined;
        if (
          !Array.isArray(requests) ||
          requests.some(
            (entry) =>
              !entry ||
              typeof entry !== "object" ||
              typeof entry.method !== "string" ||
              typeof entry.path !== "string",
          )
        )
          throw new ElizaError(`Malformed ${service} effect evidence`, {
            code: "SCENARIO_EFFECT_EVIDENCE_INVALID",
          });
        return requests.map((entry) => ({
          ...entry,
          service,
        })) as MockRequestLedgerEntry[];
      }),
    );
  return async (callerSignal) => {
    const before = await read(callerSignal);
    return async () => {
      const after = await read(callerSignal);
      return after.flatMap((requests, index) => {
        const count = before[index].length;
        if (
          requests.length < count ||
          JSON.stringify(requests.slice(0, count)) !==
            JSON.stringify(before[index])
        )
          throw new ElizaError(
            "Mock request evidence was reset during an action",
            { code: "SCENARIO_EFFECT_EVIDENCE_RESET" },
          );
        return mutationRequests(requests.slice(count));
      });
    };
  };
}
