/** Defines the authenticated reset, seed, fault, and ledger boundary shared by provider mocks. */

import { payloadHash, type SyntheticWorld } from "@elizaos/synthetic-world";
import type {
  ProviderProtocolFault,
  ProviderProtocolFixture,
} from "./types.js";

export const PROVIDER_MOCK_CONTROL_PREFIX = "/__eliza/mock-control/v1";
const CONTROL_TOKEN_HEADER = "x-eliza-mock-control-token";

export interface ProviderMockControlSnapshot {
  schemaVersion: 1;
  providerId: string;
  generation: number;
  namespace: string | null;
  worldStateHash: string | null;
  executionStateHash: string;
  globalExecutionStateHash: string | null;
  state: Record<string, unknown>;
  controlLedger: ProviderMockControlLedgerEntry[];
  certification: "mock-only-not-provider-qualified";
}

export interface ProviderMockControlLedgerEntry {
  sequence: number;
  command: "seed" | "fault" | "reset";
  generationBefore: number;
  generationAfter: number;
  occurredAt: string;
}

export interface ProviderMockControlAdapter {
  inspect(): Record<string, unknown>;
  executionState(): Record<string, unknown>;
  reset(): void;
  seed(fixtures: readonly ProviderProtocolFixture[]): void;
  enqueueFault(
    method: string,
    path: string,
    fault: ProviderProtocolFault,
  ): void;
}

interface ProviderMockControlOptions {
  providerId: string;
  token: string;
  adapter: ProviderMockControlAdapter;
  now?: () => number;
  coordinator?: ProviderMockWorldCoordinator;
}

export interface ProviderMockControlHandler {
  handle(request: Request): Promise<Response | null>;
  dispose(): void;
}

export interface ProviderMockMutationOptions {
  expectedGeneration?: number;
}

export class ProviderMockControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  snapshot(): Promise<ProviderMockControlSnapshot> {
    return this.request("GET", "/state");
  }

  reset(
    options: ProviderMockMutationOptions = {},
  ): Promise<ProviderMockControlSnapshot> {
    return this.request("POST", "/reset", options);
  }

  resetWorld(
    options: ProviderMockMutationOptions = {},
  ): Promise<ProviderMockControlSnapshot> {
    return this.request("POST", "/world/reset", options);
  }

  seed(
    fixtures: readonly ProviderProtocolFixture[],
    options: ProviderMockMutationOptions = {},
  ): Promise<ProviderMockControlSnapshot> {
    return this.request("POST", "/seed", { ...options, fixtures });
  }

  fault(
    method: string,
    path: string,
    fault: ProviderProtocolFault,
    options: ProviderMockMutationOptions = {},
  ): Promise<ProviderMockControlSnapshot> {
    return this.request("POST", "/fault", {
      ...options,
      method,
      path,
      fault,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [CONTROL_TOKEN_HEADER]: this.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(
        `provider mock control ${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`,
      );
    }
    return payload as T;
  }
}

interface CoordinatedProvider {
  reset(): void;
  clearControlLedger(): void;
  advanceGeneration(): void;
  executionState(): Record<string, unknown>;
}

export class ProviderMockWorldCoordinator {
  private readonly providers = new Map<string, CoordinatedProvider>();

  public constructor(public readonly world: SyntheticWorld) {}

  public register(
    providerId: string,
    provider: CoordinatedProvider,
  ): () => void {
    if (this.providers.has(providerId))
      throw new Error(`provider mock coordinator already owns ${providerId}`);
    this.providers.set(providerId, provider);
    return () => this.providers.delete(providerId);
  }

  public reset(): string {
    for (const provider of this.providers.values()) provider.reset();
    this.world.reset();
    for (const provider of this.providers.values()) {
      provider.clearControlLedger();
      provider.advanceGeneration();
    }
    return this.executionStateHash;
  }

  public get executionStateHash(): string {
    const providers = Object.fromEntries(
      [...this.providers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, provider]) => [id, provider.executionState()]),
    );
    return payloadHash(
      toJsonValue(
        { worldStateHash: this.world.stateHash, providers },
        "coordinated provider execution state",
      ),
    );
  }
}

const coordinators = new WeakMap<
  SyntheticWorld,
  ProviderMockWorldCoordinator
>();

export function providerMockCoordinatorFor(
  world: SyntheticWorld,
): ProviderMockWorldCoordinator {
  const existing = coordinators.get(world);
  if (existing) return existing;
  const coordinator = new ProviderMockWorldCoordinator(world);
  coordinators.set(world, coordinator);
  return coordinator;
}

export function createProviderMockControl(
  options: ProviderMockControlOptions,
): ProviderMockControlHandler {
  if (!options.providerId.trim()) {
    throw new Error("provider mock control requires a providerId");
  }
  if (options.token.length < 24) {
    throw new Error(
      "provider mock control token must have at least 24 characters",
    );
  }
  const now = options.now ?? Date.now;
  const ledger: ProviderMockControlLedgerEntry[] = [];
  let generation = 1;
  let sequence = 0;
  const clearControlLedger = (): void => {
    ledger.length = 0;
    sequence = 0;
  };
  const unregister = options.coordinator?.register(options.providerId, {
    reset: options.adapter.reset,
    clearControlLedger,
    advanceGeneration: () => {
      generation += 1;
    },
    executionState: options.adapter.executionState,
  });

  const snapshot = (): ProviderMockControlSnapshot => ({
    schemaVersion: 1,
    providerId: options.providerId,
    generation,
    namespace: options.coordinator?.world.namespace ?? null,
    worldStateHash: options.coordinator?.world.stateHash ?? null,
    executionStateHash: payloadHash(
      toJsonValue(options.adapter.executionState(), "provider execution state"),
    ),
    globalExecutionStateHash: options.coordinator?.executionStateHash ?? null,
    state: structuredClone(options.adapter.inspect()),
    controlLedger: ledger.map((entry) => ({ ...entry })),
    certification: "mock-only-not-provider-qualified",
  });

  return {
    dispose(): void {
      unregister?.();
    },
    async handle(request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(PROVIDER_MOCK_CONTROL_PREFIX)) return null;
      if (request.headers.get(CONTROL_TOKEN_HEADER) !== options.token) {
        return controlJson({ error: { code: "control_not_found" } }, 404);
      }
      const suffix = url.pathname.slice(PROVIDER_MOCK_CONTROL_PREFIX.length);
      if (request.method === "GET" && suffix === "/state") {
        return controlJson(snapshot());
      }
      if (request.method !== "POST") {
        return controlJson({ error: { code: "method_not_allowed" } }, 405);
      }

      const parsed = await parseControlBody(request);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const expectedGeneration = body.expectedGeneration;
      if (
        expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) ||
          expectedGeneration !== generation)
      ) {
        return controlJson(
          {
            error: {
              code: "generation_conflict",
              expected: expectedGeneration,
              actual: generation,
            },
          },
          409,
        );
      }

      const generationBefore = generation;
      let command: ProviderMockControlLedgerEntry["command"];
      if (suffix === "/world/reset") {
        if (!options.coordinator) {
          return controlJson({ error: { code: "world_not_configured" } }, 409);
        }
        options.coordinator.reset();
        return controlJson(snapshot());
      }
      if (suffix === "/reset") {
        command = "reset";
        options.adapter.reset();
        clearControlLedger();
      } else if (suffix === "/seed") {
        command = "seed";
        const fixtures = validateFixtures(body.fixtures);
        if (!fixtures.ok) return fixtures.response;
        options.adapter.seed(fixtures.value);
      } else if (suffix === "/fault") {
        command = "fault";
        const fault = validateFaultCommand(body);
        if (!fault.ok) return fault.response;
        options.adapter.enqueueFault(fault.method, fault.path, fault.fault);
      } else {
        return controlJson({ error: { code: "control_not_found" } }, 404);
      }

      generation += 1;
      if (command !== "reset") {
        ledger.push({
          sequence: ++sequence,
          command,
          generationBefore,
          generationAfter: generation,
          occurredAt: new Date(now()).toISOString(),
        });
        options.coordinator?.world.ledger.append({
          kind: "lifecycle",
          status: "committed",
          target: `provider.${options.providerId}.control.${command}`,
          attempt: sequence,
          payloadHash: payloadHash(
            toJsonValue(
              options.adapter.executionState(),
              "provider execution state",
            ),
          ),
        });
      }
      return controlJson(snapshot());
    },
  };
}

type ParsedBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

async function parseControlBody(request: Request): Promise<ParsedBody> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        response: controlJson({ error: { code: "invalid_control_body" } }, 400),
      };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    // error-policy:J3 Control input is untrusted and never receives a default.
    return {
      ok: false,
      response: controlJson(
        {
          error: {
            code: "invalid_control_json",
            detail: error instanceof Error ? error.name : "parse_error",
          },
        },
        400,
      ),
    };
  }
}

export function assertProviderProtocolFixtures(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): asserts value is ProviderProtocolFixture[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new Error("fixtures must be a non-empty array");
  }
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("fixture must be an object");
    const fixture = candidate as Record<string, unknown>;
    if (typeof fixture.id !== "string" || fixture.id.trim().length === 0)
      throw new Error("fixture id is required");
    if (ids.has(fixture.id)) throw new Error("fixture ids must be unique");
    ids.add(fixture.id);
    if (
      typeof fixture.method !== "string" ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(fixture.method)
    )
      throw new Error("fixture method is invalid");
    if (typeof fixture.path !== "string" || !/^\/(?!\/)/.test(fixture.path))
      throw new Error("fixture path is invalid");
    const route = `${fixture.method} ${fixture.path}`;
    if (routes.has(route)) throw new Error("fixture routes must be unique");
    routes.add(route);
    validateResponse(fixture.response);
    if (fixture.action !== undefined) validateAction(fixture.action);
  }
}

function validateFixtures(
  value: unknown,
):
  | { ok: true; value: ProviderProtocolFixture[] }
  | { ok: false; response: Response } {
  try {
    assertProviderProtocolFixtures(value);
    return { ok: true, value };
  } catch (error) {
    // error-policy:J3 Fixture authoring failures are sanitized at the control boundary.
    return {
      ok: false,
      response: controlJson(
        {
          error: {
            code: "invalid_fixture",
            detail: error instanceof Error ? error.message : "invalid fixture",
          },
        },
        400,
      ),
    };
  }
}

function validateFaultCommand(value: Record<string, unknown>):
  | {
      ok: true;
      method: string;
      path: string;
      fault: ProviderProtocolFault;
    }
  | { ok: false; response: Response } {
  const method = value.method;
  const path = value.path;
  const fault = value.fault;
  if (
    typeof method !== "string" ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase()) ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    !fault ||
    typeof fault !== "object" ||
    !["delay", "malformed-json", "schema-drift", "status"].includes(
      String((fault as { type?: unknown }).type),
    ) ||
    !isValidFault(fault)
  ) {
    return {
      ok: false,
      response: controlJson({ error: { code: "invalid_fault" } }, 400),
    };
  }
  return {
    ok: true,
    method: method.toUpperCase(),
    path,
    fault: fault as ProviderProtocolFault,
  };
}

function validateResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("fixture response must be an object");
  const response = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(response.status) ||
    Number(response.status) < 100 ||
    Number(response.status) > 599
  )
    throw new Error("fixture response status must be between 100 and 599");
  if (response.rawBody !== undefined && typeof response.rawBody !== "string")
    throw new Error("fixture rawBody must be a string");
  if (response.rawBody !== undefined && response.body !== undefined)
    throw new Error("fixture response cannot declare both body and rawBody");
  if (response.body !== undefined)
    toJsonValue(response.body, "fixture response body");
  validateStringRecord(response.headers, "fixture response headers");
}

function validateAction(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("fixture action must be an object");
  const action = value as Record<string, unknown>;
  if (
    typeof action.operation !== "string" ||
    !action.operation.trim() ||
    typeof action.capabilityId !== "string" ||
    !action.capabilityId.trim() ||
    !["read", "write", "irreversible"].includes(String(action.effect)) ||
    !["R0", "R1", "R2", "R3"].includes(String(action.riskLevel)) ||
    !["allow", "deny"].includes(String(action.decision))
  )
    throw new Error("fixture action policy is invalid");
  const confirmation = action.confirmation;
  if (
    !confirmation ||
    typeof confirmation !== "object" ||
    Array.isArray(confirmation)
  )
    throw new Error("fixture action confirmation is invalid");
  const state = (confirmation as Record<string, unknown>).state;
  if (!["not_required", "already_granted", "required"].includes(String(state)))
    throw new Error("fixture action confirmation state is invalid");
  if (
    state === "required" &&
    (typeof (confirmation as Record<string, unknown>).confirmationId !==
      "string" ||
      !(confirmation as Record<string, unknown>).confirmationId)
  )
    throw new Error("required confirmation needs confirmationId");
}

function validateStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  if (
    Object.entries(value).some(
      ([key, item]) => !key || typeof item !== "string",
    )
  )
    throw new Error(`${label} must contain string values`);
}

function isValidFault(value: object): boolean {
  const fault = value as Record<string, unknown>;
  if (fault.type === "delay")
    return (
      Number.isSafeInteger(fault.durationMs) && Number(fault.durationMs) >= 0
    );
  if (fault.type === "malformed-json")
    return fault.body === undefined || typeof fault.body === "string";
  if (fault.type === "schema-drift") {
    try {
      toJsonValue(fault.body, "schema drift body");
      return true;
    } catch {
      // error-policy:J3 Invalid injected payloads are rejected at authoring time.
      return false;
    }
  }
  if (fault.type === "status") {
    if (
      !Number.isSafeInteger(fault.status) ||
      Number(fault.status) < 100 ||
      Number(fault.status) > 599
    )
      return false;
    try {
      if (fault.body !== undefined) toJsonValue(fault.body, "fault body");
      validateStringRecord(fault.headers, "fault headers");
      return true;
    } catch {
      // error-policy:J3 Invalid injected payloads are rejected at authoring time.
      return false;
    }
  }
  return false;
}

function toJsonValue(
  value: unknown,
  label: string,
): import("@elizaos/synthetic-world").JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item) => toJsonValue(item, label));
  if (value && typeof value === "object") {
    const output: Record<string, import("@elizaos/synthetic-world").JsonValue> =
      {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      output[key] = toJsonValue(item, label);
    }
    return output;
  }
  throw new Error(`${label} must be finite JSON data`);
}

function controlJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
