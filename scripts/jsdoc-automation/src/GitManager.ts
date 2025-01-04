import { Octokit } from "@octokit/rest";
import { PrModeFileChange, Repository } from "./types/index.js";
import dotenv from 'dotenv';

dotenv.config();

interface CreatePullRequestOptions {
    title: string;
    body: string;
    head: string;
    base: string;
    labels?: string[];
    reviewers?: string[];
}

/**
 * Manages operations related to interacting with a Git repository using the GitHub API.
 */
export class GitManager {
    private octokit: Octokit;

    /**
     * Constructor for a class that initializes the Octokit instance with the provided Repository and checks if the GITHUB_ACCESS_TOKEN is set in the environment.
     * @param {Repository} repository - The repository instance to use
     * @throws {Error} Throws an error if the GITHUB_ACCESS_TOKEN is not set
     */
    constructor(public repository: Repository) {
        if (!process.env.GITHUB_ACCESS_TOKEN) {
            throw new Error('GITHUB_ACCESS_TOKEN is not set');
        }
        this.octokit = new Octokit({
            auth: process.env.GITHUB_ACCESS_TOKEN,
        });
    }

    /**
     * Retrieve files in a specific pull request.
     * @param {number} pullNumber - The number of the pull request to get files from.
     * @returns {Promise<PrModeFileChange[]>} - Array of objects representing file changes in the pull request.
     */
    public async getFilesInPullRequest(pullNumber: number): Promise<PrModeFileChange[]> {
        const { data } = await this.octokit.pulls.listFiles({
            owner: this.repository.owner,
            repo: this.repository.name,
            pull_number: pullNumber,
        });

        return data.map((file: any) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            contents_url: file.contents_url,
        }));
    }

    /**
     * Creates a new branch in the GitHub repository using the given branch name and base branch.
     *
     * @param {string} branchName - The name of the new branch to be created.
     * @param {string} baseBranch - The name of the branch to base the new branch off of.
     * @returns {Promise<void>} - A Promise that resolves when the branch is successfully created.
     */
    public async createBranch(branchName: string, baseBranch: string): Promise<void> {
        await this.octokit.git.createRef({
            owner: this.repository.owner,
            repo: this.repository.name,
            ref: `refs/heads/${branchName}`,
            sha: (await this.octokit.git.getRef({
                owner: this.repository.owner,
                repo: this.repository.name,
                ref: `heads/${baseBranch}`,
            })).data.object.sha,
        });
    }

    /**
     * Asynchronously commits a file to a repository using the GitHub API.
     *
     * @param {string} branchName - The name of the branch to commit the file to.
     * @param {string} filePath - The path of the file to commit.
     * @param {string} content - The content of the file to commit.
     * @param {string} message - The commit message.
     * @returns {Promise<void>} A promise that resolves when the file is successfully committed.
     */
    public async commitFile(branchName: string, filePath: string, content: string, message: string): Promise<void> {
        try {
            const { data } = await this.octokit.repos.getContent({
                owner: this.repository.owner,
                repo: this.repository.name,
                path: filePath,
                ref: branchName,
            });

            await this.octokit.repos.createOrUpdateFileContents({
                owner: this.repository.owner,
                repo: this.repository.name,
                path: filePath,
                message: message,
                content: Buffer.from(content).toString('base64'),
                sha: (data as any).sha,
                branch: branchName,
            });
        } catch (error: any) {
            if (error.status === 404) {
                console.log('404 - File doesn\'t exist in the target branch, creating a new file');
                // File doesn't exist in the target branch, create a new file
                await this.octokit.repos.createOrUpdateFileContents({
                    owner: this.repository.owner,
                    repo: this.repository.name,
                    path: filePath,
                    message: message,
                    content: Buffer.from(content).toString('base64'),
                    branch: branchName,
                });
            } else {
                throw error;
            }
        }
    }

    /**
     * Create a pull request using the provided options.
     * @param {CreatePullRequestOptions} options - The options for creating the pull request.
     * @returns {Promise<void>} A Promise that resolves once the pull request is successfully created.
     */
    public async createPullRequest(options: CreatePullRequestOptions): Promise<void> {
        try {
            // Create the pull request
            const { data: pr } = await this.octokit.pulls.create({
                owner: this.repository.owner,
                repo: this.repository.name,
                title: options.title,
                body: options.body,
                head: options.head,
                base: options.base
            });

            // Add labels if provided
            if (options.labels && options.labels.length > 0) {
                await this.octokit.issues.addLabels({
                    owner: this.repository.owner,
                    repo: this.repository.name,
                    issue_number: pr.number,
                    labels: options.labels
                });
            }

            // Add reviewers if provided
            if (options.reviewers && options.reviewers.length > 0) {
                await this.octokit.pulls.requestReviewers({
                    owner: this.repository.owner,
                    repo: this.repository.name,
                    pull_number: pr.number,
                    reviewers: options.reviewers
                });
            }

            console.log(`Created PR #${pr.number}: ${pr.html_url}`);
        } catch (error) {
            console.error('Error creating pull request:', error);
            throw error;
        }
    }
}