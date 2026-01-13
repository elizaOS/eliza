/**
 * GitHub utilities
 * Converted from sweagent/utils/github.py
 */

import axios from 'axios';

export class InvalidGithubURL extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGithubURL';
  }
}

/**
 * Check if URL is a GitHub repository URL
 */
export function isGithubRepoUrl(dataPath: string): boolean {
  const patterns = [
    /^https?:\/\/github\.com\/[\w-]+\/[\w-]+/,
    /^github\.com\/[\w-]+\/[\w-]+/,
    /^git@github\.com:[\w-]+\/[\w-]+\.git$/,
    /^gh:[\w-]+\/[\w-]+$/,
  ];
  return patterns.some((pattern) => pattern.test(dataPath));
}

/**
 * Check if URL is a GitHub issue URL
 */
export function isGithubIssueUrl(dataPath: string): boolean {
  return /^https?:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+$/.test(dataPath);
}

/**
 * Parse GitHub issue URL
 */
export function parseGhIssueUrl(issueUrl: string): { owner: string; repo: string; issueNumber: string } {
  const match = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
  if (!match) {
    throw new InvalidGithubURL(`Invalid GitHub issue URL: ${issueUrl}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3],
  };
}

/**
 * Parse GitHub repository URL
 */
export function parseGhRepoUrl(repoUrl: string): { owner: string; repo: string } {
  let match = repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
  if (!match) {
    match = repoUrl.match(/^gh:([^\/]+)\/([^\/]+)$/);
  }
  if (!match) {
    throw new InvalidGithubURL(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
}

/**
 * Get GitHub issue data
 */
export async function getGhIssueData(issueUrl: string, token: string = ''): Promise<any> {
  const { owner, repo, issueNumber } = parseGhIssueUrl(issueUrl);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, { headers });

  return response.data;
}

/**
 * Get problem statement from GitHub issue
 */
export async function getProblemStatementFromGithubIssue(
  owner: string,
  repo: string,
  issueNumber: string,
  token: string = '',
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, { headers });

  const issue = response.data;
  return `${issue.title}\n\n${issue.body || ''}`;
}

/**
 * Get associated commit URLs for an issue
 */
export async function getAssociatedCommitUrls(
  org: string,
  repo: string,
  issueNumber: string,
  token: string = '',
): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // Get events for the issue
  const response = await axios.get(`https://api.github.com/repos/${org}/${repo}/issues/${issueNumber}/events`, {
    headers,
  });

  const commitUrls: string[] = [];
  for (const event of response.data) {
    if (event.event === 'referenced' && event.commit_id) {
      commitUrls.push(`https://github.com/${org}/${repo}/commit/${event.commit_id}`);
    }
  }

  return commitUrls;
}
