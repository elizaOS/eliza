/**
 * Website reputation annotation for hosted web search.
 *
 * Cloud already holds the search results, so it checks their addresses
 * directly against the reputation index. A listed result gets an explicit
 * warning; it is kept, not silently removed, so the agent can tell the user
 * why it should not be opened. Other results carry nothing that implies
 * safety. A slow or failed check never delays or fails the search.
 */
import type { WebsiteReputationVerdict } from "@elizaos/cloud-sdk/website-reputation";
import { checkWebsiteReputation } from "../../services/website-reputation";
import type { SearchResponse, SearchResult, SearchResultReputation } from "./types";

const MAX_ANSWER_URLS = 20;
const DEFAULT_TIMEOUT_MS = 1500;

export function extractAnswerUrls(text: string | undefined): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]{}"'`]+/gi)) {
    urls.add(match[0].replace(/[.,;:!?]+$/, ""));
    if (urls.size >= MAX_ANSWER_URLS) break;
  }
  return [...urls];
}

function toReputation(verdict: WebsiteReputationVerdict | undefined): SearchResultReputation {
  if (verdict?.status === "listed") {
    return {
      status: "listed",
      sources: verdict.sources,
      categories: verdict.categories,
      warning: verdict.warning,
    };
  }
  if (verdict?.status === "not_listed") return { status: "not_listed", label: "No known threat" };
  return { status: "unavailable" };
}

export async function annotateSearchReputation(
  response: SearchResponse,
  options: {
    check?: (addresses: string[]) => Promise<WebsiteReputationVerdict[]>;
    timeoutMs?: number;
  } = {},
): Promise<SearchResponse> {
  const check = options.check ?? ((addresses) => checkWebsiteReputation(addresses));
  const answerUrls = extractAnswerUrls(response.answer);
  const addresses = [...response.results.map((result) => result.url), ...answerUrls];
  if (!addresses.length) return response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let verdicts: WebsiteReputationVerdict[] = [];
  try {
    verdicts = await Promise.race([
      check(addresses),
      new Promise<WebsiteReputationVerdict[]>((resolve) => {
        timer = setTimeout(() => resolve([]), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    verdicts = [];
  } finally {
    if (timer) clearTimeout(timer);
  }
  const results = response.results.map((result, index) => ({
    ...result,
    reputation: toReputation(verdicts[index]),
  }));
  const reputationWarnings = answerUrls.flatMap((url, index) => {
    const verdict = verdicts[response.results.length + index];
    return verdict?.status === "listed"
      ? [{ url, host: verdict.host, warning: verdict.warning }]
      : [];
  });
  return { ...response, results, reputationWarnings };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sanitizeListedAnswer(
  answer: string,
  warnings: Array<{ url: string; host: string | null; warning: string }>,
): string {
  let sanitized = answer;
  for (const warning of warnings) {
    const host = warning.host || hostOf(warning.url);
    const escapedUrl = warning.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A Markdown link keeps its label but loses the link target.
    sanitized = sanitized.replace(
      new RegExp(`\\[([^\\]]*)\\]\\(${escapedUrl}\\)`, "g"),
      (_match, label: string) => `${label} (blocked ${host})`,
    );
    sanitized = sanitized.split(warning.url).join(`[blocked ${host}]`);
  }
  return sanitized;
}

function formatResultLine(result: SearchResult, index: number): string {
  // A listed site is named without a link so the warning cannot be skipped by a click.
  if (result.reputation?.status === "listed") {
    return `${index + 1}. ${result.title} (${hostOf(result.url)}) - ${result.reputation.warning}`;
  }
  return `${index + 1}. [${result.title}](${result.url})`;
}

/**
 * Text the agent sees. Listed sites get an explicit warning. Nothing is added
 * for other sites, so the text never implies that a site is safe.
 */
export function formatWebSearchText(searchResponse: SearchResponse): string {
  const lines: string[] = [];
  const answerWarnings = searchResponse.reputationWarnings ?? [];
  if (searchResponse.answer) {
    lines.push(
      answerWarnings.length
        ? sanitizeListedAnswer(searchResponse.answer, answerWarnings)
        : searchResponse.answer,
    );
    if (searchResponse.results.length > 0) {
      lines.push(
        "",
        "For more details, you can check out these resources:",
        ...searchResponse.results.map(formatResultLine),
      );
    }
  }
  const warnings = new Map<string, string>();
  for (const warning of answerWarnings) {
    warnings.set(warning.host, warning.warning);
  }
  if (!searchResponse.answer) {
    for (const result of searchResponse.results) {
      if (result.reputation?.status === "listed") {
        warnings.set(hostOf(result.url), result.reputation.warning);
      }
    }
  }
  if (warnings.size > 0) {
    lines.push(
      ...(lines.length ? [""] : []),
      "Website warnings:",
      ...[...warnings].map(([host, warning]) => `- ${host}: ${warning}`),
    );
  }
  return lines.join("\n");
}
