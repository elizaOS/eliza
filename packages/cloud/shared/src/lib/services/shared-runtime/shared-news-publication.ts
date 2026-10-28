/** Actual publication precision, never search retrieval time.
 * Parallel: https://docs.parallel.ai/api-reference/search/search (publish_date, YYYY-MM-DD)
 * Exa: https://exa.ai/docs/reference/search (publishedDate, offset-bearing ISO timestamp)
 */
import { resolveWorldWeatherPlace, worldWeatherLocalDay } from "./shared-world-place";

export interface SharedNewsPublicationScope {
  query: string;
  requestedAt: number;
  day: string;
  timeZone: string;
  reference: "place" | "utc";
  placeId?: number;
}
export interface SharedNewsPublicationEvidence {
  field: "publish_date" | "publishedDate" | "publisher_header_date" | "publisher_displayed_day";
  value: string;
  precision: "calendar-day" | "instant";
  day: string;
  requestedDay: string;
  /** Request reference only; date-only data never invents a publisher zone or instant. */
  requestedTimeZone: string;
}
function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}

/** Own opening headline identity; navigation, body and related headings cannot disagree for it. */
export function ownArticleTitle(value: unknown, url: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.url !== url ||
    typeof record.title !== "string" ||
    !Array.isArray(record.excerpts) ||
    !record.excerpts.every((excerpt) => typeof excerpt === "string")
  )
    return undefined;
  const normalize = (title: string) =>
    title
      .normalize("NFKC")
      .replace(/\*\*/gu, "")
      .split(/\s+\|\s+/u)[0]
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
  const expected = normalize(record.title);
  if (!expected) return undefined;
  try {
    if (
      /^\/$|\/(?:news|events|category|tag|search|latest|living|guides)\/?$/iu.test(
        new URL(url).pathname,
      )
    )
      return undefined;
  } catch {
    return undefined;
  }
  let matches = 0;
  for (const excerpt of record.excerpts as string[]) {
    const lines = excerpt.split(/\r?\n/u);
    for (let index = 0; index < Math.min(lines.length, 4); index++) {
      const heading = lines[index].match(/^#{1,2}\s+(.+)$/u);
      if (normalize(heading?.[1] ?? lines[index]) !== expected) continue;
      if (
        !lines
          .slice(0, index)
          .every(
            (line) =>
              !line.trim() || /^Home\s*\//u.test(line) || (heading && /^#{1,2}\s+/u.test(line)),
          )
      )
        continue;
      matches++;
    }
  }
  return matches === 1 ? expected : undefined;
}

/** Topic matching uses only the selected article body, excluding related-story navigation. */
export function articleMatchesNewsTopic(
  own: { title: string; excerpts: string[] },
  query: string,
): boolean {
  const topic = query.match(/^latest public (.+?) news dated /u)?.[1];
  const words = (text: string) =>
    new Set(
      text
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    );
  const body = [own.title, ...own.excerpts]
    .join("\n")
    .split(/\n(?:_?Related(?: coverage)?|#{1,6}\s+(?:Related|More))\b/iu)[0];
  const bodyWords = words(body);
  return Boolean(topic) && [...words(topic ?? "")].every((word) => bodyWords.has(word));
}

export type SharedNewsArticleConflict = "article_title_conflict" | "article_publication_conflict";

/** Two bounded own-article records can disagree without either becoming fresh origin authority. */
export function newsArticleEvidenceConflict(
  left: unknown,
  right: unknown,
  url: string,
  timeZone: string,
  observedAt: number,
): SharedNewsArticleConflict | undefined {
  const leftTitle = ownArticleTitle(left, url);
  const rightTitle = ownArticleTitle(right, url);
  if (!leftTitle || !rightTitle) return undefined;
  if (leftTitle !== rightTitle) return "article_title_conflict";
  const publication = (record: unknown) =>
    publisherArticlePublication(
      record,
      url,
      (record as { title: string }).title,
      timeZone,
      observedAt,
    ) ?? publisherCalendarArticlePublication(record, url, (record as { title: string }).title);
  const first = publication(left),
    second = publication(right);
  if (
    first &&
    second &&
    (first.day !== second.day ||
      (first.precision === "instant" &&
        second.precision === "instant" &&
        Date.parse(first.value) !== Date.parse(second.value)))
  )
    return "article_publication_conflict";
  return undefined;
}

/** Resolves only a selected article's bounded publication header, never surrounding page dates. */
export function publisherArticlePublication(
  value: unknown,
  url: string,
  title: string,
  timeZone: string,
  observedAt: number,
):
  | {
      value: string;
      day: string;
      intrinsicDay: string;
      precision: "calendar-day" | "instant";
      dateKind: "original_publication" | "publisher_displayed_day";
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.url !== url || typeof record.title !== "string" || !Array.isArray(record.excerpts))
    return undefined;
  const clean = (text: string) => text.replace(/\*\*/gu, "").trim();
  const sameTitle = (heading: string) => {
    const normalized = clean(heading);
    return normalized === clean(title) || clean(title).startsWith(normalized + " | ");
  };
  if (!sameTitle(record.title) || !record.excerpts.every((x) => typeof x === "string"))
    return undefined;
  const parseDate = (raw: string) => {
    let canonical = raw;
    if (!validDay(canonical) && !/^\d{4}-\d{2}-\d{2}T/u.test(canonical)) {
      const months = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];
      const first = canonical.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(.*)$/u);
      const second = canonical.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})(.*)$/u);
      if (!first && !second) return undefined;
      const name = (first?.[1] ?? second?.[2] ?? "").toLowerCase();
      const fullMonths = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ];
      const month = months.indexOf(name) >= 0 ? months.indexOf(name) : fullMonths.indexOf(name);
      if (month < 0) return undefined;
      const day = first?.[2] ?? second?.[1];
      const year = first?.[3] ?? second?.[3];
      canonical = `${year}-${String(month + 1).padStart(2, "0")}-${day?.padStart(2, "0")}`;
      if (!validDay(canonical)) return undefined;
      const clock = (first?.[4] ?? second?.[4] ?? "").trim().replace(/^,\s*/u, "");
      if (clock) {
        const time = clock.match(
          /^(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(Z|UTC|GMT|JST|EDT|EST|PDT|PST|[+-]\d{2}:\d{2})$/iu,
        );
        if (!time) return undefined;
        let hour = Number(time[1]);
        if (time[4]) {
          if (hour < 1 || hour > 12) return undefined;
          hour = (hour % 12) + (time[4].toLowerCase().startsWith("p") ? 12 : 0);
        }
        if (hour > 23 || Number(time[2]) > 59 || Number(time[3] ?? "0") > 59) return undefined;
        const offsets: Record<string, string> = {
          Z: "Z",
          UTC: "Z",
          GMT: "Z",
          JST: "+09:00",
          EDT: "-04:00",
          EST: "-05:00",
          PDT: "-07:00",
          PST: "-08:00",
        };
        const zone = offsets[time[5].toUpperCase()] ?? time[5];
        canonical += `T${String(hour).padStart(2, "0")}:${time[2]}:${time[3] ?? "00"}${zone}`;
      }
    }
    if (validDay(canonical))
      return {
        value: canonical,
        day: canonical,
        intrinsicDay: canonical,
        precision: "calendar-day" as const,
      };
    if (
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        canonical,
      ) ||
      !validDay(canonical.slice(0, 10)) ||
      !Number.isFinite(Date.parse(canonical)) ||
      Date.parse(canonical) > observedAt
    )
      return undefined;
    return {
      value: canonical,
      day: worldWeatherLocalDay(Date.parse(canonical), timeZone),
      intrinsicDay: canonical.slice(0, 10),
      precision: "instant" as const,
    };
  };
  const dates = new Map<
    string,
    NonNullable<ReturnType<typeof parseDate>> & {
      dateKind: "original_publication" | "publisher_displayed_day";
    }
  >();
  let matchedHeaders = 0;
  for (const excerpt of record.excerpts as string[]) {
    const lines = excerpt.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const heading = lines[index].match(/^#{1,2}\s+(.+)$/u);
      // Search excerpts can preserve an own title as plain text after a breadcrumb.
      // Only the opening title region qualifies; body/listing repetitions do not.
      const plainHeading =
        !heading &&
        index <= 3 &&
        sameTitle(lines[index]) &&
        lines.slice(0, index).every((line) => !line.trim() || /^Home\s*\//u.test(line));
      if ((!heading || !sameTitle(heading[1])) && !plainHeading) continue;
      if (plainHeading) {
        let path: string;
        try {
          path = new URL(url).pathname;
        } catch {
          return undefined;
        }
        if (
          /^\/$/u.test(path) ||
          /\/(?:news|events|category|tag|search|latest|living|guides)\/?$/iu.test(path)
        )
          return undefined;
      }
      matchedHeaders += 1;
      // A small header block can contain a byline, category and publication. Body/other headings end it.
      const header = lines.slice(index + 1, index + 13);
      let firstContent = true;
      let subtitleSeen = false;
      for (const [headerIndex, line] of header.entries()) {
        const text = clean(line);
        if (!text) continue;
        if (/^#{1,6}\s/u.test(text)) break;
        if (plainHeading) {
          const byline = text.match(/^By\s+[\p{L}\p{N} .&’'–-]{2,80}\s+•\s+(.+)$/u);
          if (byline) {
            const publication = parseDate(byline[1].trim());
            if (!publication) return undefined;
            const adjacent = header.slice(headerIndex + 1).find((next) => clean(next));
            if (
              adjacent &&
              (/^(?:By|Published|Posted|Publication|Updated|Modified|DateModified|Last[- ]Modified)\b/iu.test(
                clean(adjacent),
              ) ||
                parseDate(clean(adjacent)))
            )
              return undefined;
            dates.set(publication.value, { ...publication, dateKind: "original_publication" });
            break;
          }
          // One short subtitle may precede the byline, never a body/date/related block.
          if (
            !subtitleSeen &&
            text.length <= 160 &&
            !/[\d#]|https?:|^(?:By|Published|Posted|Updated|Modified|Related|More|Author)\b/iu.test(
              text,
            )
          ) {
            subtitleSeen = true;
            continue;
          }
          break;
        }
        if (/^(?:By\s+\S|Author\s*:|Category\s*:|Section\s*:)/iu.test(text)) {
          firstContent = false;
          continue;
        }
        if (/^(?:Updated|Modified|Retrieved|DateModified|Last[- ]Modified)\b/iu.test(text)) {
          firstContent = false;
          continue;
        }
        const bare =
          firstContent &&
          heading?.[0].startsWith("# ") &&
          (record.readMethod === "jina_no_cache" || record.readMethod === "cloudflare_browser")
            ? text.match(/^(.+?)\s+\|\s+[\p{L}\p{N} .&’'–-]{2,80}$/u)
            : null;
        firstContent = false;
        if (bare) {
          const displayed = parseDate(bare[1].trim());
          if (
            !displayed ||
            displayed.precision !== "calendar-day" ||
            header.some((x) =>
              /^(?:Updated|Modified|DateModified|Last[- ]Modified)\b/iu.test(clean(x)),
            )
          )
            return undefined;
          dates.set(displayed.value, { ...displayed, dateKind: "publisher_displayed_day" });
          continue;
        }
        const labeled = text.match(
          /^(?:Published|Posted|Publication\s+date)(?:\s+on)?\s*:?\s+(.+)$/iu,
        );
        if (!labeled) break;
        const publication = parseDate(labeled[1].trim());
        if (!publication) return undefined;
        dates.set(publication.value, { ...publication, dateKind: "original_publication" });
      }
    }
  }
  if (matchedHeaders !== 1 || dates.size !== 1) return undefined;
  const [publication] = dates.values();
  if (
    record.publish_date != null &&
    record.publish_date !== publication.intrinsicDay &&
    record.publish_date !== publication.day
  )
    return undefined;
  if (
    record.publishedDate != null &&
    record.publishedDate !== publication.value &&
    record.publishedDate !== publication.day
  )
    return undefined;
  return publication;
}
export function publicationScopedNewsQuery(
  subject: string | undefined,
  message: string,
  now = Date.now(),
): string {
  const base = subject ? `latest public ${subject} news` : "latest public news";
  if (!/\btoday\b/iu.test(message))
    return /^latest public .*news dated \d{4}-\d{2}-\d{2}(?: UTC)?$/u.test(message)
      ? message.trim()
      : base;
  const place = subject ? resolveWorldWeatherPlace(subject) : undefined;
  return `${base} dated ${worldWeatherLocalDay(now, place?.timeZone ?? "UTC")}${place ? "" : " UTC"}`;
}
/** Server query and original request clock agree with the public place/explicit UTC reference. */
export function newsPublicationScope(
  query: string,
  requestedAt: number,
): SharedNewsPublicationScope | undefined {
  const match = query.match(/^latest public (?:(.+) )?news dated (\d{4}-\d{2}-\d{2})( UTC)?$/iu);
  if (!match || !validDay(match[2]) || !Number.isSafeInteger(requestedAt) || requestedAt < 0)
    return undefined;
  const place = match[1] ? resolveWorldWeatherPlace(match[1]) : undefined;
  if ((!place && !match[3]) || (place && match[3])) return undefined;
  const timeZone = place?.timeZone ?? "UTC";
  if (worldWeatherLocalDay(requestedAt, timeZone) !== match[2]) return undefined;
  return {
    query,
    requestedAt,
    day: match[2],
    timeZone,
    reference: place ? "place" : "utc",
    ...(place ? { placeId: place.id } : {}),
  };
}
export function needsNewsPublication(query: string): boolean {
  return /^latest public .*news (?:today|dated\b)/iu.test(query);
}
export function verifiedNewsPublicationScope(
  value: unknown,
  query: string,
  observedAt: number,
): SharedNewsPublicationScope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as SharedNewsPublicationScope;
  const expected = newsPublicationScope(query, input.requestedAt);
  if (
    !expected ||
    input.requestedAt > observedAt ||
    observedAt - input.requestedAt > 300000 ||
    Object.keys(input).sort().join() !== Object.keys(expected).sort().join() ||
    Object.keys(expected).some(
      (key) =>
        input[key as keyof SharedNewsPublicationScope] !==
        expected[key as keyof SharedNewsPublicationScope],
    )
  )
    return undefined;
  return expected;
}
/** Called after canonical one-URL record extraction. If a record retains url, it must match too. */
export function sourceNewsPublication(
  scope: SharedNewsPublicationScope,
  url: string,
  text: string,
  observedAt: number,
): SharedNewsPublicationEvidence | undefined {
  if (!verifiedNewsPublicationScope(scope, scope.query, observedAt)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const object = record as Record<string, unknown>;
  if (object.url !== undefined) {
    try {
      if (typeof object.url !== "string" || new URL(object.url).href !== new URL(url).href)
        return undefined;
    } catch {
      return undefined;
    }
  }
  const evidence: SharedNewsPublicationEvidence[] = [];
  if (object.publisherVerificationRequired === true && object.publisherArticle === undefined)
    return undefined;
  if (object.publisherArticle !== undefined) {
    if (typeof object.title !== "string") return undefined;
    const fetchedAt = object.publisherArticleObservedAt;
    if (
      typeof fetchedAt !== "number" ||
      !Number.isSafeInteger(fetchedAt) ||
      fetchedAt < scope.requestedAt ||
      fetchedAt > observedAt ||
      fetchedAt - scope.requestedAt > 300000 ||
      fetchedAt > Date.now() + 60000
    )
      return undefined;
    if (
      !object.publisherArticle ||
      typeof object.publisherArticle !== "object" ||
      Array.isArray(object.publisherArticle)
    )
      return undefined;
    const article = object.publisherArticle as Record<string, unknown>;
    const articleTitle =
      (article.readMethod === "jina_no_cache" || article.readMethod === "cloudflare_browser") &&
      article.url === url &&
      typeof article.title === "string"
        ? article.title
        : object.title;
    const publication = publisherArticlePublication(
      article,
      url,
      articleTitle,
      scope.timeZone,
      fetchedAt,
    );
    if (!publication || publication.day !== scope.day) return undefined;
    if (
      (object.publish_date != null &&
        object.publish_date !== publication.intrinsicDay &&
        object.publish_date !== publication.day) ||
      (object.publishedDate != null &&
        object.publishedDate !== publication.value &&
        object.publishedDate !== publication.day)
    )
      return undefined;
    return {
      field:
        publication.dateKind === "publisher_displayed_day"
          ? "publisher_displayed_day"
          : "publisher_header_date",
      value: publication.value,
      precision: publication.precision,
      day: publication.day,
      requestedDay: scope.day,
      requestedTimeZone: scope.timeZone,
    };
  }
  for (const field of ["publish_date", "publishedDate"] as const) {
    const raw = object[field];
    if (raw == null) continue;
    if (typeof raw !== "string") return undefined;
    if (validDay(raw)) {
      evidence.push({
        field,
        value: raw,
        precision: "calendar-day",
        day: raw,
        requestedDay: scope.day,
        requestedTimeZone: scope.timeZone,
      });
    } else if (
      field === "publishedDate" &&
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        raw,
      ) &&
      validDay(raw.slice(0, 10)) &&
      Number.isFinite(Date.parse(raw)) &&
      Date.parse(raw) <= observedAt
    ) {
      evidence.push({
        field,
        value: raw,
        precision: "instant",
        day: worldWeatherLocalDay(Date.parse(raw), scope.timeZone),
        requestedDay: scope.day,
        requestedTimeZone: scope.timeZone,
      });
    } else return undefined;
  }
  if (!evidence.length || evidence.some((entry) => entry.day !== scope.day)) return undefined;
  return evidence.find((entry) => entry.precision === "instant") ?? evidence[0];
}
export function newsPublicationLabel(query: string): string | undefined {
  const match = query.match(/ news dated (\d{4}-\d{2}-\d{2})( UTC)?$/iu);
  return match && validDay(match[1])
    ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
        new Date(match[1] + "T12:00:00Z"),
      ) + (match[2] ? " (UTC date reference)" : "")
    : undefined;
}

/** A dated alternative is not current-day grounding and carries no inferred publisher timezone. */
export interface SharedRecentNewsPublication {
  value: string;
  day: string;
  requestedDay: string;
  requestedTimeZone: string;
  precision: "calendar-day" | "instant";
}

/** Some publisher extracts expose an adjacent linked byline and unzoned display clock. */
function publisherCalendarArticlePublication(value: unknown, url: string, title: string) {
  if (!ownArticleTitle(value, url)) return undefined;
  const record = value as {
    title: string;
    excerpts: string[];
    publish_date?: unknown;
    publishedDate?: unknown;
  };
  if (record.title !== title) return undefined;
  const dates: string[] = [];
  for (const excerpt of record.excerpts) {
    const lines = excerpt.split(/\r?\n/u).filter((line) => line.trim());
    const heading = lines[0]?.match(/^#\s+(.+)$/u);
    if (!heading || heading[1].trim() !== title.trim()) continue;
    const author = lines[1]?.match(
      /^([\p{L}\p{N} .&’'–-]{2,80})\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/u,
    );
    if (!author || author[1].trim() !== author[2].trim()) continue;
    try {
      if (new URL(author[3]).hostname !== new URL(url).hostname) continue;
    } catch {
      continue;
    }
    const date = lines[2]?.match(
      /^\\{0,2}-\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+-\s+([01]\d|2[0-3]):[0-5]\d((?:\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*,?)+)\s*$/u,
    );
    if (!date) continue;
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const month = months.indexOf(date[1].toLowerCase());
    if (month < 0) continue;
    const day = `${date[3]}-${String(month + 1).padStart(2, "0")}-${date[2].padStart(2, "0")}`;
    if (!validDay(day)) continue;
    const links = [...date[5].matchAll(/\]\((https?:\/\/[^)]+)\)/gu)];
    if (
      links.some((link) => {
        try {
          return new URL(link[1]).hostname !== new URL(url).hostname;
        } catch {
          return true;
        }
      })
    )
      continue;
    if (
      /^(?:Published|Posted|Updated|Modified|DateModified|Last[- ]Modified)\b/iu.test(
        lines[3] ?? "",
      )
    )
      return undefined;
    dates.push(day);
  }
  if (
    dates.length !== 1 ||
    (record.publish_date != null && record.publish_date !== dates[0]) ||
    (record.publishedDate != null && record.publishedDate !== dates[0])
  )
    return undefined;
  return { value: dates[0], day: dates[0], precision: "calendar-day" as const };
}

/** Exactly the preceding calendar day; the original request clock/query never changes. */
export function recentNewsArticlePublication(
  scope: SharedNewsPublicationScope,
  value: unknown,
  url: string,
  title: string,
  observedAt: number,
): SharedRecentNewsPublication | undefined {
  if (!verifiedNewsPublicationScope(scope, scope.query, observedAt)) return undefined;
  const publication =
    publisherArticlePublication(value, url, title, scope.timeZone, observedAt) ??
    publisherCalendarArticlePublication(value, url, title);
  const previousDay = new Date(Date.parse(scope.day + "T12:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
  if (!publication || publication.day !== previousDay) return undefined;
  return {
    value: publication.value,
    day: publication.day,
    precision: publication.precision,
    requestedDay: scope.day,
    requestedTimeZone: scope.timeZone,
  };
}

/** Persistable dated alternative, deliberately separate from current grounding. */
export interface SharedRecentNewsArticleReport {
  kind: "recent_news_article";
  title: string;
  url: string;
  publicationDay: string;
  requestedDay: string;
  requestedTimeZone: string;
  query: string;
  requestedAt: number;
  retrievedAt: number;
  publication: SharedRecentNewsPublication;
  source: { provider: "parallel"; readMethod: "provider_extract"; text: string };
}

/** Revalidate persisted own-source evidence against the original query and retrieval clock. */
export function readSharedRecentNewsArticleReport(
  value: unknown,
  expectedQuery: string,
  observedAt: number,
): SharedRecentNewsArticleReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as SharedRecentNewsArticleReport;
  if (
    report.kind !== "recent_news_article" ||
    typeof report.query !== "string" ||
    report.query !== expectedQuery ||
    typeof report.title !== "string" ||
    !report.title.trim() ||
    typeof report.url !== "string" ||
    !Number.isSafeInteger(report.requestedAt) ||
    !Number.isSafeInteger(report.retrievedAt) ||
    report.retrievedAt < report.requestedAt ||
    !Number.isSafeInteger(observedAt) ||
    report.retrievedAt > observedAt ||
    report.source?.provider !== "parallel" ||
    report.source.readMethod !== "provider_extract" ||
    typeof report.source.text !== "string"
  )
    return undefined;
  try {
    const url = new URL(report.url);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  const scope = newsPublicationScope(report.query, report.requestedAt);
  if (!scope) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(report.source.text);
  } catch {
    return undefined;
  }
  const publication = recentNewsArticlePublication(
    scope,
    record,
    report.url,
    report.title,
    report.retrievedAt,
  );
  if (
    !publication ||
    report.publicationDay !== publication.day ||
    report.requestedDay !== scope.day ||
    report.requestedTimeZone !== scope.timeZone ||
    !report.publication ||
    Object.keys(publication).some(
      (key) =>
        publication[key as keyof SharedRecentNewsPublication] !==
        report.publication[key as keyof SharedRecentNewsPublication],
    )
  )
    return undefined;
  const own = record as { title: string; excerpts: string[] };
  if (own.title !== report.title) return undefined;
  if (!articleMatchesNewsTopic(own, report.query)) return undefined;
  return {
    kind: "recent_news_article",
    title: report.title,
    url: report.url,
    publicationDay: publication.day,
    requestedDay: scope.day,
    requestedTimeZone: scope.timeZone,
    query: scope.query,
    requestedAt: scope.requestedAt,
    retrievedAt: report.retrievedAt,
    publication,
    source: { provider: "parallel", readMethod: "provider_extract", text: report.source.text },
  };
}
