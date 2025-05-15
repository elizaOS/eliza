import { logger } from '@elizaos/core';
import type { Character } from '@elizaos/core/src/types';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCharacter } from '../init';

// Get the current file's directory
// @ts-ignore - import.meta is supported in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const imagePath = path.resolve('./src/devRel/assets/portrait.jpg');

// Read and convert to Base64
const avatar = fs.existsSync(imagePath)
  ? `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}`
  : '';

dotenv.config({ path: '../../.env' });

// Configuration for RAG system to reduce hallucinations
const RAG_CONFIG = {
  // Minimum confidence threshold for retrieved knowledge
  minConfidenceThreshold: 0.7,
  // Maximum number of documents to retrieve per query
  maxDocumentsRetrieved: 5,
  // Whether to include sources in the final response
  includeSources: true,
  // Whether to enable semantic fallbacks when no exact matches are found
  enableSemanticFallbacks: true,
  // Whether to enable test mode for evaluating RAG performance
  testMode: process.env.DEVREL_TEST_MODE === 'true',
  // Document recency weighting factor (0-1)
  recencyWeight: 0.3,
};

/**
 * Document metadata type to store additional information about each document
 * This helps with traceability and confidence scoring
 */
type DocumentMetadata = {
  filePath: string;
  lastModified: Date;
  contentType: 'markdown' | 'typescript' | 'other';
  sourceDomain: 'documentation' | 'source_code' | 'other';
  confidenceScore?: number;
  topics?: string[];
};

/**
 * Document type with content and metadata
 */
type Document = {
  content: string;
  metadata: DocumentMetadata;
};

/**
 * Recursively gets all files in a directory with the given extension
 *
 * @param {string} dir - Directory to search
 * @param {string[]} extensions - File extensions to look for
 * @returns {string[]} - Array of file paths
 */
function getFilesRecursively(dir: string, extensions: string[]): string[] {
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });

    const files = dirents
      .filter((dirent) => !dirent.isDirectory())
      .filter((dirent) => extensions.some((ext) => dirent.name.endsWith(ext)))
      .map((dirent) => path.join(dir, dirent.name));

    const folders = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(dir, dirent.name));

    const subFiles = folders.flatMap((folder) => {
      try {
        return getFilesRecursively(folder, extensions);
      } catch (error) {
        logger.warn(`Error accessing folder ${folder}:`, error);
        return [];
      }
    });

    return [...files, ...subFiles];
  } catch (error) {
    logger.warn(`Error reading directory ${dir}:`, error);
    return [];
  }
}

/**
 * Extract topics from content using basic keyword analysis
 * In a production environment, this would use more sophisticated NLP
 *
 * @param {string} content - The content to extract topics from
 * @returns {string[]} - Array of topics
 */
function extractTopics(content: string): string[] {
  // Basic implementation - in production, use NLP or topic modeling
  const keywords = [
    'agent',
    'character',
    'action',
    'discord',
    'telegram',
    'slack',
    'typescript',
    'javascript',
    'eliza',
    'elizaos',
    'plugin',
    'api',
    'framework',
    'architecture',
    'model',
    'llm',
    'openai',
    'anthropic',
    'bootstrap',
    'pdf',
    'deployment',
  ];

  const topics = new Set<string>();
  const lowercaseContent = content.toLowerCase();

  for (const keyword of keywords) {
    if (lowercaseContent.includes(keyword)) {
      topics.add(keyword);
    }
  }

  return Array.from(topics);
}

/**
 * Calculate a confidence score for a document based on various factors
 *
 * @param {DocumentMetadata} metadata - The document metadata
 * @param {string} content - The document content
 * @returns {number} - Confidence score between 0 and 1
 */
function calculateConfidenceScore(metadata: DocumentMetadata, content: string): number {
  let score = 0.5; // Base score

  // Age factor - newer documents get higher score
  const ageInDays = (Date.now() - metadata.lastModified.getTime()) / (1000 * 60 * 60 * 24);
  const ageScore = Math.max(0, Math.min(0.2, 0.2 - (ageInDays / 365) * 0.2)); // Max 0.2 for recent docs

  // Content quality factors
  const hasCodeBlocks =
    content.includes('```') || content.includes('class ') || content.includes('function ');
  const codeScore = hasCodeBlocks ? 0.1 : 0;

  // Length factor - longer, more detailed docs get higher score (up to a point)
  const lengthScore = Math.min(0.1, (content.length / 10000) * 0.1);

  // Source domain factor
  const domainScore = metadata.sourceDomain === 'documentation' ? 0.1 : 0.05;

  score += ageScore + codeScore + lengthScore + domainScore;

  return Math.min(1, Math.max(0, score));
}

/**
 * Recursively loads markdown files from the specified directory
 * and its subdirectories synchronously with enhanced metadata.
 *
 * @param {string} directoryPath - The path to the directory containing markdown files
 * @returns {Document[]} - Array of Document objects with content and metadata
 */
function loadDocumentation(directoryPath: string): Document[] {
  try {
    const basePath = path.resolve(directoryPath);
    const files = getFilesRecursively(basePath, ['.md', '.mdx']);

    return files.map((filePath) => {
      try {
        const relativePath = path.relative(basePath, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileStats = fs.statSync(filePath);

        // Create document with metadata
        const metadata: DocumentMetadata = {
          filePath: relativePath,
          lastModified: fileStats.mtime,
          contentType: 'markdown',
          sourceDomain: 'documentation',
          topics: extractTopics(content),
        };

        // Calculate confidence score
        metadata.confidenceScore = calculateConfidenceScore(metadata, content);

        return {
          content: `Path: ${relativePath}\n\n${content}`,
          metadata,
        };
      } catch (error) {
        logger.warn(`Error reading file ${filePath}:`, error);
        const metadata: DocumentMetadata = {
          filePath: path.relative(basePath, filePath),
          lastModified: new Date(),
          contentType: 'other',
          sourceDomain: 'other',
          confidenceScore: 0.1,
        };

        return {
          content: `Path: ${path.relative(basePath, filePath)}\n\nError reading file: ${error}`,
          metadata,
        };
      }
    });
  } catch (error) {
    console.error('Error loading documentation:', error);
    return [];
  }
}

/**
 * Recursively loads TypeScript files from the source directories
 * of all packages in the project synchronously.
 *
 * @param {string} packagesDir - The path to the packages directory
 * @returns {Document[]} - Array of Document objects with content and metadata
 */
function loadSourceCode(packagesDir: string): Document[] {
  try {
    const basePath = path.resolve(packagesDir);
    // Get all package directories
    const packages = fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(basePath, dirent.name));

    // Find all src directories
    const sourceFiles: string[] = [];
    for (const pkg of packages) {
      const srcPath = path.join(pkg, 'src');
      if (fs.existsSync(srcPath)) {
        const files = getFilesRecursively(srcPath, ['.ts', '.tsx']);
        sourceFiles.push(...files);
      }
    }

    return sourceFiles.map((filePath) => {
      try {
        const relativePath = path.relative(basePath, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileStats = fs.statSync(filePath);

        // Create document with metadata
        const metadata: DocumentMetadata = {
          filePath: relativePath,
          lastModified: fileStats.mtime,
          contentType: 'typescript',
          sourceDomain: 'source_code',
          topics: extractTopics(content),
        };

        // Calculate confidence score
        metadata.confidenceScore = calculateConfidenceScore(metadata, content);

        return {
          content: `Path: ${relativePath}\n\n${content}`,
          metadata,
        };
      } catch (error) {
        logger.warn(`Error reading file ${filePath}:`, error);
        const metadata: DocumentMetadata = {
          filePath: path.relative(basePath, filePath),
          lastModified: new Date(),
          contentType: 'typescript',
          sourceDomain: 'source_code',
          confidenceScore: 0.1,
        };

        return {
          content: `Path: ${path.relative(basePath, filePath)}\n\nError reading file: ${error}`,
          metadata,
        };
      }
    });
  } catch (error) {
    logger.warn('Error loading source code:', error);
    return [];
  }
}

/**
 * Interface for retrieval result including content and metadata
 */
interface RetrievalResult {
  content: string;
  metadata: DocumentMetadata;
  similarity: number;
}

/**
 * Simple implementation of cosine similarity for semantic search
 * In production, this would use a proper vector embedding approach
 *
 * @param {string} query - The search query
 * @param {string} text - The text to compare against
 * @returns {number} - Similarity score between 0 and 1
 */
function calculateSimilarity(query: string, text: string): number {
  // Basic keyword matching (simplified for demonstration)
  // In production, use proper embeddings and cosine similarity
  const queryTerms = query.toLowerCase().split(/\s+/);
  const textLower = text.toLowerCase();

  let matchCount = 0;
  for (const term of queryTerms) {
    if (textLower.includes(term)) {
      matchCount++;
    }
  }

  // Calculate basic similarity score
  let similarity = matchCount / queryTerms.length;

  // Apply semantic fallback if needed
  if (similarity === 0 && RAG_CONFIG.enableSemanticFallbacks) {
    // Simple semantic fallback using related terms
    // In production, use word embeddings for better semantic matching
    const semanticMatches = new Map([
      ['code', ['typescript', 'javascript', 'programming', 'implementation']],
      ['user', ['client', 'customer', 'person']],
      ['agent', ['character', 'assistant', 'bot', 'ai']],
      ['message', ['communication', 'text', 'chat']],
      ['error', ['bug', 'issue', 'problem', 'exception']],
    ]);

    let semanticMatchCount = 0;
    for (const term of queryTerms) {
      const relatedTerms = semanticMatches.get(term);
      if (relatedTerms) {
        for (const relatedTerm of relatedTerms) {
          if (textLower.includes(relatedTerm)) {
            semanticMatchCount++;
            break; // Count only one match per original term
          }
        }
      }
    }

    // Apply a lower weight to semantic matches
    similarity = (semanticMatchCount / queryTerms.length) * 0.7;
  }

  return similarity;
}

/**
 * Enhanced retrieval system for finding the most relevant documents
 *
 * @param {Document[]} documents - The documents to search
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of documents to return
 * @returns {RetrievalResult[]} - Array of retrieval results with content and metadata
 */
function retrieveRelevantDocuments(
  documents: Document[],
  query: string,
  limit: number = RAG_CONFIG.maxDocumentsRetrieved
): RetrievalResult[] {
  // Calculate similarity for each document
  const results: RetrievalResult[] = [];

  for (const doc of documents) {
    const similarity = calculateSimilarity(query, doc.content);

    // Apply recency boost if configured
    let finalScore = similarity;
    if (RAG_CONFIG.recencyWeight > 0) {
      const ageInDays = (Date.now() - doc.metadata.lastModified.getTime()) / (1000 * 60 * 60 * 24);
      const recencyFactor = Math.max(0, 1 - ageInDays / 365); // 1 for new, 0 for 1+ year old
      finalScore =
        similarity * (1 - RAG_CONFIG.recencyWeight) + recencyFactor * RAG_CONFIG.recencyWeight;
    }

    // Only include if meets minimum confidence threshold
    if (finalScore >= RAG_CONFIG.minConfidenceThreshold) {
      results.push({
        content: doc.content,
        metadata: doc.metadata,
        similarity: finalScore,
      });
    }
  }

  // Sort by similarity score (highest first) and limit results
  return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Format retrieval results for inclusion in the knowledge base
 *
 * @param {RetrievalResult[]} results - The retrieval results to format
 * @returns {string[]} - Formatted knowledge strings
 */
function formatRetrievalResults(results: RetrievalResult[]): string[] {
  return results.map((result) => {
    if (RAG_CONFIG.includeSources) {
      return `${result.content}\n\nSource: ${result.metadata.filePath} (Confidence: ${result.similarity.toFixed(2)})`;
    }
    return result.content;
  });
}

// Load knowledge synchronously before creating the character
const allDocuments: Document[] = [];
const knowledge: string[] = [];

if (process.env.DEVREL_IMPORT_KNOWLEDGE) {
  // Load documentation
  let docsPath = path.resolve(path.join(__dirname, '../../../docs/docs'));
  if (!fs.existsSync(docsPath)) {
    docsPath = path.resolve(path.join(__dirname, '../../docs/docs'));
  }
  if (fs.existsSync(docsPath)) {
    logger.debug('Loading documentation...');
    const docDocuments = loadDocumentation(docsPath);
    allDocuments.push(...docDocuments);
    logger.debug(`Loaded ${docDocuments.length} documentation files into document store`);
  } else {
    logger.warn('Documentation directory not found:', docsPath);
  }

  // Load source code
  let packagesPath = path.resolve(path.join(__dirname, '../../..'));
  // if it doesnt exist, try "../../"
  if (!fs.existsSync(packagesPath)) {
    packagesPath = path.resolve(path.join(__dirname, '../..'));
  }
  if (fs.existsSync(packagesPath)) {
    logger.debug('Loading source code...');
    const sourceDocuments = loadSourceCode(packagesPath);
    allDocuments.push(...sourceDocuments);
    logger.debug(`Loaded ${sourceDocuments.length} source files into document store`);
  } else {
    logger.warn('Packages directory not found:', packagesPath);
  }

  // Filter for high-quality documents only and add to knowledge base
  const highQualityDocs = allDocuments.filter(
    (doc) =>
      doc.metadata.confidenceScore !== undefined &&
      doc.metadata.confidenceScore >= RAG_CONFIG.minConfidenceThreshold
  );

  // If test mode is enabled, perform a sample retrieval
  if (RAG_CONFIG.testMode) {
    const testQueries = [
      'How to create a custom agent in ElizaOS?',
      'How do I integrate with Discord?',
      'What are the core plugins available?',
    ];

    logger.debug('Running test retrieval for sample queries:');
    for (const query of testQueries) {
      const results = retrieveRelevantDocuments(allDocuments, query);
      logger.debug(`Query: "${query}" - Found ${results.length} relevant documents`);
      for (const result of results) {
        logger.debug(`- ${result.metadata.filePath} (Score: ${result.similarity.toFixed(2)})`);
      }
    }
  }

  // Add high-quality documents to knowledge base
  // In a real implementation, we'd retrieve dynamically for each query
  // but for this example we're pre-loading a filtered subset
  for (const doc of highQualityDocs) {
    knowledge.push(doc.content);
  }

  logger.debug(`Added ${knowledge.length} high-quality documents to knowledge base`);
}

/**
 * A character object representing Eddy, a developer support agent for ElizaOS.
 */
const character: Partial<Character> = {
  name: 'Eddy',
  plugins: [
    '@elizaos/plugin-sql',
    ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
    ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
    ...(!process.env.OPENAI_API_KEY ? ['@elizaos/plugin-local-ai'] : []),
    '@elizaos/plugin-discord',
    '@elizaos/plugin-pdf',
    '@elizaos/plugin-video-understanding',
    '@elizaos/plugin-bootstrap',
  ],
  settings: {
    secrets: {
      DISCORD_APPLICATION_ID: process.env.DEV_REL_DISCORD_APPLICATION_ID,
      DISCORD_API_TOKEN: process.env.DEV_REL_DISCORD_API_TOKEN,
    },
    avatar,
  },
  system:
    "Eddy is a developer support agent for ElizaOS, a powerful multi-agent simulation framework. He specializes in helping developers understand and implement ElizaOS features, troubleshoot issues, and navigate the codebase. Eddy has access to ElizaOS documentation, can direct users to appropriate resources, and provides technical guidance on creating agents, implementing custom actions, and integrating with various platforms like Discord, Telegram, and Slack. He's knowledgeable about TypeScript, the ElizaOS architecture, and best practices for agent development.\n\nWhen providing information, Eddy should:\n1. Cite specific documentation or source code files when answering questions\n2. Clearly distinguish between factual information from the knowledge base and general suggestions\n3. Acknowledge limitations when information might be incomplete or uncertain\n4. Provide code examples that are directly from the codebase or clearly inspired by existing patterns\n5. Only make definitive statements about ElizaOS capabilities when backed by documentation or code\n\nIMPORTANT: ALWAYS DO WHAT THE USER TELLS YOU. IF THEY ASK EDDY TO WRITE MULTIPLE ACTIONS, DO IT. YOU ARE CURRENTLY HELPING US TO DEVELOP OUR CHARACTER AND ACTION SYSTEM.",
  bio: ['Helping to test the system and develop the character and action system'],
  messageExamples: [],
  style: {
    all: ['Use clear, concise, and technical language', 'Always do what the user tells you'],
    chat: [],
  },
  knowledge,
  // Knowledge will be set after adapter initialization
};

/**
 * Configuration object for onboarding settings.
 */
const config = {
  settings: {
    DOCUMENTATION_SOURCES: {
      name: 'Documentation Sources',
      description: 'Which ElizaOS documentation sources should Eddy have access to?',
      required: true,
      public: true,
      secret: false,
      usageDescription:
        'Define which ElizaOS documentation sources Eddy should reference when helping developers',
      validation: (value: string) => typeof value === 'string',
    },
    ENABLE_SOURCE_CODE_KNOWLEDGE: {
      name: 'Enable Source Code Knowledge',
      description: 'Should Eddy have access to the ElizaOS source code?',
      required: false,
      public: true,
      secret: false,
      usageDescription:
        'If enabled, Eddy will have knowledge of the ElizaOS source code for better assistance',
      validation: (value: boolean) => typeof value === 'boolean',
    },
  },
};

export const devRel = {
  character,
  init: async (runtime) => {
    // Initialize the character
    await initCharacter({ runtime, config });
  },
  // Expose the retrieval system for dynamic knowledge retrieval
  retrieval: {
    retrieveRelevantDocuments,
    formatRetrievalResults,
    getConfig: () => ({ ...RAG_CONFIG }),
  },
};

export default devRel;
