/**
 * Extracts canonical GitHub pull-request links from coding-agent completion
 * output so task metadata can expose the relevant PR to client surfaces.
 */
import { stripAnsi } from "./ansi-utils.js";

/** A pull request referenced by a coding agent's completion output. */
export interface ParsedPullRequestLink {
  /** The canonical `https://github.com/owner/repo/pull/N` URL. */
  url: string;
  /** The pull-request number. */
  number: number;
  /** The compact `owner/repo` repository identifier. */
  repo: string;
}

const PULL_REQUEST_URL_RE =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/** Extract the first canonical GitHub pull-request link from terminal output. */
export function extractPullRequestLink(
  raw: string,
): ParsedPullRequestLink | null {
  const match = PULL_REQUEST_URL_RE.exec(stripAnsi(raw));
  if (!match) return null;

  const [, owner, repo, numberRaw] = match;
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    number,
    repo: `${owner}/${repo}`,
  };
}
