/**
 * Problem statement classes for defining agent tasks
 * Converted from sweagent/agent/problem_statement.py
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

import axios from 'axios';
import { getLogger } from '../utils/log';
import { ExtraFields } from './types';

const logger = getLogger('problem-statement');

// Constants for image processing
const VALID_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg', // Some servers return jpg instead of jpeg
  'image/webp',
]);

/**
 * Interface for problem statements
 * Any class that implements this interface can be used as a problem statement
 */
export interface ProblemStatement {
  id: string;

  getProblemStatement(): string;

  /**
   * Used for setting environment variables in the container
   * By default, this is the same as getProblemStatement()
   */
  getProblemStatementForEnv(): string;

  getExtraFields(): ExtraFields;
}

/**
 * Base class for built-in problem statements
 */
abstract class BuiltinProblemStatementBase implements ProblemStatement {
  abstract id: string;

  abstract getProblemStatement(): string;

  getProblemStatementForEnv(): string {
    return this.getProblemStatement();
  }

  getExtraFields(): ExtraFields {
    return {};
  }
}

/**
 * Empty problem statement
 */
export class EmptyProblemStatement extends BuiltinProblemStatementBase {
  id: string;
  type: 'empty' = 'empty';

  constructor() {
    super();
    this.id = crypto.randomUUID();
  }

  getProblemStatement(): string {
    return '';
  }
}

/**
 * Text-based problem statement
 */
export class TextProblemStatement extends BuiltinProblemStatementBase {
  id: string;
  text: string;
  extraFields: ExtraFields;
  type: 'text' = 'text';

  constructor(config: { text: string; extraFields?: ExtraFields; id?: string }) {
    super();
    this.text = config.text;
    this.extraFields = config.extraFields || {};

    if (config.id) {
      this.id = config.id;
    } else {
      logger.info('Setting problem statement id to hash of text');
      this.id = crypto.createHash('sha256').update(this.text).digest('hex').substring(0, 6);
    }
  }

  getProblemStatement(): string {
    return this.text;
  }

  getExtraFields(): ExtraFields {
    return this.extraFields;
  }

  toString(): string {
    return `id=${this.id}, text=${this.text.substring(0, 30)}...`;
  }
}

/**
 * File-based problem statement
 */
export class FileProblemStatement extends BuiltinProblemStatementBase {
  id: string;
  filepath: string;
  extraFields: ExtraFields;
  type: 'text_file' = 'text_file';

  constructor(config: { path: string; extraFields?: ExtraFields; id?: string }) {
    super();
    this.filepath = config.path;
    this.extraFields = config.extraFields || {};

    if (config.id) {
      this.id = config.id;
    } else {
      logger.info(`Setting problem statement id to hash of file contents (path: ${this.filepath})`);
      const content = this.getProblemStatement();
      this.id = crypto.createHash('sha256').update(content).digest('hex').substring(0, 6);
    }
  }

  getProblemStatement(): string {
    return fs.readFileSync(this.filepath, 'utf-8');
  }

  getExtraFields(): ExtraFields {
    return this.extraFields;
  }
}

/**
 * GitHub issue problem statement
 */
export class GithubIssue extends BuiltinProblemStatementBase {
  id: string;
  githubUrl: string;
  extraFields: ExtraFields;
  type: 'github' = 'github';

  constructor(config: { githubUrl: string; extraFields?: ExtraFields; id?: string }) {
    super();
    this.githubUrl = config.githubUrl;
    this.extraFields = config.extraFields || {};

    if (config.id) {
      this.id = config.id;
    } else {
      logger.info('Setting problem statement based on github issue url');
      const { owner, repo, issueNumber } = this.parseGithubUrl(this.githubUrl);
      this.id = `${owner}__${repo}-i${issueNumber}`;
    }
  }

  private parseGithubUrl(url: string): { owner: string; repo: string; issueNumber: string } {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid GitHub issue URL: ${url}`);
    }
    return {
      owner: match[1],
      repo: match[2],
      issueNumber: match[3],
    };
  }

  async getProblemStatementAsync(): Promise<string> {
    const { owner, repo, issueNumber } = this.parseGithubUrl(this.githubUrl);

    const token = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'SWE-agent',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
        headers,
      });

      const issue = response.data;
      return `${issue.title}\n\n${issue.body}`;
    } catch (error) {
      logger.error(`Failed to fetch GitHub issue: ${error}`);
      throw error;
    }
  }

  private cachedStatement: string | null = null;

  getProblemStatement(): string {
    // For synchronous compatibility, we cache the result after first async fetch
    if (this.cachedStatement) {
      return this.cachedStatement;
    }

    // Synchronous HTTP request using Node.js built-in modules
    const { owner, repo, issueNumber } = this.parseGithubUrl(this.githubUrl);

    try {
      const { execSync } = require('child_process');
      const token = process.env.GITHUB_TOKEN;

      // Use curl for synchronous HTTP request
      const headers = ['-H "Accept: application/vnd.github.v3+json"', '-H "User-Agent: SWE-agent"'];

      if (token) {
        headers.push(`-H "Authorization: Bearer ${token}"`);
      }

      const command = `curl -s ${headers.join(' ')} https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
      const result = execSync(command, { encoding: 'utf-8', timeout: 5000 });

      const issue = JSON.parse(result);
      const statement = `${issue.title}\n\n${issue.body || ''}`;
      this.cachedStatement = statement;
      return statement;
    } catch (error) {
      logger.error(`Failed to fetch GitHub issue synchronously: ${error}`);

      // Fallback to basic issue reference
      const fallback = `GitHub Issue #${issueNumber} from ${owner}/${repo}\nURL: ${this.githubUrl}`;
      this.cachedStatement = fallback;
      return fallback;
    }
  }

  getExtraFields(): ExtraFields {
    return this.extraFields;
  }
}

/**
 * SWE-Bench multimodal problem statement with image support
 */
export class SWEBenchMultimodalProblemStatement extends BuiltinProblemStatementBase {
  id: string;
  text: string;
  issueImages: string[];
  disableImageProcessing: boolean;
  extraFields: ExtraFields;
  type: 'swe_bench_multimodal' = 'swe_bench_multimodal';
  private cachedProblemStatement: string | null = null;

  constructor(config: {
    text: string;
    issueImages?: string[];
    disableImageProcessing?: boolean;
    extraFields?: Record<string, any>;
    id?: string;
  }) {
    super();
    this.text = config.text;
    this.issueImages = config.issueImages || [];
    this.disableImageProcessing = config.disableImageProcessing || false;
    this.extraFields = config.extraFields || {};

    if (config.id) {
      this.id = config.id;
    } else {
      logger.info('Setting problem statement id to hash of text');
      this.id = crypto.createHash('sha256').update(this.text).digest('hex').substring(0, 6);
    }
  }

  getProblemStatementForEnv(): string {
    // Return text without images for environment
    return this.text;
  }

  getProblemStatement(): string {
    // For backwards compatibility, use the synchronous version
    // Tests can use getProblemStatementAsync() instead
    if (this.disableImageProcessing) {
      logger.info('Image processing disabled, returning text-only problem statement');
      return this.text;
    }

    if (this.cachedProblemStatement !== null) {
      return this.cachedProblemStatement;
    }

    let processedText = this.text;

    // Process images synchronously
    for (const link of this.issueImages) {
      const imageMarkdown = this.downloadAndConvertImageSync(link);
      if (imageMarkdown) {
        processedText += `\n\n${imageMarkdown}`;
      }
    }

    this.cachedProblemStatement = processedText;
    return processedText;
  }

  async getProblemStatementAsync(): Promise<string> {
    if (this.disableImageProcessing) {
      logger.info('Image processing disabled, returning text-only problem statement');
      return this.text;
    }

    if (this.cachedProblemStatement !== null) {
      return this.cachedProblemStatement;
    }

    let processedText = this.text;

    // Process images asynchronously
    for (const link of this.issueImages) {
      const imageMarkdown = await this.downloadAndConvertImage(link);
      if (imageMarkdown) {
        processedText += `\n\n${imageMarkdown}`;
      }
    }

    this.cachedProblemStatement = processedText;
    return processedText;
  }

  downloadAndConvertImageSync(url: string): string | null {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      logger.warn(`Invalid URL format: ${url}`);
      return null;
    }

    if (!urlObj.protocol || !urlObj.hostname) {
      logger.warn(`Invalid URL format: ${url}`);
      return null;
    }

    // Only allow HTTP and HTTPS protocols
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      logger.warn(`Invalid URL protocol: ${urlObj.protocol} for URL: ${url}`);
      return null;
    }

    try {
      const { execSync } = require('child_process');
      const headers = [
        '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
        '--max-time 30',
        '--max-filesize 10485760', // 10MB
      ];

      // Download image using curl and get headers
      const command = `curl -s -I ${headers.join(' ')} "${url}"`;
      const headResult = execSync(command, { encoding: 'utf-8', timeout: 5000 });

      // Check content type
      const contentTypeMatch = headResult.match(/content-type:\s*([^\r\n]+)/i);
      if (!contentTypeMatch) {
        logger.warn(`No content-type header for URL: ${url}`);
        return null;
      }

      let contentType = contentTypeMatch[1].toLowerCase().trim();
      if (contentType === 'image/jpg') {
        contentType = 'image/jpeg';
      }

      const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
      if (!validTypes.has(contentType)) {
        logger.warn(`Unsupported image MIME type '${contentType}' for URL: ${url}`);
        return null;
      }

      // Download the actual image
      const downloadCommand = `curl -s ${headers.join(' ')} "${url}" | base64`;
      const base64Data = execSync(downloadCommand, { encoding: 'utf-8', timeout: 30000, maxBuffer: 15 * 1024 * 1024 });

      if (!base64Data || base64Data.trim().length === 0) {
        logger.warn(`Empty image data for URL: ${url}`);
        return null;
      }

      const markdown = `![${url}](data:${contentType};base64,${base64Data.trim()})`;
      logger.info(`Successfully processed image from ${url} (${contentType})`);
      return markdown;
    } catch (error) {
      logger.warn(`Failed to download image from ${url}: ${error}`);
      return null;
    }
  }

  async downloadAndConvertImage(url: string): Promise<string | null> {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      logger.warn(`Invalid URL format: ${url}`);
      return null;
    }

    if (!urlObj.protocol || !urlObj.hostname) {
      logger.warn(`Invalid URL format: ${url}`);
      return null;
    }

    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      const response = await axios.get(url, {
        headers,
        timeout: 30000,
        responseType: 'arraybuffer',
        maxContentLength: 10 * 1024 * 1024, // 10MB
      });

      let contentType = response.headers['content-type']?.toLowerCase() || '';
      if (contentType === 'image/jpg') {
        contentType = 'image/jpeg';
      }

      if (!VALID_IMAGE_MIME_TYPES.has(contentType)) {
        logger.warn(`Unsupported image MIME type '${contentType}' for URL: ${url}`);
        return null;
      }

      const imageData = Buffer.from(response.data);
      const b64Data = imageData.toString('base64');
      const markdown = `![${url}](data:${contentType};base64,${b64Data})`;

      logger.info(`Successfully processed image from ${url} (${imageData.length} bytes, ${contentType})`);
      return markdown;
    } catch (error) {
      logger.warn(`Failed to process image from ${url}: ${error}`);
      return null;
    }
  }

  getExtraFields(): ExtraFields {
    return this.extraFields;
  }

  toString(): string {
    const nImages = this.issueImages.length;
    return `id=${this.id}, text=${this.text.substring(0, 30)}..., images=${nImages}`;
  }
}

/**
 * Factory function to create problem statement from simplified input
 */
export function problemStatementFromSimplifiedInput(
  input: string,
  type: 'text' | 'text_file' | 'github_issue' | 'swe_bench_multimodal',
): ProblemStatement {
  switch (type) {
    case 'text':
      return new TextProblemStatement({ text: input });
    case 'text_file':
      return new FileProblemStatement({ path: input });
    case 'github_issue':
      return new GithubIssue({ githubUrl: input });
    case 'swe_bench_multimodal':
      return new SWEBenchMultimodalProblemStatement({ text: input });
    default:
      throw new Error(`Unknown problem statement type: ${type}`);
  }
}

/**
 * Type for problem statement configurations
 */
export type ProblemStatementConfig =
  | TextProblemStatement
  | SWEBenchMultimodalProblemStatement
  | GithubIssue
  | EmptyProblemStatement
  | FileProblemStatement;
