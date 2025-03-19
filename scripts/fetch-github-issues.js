#!/usr/bin/env node

/**
 * GitHub Issues Fetcher for Eliza RAG
 *
 * This script fetches issues from specified GitHub repositories
 * and saves them as markdown files in the characters/knowledge/github-issues directory.
 *
 * Usage:
 *   node fetch-github-issues.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const REPOSITORIES = [
  { owner: 'bnb-chain', repo: 'bsc' },
  { owner: 'bnb-chain', repo: 'reth' },
  { owner: 'node-real', repo: 'bsc-erigon' }
];

const OUTPUT_DIR = path.join('characters', 'knowledge', 'github-issues');
const DAYS_TO_FETCH = 30; // Fetch issues from the last 30 days

// Ensure the output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Fetch issues from a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<Object[]>} - Array of issue objects
 */
function fetchIssues(owner, repo) {
  return new Promise((resolve, reject) => {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - DAYS_TO_FETCH);
    const sinceIsoString = sinceDate.toISOString();

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues?state=all&since=${sinceIsoString}&per_page=100`,
      method: 'GET',
      headers: {
        'User-Agent': 'Eliza-RAG-Issues-Fetcher',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    // Get GitHub token from environment if available
    if (process.env.GITHUB_TOKEN) {
      options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const issues = JSON.parse(data);
            resolve(issues);
          } catch (error) {
            reject(`Error parsing response: ${error.message}`);
          }
        } else {
          reject(`Request failed with status code ${res.statusCode}: ${data}`);
        }
      });
    });

    req.on('error', (error) => {
      reject(`Request error: ${error.message}`);
    });

    req.end();
  });
}

/**
 * Convert GitHub issue to markdown
 * @param {Object} issue - GitHub issue object
 * @param {string} repo - Repository name
 * @returns {string} - Markdown content
 */
function issueToMarkdown(issue, repo) {
  const createdAt = new Date(issue.created_at).toLocaleString();
  const updatedAt = new Date(issue.updated_at).toLocaleString();

  let markdown = `# [${repo}] ${issue.title}\n\n`;
  markdown += `- **Issue**: #${issue.number}\n`;
  markdown += `- **Status**: ${issue.state}\n`;
  markdown += `- **Created**: ${createdAt}\n`;
  markdown += `- **Updated**: ${updatedAt}\n`;
  markdown += `- **URL**: ${issue.html_url}\n\n`;

  if (issue.labels && issue.labels.length > 0) {
    markdown += '## Labels\n\n';
    issue.labels.forEach(label => {
      markdown += `- ${label.name}\n`;
    });
    markdown += '\n';
  }

  markdown += '## Description\n\n';
  markdown += issue.body || 'No description provided.\n\n';

  if (issue.comments > 0) {
    markdown += `## Comments\n\n`;
    markdown += `This issue has ${issue.comments} comments. View them at ${issue.html_url}.\n\n`;
  }

  return markdown;
}

/**
 * Main function
 */
async function main() {
  console.log('Fetching GitHub issues...');

  for (const { owner, repo } of REPOSITORIES) {
    console.log(`\nProcessing ${owner}/${repo}...`);

    try {
      const issues = await fetchIssues(owner, repo);
      console.log(`Found ${issues.length} issues`);

      // Create repo directory if it doesn't exist
      const repoDir = path.join(OUTPUT_DIR, `${owner}-${repo}`);
      if (!fs.existsSync(repoDir)) {
        fs.mkdirSync(repoDir, { recursive: true });
      }

      // Create index file
      let indexContent = `# GitHub Issues for ${owner}/${repo}\n\n`;
      indexContent += `Last updated: ${new Date().toLocaleString()}\n\n`;
      indexContent += '## Recent Issues\n\n';

      // Process each issue
      for (const issue of issues) {
        const issueFilename = `issue-${issue.number}.md`;
        const issueFilePath = path.join(repoDir, issueFilename);

        // Add to index
        indexContent += `- [#${issue.number}: ${issue.title}](${issueFilename}) (${issue.state})\n`;

        // Save issue to file
        const markdown = issueToMarkdown(issue, repo);
        fs.writeFileSync(issueFilePath, markdown);
      }

      // Save index file
      fs.writeFileSync(path.join(repoDir, 'index.md'), indexContent);

    } catch (error) {
      console.error(`Error processing ${owner}/${repo}:`, error);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
