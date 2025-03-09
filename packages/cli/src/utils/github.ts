import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import fetch from "node-fetch";
import { logger } from "./logger";

const GITHUB_API_URL = "https://api.github.com";

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
				Accept: "application/vnd.github.v3+json",
			},
		});

		if (response.status === 200) {
			const userData = (await response.json()) as GitHubUserResponse;
			logger.success(`Authenticated as ${userData.login}`);
			return true;
		}

		return false;
	} catch (error) {
		logger.error(`Failed to validate GitHub token: ${error.message}`);
		return false;
	}
}

/**
 * Check if a fork exists for a given repository
 */
export async function forkExists(
	token: string,
	owner: string,
	repo: string,
	username: string,
): Promise<boolean> {
	try {
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${username}/${repo}`,
			{
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		);

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
	repo: string,
): Promise<string | null> {
	try {
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/forks`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		);

		if (response.status === 202) {
			const forkData = (await response.json()) as GitHubRepoResponse;
			logger.success(`Forked ${owner}/${repo} to ${forkData.full_name}`);
			return forkData.full_name;
		}

		logger.error(`Failed to fork repository: ${response.statusText}`);
		return null;
	} catch (error) {
		logger.error(`Failed to fork repository: ${error.message}`);
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
	branch: string,
): Promise<boolean> {
	try {
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/branches/${branch}`,
			{
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		);

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
	baseBranch = "main",
): Promise<boolean> {
	try {
		// Get the SHA of the base branch
		const baseResponse = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
			{
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		);

		if (baseResponse.status !== 200) {
			logger.error(
				`Failed to get base branch ${baseBranch}: ${baseResponse.statusText}`,
			);
			return false;
		}

		const baseData = (await baseResponse.json()) as GitHubBranchResponse;
		const sha = baseData.object.sha;

		// Create the new branch
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ref: `refs/heads/${branch}`,
					sha,
				}),
			},
		);

		if (response.status === 201) {
			logger.success(`Created branch ${branch} in ${owner}/${repo}`);
			return true;
		}

		logger.error(`Failed to create branch: ${response.statusText}`);
		return false;
	} catch (error) {
		logger.error(`Failed to create branch: ${error.message}`);
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
	branch = "main",
): Promise<string | null> {
	try {
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
			{
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				},
			},
		);

		if (response.status === 200) {
			const data = (await response.json()) as GitHubFileResponse;
			// GitHub API returns content as base64
			return Buffer.from(data.content, "base64").toString("utf-8");
		}

		return null;
	} catch (error) {
		return null;
	}
}

/**
 * Update or create a file in a repository
 */
export async function updateFile(
	token: string,
	owner: string,
	repo: string,
	path: string,
	content: string,
	message: string,
	branch = "main",
): Promise<boolean> {
	try {
		// Check if file already exists
		const existingContent = await getFileContent(
			token,
			owner,
			repo,
			path,
			branch,
		);
		const method = existingContent !== null ? "PUT" : "POST";

		// Get the SHA if the file exists
		let sha: string | undefined;
		if (existingContent !== null) {
			const response = await fetch(
				`${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
				{
					headers: {
						Authorization: `token ${token}`,
						Accept: "application/vnd.github.v3+json",
					},
				},
			);

			if (response.status === 200) {
				const data = (await response.json()) as GitHubFileResponse;
				sha = data.sha;
			}
		}

		// Update or create the file
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}`,
			{
				method,
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message,
					content: Buffer.from(content).toString("base64"),
					branch,
					sha,
				}),
			},
		);

		if (response.status === 200 || response.status === 201) {
			logger.success(
				`${existingContent !== null ? "Updated" : "Created"} file ${path} in ${owner}/${repo}`,
			);
			return true;
		}

		logger.error(
			`Failed to ${existingContent !== null ? "update" : "create"} file: ${response.statusText}`,
		);
		return false;
	} catch (error) {
		logger.error(`Failed to update file: ${error.message}`);
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
	base = "main",
): Promise<string | null> {
	try {
		const response = await fetch(
			`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title,
					body,
					head,
					base,
				}),
			},
		);

		if (response.status === 201) {
			const data = (await response.json()) as GitHubPullRequestResponse;
			logger.success(`Created pull request: ${data.html_url}`);
			return data.html_url;
		}

		logger.error(`Failed to create pull request: ${response.statusText}`);
		return null;
	} catch (error) {
		logger.error(`Failed to create pull request: ${error.message}`);
		return null;
	}
}

/**
 * Get authenticated user information
 */
export async function getAuthenticatedUser(
	token: string,
): Promise<GitHubUserResponse | null> {
	try {
		const response = await fetch(`${GITHUB_API_URL}/user`, {
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github.v3+json",
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
 * Get GitHub credentials from env or prompt the user
 */
export async function getGitHubCredentials(): Promise<{
	username: string;
	token: string;
} | null> {
	// Check for existing credentials in env
	if (process.env.GITHUB_USERNAME && process.env.GITHUB_TOKEN) {
		const isValid = await validateGitHubToken(process.env.GITHUB_TOKEN);
		if (isValid) {
			return {
				username: process.env.GITHUB_USERNAME,
				token: process.env.GITHUB_TOKEN,
			};
		}
	}

	// No valid credentials found, prompt the user
	const prompt = await import("prompts");

	const { username } = await prompt.default({
		type: "text",
		name: "username",
		message: "Enter your GitHub username:",
		validate: (value) => (value ? true : "Username is required"),
	});

	if (!username) {
		return null;
	}

	const { token } = await prompt.default({
		type: "password",
		name: "token",
		message: "Enter your GitHub Personal Access Token (with repo scope):",
		validate: (value) => (value ? true : "Token is required"),
	});

	if (!token) {
		return null;
	}

	// Validate token
	const isValid = await validateGitHubToken(token);
	if (!isValid) {
		logger.error("Invalid GitHub token");
		return null;
	}

	// Save credentials to .env
	const envFile = path.join(os.homedir(), ".eliza", ".env");
	const envDir = path.dirname(envFile);

	await fs.mkdir(envDir, { recursive: true });

	try {
		let envContent = "";
		try {
			envContent = await fs.readFile(envFile, "utf-8");
			if (!envContent.endsWith("\n")) {
				envContent += "\n";
			}
		} catch (error) {
			// File doesn't exist, create it
			envContent = "# Environment variables for Eliza\n\n";
		}

		// Add GitHub credentials
		envContent += `GITHUB_USERNAME=${username}\n`;
		envContent += `GITHUB_TOKEN=${token}\n`;

		await fs.writeFile(envFile, envContent);
		logger.success(`GitHub credentials saved to ${envFile}`);
	} catch (error) {
		logger.warn(`Failed to save GitHub credentials: ${error.message}`);
	}

	return { username, token };
}
