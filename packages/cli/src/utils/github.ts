import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { existsSync } from 'node:fs';
import { bunExecSimple, bunExec } from './bun-exec.js';
import { UserEnvironment } from './user-environment';
import * as clack from '@clack/prompts';

const GITHUB_API_URL = 'https://api.github.com';

interface GitHubUserResponse {
  login: string;
  [key: string]: unknown;
}

interface GitHubRepoResponse {
  full_name: string;
  [key: string]: unknown;
}

interface GitHubBranchResponse {
  object: {
    sha: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface GitHubFileResponse {
  content: string;
  sha: string;
  [key: string]: unknown;
}

interface GitHubPullRequestResponse {
  html_url: string;
  [key: string]: unknown;
}

/**
 * Validate a GitHub token with the API
 */
export async function validateGitHubToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (response.status === 200) {
      const userData = (await response.json()) as GitHubUserResponse;
      logger.success(`Authenticated as ${userData.login}`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error(
      `Failed to validate GitHub token: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Check if a fork exists for a given repository
 */
export async function forkExists(token: string, repo: string, username: string): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${username}/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Fork a repository
 */
export async function forkRepository(
  token: string,
  owner: string,
  repo: string
): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/forks`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (response.status === 202) {
      const forkData = (await response.json()) as GitHubRepoResponse;
      logger.success(`Forked ${owner}/${repo} to ${forkData.full_name}`);
      return forkData.full_name;
    }

    logger.error(`Failed to fork repository: ${response.statusText}`);
    return null;
  } catch (error) {
    logger.error(
      `Failed to fork repository: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Check if a branch exists in a repository
 */
export async function branchExists(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/branches/${branch}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Create a new branch in a repository
 */
export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  baseBranch = 'main'
): Promise<boolean> {
  try {
    // Get the SHA of the base branch
    let baseResponse = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    // If the requested base branch doesn't exist, try to find an alternative branch
    if (baseResponse.status !== 200) {
      logger.warn(`Base branch '${baseBranch}' not found, checking for alternative branches...`);

      // List available branches
      const branchesResponse = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/branches`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (branchesResponse.status === 200) {
        const branches = (await branchesResponse.json()) as Array<{ name: string }>;
        if (branches && branches.length > 0) {
          // Use the first available branch as base
          const alternativeBranch = branches[0].name;
          logger.info(`Using '${alternativeBranch}' as base branch instead`);

          // Try again with the alternative branch
          baseResponse = await fetch(
            `${GITHUB_API_URL}/repos/${owner}/${repo}/git/ref/heads/${alternativeBranch}`,
            {
              headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
              },
            }
          );
        } else {
          // No branches found, could be a fresh fork - create initial empty commit and branch
          logger.info('No branches found in repository, creating initial commit');

          // Create a blob for empty README
          const blobResponse = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST',
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content: '# Repository initialized by Eliza CLI',
              encoding: 'utf-8',
            }),
          });

          if (blobResponse.status !== 201) {
            logger.error('Failed to create initial blob');
            return false;
          }

          const blobData = (await blobResponse.json()) as { sha: string };
          const blobSha = blobData.sha;

          // Create a tree with the README
          const treeResponse = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/git/trees`, {
            method: 'POST',
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tree: [
                {
                  path: 'README.md',
                  mode: '100644',
                  type: 'blob',
                  sha: blobSha,
                },
              ],
            }),
          });

          if (treeResponse.status !== 201) {
            logger.error('Failed to create initial tree');
            return false;
          }

          const treeData = (await treeResponse.json()) as { sha: string };
          const treeSha = treeData.sha;

          // Create a commit
          const commitResponse = await fetch(
            `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits`,
            {
              method: 'POST',
              headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: 'Initial commit',
                tree: treeSha,
              }),
            }
          );

          if (commitResponse.status !== 201) {
            logger.error('Failed to create initial commit');
            return false;
          }

          const commitData = (await commitResponse.json()) as { sha: string };
          const commitSha = commitData.sha;

          // Create a reference for main branch
          const refResponse = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs`, {
            method: 'POST',
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ref: 'refs/heads/main',
              sha: commitSha,
            }),
          });

          if (refResponse.status !== 201) {
            logger.error('Failed to create main branch');
            return false;
          }

          logger.success('Created main branch with initial commit');

          // Now we can use this as our base
          baseResponse = await fetch(
            `${GITHUB_API_URL}/repos/${owner}/${repo}/git/ref/heads/main`,
            {
              headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
              },
            }
          );
        }
      }
    }

    if (baseResponse.status !== 200) {
      logger.error(`Failed to get base branch ${baseBranch}: ${baseResponse.statusText}`);
      return false;
    }

    const baseData = (await baseResponse.json()) as GitHubBranchResponse;
    const sha = baseData.object.sha;

    // Create the new branch
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha,
      }),
    });

    if (response.status === 201) {
      logger.success(`Created branch ${branch} in ${owner}/${repo}`);
      return true;
    }

    logger.error(`Failed to create branch: ${response.statusText}`);
    return false;
  } catch (error) {
    logger.error(
      `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Get content of a file from a repository
 */
export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch = 'main'
): Promise<string | null> {
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (response.status === 200) {
      const data = (await response.json()) as GitHubFileResponse;
      // GitHub API returns content as base64
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Create or update a file in a repository
 */
export async function updateFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch = 'main'
): Promise<boolean> {
  try {
    // Check if file already exists
    const existingContent = await getFileContent(token, owner, repo, path, branch);
    // GitHub API behavior: PUT works more reliably than POST for creating files
    // in directories that may not exist yet, so we always use PUT
    const method = 'PUT';

    // Get the SHA if the file exists
    let sha: string | undefined;
    if (existingContent !== null) {
      const response = await fetch(
        `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (response.status === 200) {
        const data = (await response.json()) as GitHubFileResponse;
        sha = data.sha;
      }
    }

    // Full URL for debugging
    const fileUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}`;
    logger.info(`Updating file at: ${fileUrl}`);

    // Full request body for debugging
    const requestBody = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha,
    };
    logger.info(`Request details: method=${method}, branch=${branch}, has_sha=${!!sha}`);

    // Update or create the file
    const response = await fetch(fileUrl, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 200 || response.status === 201) {
      logger.success(existingContent !== null ? 'File updated' : 'File created');
      return true;
    }

    // Log the full error response for debugging
    const errorBody = await response.text();
    logger.error(`Failed to update file: ${response.status} ${response.statusText}`);
    logger.error(`Response body: ${errorBody}`);

    // Check for common GitHub API errors
    if (response.status === 404) {
      logger.error(`Repository or path not found: ${owner}/${repo}/${path}`);
      // Try to check if the repo exists
      const repoCheck = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (repoCheck.status === 404) {
        logger.error(`Repository ${owner}/${repo} does not exist or is not accessible`);
      } else {
        logger.info(`Repository exists, but path is likely invalid`);
      }
    }

    return false;
  } catch (error) {
    logger.error(`Error updating file: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base = 'main'
): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        body,
        head,
        base,
      }),
    });

    if (response.status === 201) {
      const data = (await response.json()) as GitHubPullRequestResponse;
      logger.success(`Created pull request: ${data.html_url}`);
      return data.html_url;
    }

    logger.error(`Failed to create pull request: ${response.statusText}`);
    return null;
  } catch (error) {
    logger.error(
      `Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Get authenticated user information
 */
export async function getAuthenticatedUser(token: string): Promise<GitHubUserResponse | null> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (response.status === 200) {
      return (await response.json()) as GitHubUserResponse;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Retrieves GitHub credentials from the environment, registry, or user prompt.
 *
 * Attempts to obtain a valid GitHub username and personal access token by first checking environment variables, then a stored registry, and finally prompting the user if necessary. Validates the token before returning credentials.
 *
 * @returns An object containing the GitHub username and token if valid credentials are found or provided, otherwise `null`.
 */
export async function getGitHubCredentials(): Promise<{
  username: string;
  token: string;
} | null> {
  const envInfo = await UserEnvironment.getInstanceInfo();

  logger.debug('[GitHub] Checking for credentials');

  // First check environment variables
  const envUsername = envInfo.env.GITHUB_USERNAME;
  const envToken = envInfo.env.GITHUB_TOKEN;

  if (envUsername && envToken) {
    // Validate the token
    if (await validateGitHubToken(envToken)) {
      return {
        username: envUsername,
        token: envToken,
      };
    }
    logger.warn('Invalid GitHub token found in environment variables');
  }

  // If not in process.env, try to load from .env file
  const { getGitHubToken } = await import('./registry');
  const token = (await getGitHubToken()) || undefined;

  // If we have a token, validate it and try to get username if missing
  if (token) {
    const isValid = await validateGitHubToken(token);
    if (isValid) {
      // If we don't have a username, try to get it from GitHub
      const userInfo = await getAuthenticatedUser(token);
      if (userInfo) {
        const username = userInfo.login;
        // Save the username to env
        await saveGitHubCredentials(username, token);
        return { username, token };
      }
    } else {
      logger.warn('Stored GitHub token is invalid, will prompt for new credentials');
    }
  }

  // No valid credentials found, prompt the user
  clack.intro('🔐 GitHub Authentication Required');

  clack.note(
    `To create a GitHub Personal Access Token (Classic):
1. Go to https://github.com/settings/tokens/new
2. Give your token a descriptive name (e.g., "ElizaOS CLI")
3. Select "No expiration" or any expiration date
4. Select the following scopes (all are required):
   - repo (Full control of private repositories)
   - read:org (Read org and team membership, read org projects)
   - workflow (Update GitHub Action workflows)
5. Click "Generate token" at the bottom of the page
6. Copy the displayed token (you won't be able to see it again!)

NOTE: You must use a Classic token, not a Fine-grained token`,
    'Setup Instructions'
  );

  // Then prompt for the username with a simple message
  const promptedUsername = await clack.text({
    message: 'Enter your GitHub username:',
    validate: (value) => (value ? undefined : 'Username is required'),
  });

  if (clack.isCancel(promptedUsername)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  const promptedToken = await clack.password({
    message: 'Enter your GitHub Personal Access Token (with repo, read:org, and workflow scopes):',
    validate: (value) => (value ? undefined : 'Token is required'),
  });

  if (clack.isCancel(promptedToken)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  // Validate token
  const isValid = await validateGitHubToken(promptedToken);
  if (!isValid) {
    logger.error('Invalid GitHub token');
    return null;
  }

  // Save credentials
  await saveGitHubCredentials(promptedUsername, promptedToken);
  logger.success('GitHub credentials saved successfully');

  return { username: promptedUsername, token: promptedToken };
}

/**
 * Saves the provided GitHub username and token to the `.env` file in the user's `.eliza` directory.
 *
 * Updates or adds the `GITHUB_USERNAME` and `GITHUB_TOKEN` entries in the file and sets them in the current process environment.
 */
export async function saveGitHubCredentials(username: string, token: string): Promise<void> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  const { elizaDir, envFilePath } = envInfo.paths;

  logger.debug('[GitHub] Saving credentials');

  // Ensure .eliza directory exists
  if (!existsSync(elizaDir)) {
    await fs.mkdir(elizaDir, { recursive: true });
  }

  // Ensure .env file exists
  if (!existsSync(envFilePath)) {
    await fs.writeFile(envFilePath, '', { encoding: 'utf8' });
  }

  // Read current content
  const currentContent = await fs.readFile(envFilePath, 'utf8');
  const lines = currentContent.split('\n');

  // Update or add GITHUB_USERNAME
  const usernameLineIndex = lines.findIndex((line) => line.startsWith('GITHUB_USERNAME='));
  const usernameLine = `GITHUB_USERNAME=${username}`;
  if (usernameLineIndex >= 0) {
    lines[usernameLineIndex] = usernameLine;
  } else {
    lines.push(usernameLine);
  }

  // Update or add GITHUB_TOKEN
  const tokenLineIndex = lines.findIndex((line) => line.startsWith('GITHUB_TOKEN='));
  const tokenLine = `GITHUB_TOKEN=${token}`;
  if (tokenLineIndex >= 0) {
    lines[tokenLineIndex] = tokenLine;
  } else {
    lines.push(tokenLine);
  }

  // Write back to file
  await fs.writeFile(envFilePath, lines.join('\n'));

  // Set in current process
  process.env.GITHUB_USERNAME = username;
  process.env.GITHUB_TOKEN = token;

  logger.success('GitHub credentials saved');
}

/**
 * Ensure a directory exists in the repository
 */
export async function ensureDirectory(
  token: string,
  repo: string,
  path: string,
  branch: string
): Promise<boolean> {
  try {
    // First check if the directory already exists
    try {
      const response = await fetch(
        `${GITHUB_API_URL}/repos/${repo}/contents/${path}?ref=${branch}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      // Directory exists
      if (response.status === 200) {
        logger.info(`Directory ${path} already exists`);
        return true;
      }
    } catch (error) {
      // Directory doesn't exist, we'll create it
      logger.info(`Directory ${path} doesn't exist, creating it`);
    }

    // Create a placeholder file in the directory
    // (GitHub doesn't have a concept of empty directories)
    const placeholderPath = `${path}/.gitkeep`;
    const result = await updateFile(
      token,
      repo,
      placeholderPath,
      '', // Empty content for placeholder
      `Create directory: ${path}`,
      branch
    );

    if (result) {
      logger.success(`Created directory: ${path}`);
      return true;
    }

    logger.error(`Failed to create directory: ${path}`);
    return false;
  } catch (error) {
    logger.error(
      `Error creating directory: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Create a new GitHub repository
 */
export async function createGitHubRepository(
  token: string,
  repoName: string,
  description: string,
  isPrivate = false,
  topics: string[] = []
): Promise<{ success: boolean; repoUrl?: string; message?: string }> {
  try {
    // Get the authenticated user to check repository existence
    const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (userResponse.status !== 200) {
      return { success: false, message: 'Failed to get authenticated user information' };
    }

    const userData = await userResponse.json();
    const username = userData.login;

    // First check if the repository already exists
    const checkResponse = await fetch(`${GITHUB_API_URL}/repos/${username}/${repoName}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    // If repo exists, return success
    if (checkResponse.status === 200) {
      const data = await checkResponse.json();
      logger.info(`Repository already exists: ${data.html_url}`);
      return { success: true, repoUrl: data.html_url };
    }

    // If status is not 404, there might be another issue
    if (checkResponse.status !== 404) {
      const errorData = await checkResponse.json();
      return {
        success: false,
        message: `Error checking repository: ${checkResponse.status} ${checkResponse.statusText} - ${errorData.message || 'Unknown error'}`,
      };
    }

    // If we get here, repo doesn't exist on GitHub (404), so create it
    const response = await fetch(`${GITHUB_API_URL}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        description,
        private: isPrivate,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
        auto_init: false, // Don't initialize with README to avoid conflicts
        default_branch: 'main', // Explicitly set main as default branch
      }),
    });

    if (response.status === 201) {
      const data = await response.json();
      const repoUrl = data.html_url;

      // Wait a moment for GitHub to initialize the repository
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Add topics to the repository
      if (topics.length > 0) {
        await fetch(`${GITHUB_API_URL}/repos/${data.full_name}/topics`, {
          method: 'PUT',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.mercy-preview+json', // Required for topics API
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            names: topics,
          }),
        });
      }

      logger.success(`Repository created: ${repoUrl}`);
      return { success: true, repoUrl };
    }

    const errorData = await response.json();
    return {
      success: false,
      message: `Failed to create repository: ${response.status} ${response.statusText} - ${errorData.message || 'Unknown error'}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error creating repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Push local code to GitHub repository
 */
export async function pushToGitHub(
  cwd: string,
  repoUrl: string,
  branch = 'main'
): Promise<boolean> {
  try {
    // Check if git is initialized
    const gitDirExists = existsSync(path.join(cwd, '.git'));

    // If we have a git directory, check if it has the correct remote
    let hasCorrectRemote = false;
    if (gitDirExists) {
      try {
        const { stdout: remoteUrl } = await bunExecSimple('git', ['remote', 'get-url', 'origin'], {
          cwd,
        });
        // Check if the remote URL matches our target (ignoring the token part)
        const sanitizedRepoUrl = repoUrl.replace(/https:\/\/.*?@/, 'https://');
        const sanitizedRemoteUrl = remoteUrl.replace(/https:\/\/.*?@/, 'https://');
        hasCorrectRemote = sanitizedRemoteUrl.includes(
          sanitizedRepoUrl.replace(/^https:\/\/.*?@/, '')
        );
      } catch (error) {
        // Remote doesn't exist or command failed, will set up remote later
        hasCorrectRemote = false;
      }
    }

    // If git is not initialized or remote doesn't match, start fresh
    if (!gitDirExists || !hasCorrectRemote) {
      if (gitDirExists) {
        logger.info('Existing git repository has incorrect remote, reinitializing...');
        await bunExec('rm', ['-rf', '.git'], { cwd });
      }

      await bunExec('git', ['init'], { cwd });
      // Explicitly create and switch to main branch
      await bunExec('git', ['checkout', '-b', 'main'], { cwd });
      logger.info('Git repository initialized with main branch');

      // Add remote
      await bunExec('git', ['remote', 'add', 'origin', repoUrl], { cwd });
      logger.info(`Added remote: ${repoUrl.replace(/\/\/.*?@/, '//***@')}`);
    } else {
      // Make sure we're on the main branch
      try {
        await bunExec('git', ['rev-parse', '--verify', branch], { cwd });
        await bunExec('git', ['checkout', branch], { cwd });
      } catch (error) {
        // Branch doesn't exist, create it
        await bunExec('git', ['checkout', '-b', branch], { cwd });
        logger.info(`Created and switched to ${branch} branch`);
      }
    }

    // Add all files
    await bunExec('git', ['add', '.'], { cwd });
    logger.info('Added files to git');

    // Set git user info if not already set
    try {
      await bunExec('git', ['config', 'user.email'], { cwd });
    } catch (error) {
      await bunExec('git', ['config', 'user.email', 'plugindev@elizaos.com'], { cwd });
      await bunExec('git', ['config', 'user.name', 'ElizaOS Plugin Dev'], { cwd });
      logger.info('Set git user info for commit');
    }

    // Commit if there are changes
    try {
      await bunExec('git', ['commit', '-m', 'Initial commit from ElizaOS CLI'], { cwd });
      logger.info('Committed changes');
    } catch (error) {
      // If no changes to commit, that's okay
      logger.info('No changes to commit');
    }

    // Push to GitHub
    try {
      await bunExec('git', ['push', '-u', 'origin', branch], { cwd });
      logger.success(`Pushed to GitHub repository: ${repoUrl}`);
      return true;
    } catch (error) {
      logger.error(
        `Failed to push to GitHub: ${error instanceof Error ? error.message : String(error)}`
      );

      // Try force pushing if normal push fails
      try {
        logger.info('Attempting force push...');
        // Use force-with-lease as a slightly safer option than force
        await bunExec('git', ['push', '-u', 'origin', 'main', '--force-with-lease'], {
          cwd,
        });
        return true;
      } catch (forcePushError) {
        logger.error(
          'Force push also failed:',
          forcePushError instanceof Error ? forcePushError.message : String(forcePushError)
        );
        return false;
      }
    }
  } catch (error) {
    logger.error(
      `Error in git operations: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
