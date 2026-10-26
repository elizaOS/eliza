/** Projects existing producer-validated public reads into the canonical evaluator's opt-in contract. */
import { ChannelType, type MessageProcessingOptions } from "@elizaos/core";
import { webSearchSourceEvidence } from "@elizaos/plugin-web-search/edge";
import {
  CURRENT_WEATHER_LIMITS,
  isVerifiedCurrentNwsObservation,
  parseExplicitUsWeatherQuery,
} from "./shared-current-weather";
import {
  articleMatchesNewsTopic,
  newsArticleEvidenceConflict,
  ownArticleTitle,
  publisherArticlePublication,
  recentNewsArticlePublication,
  verifiedNewsPublicationScope,
} from "./shared-news-publication";
import {
  matchesSharedArticleReadEvidence,
  readSharedOriginReadEvidence,
  type SharedPublicReadScope,
} from "./shared-read-evidence";
import { normalizedRealtimeQuery } from "./shared-realtime-grounding";
import {
  inspectCurrentWttrOriginTemperature,
  isSimpleCurrentTemperatureRequest,
  readSharedLatestWeatherReport,
  resolveTypedNwsReadScope,
  resolveTypedPublicReadParts,
  type SharedPublicSearchPart,
  sharedNewsSearchMatchesRequest,
  sharedReplyWantsSourceLinks,
  typedReadRequirementId,
  typedTemperatureEvidenceMessage,
  WTTR_CURRENT_OBSERVATION_AGE_MS,
} from "./shared-typed-read-domain";
import {
  resolveWorldWeatherPlace,
  resolveWorldWeatherScope,
  WORLD_WEATHER_TIME,
  weatherLocationWithoutTemperatureUnit,
} from "./shared-world-weather";

type Resolver = NonNullable<MessageProcessingOptions["resolveTypedReadReply"]>;
type Binding = NonNullable<ReturnType<Resolver>>;

function ownArticle(value: string): { url: string; title: string; excerpts: string[] } | undefined {
  try {
    const article: unknown = JSON.parse(value);
    if (!article || typeof article !== "object" || Array.isArray(article)) return undefined;
    const record = article as Record<string, unknown>;
    if (
      typeof record.url !== "string" ||
      typeof record.title !== "string" ||
      !Array.isArray(record.excerpts) ||
      !record.excerpts.every((x) => typeof x === "string")
    )
      return undefined;
    return article as { url: string; title: string; excerpts: string[] };
  } catch {
    // error-policy:J3 A malformed extraction has no article authority.
    return undefined;
  }
}

/** Only server-owned original requirements and room identity may construct this callback. */
export function createSharedTypedReadReplyResolver(input: {
  ownerScope: string;
  parts: readonly SharedPublicSearchPart[];
  includeSources: boolean;
  turnId: string;
  turnStartedAtMs: number;
  /** Existing host eligibility only; these callbacks do not grant or reserve spending. */
  onNewsReadStatus?: (verified: boolean) => void;
  fallbackAvailable?: () => boolean;
}): Resolver | undefined {
  if (
    !input.ownerScope ||
    !input.turnId ||
    !Number.isSafeInteger(input.turnStartedAtMs) ||
    input.parts.length !== 1 ||
    input.parts.some(
      (part) =>
        !["weather", "news"].includes(part.requirement.domain) ||
        (part.requirement.domain === "weather" &&
          !isSimpleCurrentTemperatureRequest(part.message)) ||
        (part.requirement.domain === "news" && part.requirement.publicationScope === undefined),
    )
  )
    return undefined;
  const originScope: SharedPublicReadScope | undefined =
    input.turnId && input.turnStartedAtMs !== undefined
      ? {
          ownerScope: input.ownerScope,
          turnId: input.turnId,
          turnStartedAtMs: input.turnStartedAtMs,
          parts: input.parts,
        }
      : undefined;
  return ({ trajectory, nowMs, admittedToolNames }) => {
    const facts: Binding["facts"][number][] = [];
    const requirements: Binding["policy"]["requirements"][number][] = [];
    const remaining = new Set<string>();
    const pending = new Set<string>();
    const steps = [...trajectory.archivedSteps, ...trajectory.steps];
    for (const [index, part] of input.parts.entries()) {
      const requirement = part.requirement;
      const id = typedReadRequirementId(part, index);
      const admittedFactIds: string[] = [];
      const qualifiedFactIds: string[] = [];
      let freshnessMs = CURRENT_WEATHER_LIMITS.observationAgeMs;
      const simpleTemperature =
        requirement.domain === "weather" && isSimpleCurrentTemperatureRequest(part.message);
      const world = simpleTemperature
        ? resolveWorldWeatherScope(
            typedTemperatureEvidenceMessage(part.message),
            input.turnStartedAtMs ?? nowMs,
          )
        : undefined;
      const searchUrls = new Set<string>();
      const articleReads = new Map<
        string,
        Array<{ article: NonNullable<ReturnType<typeof ownArticle>>; at: number }>
      >();
      const conflictedUrls = new Set<string>();
      let settledSearch = false;
      let settledNws = false;
      let articleReadAttempted = false;
      const settledFetchUrls = new Set<string>();
      const eligibleSearch = (query: unknown) =>
        typeof query === "string" &&
        (normalizedRealtimeQuery(query) === normalizedRealtimeQuery(requirement.query) ||
          resolveTypedNwsReadScope(part, query) !== undefined ||
          (requirement.domain === "news" && sharedNewsSearchMatchesRequest(query, requirement)));
      for (const step of steps) {
        const call = step.toolCall,
          result = step.result;
        if (!call || !result || !call.id) continue;
        const attemptedNwsScope =
          call.name === "WEB_SEARCH" && typeof call.params?.query === "string"
            ? resolveTypedNwsReadScope(part, call.params.query)
            : undefined;
        const settledNwsScope =
          result.data?.actionName === "WEB_SEARCH" && typeof result.data.query === "string"
            ? resolveTypedNwsReadScope(part, result.data.query)
            : undefined;
        // A source-bearing search is discovery, not an observation. Permit the
        // normal planner's one scoped producer attempt, then honor its settled
        // success or failure rather than keeping an unbounded retry obligation.
        if (
          simpleTemperature &&
          attemptedNwsScope &&
          settledNwsScope?.producerQuery === attemptedNwsScope.producerQuery
        )
          settledNws = true;
        if (
          call.name === "WEB_SEARCH" &&
          call.params?.provider !== "fallback" &&
          eligibleSearch(call.params?.query)
        )
          settledSearch = true;
        if (
          call.name === "WEB_FETCH" &&
          typeof call.params?.url === "string" &&
          searchUrls.has(call.params.url)
        )
          settledFetchUrls.add(call.params.url);
        if (!result.success) continue;
        const factId = JSON.stringify([input.ownerScope, id, step.iteration, call.id]);
        if (call.name === "WEB_SEARCH" && eligibleSearch(call.params?.query)) {
          const observation = result.data?.weatherObservation;
          const nwsScope =
            typeof call.params?.query === "string"
              ? resolveTypedNwsReadScope(part, call.params.query)
              : undefined;
          const resultNwsScope =
            typeof result.data?.query === "string"
              ? resolveTypedNwsReadScope(part, result.data.query)
              : undefined;
          if (
            simpleTemperature &&
            nwsScope &&
            result.data?.actionName === "WEB_SEARCH" &&
            result.data.provider === "nws" &&
            resultNwsScope?.producerQuery === nwsScope.producerQuery &&
            isVerifiedCurrentNwsObservation(observation, nwsScope.producerQuery, nowMs)
          ) {
            if (nwsScope.namedPlaceAlternative) {
              const sourcePlace = resolveWorldWeatherPlace(
                `${observation.city}, ${observation.state}, United States`,
              );
              facts.push({
                id: factId,
                kind: "quantity-report",
                qualification: "named-place-alternative",
                ownerScope: input.ownerScope,
                sourceUrl: observation.sourceUrl,
                value: observation.temperatureC,
                unit: "°C",
                providerLocality: `${observation.city}, ${sourcePlace?.region ?? observation.state}, United States`,
                observedAtMs: Date.parse(observation.timestamp),
              });
              qualifiedFactIds.push(factId);
            } else {
              facts.push({
                id: factId,
                kind: "quantity",
                ownerScope: input.ownerScope,
                sourceUrl: observation.sourceUrl,
                value: observation.temperatureC,
                unit: "°C",
                observedAtMs: Date.parse(observation.timestamp),
              });
              admittedFactIds.push(factId);
            }
          }
          if (typeof result.text === "string") {
            const evidence = webSearchSourceEvidence(result.text);
            if (!evidence.overflowed) for (const url of evidence.sourceUrls) searchUrls.add(url);
          }
        }
        if (
          simpleTemperature &&
          originScope &&
          call.name === "WEB_FETCH" &&
          typeof call.params?.url === "string" &&
          result.data?.action === "WEB_FETCH" &&
          result.data.url === call.params.url &&
          result.data.final_url === call.params.url &&
          result.data.provider === undefined &&
          result.data.status === 200 &&
          result.data.kind === "json" &&
          result.data.truncated === false
        ) {
          const evidence = readSharedOriginReadEvidence({
            value: result.data.readEvidence,
            scope: originScope,
            requirementId: id,
            part,
            url: call.params.url,
            originRead: result.data.originRead,
            nowMs,
          });
          if (
            evidence?.kind === "world-model" &&
            evidence.worldWeatherRead?.authority === "near_current_model" &&
            world?.kind === "current" &&
            !/\b(?:observations?|observed|measured|measurement|station)\b/iu.test(part.message)
          ) {
            const read = evidence.worldWeatherRead,
              point = read.points[0];
            facts.push({
              id: factId,
              kind: "quantity",
              ownerScope: input.ownerScope,
              sourceUrl: call.params.url,
              value: point.temperatureC,
              unit: "°C",
              modelEstimate: {
                validAtMs: Date.parse(point.validAt),
                modelUpdatedAtMs: Date.parse(read.modelUpdatedAt),
                creditConnectorId: "weather-credit",
              },
            });
            admittedFactIds.push(factId);
          } else if (evidence?.kind === "wttr-origin") {
            const current = inspectCurrentWttrOriginTemperature(
              result.data.originRead,
              part.message,
              nowMs,
            );
            if (current.status === "available") {
              freshnessMs = Math.min(freshnessMs, WTTR_CURRENT_OBSERVATION_AGE_MS);
              facts.push({
                id: factId,
                kind: "quantity",
                ownerScope: input.ownerScope,
                sourceUrl: current.current.sourceUrl,
                value: current.current.temperatureC,
                unit: "°C",
                observedAtMs: current.current.observedAtMs,
              });
              admittedFactIds.push(factId);
            } else {
              // Current-point authority and a qualified nearby report have independent validators.
              // Only the existing report validator may admit this alternative, never as current.
              const report = readSharedLatestWeatherReport(result, part.message, nowMs);
              if (report) {
                facts.push({
                  id: factId,
                  kind: "quantity-report",
                  ownerScope: input.ownerScope,
                  sourceUrl: report.sourceUrl,
                  value: report.temperatureC,
                  unit: "°C",
                  providerLocality: report.providerLocality,
                  ...(report.reportedDate ? { reportedDay: report.reportedDate } : {}),
                });
                qualifiedFactIds.push(factId);
              }
            }
          }
        }
        // Only the admitted provider operation can own an article read.
        // Discovery is optional; its dates never become article authority.
        if (
          requirement.domain !== "news" ||
          call.name !== "WEB_FETCH" ||
          typeof call.params?.url !== "string" ||
          result.data?.read_method !== "provider_extract" ||
          result.data.provider !== "parallel" ||
          result.data.truncated !== false ||
          result.data.url !== call.params.url ||
          typeof result.data.retrieved_at !== "number" ||
          result.data.retrieved_at > nowMs ||
          typeof result.text !== "string"
        )
          continue;
        if (
          !originScope ||
          !matchesSharedArticleReadEvidence({
            value: result.data.readEvidence,
            scope: originScope,
            requirementId: id,
            part,
            url: call.params.url,
            retrievedAt: result.data.retrieved_at,
            nowMs,
          })
        )
          continue;
        articleReadAttempted = true;
        const scope = verifiedNewsPublicationScope(
          requirement.publicationScope,
          requirement.publicationScope?.query ?? requirement.query,
          nowMs,
        );
        if (!scope) continue;
        const retrievedAt = result.data.retrieved_at;
        const evidence = webSearchSourceEvidence(result.text);
        if (evidence.overflowed) continue;
        for (const source of evidence.sources) {
          if (source.url !== call.params.url) continue;
          const article = ownArticle(source.text);
          if (!article || !ownArticleTitle(article, source.url)) continue;
          const prior = articleReads.get(source.url) ?? [];
          if (
            prior.some((read) =>
              newsArticleEvidenceConflict(
                read.article,
                article,
                source.url,
                scope.timeZone,
                Math.max(read.at, retrievedAt),
              ),
            )
          )
            conflictedUrls.add(source.url);
          prior.push({ article, at: result.data.retrieved_at });
          articleReads.set(source.url, prior);
          if (
            conflictedUrls.has(source.url) ||
            !articleMatchesNewsTopic(article, requirement.query)
          )
            continue;
          const publication = publisherArticlePublication(
            article,
            source.url,
            article.title,
            scope.timeZone,
            result.data.retrieved_at,
          );
          if (!publication || publication.day !== scope.day) {
            const alternative = recentNewsArticlePublication(
              scope,
              article,
              source.url,
              article.title,
              result.data.retrieved_at,
            );
            if (alternative) {
              facts.push({
                id: factId,
                kind: "publication-report",
                ownerScope: input.ownerScope,
                sourceUrl: source.url,
                title: article.title,
                publicationDay: alternative.day,
              });
              qualifiedFactIds.push(factId);
            }
            continue;
          }
          facts.push({
            id: factId,
            kind: "publication",
            ownerScope: input.ownerScope,
            sourceUrl: source.url,
            title: article.title,
            publicationDay: publication.day,
          });
          admittedFactIds.push(factId);
          break;
        }
      }
      if (conflictedUrls.size) {
        const admitted = new Set([...admittedFactIds, ...qualifiedFactIds]);
        const invalid = new Set(
          facts
            .filter((fact) => admitted.has(fact.id) && conflictedUrls.has(fact.sourceUrl))
            .map((fact) => fact.id),
        );
        for (let at = facts.length - 1; at >= 0; at--)
          if (invalid.has(facts[at].id)) facts.splice(at, 1);
        admittedFactIds.splice(
          0,
          admittedFactIds.length,
          ...admittedFactIds.filter((id) => !invalid.has(id)),
        );
        qualifiedFactIds.splice(
          0,
          qualifiedFactIds.length,
          ...qualifiedFactIds.filter((id) => !invalid.has(id)),
        );
      }
      if (requirement.domain === "news" && articleReadAttempted)
        input.onNewsReadStatus?.(admittedFactIds.length > 0);
      const sourceTemperatureFact = facts.find(
        (fact) =>
          (admittedFactIds.includes(fact.id) && fact.kind === "quantity") ||
          (qualifiedFactIds.includes(fact.id) && fact.kind === "quantity-report"),
      );
      const namedAlternativeFact = facts.find(
        (fact) =>
          qualifiedFactIds.includes(fact.id) &&
          fact.kind === "quantity-report" &&
          fact.qualification === "named-place-alternative",
      );
      // All supported producers expose °C. With no admitted fact this is planning-only, never egress proof.
      requirements.push(
        requirement.domain === "weather"
          ? {
              id,
              kind: "quantity",
              label: "Temperature",
              unit:
                sourceTemperatureFact && "unit" in sourceTemperatureFact
                  ? sourceTemperatureFact.unit
                  : "°C",
              current: true,
              freshnessMs,
              admittedFactIds,
              qualifiedFactIds,
              ...(world?.kind === "current" &&
              !/\b(?:observations?|observed|measured|measurement|station)\b/iu.test(part.message)
                ? {
                    modelEstimate: {
                      maxSourceAgeMs: WORLD_WEATHER_TIME.modelAgeMs,
                      maxValidDistanceMs: WORLD_WEATHER_TIME.currentValidDistanceMs,
                      futureSkewMs: WORLD_WEATHER_TIME.futureSkewMs,
                    },
                  }
                : {}),
              unverifiedText: namedAlternativeFact
                ? "I couldn't verify that this is the place you meant."
                : simpleTemperature
                  ? "I couldn't verify the current temperature."
                  : "I couldn't verify the requested weather details.",
            }
          : {
              id,
              kind: "publication",
              label: "News",
              requestedDay: requirement.publicationScope?.day,
              admittedFactIds,
              qualifiedFactIds,
              unverifiedText: "I couldn't verify a headline for the requested date.",
            },
      );
      if (!admittedFactIds.length) {
        for (const call of trajectory.plannedQueue) {
          if (
            call.id &&
            ((call.name === "WEB_SEARCH" && eligibleSearch(call.params?.query)) ||
              (call.name === "WEB_FETCH" &&
                typeof call.params?.url === "string" &&
                searchUrls.has(call.params.url)))
          )
            pending.add(call.id);
        }
        const next =
          requirement.domain === "news" && [...searchUrls].some((url) => !settledFetchUrls.has(url))
            ? "WEB_FETCH"
            : !settledSearch ||
                (simpleTemperature && searchUrls.size > 0 && !settledNws) ||
                (requirement.domain === "news" && input.fallbackAvailable?.() === true)
              ? "WEB_SEARCH"
              : undefined;
        if (next && admittedToolNames.includes(next)) remaining.add(next);
      }
    }
    return {
      phase: remaining.size || pending.size ? "planning" : "final-answer",
      remainingReadActionNames: [...remaining],
      pendingReadCallIds: [...pending],
      facts,
      policy: {
        ownerScope: input.ownerScope,
        turnId: input.turnId,
        nowMs,
        includeSources: input.includeSources,
        requirements,
        connectors: { paragraph: "\n\n", "weather-credit": "MET Norway/GeoNames" },
      },
    };
  };
}

/** Compose one server-attested private messaging turn; no transport, provider or artifact is activated here. */
export function createSharedTypedReadTurn(input: {
  enabled?: true;
  authenticatedPersonalSharedUser?: true;
  channelSource: string;
  channelType: string;
  agentKey: string;
  roomKey: string;
  userEntityId: string;
  turnId?: string;
  message: string;
  history: readonly import("./run-shared-agent-turn").SharedTurnMessage[];
  turnStartedAtMs?: number;
}) {
  if (
    input.enabled !== true ||
    input.authenticatedPersonalSharedUser !== true ||
    input.channelSource !== "blooio" ||
    input.channelType !== ChannelType.DM ||
    !input.agentKey ||
    !input.roomKey ||
    !input.userEntityId ||
    !input.turnId
  )
    return undefined;
  const turnStartedAtMs = input.turnStartedAtMs ?? Date.now();
  const parts = resolveTypedPublicReadParts(input.message, input.history, turnStartedAtMs);
  if (!parts || parts.length !== 1 || parts[0].requirement.domain !== "weather") return undefined;
  // This host currently registers only the US observation producer. Keep
  // future news/world-origin validators dormant until their actual readers
  // are wired. A unique public US catalog entry establishes availability,
  // never the user's intended location; bare-city answers remain qualified.
  const publicQuery = parts[0].requirement.query;
  const location = weatherLocationWithoutTemperatureUnit(
    publicQuery.slice("current public weather in ".length),
  ).trim();
  if (!publicQuery.startsWith("current public weather in ")) return undefined;
  if (!parseExplicitUsWeatherQuery(`current public weather in ${location}`)) {
    const [city, ...qualifiers] = location.split(",").map((piece) => piece.trim());
    if (
      qualifiers.length > 1 ||
      (qualifiers.length === 1 &&
        !/^(?:US|USA|United States(?: of America)?)$/iu.test(qualifiers[0])) ||
      resolveWorldWeatherPlace(`${city}, United States`)?.countryCode !== "US"
    )
      return undefined;
  }
  const scope: SharedPublicReadScope = {
    ownerScope: JSON.stringify([input.agentKey, input.roomKey, input.userEntityId]),
    turnId: input.turnId,
    turnStartedAtMs,
    parts,
  };
  const resolveTypedReadReply = createSharedTypedReadReplyResolver({
    ...scope,
    includeSources: sharedReplyWantsSourceLinks(input.message),
  });
  if (!resolveTypedReadReply) return undefined;
  return {
    scope,
    requirementIds: parts.map(typedReadRequirementId),
    authorizedPublicQueries: Object.freeze(parts.map((part) => part.requirement.query)),
    authorizePublicSearch(query: string) {
      for (const part of parts) {
        const nws = resolveTypedNwsReadScope(part, query);
        if (nws)
          return {
            kind: "nws" as const,
            query: nws.producerQuery,
            namedPlaceAlternative: nws.namedPlaceAlternative,
          };
        if (normalizedRealtimeQuery(query) === normalizedRealtimeQuery(part.requirement.query)) {
          // Never dispatch model casing/spacing as an outbound data channel.
          return {
            kind: "search" as const,
            query: part.requirement.query,
            namedPlaceAlternative: false,
          };
        }
      }
      return undefined;
    },
    resolveTypedReadReply,
  };
}
