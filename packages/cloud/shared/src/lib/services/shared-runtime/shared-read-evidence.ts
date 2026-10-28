/** Projects actual guarded origin responses into owner/turn/operation-bound weather evidence before extraction. */

import type { WebFetchEvidencePort } from "@elizaos/plugin-coding-tools/edge";
import { webSearchSourceEvidence } from "@elizaos/plugin-web-search/edge";
import { normalizedRealtimeQuery } from "./shared-realtime-grounding";
import {
  type SharedPublicSearchPart,
  typedReadRequirementId,
  typedTemperatureEvidenceMessage,
} from "./shared-typed-read-domain";
import {
  inspectWorldWeatherBody,
  isVerifiedWorldWeatherRead,
  resolveWorldWeatherScope,
  type WorldWeatherModelRead,
  worldWeatherSourceUrl,
} from "./shared-world-weather";

export interface SharedPublicReadScope {
  ownerScope: string;
  turnId: string;
  turnStartedAtMs: number;
  parts: readonly SharedPublicSearchPart[];
}

interface OriginOperation {
  url: string;
  requestedAt: number;
  retrievedAt: number;
  requestPolicy: { method: "GET"; redirect: "manual"; cache: "no-store" };
}
export interface SharedOriginReadEvidence {
  format: "elizaos.shared-origin-read.v1";
  ownerScope: string;
  turnId: string;
  turnStartedAtMs: number;
  requirementId: string;
  query: string;
  operation: OriginOperation;
  kind: "world-model" | "wttr-origin";
  worldWeatherRead?: WorldWeatherModelRead;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  } // error-policy:J3 Malformed source URLs have no origin evidence.
}

/** The port changes no ordinary transport unless this original scoped request is opted in. */
export function createSharedReadEvidencePort(
  scope: SharedPublicReadScope,
): WebFetchEvidencePort | undefined {
  const targets = scope.parts.flatMap((part, index) => {
    if (part.requirement.domain !== "weather") return [];
    const world = resolveWorldWeatherScope(
      typedTemperatureEvidenceMessage(part.message),
      scope.turnStartedAtMs,
    );
    return world
      ? [
          {
            part,
            world,
            id: typedReadRequirementId(part, index),
            url: worldWeatherSourceUrl(world),
          },
        ]
      : [];
  });
  const news = scope.parts.flatMap((part, index) =>
    part.requirement.domain === "news" ? [{ part, id: typedReadRequirementId(part, index) }] : [],
  );
  if (
    !scope.ownerScope ||
    !scope.turnId ||
    !Number.isSafeInteger(scope.turnStartedAtMs) ||
    (!targets.length && !news.length)
  )
    return undefined;
  const originUrls = new Set(
    targets.flatMap((target) => [
      target.url,
      ...(target.world.kind === "current"
        ? [
            `https://wttr.in/${target.world.place.latitude},${target.world.place.longitude}?format=j1`,
          ]
        : []),
    ]),
  );
  const discoveredUrls = new Set<string>();
  const targetFor = (url: string) =>
    targets.find(
      (target) =>
        url === target.url ||
        (target.world.kind === "current" && originOf(url) === "https://wttr.in"),
    );
  return {
    authorizeUrl(url) {
      return originUrls.has(url) || discoveredUrls.has(url);
    },
    authorizedUrls() {
      return [...originUrls, ...discoveredUrls];
    },
    observePublicSearch(result, query) {
      if (
        result.success !== true ||
        typeof result.text !== "string" ||
        result.data?.actionName !== "WEB_SEARCH" ||
        normalizedRealtimeQuery(result.data.query) !== normalizedRealtimeQuery(query) ||
        !news.some(
          ({ part }) =>
            normalizedRealtimeQuery(part.requirement.query) === normalizedRealtimeQuery(query),
        )
      )
        return;
      const source = webSearchSourceEvidence(result.text);
      if (!source.overflowed) for (const url of source.sourceUrls) discoveredUrls.add(url);
    },
    acceptsOriginUrl(url) {
      return targetFor(url) !== undefined;
    },
    projectOrigin(response) {
      const target = targetFor(response.url),
        policy = response.requestPolicy;
      if (
        !target ||
        response.kind !== "origin-http" ||
        response.ok !== true ||
        response.status !== 200 ||
        response.truncated !== false ||
        !policy ||
        policy.method !== "GET" ||
        policy.redirect !== "manual" ||
        policy.cache !== "no-store" ||
        !Number.isSafeInteger(response.requestedAt) ||
        !Number.isSafeInteger(response.retrievedAt) ||
        Number(response.requestedAt) < scope.turnStartedAtMs ||
        Number(response.retrievedAt) < Number(response.requestedAt) ||
        Number(response.retrievedAt) > Date.now() + 60000
      )
        return undefined;
      const base = {
        format: "elizaos.shared-origin-read.v1" as const,
        ownerScope: scope.ownerScope,
        turnId: scope.turnId,
        turnStartedAtMs: scope.turnStartedAtMs,
        requirementId: target.id,
        query: target.part.requirement.query,
        operation: {
          url: response.url,
          requestedAt: Number(response.requestedAt),
          retrievedAt: Number(response.retrievedAt),
          requestPolicy: policy,
        },
      };
      if (originOf(response.url) === "https://wttr.in") return { ...base, kind: "wttr-origin" };
      if (
        response.url !== target.url ||
        !/^(?:application\/(?:[\w.+-]+\+)?json)(?:;|$)/iu.test(response.contentType)
      )
        return undefined;
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch (error) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      } // error-policy:J3 Malformed origin JSON has no model evidence.
      const read = inspectWorldWeatherBody(body, target.world, Number(response.requestedAt));
      if (!read) return undefined;
      read.retrievedAt = Number(response.retrievedAt);
      if (
        !isVerifiedWorldWeatherRead(
          read,
          typedTemperatureEvidenceMessage(target.part.message),
          response.url,
          Date.now(),
        )
      )
        return undefined;
      return { ...base, kind: "world-model", worldWeatherRead: read };
    },
    projectProvider(response) {
      const target = news[0];
      if (
        !target ||
        response.kind !== "provider-extract" ||
        response.provider !== "parallel" ||
        response.truncated !== false ||
        !Number.isSafeInteger(response.requestedAt) ||
        !Number.isSafeInteger(response.observedAt) ||
        Number(response.requestedAt) < scope.turnStartedAtMs ||
        response.observedAt < Number(response.requestedAt) ||
        response.observedAt > Date.now() + 60000
      )
        return undefined;
      return {
        format: "elizaos.shared-article-read.v1",
        ownerScope: scope.ownerScope,
        turnId: scope.turnId,
        turnStartedAtMs: scope.turnStartedAtMs,
        requirementId: target.id,
        query: target.part.requirement.query,
        operation: {
          url: response.url,
          requestedAt: Number(response.requestedAt),
          retrievedAt: response.observedAt,
          transport: "parallel-extract",
        },
      };
    },
  };
}

/** Revalidates the producer projection against the actual current call receipt and original request. */
export function readSharedOriginReadEvidence(input: {
  value: unknown;
  scope: SharedPublicReadScope;
  requirementId: string;
  part: SharedPublicSearchPart;
  url: string;
  originRead: unknown;
  nowMs: number;
}): SharedOriginReadEvidence | undefined {
  const value = record(input.value),
    operation = record(value?.operation),
    policy = record(operation?.requestPolicy),
    receipt = record(input.originRead);
  if (
    !value ||
    !operation ||
    !policy ||
    !receipt ||
    value.format !== "elizaos.shared-origin-read.v1" ||
    value.ownerScope !== input.scope.ownerScope ||
    value.turnId !== input.scope.turnId ||
    value.turnStartedAtMs !== input.scope.turnStartedAtMs ||
    value.requirementId !== input.requirementId ||
    value.query !== input.part.requirement.query ||
    receipt.format !== "elizaos.web-fetch.origin.v1" ||
    receipt.url !== input.url ||
    operation.url !== input.url ||
    receipt.status !== 200 ||
    receipt.redirect !== "manual" ||
    receipt.cache !== "no-store" ||
    policy.method !== "GET" ||
    policy.redirect !== "manual" ||
    policy.cache !== "no-store" ||
    !Number.isSafeInteger(operation.requestedAt) ||
    !Number.isSafeInteger(operation.retrievedAt) ||
    operation.requestedAt !== receipt.requestedAt ||
    operation.retrievedAt !== receipt.retrievedAt ||
    Number(operation.requestedAt) < input.scope.turnStartedAtMs ||
    Number(operation.retrievedAt) < Number(operation.requestedAt) ||
    Number(operation.retrievedAt) > input.nowMs + 60000
  )
    return undefined;
  const base = {
    format: "elizaos.shared-origin-read.v1" as const,
    ownerScope: input.scope.ownerScope,
    turnId: input.scope.turnId,
    turnStartedAtMs: input.scope.turnStartedAtMs,
    requirementId: input.requirementId,
    query: input.part.requirement.query,
    operation: {
      url: input.url,
      requestedAt: Number(operation.requestedAt),
      retrievedAt: Number(operation.retrievedAt),
      requestPolicy: {
        method: "GET" as const,
        redirect: "manual" as const,
        cache: "no-store" as const,
      },
    },
  };
  if (value.kind === "wttr-origin") {
    if (originOf(input.url) !== "https://wttr.in" || value.worldWeatherRead !== undefined)
      return undefined;
    return { ...base, kind: "wttr-origin" };
  } else if (value.kind === "world-model") {
    if (
      !isVerifiedWorldWeatherRead(
        value.worldWeatherRead,
        typedTemperatureEvidenceMessage(input.part.message),
        input.url,
        input.nowMs,
      )
    )
      return undefined;
    if (
      value.worldWeatherRead.requestedAt !== operation.requestedAt ||
      value.worldWeatherRead.retrievedAt !== operation.retrievedAt
    )
      return undefined;
    return { ...base, kind: "world-model", worldWeatherRead: value.worldWeatherRead };
  }
  return undefined;
}

/** Binds a completed provider article read to the actual operation and original owner/turn requirement. */
export function matchesSharedArticleReadEvidence(input: {
  value: unknown;
  scope: SharedPublicReadScope;
  requirementId: string;
  part: SharedPublicSearchPart;
  url: string;
  retrievedAt: number;
  nowMs: number;
}): boolean {
  const value = record(input.value),
    operation = record(value?.operation);
  return Boolean(
    value &&
      operation &&
      value.format === "elizaos.shared-article-read.v1" &&
      value.ownerScope === input.scope.ownerScope &&
      value.turnId === input.scope.turnId &&
      value.turnStartedAtMs === input.scope.turnStartedAtMs &&
      value.requirementId === input.requirementId &&
      value.query === input.part.requirement.query &&
      operation.transport === "parallel-extract" &&
      operation.url === input.url &&
      Number.isSafeInteger(operation.requestedAt) &&
      Number.isSafeInteger(operation.retrievedAt) &&
      Number(operation.requestedAt) >= input.scope.turnStartedAtMs &&
      Number(operation.retrievedAt) >= Number(operation.requestedAt) &&
      operation.retrievedAt === input.retrievedAt &&
      input.retrievedAt <= input.nowMs + 60000,
  );
}
