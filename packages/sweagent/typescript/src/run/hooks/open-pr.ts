/**
 * Hook for opening pull requests on GitHub
 */

import { Octokit } from '@octokit/rest';
import { AbstractRunHook } from './types';
import { SWEEnv } from '../../environment/swe-env';
import { AgentRunResult } from '../../types';
import { getLogger, AgentLogger } from '../../utils/log';
import { InvalidGithubURL, getAssociatedCommitUrls, getGhIssueData, parseGhIssueUrl } from '../../utils/github';

const logger = getLogger('swea-open_pr', '⚡️');

/**
 * Configuration for opening PRs
 */
export interface OpenPRConfig {
  // Skip action if there are already commits claiming to fix the issue
  skipIfCommitsReferenceIssue?: boolean;
}

/**
 * Format trajectory for markdown PR description
 */
interface TrajectoryStep {
  response?: string;
  observation?: string;
  [key: string]: unknown;
}

function formatTrajectoryMarkdown(trajectory: TrajectoryStep[], charLimit?: number): string {
  const prefix = [
    '<details>',
    "<summary>Thought process ('trajectory') of SWE-agent (click to expand)</summary>",
    '',
    '',
  ];
  const prefixText = prefix.join('\n');

  const suffix = ['', '</details>'];
  const suffixText = suffix.join('\n');

  const steps: string[] = [];
  let currentLength = prefixText.length + suffixText.length;

  function removeTripleBackticks(text: string): string {
    return text
      .split('\n')
      .map((line) => (line.startsWith('```') ? line.substring(3) : line))
      .join('\n');
  }

  for (let i = 0; i < trajectory.length; i++) {
    const step = trajectory[i];
    const stepStrs = [
      `**🧑‍🚒 Response (${i})**:`,
      step.response?.trim() || '',
      `**👀‍ Observation (${i})**:`,
      '```',
      removeTripleBackticks(step.observation?.trim() || ''),
      '```',
    ];
    const stepText = stepStrs.join('\n');

    // Calculate separator length (only needed for steps after the first one)
    let separatorLength = 0;
    if (steps.length > 0) {
      separatorLength = '\n\n---\n\n'.length;
    }

    // Check if adding this step would exceed the character limit
    if (charLimit !== undefined && currentLength + separatorLength + stepText.length > charLimit) {
      if (i > 0) {
        steps.push('\n\n... (truncated due to length limit)');
      }
      break;
    }

    if (steps.length > 0) {
      steps.push('\n\n---\n\n');
      currentLength += separatorLength;
    }

    steps.push(stepText);
    currentLength += stepText.length;
  }

  return prefixText + steps.join('') + suffixText;
}

/**
 * Create PR to repository
 */
interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  assignee?: unknown;
  locked: boolean;
  [key: string]: unknown;
}

async function openPR(params: {
  logger: AgentLogger;
  token: string;
  env: SWEEnv;
  githubUrl: string;
  trajectory: TrajectoryStep[];
  dryRun?: boolean;
}): Promise<void> {
  const { logger, token, env, githubUrl, trajectory, dryRun = false } = params;

  logger.info('Opening PR');

  let issue: GitHubIssue;
  try {
    issue = (await getGhIssueData(githubUrl, token)) as GitHubIssue;
  } catch (error) {
    if (error instanceof InvalidGithubURL) {
      throw new Error('Data path must be a github issue URL if open_pr is set to True.');
    }
    throw error;
  }

  const branchName = `swe-agent-fix-#${issue.number}-${Math.random().toString().slice(2, 10)}`;

  // Set git user
  await env.communicate("git config user.email 'noemail@swe-agent.com' && git config user.name 'SWE-agent'", 10, {
    errorMsg: 'Failed to set git user',
    check: 'raise',
  });

  // Remove model patch if exists
  await env.communicate('rm -f model.patch', 10, {
    errorMsg: 'Failed to remove model patch',
    check: 'raise',
  });

  // Create new branch
  await env.communicate(`git checkout -b ${branchName}`, 10, {
    errorMsg: 'Failed to switch to new branch',
    check: 'raise',
  });

  // Add all changes
  await env.communicate('git add .', 10, {
    errorMsg: 'Failed to add commits',
    check: 'raise',
  });

  // Commit changes
  const dryRunFlag = dryRun ? '--allow-empty' : '';
  const commitMsg = [`Fix: ${issue.title}`, `Closes #${issue.number}`];

  const out = await env.communicate(`git commit -m "${commitMsg[0]}" -m "${commitMsg[1]}" ${dryRunFlag}`, 10, {
    errorMsg: 'Failed to commit changes',
    check: 'raise',
  });

  logger.debug(`Committed changes: ${out}`);

  const { owner, repo } = parseGhIssueUrl(githubUrl);

  // Check if we're using a fork by looking at the repo configuration
  // If env.repo has a push_gh_repo_url, that's the fork URL
  let forker = owner;
  let remote = 'origin';
  const pushRepoUrl = (env.repo as { push_gh_repo_url?: string })?.push_gh_repo_url;

  if (pushRepoUrl) {
    // Extract forker from push repo URL
    const match = pushRepoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      forker = match[1];
    }
  }

  const head = forker !== owner ? `${forker}:${branchName}` : branchName;

  // If using a fork, add it as a remote
  if (forker !== owner) {
    const tokenPrefix = token ? `${token}@` : '';
    const forkUrl = `https://${tokenPrefix}github.com/${forker}/${repo}.git`;

    logger.debug(`Using fork: ${forkUrl}`);
    await env.communicate(`git remote add fork ${forkUrl}`, 10, {
      errorMsg: 'Failed to create new git remote',
    });
    remote = 'fork';
  }

  // Push branch
  const dryRunPrefix = dryRun ? 'echo ' : '';
  const pushOut = await env.communicate(`${dryRunPrefix}git push ${remote} ${branchName}`, 10, {
    errorMsg: 'Failed to push branch to remote. Please check your token and permissions.',
  });

  logger.debug(`Pushed commit to remote=${remote} branch=${branchName}: ${pushOut}`);

  // Create PR body
  let body = `This is a PR opened by AI tool [SWE Agent](https://github.com/elizaos/swe-agent-ts/) `;
  body += `to close [#${issue.number}](${githubUrl}) (${issue.title}).\n\nCloses #${issue.number}.`;
  body += '\n\n' + formatTrajectoryMarkdown(trajectory, 60000);

  if (!dryRun) {
    const octokit = new Octokit({ auth: token });

    // Get default branch
    const repoData = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = (repoData.data as any).default_branch;

    // Create PR
    const pr = await octokit.rest.pulls.create({
      owner,
      repo,
      title: `SWE-agent[bot] PR to fix: ${issue.title}`,
      head,
      base: defaultBranch,
      body,
      draft: true,
    });

    logger.info(
      `🎉 PR created as a draft at ${(pr.data as any).html_url}. Please review it carefully, push ` +
        'any required changes onto the branch and then click ' +
        "'Ready for Review' to bring it to the attention of the maintainers.",
    );
  }
}

/**
 * This hook opens a PR if the issue is solved and the user has enabled the option
 */
interface ProblemStatementWithGithubUrl {
  githubUrl: string;
  [key: string]: unknown;
}

export class OpenPRHook extends AbstractRunHook {
  private config: OpenPRConfig;
  private env?: SWEEnv;
  private token: string = '';
  private problemStatement?: ProblemStatementWithGithubUrl;

  constructor(config: OpenPRConfig = { skipIfCommitsReferenceIssue: true }) {
    super();
    this.config = config;
  }

  onInit(run: { env: SWEEnv; problemStatement: ProblemStatementWithGithubUrl }): void {
    this.env = run.env;
    this.token = process.env.GITHUB_TOKEN || '';
    this.problemStatement = run.problemStatement;
  }

  async onInstanceCompleted(params: { result: AgentRunResult }): Promise<void> {
    try {
      if (await this.shouldOpenPR(params.result)) {
        if (!this.env || !this.problemStatement) {
          logger.error('Environment or problem statement not initialized');
          return;
        }
        // Map trajectory to local TrajectoryStep type
        const trajectory: TrajectoryStep[] = params.result.trajectory.map((step) => ({
          ...step,
        }));
        await openPR({
          logger,
          token: this.token,
          env: this.env,
          githubUrl: this.problemStatement.githubUrl,
          trajectory,
        });
      }
    } catch (error) {
      logger.error('Failed to open PR:', error);
      // Don't propagate the error - handle it gracefully
    }
  }

  private async shouldOpenPR(result: AgentRunResult): Promise<boolean> {
    if (!result.info.submission) {
      logger.info('Not opening PR because no submission was made.');
      return false;
    }

    if (result.info.exitStatus !== 'submitted') {
      logger.info(`Not opening PR because exit status was ${result.info.exitStatus} and not submitted.`);
      return false;
    }

    if (!this.problemStatement || !this.problemStatement.githubUrl) {
      logger.info('Problem statement not initialized or missing GitHub URL. Skipping PR creation.');
      return false;
    }

    let issue: GitHubIssue;
    try {
      issue = (await getGhIssueData(this.problemStatement.githubUrl, this.token)) as GitHubIssue;
    } catch (error) {
      if (error instanceof InvalidGithubURL) {
        logger.info('Currently only GitHub is supported to open PRs to. Skipping PR creation.');
      } else {
        logger.error('Failed to get issue data:', error);
      }
      return false;
    }

    if (issue.state !== 'open') {
      logger.info(`Issue is not open (state=${issue.state}). Skipping PR creation.`);
      return false;
    }

    if (issue.assignee) {
      logger.info('Issue is already assigned. Skipping PR creation. Be nice :)');
      return false;
    }

    if (issue.locked) {
      logger.info('Issue is locked. Skipping PR creation.');
      return false;
    }

    let associatedCommits: string[] = [];
    try {
      const parsed = parseGhIssueUrl(this.problemStatement.githubUrl);
      if (!parsed) {
        logger.error('Failed to parse GitHub issue URL');
        return false;
      }
      const { owner: org, repo, issueNumber } = parsed;
      associatedCommits = await getAssociatedCommitUrls(org, repo, issueNumber, this.token);
    } catch (error) {
      logger.error('Failed to get associated commits:', error);
      // Continue anyway - we can't check for existing commits but that shouldn't stop PR creation
    }

    if (associatedCommits.length > 0) {
      const commitUrlStrs = associatedCommits.join(', ');
      if (this.config.skipIfCommitsReferenceIssue) {
        logger.info(`Issue already has associated commits (see ${commitUrlStrs}). Skipping PR creation.`);
        return false;
      } else {
        logger.warn(
          `Proceeding with PR creation even though there are already commits (${commitUrlStrs}) ` +
            'associated with the issue. Please only do this for your own repositories ' +
            'or after verifying that the existing commits do not fix the issue.',
        );
      }
    }

    return true;
  }
}
