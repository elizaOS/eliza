import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { existsSync, promises as fsPromises } from 'node:fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { default as generate } from '@babel/generator';
import * as t from '@babel/types';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import minimist from 'minimist';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = process.argv.slice(2);
const shouldApply = args.includes('--apply');
const shouldAnalyze = args.includes('--analyze') || shouldApply;

// Global configuration
let VERBOSE = false;
const PARSE_CACHE_PATH = path.join(process.cwd(), 'scripts', 'async-analysis-parse.json');
const AI_CACHE_PATH = path.join(process.cwd(), 'scripts', 'async-analysis-ai.json');
const FINAL_CACHE_PATH = path.join(process.cwd(), 'scripts', 'async-analysis-final.json');
const CACHE_DIR = path.join(process.cwd(), 'scripts', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'analysis-cache.json');

// Configuration
const VERBOSE_LOGGING = false; // Set to true for detailed logs

// Utility for conditional logging
function logVerbose(...args) {
  if (VERBOSE) {
    console.log('[VERBOSE]', ...args);
  }
}

dotenv.config();

// Initialize the Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CACHE_VERSION = '1.0.0';
const CACHE_FILE = path.join(__dirname, 'cache', 'analysis-cache.json');
const RESULTS_FILE = path.join(__dirname, 'optimization-results.json');
const OPTIMIZED_FILE = path.join(__dirname, 'async-optimization-test.optimized.js');
const STAGE_FILES = {
  PARSE: path.join(__dirname, 'async-analysis-parse.json'),
  ANALYSIS: path.join(__dirname, 'async-analysis-ai.json'),
  FINAL: path.join(__dirname, 'async-analysis-final.json'),
};

// Add skip packages configuration
const SKIP_PACKAGES = new Set([
  'cli', // Skip auto doc client CLI
  'create-eliza', // Skip Eliza projects
  'project-starter',
  'plugin-starter',
  'plugin-example',
]);

const TRACKING_FILES = {
  CANDIDATES: path.join(__dirname, 'candidates.json'),
  RESULTS: path.join(__dirname, 'results.json'),
};

// Add cache initialization at the top level
let analysisCache = {
  version: CACHE_VERSION,
  lastRun: null,
  metadata: {
    totalFunctions: 0,
    analyzedFunctions: 0,
    parallelizableFunctions: 0,
  },
  functions: {},
};

async function loadCache() {
  try {
    await fsPromises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const content = await fsPromises.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(content);
    if (cache.version === CACHE_VERSION) {
      return cache;
    }
  } catch (error) {
    // If cache doesn't exist or is invalid, return empty cache
    return {
      version: CACHE_VERSION,
      lastRun: null,
      metadata: {
        totalFunctions: 0,
        analyzedFunctions: 0,
        parallelizableFunctions: 0,
      },
      functions: {},
    };
  }
}

async function initializeCache() {
  try {
    await fsPromises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const content = await fsPromises.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(content);
    if (cache.version === CACHE_VERSION) {
      analysisCache = cache;
      logVerbose('\n=== Cache Status ===');
      logVerbose(`Last run: ${cache.lastRun || 'Never'}`);
      logVerbose(
        `Previously analyzed: ${cache.metadata.analyzedFunctions}/${cache.metadata.totalFunctions} functions`
      );
      logVerbose(`Found ${cache.metadata.parallelizableFunctions} parallelizable functions\n`);
    }
  } catch (error) {
    // If cache doesn't exist or is invalid, we'll use the default empty cache
    logVerbose('\nNo valid cache found, starting fresh analysis');
    analysisCache = {
      version: CACHE_VERSION,
      lastRun: null,
      metadata: {
        totalFunctions: 0,
        analyzedFunctions: 0,
        parallelizableFunctions: 0,
      },
      functions: {},
    };
  }
}

async function updateCache(functionInfo, analysis) {
  const hash = generateFunctionHash(functionInfo.code);

  // Update function-specific cache
  analysisCache.functions[hash] = {
    timestamp: new Date().toISOString(),
    name: functionInfo.name,
    file: functionInfo.relativePath,
    analysis,
  };

  // Update metadata
  analysisCache.lastRun = new Date().toISOString();
  analysisCache.metadata.analyzedFunctions = Object.keys(analysisCache.functions).length;
  analysisCache.metadata.parallelizableFunctions = Object.values(analysisCache.functions).filter(
    (f) => f.analysis?.isParallelizable
  ).length;

  // Save cache after each update
  await saveCache();
}

// Use a circular replacer to handle circular references
const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    // Skip properties that commonly cause circular references
    if (
      key === 'parent' ||
      key === 'range' ||
      key === 'loc' ||
      key === 'start' ||
      key === 'end' ||
      key === 'body' ||
      key === 'sourceInfo'
    ) {
      return undefined;
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
};

async function saveCache() {
  try {
    await fsPromises.mkdir(path.dirname(CACHE_FILE), { recursive: true });

    await fsPromises.writeFile(CACHE_FILE, JSON.stringify(analysisCache, getCircularReplacer(), 2));
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

export async function fetchUserData(userId) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    id: userId,
    name: 'Test User',
    email: 'test@example.com',
  };
}
export async function fetchUserProducts(userId) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return [
    {
      id: 'p1',
      name: 'Product 1',
      price: 99.99,
    },
    {
      id: 'p2',
      name: 'Product 2',
      price: 149.99,
    },
  ];
}
export async function fetchUserAnalytics(userId) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    visits: 42,
    pageViews: 128,
    conversions: 3,
  };
}
export async function createUser(userData) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    id: Math.random().toString(36).substring(7),
    name: userData.name || 'New User',
    email: userData.email || 'new@example.com',
  };
}
export async function fetchDefaultPreferences() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    theme: 'light',
    notifications: true,
    language: 'en-US',
  };
}
export async function fetchWelcomeTemplate() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return "Welcome, {{name}}! We're glad to have you join us.";
}
export async function sendWelcomeEmail(email, template, preferences) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`Sending welcome email to ${email} with preferences:`, preferences);
}

function generateFunctionHash(fnStr) {
  return Buffer.from(fnStr).toString('base64');
}

class AsyncQueue {
  constructor(concurrency = 10) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.completed = 0;
    this.total = 0;
    this.lastProgressUpdate = Date.now();
    this.rateLimitDelay = 100; // ms between API calls to avoid rate limits
  }

  setTotal(total) {
    this.total = total;
  }

  updateProgress() {
    const now = Date.now();
    // Only update progress every 1000ms to avoid console spam
    if (now - this.lastProgressUpdate > 1000) {
      const percent = Math.round((this.completed / this.total) * 100);
      process.stdout.write(`\rProgress: ${percent}% (${this.completed}/${this.total})`);
      this.lastProgressUpdate = now;
    }
  }

  async add(fn) {
    if (this.running >= this.concurrency) {
      // Wait for a slot to open up
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.running++;
    try {
      // Add rate limiting delay
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));
      const result = await fn();
      this.completed++;
      this.updateProgress();
      return result;
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        // Let the next task run
        const next = this.queue.shift();
        next();
      } else if (this.running === 0) {
        // Clear the progress line when all tasks are done
        process.stdout.write('\n');
      }
    }
  }
}

async function analyzeWithClaude(functionCode, functionName) {
  const cacheKey = crypto.createHash('sha256').update(functionCode).digest('hex');

  // Check if the function is already in the cache
  if (analysisCache.functions[cacheKey]) {
    logVerbose(`[${functionName}] Using cached analysis`);
    return analysisCache.functions[cacheKey].analysis;
  }

  const cleanedCode = functionCode.replace(/`/g, '\\`').trim();

  try {
    logVerbose(`[${functionName}] Sending request to Claude...`);
    logVerbose('API Key:', process.env.ANTHROPIC_API_KEY ? 'Present' : 'Missing');

    const requestPayload = {
      model: 'claude-3-sonnet-20240229',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are a code analysis tool that responds only with valid JSON. Your responses must:
1. Start with { and end with }
2. Use double quotes for all strings
3. Use true/false (not strings) for booleans
4. Have no trailing commas
5. Include no comments or additional text
6. Properly escape all special characters

Analyze this async function for parallelization opportunities. Respond with a JSON object containing:
{
  "functionName": "${functionName}",
  "isParallelizable": boolean,
  "parallelizableOperations": [
    {
      "type": "sequential|concurrent",
      "lines": [startLine, endLine],
      "operations": ["operation1", "operation2", ...],
      "suggestion": "description of optimization opportunity"
    }
  ],
  "dataFlow": "description of data dependencies",
  "optimizedCode": "optimized version with Promise.all if applicable"
}

Note that operations must be an array of strings representing each individual operation that can be parallelized.

Function to analyze:
\`\`\`javascript
${cleanedCode}
\`\`\``,
        },
      ],
    };

    logVerbose('Request payload:', JSON.stringify(requestPayload, null, 2));

    const response = await anthropic.messages.create(requestPayload);
    logVerbose('Response received:', response);

    let result = response.content[0].text;
    logVerbose('Raw result:', result);

    // Clean up the response
    result = result.trim();
    if (!result.startsWith('{')) {
      result = result.substring(result.indexOf('{'));
    }
    if (!result.endsWith('}')) {
      result = result.substring(0, result.lastIndexOf('}') + 1);
    }

    logVerbose('Cleaned result:', result);

    // Convert string booleans to actual booleans
    result = result.replace(/"isParallelizable"\s*:\s*"(true|false)"/g, '"isParallelizable": $1');

    // Parse and validate
    const parsed = JSON.parse(result);
    logVerbose('Parsed result:', parsed);

    // Validate required properties and types
    if (typeof parsed.isParallelizable !== 'boolean') {
      throw new Error(
        `Invalid type for isParallelizable: expected boolean, got ${typeof parsed.isParallelizable}`
      );
    }
    if (!Array.isArray(parsed.parallelizableOperations)) {
      throw new Error('parallelizableOperations must be an array');
    }

    // Validate each operation in parallelizableOperations
    parsed.parallelizableOperations.forEach((op, index) => {
      if (!Array.isArray(op.operations)) {
        throw new Error(`operations in parallelizableOperations[${index}] must be an array`);
      }
      if (!Array.isArray(op.lines) || op.lines.length !== 2) {
        throw new Error(`lines in parallelizableOperations[${index}] must be an array of length 2`);
      }
      if (typeof op.type !== 'string') {
        throw new Error(`type in parallelizableOperations[${index}] must be a string`);
      }
    });

    // Ensure optimizedCode is present if the function is parallelizable
    if (
      parsed.isParallelizable &&
      (!parsed.optimizedCode || typeof parsed.optimizedCode !== 'string')
    ) {
      console.warn(
        `[${functionName}] Warning: Function is parallelizable but no optimized code provided. Generating default optimization.`
      );
      // Generate a basic optimization if none is provided
      parsed.optimizedCode = generateDefaultOptimization(
        functionName,
        parsed.parallelizableOperations,
        cleanedCode
      );
    }

    return parsed;
  } catch (error) {
    console.error(`[${functionName}] Claude analysis failed:`, error);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      console.error('Request:', error.request);
    }
    console.error('Error stack:', error.stack);
    throw error;
  }
}

async function runTest(fn, ...args) {
  const start = Date.now();
  const result = await fn(...args);
  const duration = Date.now() - start;
  return {
    result,
    duration,
  };
}

const original = {
  async loadDashboardData(userId) {
    const [userData, userProducts, userAnalytics] = await Promise.all([
      fetchUserData(userId),
      fetchUserProducts(userId),
      fetchUserAnalytics(userId),
    ]);
    return {
      userData,
      products: userProducts,
      analytics: userAnalytics,
      lastUpdated: new Date(),
    };
  },
  async processUserList(userIds) {
    const results = await Promise.all(
      userIds.map(async (id) => {
        const userData = await fetchUserData(id);
        return userData;
      })
    );
    return results;
  },
  async createUserAndNotify(userData) {
    const [user, preferences] = await Promise.all([
      createUser(userData),
      fetchDefaultPreferences(),
    ]);
    const welcomeTemplate = await fetchWelcomeTemplate();
    user.preferences = preferences;
    await sendWelcomeEmail(user.email, welcomeTemplate, preferences);
    return user;
  },
};

async function applyOptimizations(analysisResults) {
  console.log('\n=== Applying Optimizations ===\n');
  const sourceFile = new URL(import.meta.url).pathname;
  const sourceCode = await fs.readFile(sourceFile, 'utf8');
  const ast = parse(sourceCode, {
    ecmaVersion: 2022,
    sourceType: 'module',
    range: true,
    loc: true,
  });
  let hasChanges = false;
  for (const [name, analysis] of Object.entries(analysisResults)) {
    if (!analysis.isParallelizable) {
      console.log(`Skipping ${name} - not parallelizable`);
      continue;
    }
    console.log(`Applying optimizations for ${name}...`);
    const functionNode = findFunctionNode(ast, name);
    if (!functionNode) {
      console.error(`Could not find function ${name} in source`);
      continue;
    }
    try {
      const code = analysis.optimizedCode;
      const bodyStart = code.indexOf('{') + 1;
      const bodyEnd = code.lastIndexOf('}');
      const functionBody = code.slice(bodyStart, bodyEnd).trim();
      const tempAst = parse(`async function temp() { ${functionBody} }`, {
        ecmaVersion: 2022,
        sourceType: 'module',
      });
      functionNode.body = tempAst.body[0].body;
      hasChanges = true;
    } catch (error) {
      console.error(`Failed to apply optimization for ${name}:`, error);
    }
  }
  if (hasChanges) {
    const optimizedCode = generate(ast);
    await fsPromises.writeFile(sourceFile, optimizedCode);
    console.log('\nOptimizations applied successfully!');
  } else {
    console.log('\nNo optimizations were applied.');
  }
}

function findFunctionNode(ast, functionName) {
  let result = null;
  function visit(node) {
    if (
      node.type === 'Property' &&
      node.key.name === functionName &&
      node.value.type === 'FunctionExpression'
    ) {
      result = node.value;
      return;
    }
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        visit(node[key]);
      }
    }
  }
  visit(ast);
  return result;
}

async function findSourceFiles(packagesDir) {
  const sourceFiles = [];
  const packages = await fsPromises.readdir(packagesDir);

  for (const pkg of packages) {
    // Skip specified packages
    if (SKIP_PACKAGES.has(pkg)) {
      console.log(`Skipping package: ${pkg}`);
      continue;
    }

    const srcDir = path.join(packagesDir, pkg, 'src');
    try {
      await fsPromises.access(srcDir);
      const files = await findFiles(srcDir);
      sourceFiles.push(...files);
    } catch (error) {
      // Skip if src directory doesn't exist
      continue;
    }
  }

  return sourceFiles;
}

async function findFiles(dir) {
  const files = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await findFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function extractAsyncFunctions(filePath) {
  try {
    const sourceCode = await fsPromises.readFile(filePath, 'utf8');
    let ast;

    try {
      // Enhanced parsing configuration for TypeScript
      const parserOptions = {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        plugins: [],
      };

      // Add appropriate plugins based on file extension
      if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        parserOptions.plugins.push('typescript');
        if (filePath.endsWith('.tsx')) {
          parserOptions.plugins.push('jsx');
        }
      } else if (filePath.endsWith('.jsx')) {
        parserOptions.plugins.push('jsx');
      }

      ast = parse(sourceCode, parserOptions);
    } catch (error) {
      // Log the error but continue processing other files
      console.warn(`Warning: Failed to parse ${filePath}: ${error.message}`);
      return {
        functions: [],
        success: false,
        error: error.message,
      };
    }

    const asyncFunctions = [];
    const visited = new WeakSet();

    function visit(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);

      try {
        if (
          (node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression') &&
          node.async
        ) {
          // Skip if range information is invalid
          if (
            !node.range ||
            node.range.length !== 2 ||
            node.range[0] === undefined ||
            node.range[1] === undefined
          ) {
            console.warn(`Warning: Invalid range information for function in ${filePath}`);
            return;
          }

          const code = sourceCode.slice(node.range[0], node.range[1]);
          const name = node.id?.name || 'anonymous';

          // Analyze the function body for potential parallel operations
          const parallelOps = node.body ? analyzeASTForParallelization(node.body, sourceCode) : [];

          asyncFunctions.push({
            name,
            code,
            filePath,
            range: node.range,
            loc: node.loc,
            astAnalysis: {
              isParallelizable: parallelOps.length > 0,
              parallelizableOperations: parallelOps,
            },
          });
        }
      } catch (error) {
        // If a specific node processing fails, log and continue
        console.warn(`Warning: Error processing async function in ${filePath}: ${error.message}`);
      }

      // Traverse child nodes safely
      for (const key in node) {
        if (node[key] && typeof node[key] === 'object' && key !== 'parent') {
          try {
            visit(node[key]);
          } catch (error) {
            // Skip problematic nodes
            console.warn(`Warning: Error traversing node ${key} in ${filePath}: ${error.message}`);
          }
        }
      }
    }

    visit(ast);
    return asyncFunctions;
  } catch (error) {
    console.warn(`Error processing ${filePath}: ${error.message}`);
    return {
      functions: [],
      success: false,
      error: error.message,
    };
  }
}

// Improved AST analysis with better error handling
function analyzeASTForParallelization(node, sourceCode) {
  if (!node) return [];

  const parallelOps = [];
  const awaitExpressions = [];
  const visited = new WeakSet();

  // Refined blacklisted terms that prevent parallelization
  const BLACKLISTED_TERMS = ['transaction', 'lock', 'mutex', 'semaphore'];

  // Helper to check if operation contains blacklisted terms
  function containsBlacklistedTerm(code) {
    return BLACKLISTED_TERMS.some((term) => code.toLowerCase().includes(term.toLowerCase()));
  }

  // Helper to check if nodes are in different branches
  function areInDifferentBranches(node1, node2) {
    let parent1 = node1;
    const parent2 = node2;

    // Safety check
    if (!parent1 || !parent2) return false;

    try {
      while (parent1) {
        if (parent1.type === 'IfStatement' || parent1.type === 'SwitchCase') {
          const branch1Parent = parent1;
          let temp = parent2;
          while (temp) {
            if (temp === branch1Parent) {
              return true; // Found common control flow parent
            }
            temp = temp.parent;
          }
        }
        parent1 = parent1.parent;
      }
    } catch (error) {
      // If any error occurs during branch analysis, assume they might be in different branches
      return true;
    }
    return false;
  }

  // Find all await expressions and Promise.all usage with improved safety
  function collectNodes(node) {
    if (!node || visited.has(node)) return;
    visited.add(node);

    try {
      if (node.type === 'AwaitExpression') {
        // Ensure node has a range before proceeding
        if (
          node.range &&
          node.range.length === 2 &&
          typeof node.range[0] === 'number' &&
          typeof node.range[1] === 'number'
        ) {
          // Skip if the await expression contains blacklisted terms
          const awaitCode = sourceCode.slice(node.range[0], node.range[1]);
          if (!containsBlacklistedTerm(awaitCode)) {
            awaitExpressions.push(node);
          }
        }
      }
    } catch (error) {
      // Skip this node if there's an error
      console.warn('Warning: Error analyzing await expression');
    }

    // Safely traverse children
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object' && key !== 'parent') {
        try {
          const child = node[key];
          if (child) {
            child.parent = node;
            collectNodes(child);
          }
        } catch (error) {
          // Skip problematic child nodes
        }
      }
    }
  }

  try {
    collectNodes(node);
  } catch (error) {
    console.warn('Warning: Error collecting nodes for analysis');
    return [];
  }

  // Group consecutive await expressions that could be parallelized
  let currentGroup = [];

  try {
    for (let i = 0; i < awaitExpressions.length; i++) {
      const awaitExpr = awaitExpressions[i];

      // Validate await expression has required properties
      if (!awaitExpr || !awaitExpr.argument || !awaitExpr.argument.range) {
        continue;
      }

      // Find the parent statement or declaration
      let parent = awaitExpr;
      let foundParent = false;
      while (parent && !foundParent) {
        if (
          parent.type === 'VariableDeclaration' ||
          parent.type === 'ExpressionStatement' ||
          parent.type === 'ReturnStatement'
        ) {
          foundParent = true;
        } else {
          parent = parent.parent;
        }
      }

      if (!parent) continue;

      if (currentGroup.length === 0) {
        currentGroup.push({ await: awaitExpr, parent });
        continue;
      }

      const lastExpr = currentGroup[currentGroup.length - 1];

      // Skip if either has invalid properties
      if (
        !lastExpr.await ||
        !lastExpr.parent ||
        !lastExpr.await.argument ||
        !lastExpr.await.argument.range
      ) {
        currentGroup = [{ await: awaitExpr, parent }];
        continue;
      }

      // Check for dependencies between awaits with less restrictive criteria
      const hasComplexDeps = hasComplexDependencies(
        lastExpr.parent,
        parent,
        lastExpr.await,
        awaitExpr,
        sourceCode
      );
      const inDifferentBranches = areInDifferentBranches(lastExpr.await, awaitExpr);

      if (!hasComplexDeps && !inDifferentBranches) {
        currentGroup.push({ await: awaitExpr, parent });
      } else if (currentGroup.length > 1) {
        // If we have a group of parallelizable operations, add them
        const operations = [];

        // Safely extract operations
        for (const item of currentGroup) {
          if (item.await && item.await.argument && item.await.argument.range) {
            const operation = sourceCode.slice(
              item.await.argument.range[0],
              item.await.argument.range[1]
            );
            operations.push(operation);
          }
        }

        // Validate we have valid operations and location data
        if (
          operations.length > 1 &&
          currentGroup[0].await &&
          currentGroup[0].await.loc &&
          currentGroup[currentGroup.length - 1].await &&
          currentGroup[currentGroup.length - 1].await.loc
        ) {
          // Only add if none of the operations contain blacklisted terms
          if (!operations.some(containsBlacklistedTerm)) {
            parallelOps.push({
              type: 'sequential',
              lines: [
                currentGroup[0].await.loc.start.line,
                currentGroup[currentGroup.length - 1].await.loc.end.line,
              ],
              operations,
              suggestion: 'These sequential operations can be parallelized with Promise.all',
            });
          }
        }

        currentGroup = [{ await: awaitExpr, parent }];
      } else {
        currentGroup = [{ await: awaitExpr, parent }];
      }
    }
  } catch (error) {
    console.warn('Warning: Error analyzing parallel operations');
  }

  // Handle any remaining group
  try {
    if (currentGroup.length > 1) {
      const operations = [];

      // Safely extract operations
      for (const item of currentGroup) {
        if (item.await && item.await.argument && item.await.argument.range) {
          const operation = sourceCode.slice(
            item.await.argument.range[0],
            item.await.argument.range[1]
          );
          operations.push(operation);
        }
      }

      // Validate we have valid operations and location data
      if (
        operations.length > 1 &&
        currentGroup[0].await &&
        currentGroup[0].await.loc &&
        currentGroup[currentGroup.length - 1].await &&
        currentGroup[currentGroup.length - 1].await.loc
      ) {
        // Only add if none of the operations contain blacklisted terms
        if (!operations.some(containsBlacklistedTerm)) {
          parallelOps.push({
            type: 'sequential',
            lines: [
              currentGroup[0].await.loc.start.line,
              currentGroup[currentGroup.length - 1].await.loc.end.line,
            ],
            operations,
            suggestion: 'These sequential operations can be parallelized with Promise.all',
          });
        }
      }
    }
  } catch (error) {
    console.warn('Warning: Error handling remaining operations');
  }

  return parallelOps;
}

function hasComplexDependencies(startNode, endNode, awaitExpr1, awaitExpr2, sourceCode) {
  const inBetweenCode = sourceCode.slice(startNode.range[1], endNode.range[0]);

  // Get the variable names being assigned to
  const assignedVars = new Set();
  if (startNode.type === 'VariableDeclaration') {
    startNode.declarations.forEach((decl) => {
      if (decl.id.type === 'Identifier') {
        assignedVars.add(decl.id.name);
      } else if (decl.id.type === 'ObjectPattern') {
        // Handle destructuring assignments
        decl.id.properties.forEach((prop) => {
          if (prop.value && prop.value.type === 'Identifier') {
            assignedVars.add(prop.value.name);
          }
        });
      }
    });
  }

  // Get variables used in the second await
  const usedVars = new Set();
  const identifierVisited = new WeakSet();
  function collectIdentifiers(node) {
    if (!node || identifierVisited.has(node)) return;
    identifierVisited.add(node);

    if (node.type === 'Identifier') {
      usedVars.add(node.name);
    }
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object' && key !== 'parent') {
        collectIdentifiers(node[key]);
      }
    }
  }
  collectIdentifiers(awaitExpr2.argument);

  // Check for actual dependencies between awaits
  const hasDependency = Array.from(assignedVars).some((v) => usedVars.has(v));

  // Only consider assignments complex if they involve function calls that aren't simple
  const hasComplexAssignment =
    startNode.type === 'VariableDeclaration' &&
    startNode.declarations.some(
      (decl) =>
        decl.init?.type === 'CallExpression' && decl.init?.callee?.type !== 'MemberExpression'
    );

  // Simplify control flow detection - only consider certain patterns as disruptive
  const hasComplexControlFlow = /\b(if|for|while|switch)\s*\([^)]*\).*\{[^}]*await/.test(
    inBetweenCode
  );

  // Only consider method calls that might have observable side effects
  const potentiallyUnsafePatterns = [
    'write',
    'delete',
    'remove',
    'update',
    'create',
    'insert',
    'save',
    'modify',
  ];

  const hasPotentiallyUnsafeCalls =
    potentiallyUnsafePatterns.some((pattern) => inBetweenCode.toLowerCase().includes(pattern)) &&
    inBetweenCode.includes('(') &&
    !inBetweenCode.includes('Promise.all');

  return (
    hasDependency || hasComplexAssignment || hasComplexControlFlow || hasPotentiallyUnsafeCalls
  );
}

async function applyOptimizationToFile(filePath, functionInfo, optimizedCode) {
  try {
    // Validate inputs
    if (!filePath || !functionInfo || !optimizedCode) {
      throw new Error('Missing required parameters for optimization');
    }

    // Read the source file
    let sourceCode;
    try {
      sourceCode = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read source file ${filePath}: ${error.message}`);
    }

    let start = 0;
    let end = sourceCode.length;

    // Try to use range information if it exists and is valid
    if (
      functionInfo.range &&
      Array.isArray(functionInfo.range) &&
      functionInfo.range.length === 2
    ) {
      const [rangeStart, rangeEnd] = functionInfo.range;

      // Validate range bounds
      if (rangeStart >= 0 && rangeEnd <= sourceCode.length && rangeStart < rangeEnd) {
        start = rangeStart;
        end = rangeEnd;
      } else {
        logVerbose(
          `Warning: Range [${rangeStart}, ${rangeEnd}] is out of bounds for file of length ${sourceCode.length}`
        );
        // We'll find the function by content below
      }
    } else {
      logVerbose(
        `Range information missing or invalid for ${functionInfo.name}. Will attempt to find by content.`
      );
    }

    // Verify the original code matches at the specified range
    const originalRangeCode = sourceCode.slice(start, end);
    let matchFound = originalRangeCode.trim() === functionInfo.code.trim();

    // If the range doesn't match the expected code, try to find the function in the file
    if (!matchFound) {
      logVerbose(
        `Original code at range does not match function info for ${functionInfo.name}. Searching for function...`
      );

      // Escape special regex characters in function code
      const escapedFunctionCode = functionInfo.code
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+'); // Allow for whitespace differences

      // Create a regex pattern that can match the function even with whitespace differences
      const functionPattern = new RegExp(escapedFunctionCode, 'g');
      const match = functionPattern.exec(sourceCode);

      if (match) {
        start = match.index;
        end = start + match[0].length;
        matchFound = true;
        logVerbose(`Found function ${functionInfo.name} at position ${start}-${end}`);
      } else {
        // Try to find by function name if the exact code doesn't match
        const namePattern = new RegExp(
          `(async\\s+function\\s+${functionInfo.name}\\s*\\(|${functionInfo.name}\\s*:\\s*async\\s+function\\s*\\(|${functionInfo.name}\\s*=\\s*async\\s*\\()`,
          'g'
        );
        const nameMatch = namePattern.exec(sourceCode);

        if (nameMatch) {
          // Found the function declaration, now try to find the matching closing brace
          let openBraces = 0;
          let inString = false;
          let stringChar = '';
          let pos = nameMatch.index;

          while (pos < sourceCode.length) {
            if (!inString) {
              if (sourceCode[pos] === '{') {
                openBraces++;
              } else if (sourceCode[pos] === '}') {
                openBraces--;
                if (openBraces === 0) {
                  // We've found the end of the function
                  end = pos + 1;
                  start = nameMatch.index;
                  matchFound = true;
                  logVerbose(
                    `Found function ${functionInfo.name} by name at position ${start}-${end}`
                  );
                  break;
                }
              } else if (
                sourceCode[pos] === '"' ||
                sourceCode[pos] === "'" ||
                sourceCode[pos] === '`'
              ) {
                inString = true;
                stringChar = sourceCode[pos];
              }
            } else {
              if (sourceCode[pos] === stringChar && sourceCode[pos - 1] !== '\\') {
                inString = false;
              }
            }
            pos++;
          }
        }
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find function ${functionInfo.name} in source code`);
    }

    // Clean up the optimized code
    const cleanedOptimizedCode = optimizedCode
      .replace(/^\s*async\s+function\s+[^(]*/, '') // Remove function declaration if present
      .replace(/^\s*\(/, '(') // Clean up leading whitespace
      .trim();

    // Create the new code
    const newCode = sourceCode.slice(0, start) + cleanedOptimizedCode + sourceCode.slice(end);

    // Skip validation for now
    /*
    // Validate the new code
    try {
      parse(newCode, {
        ecmaVersion: 2022,
        sourceType: 'module',
        plugins: ['typescript'] // Add TypeScript plugin for TS files
      });
    } catch (error) {
      logVerbose(`Generated code validation failed: ${error.message}`);
      // Try parsing as TypeScript if the file has a .ts extension
      if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        try {
          parse(newCode, {
            ecmaVersion: 2022,
            sourceType: 'module',
            plugins: ['typescript', 'jsx']
          });
        } catch (tsError) {
          throw new Error(`Generated code is invalid for TypeScript: ${tsError.message}`);
        }
      } else {
        throw new Error(`Generated code is invalid: ${error.message}`);
      }
    }
    */

    // Create a backup of the original file
    const backupPath = `${filePath}.backup`;
    await fsPromises.writeFile(backupPath, sourceCode);

    // Write the new code
    try {
      await fsPromises.writeFile(filePath, newCode);
      logVerbose(`Successfully optimized ${functionInfo.name} in ${filePath}`);
      logVerbose(`Backup saved to ${backupPath}`);
      console.log(`✅ Successfully optimized ${functionInfo.name}`);
    } catch (error) {
      // Try to restore from backup if write fails
      console.error(`Failed to write optimized code: ${error.message}`);
      logVerbose('Attempting to restore from backup...');
      await fs.copyFile(backupPath, filePath);
      throw new Error(`Failed to write optimized code: ${error.message}`);
    }
  } catch (error) {
    throw new Error(`Failed to apply optimization to ${filePath}: ${error.message}`);
  }
}

async function loadStageResults(stage) {
  const cachePath = getStageCachePath(stage);
  if (existsSync(cachePath)) {
    const content = await fsPromises.readFile(cachePath, 'utf8');
    return JSON.parse(content);
  }
  return null;
}

async function saveStageResults(stage, results) {
  const cachePath = getStageCachePath(stage);
  await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
  await fsPromises.writeFile(cachePath, JSON.stringify(results, getCircularReplacer(), 2));
}

async function saveInitialCandidates(parseResults) {
  const candidates = [];

  // Ensure parseResults.asyncFunctions exists and is an array
  if (!parseResults.asyncFunctions || !Array.isArray(parseResults.asyncFunctions)) {
    console.warn('Warning: parseResults.asyncFunctions is missing or not an array');
    return [];
  }

  for (const fn of parseResults.asyncFunctions) {
    const candidateInfo = {
      name: fn.name,
      file: fn.relativePath,
      lines: `${fn.loc.start.line}-${fn.loc.end.line}`,
      ast_parallelizable: fn.astAnalysis.isParallelizable,
      parallelizable_functions: [],
      parallelizable_operations: [],
    };

    if (fn.astAnalysis.isParallelizable) {
      const parallelOps = fn.astAnalysis.parallelizableOperations
        .filter((op) => op.type === 'independent')
        .map((op) => ({
          operations: op.operations,
          lines: `${op.lines[0]}-${op.lines[1]}`,
        }));

      if (parallelOps.length > 0) {
        candidateInfo.parallelizable_operations = parallelOps.map((op) => ({
          lines: op.lines,
          operations: op.operations,
          potential_parallel_calls: op.operations.map((call) => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            return match ? match[1] : call;
          }),
        }));

        // Extract unique function names from parallel operations
        const functionNames = new Set();
        parallelOps.forEach((op) => {
          op.operations.forEach((call) => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            if (match) functionNames.add(match[1]);
          });
        });
        candidateInfo.parallelizable_functions = Array.from(functionNames);
      }
    }

    candidates.push(candidateInfo);
  }

  // Create directory if it doesn't exist
  await fsPromises.mkdir(path.dirname(TRACKING_FILES.CANDIDATES), { recursive: true });
  await fsPromises.writeFile(TRACKING_FILES.CANDIDATES, JSON.stringify(candidates, null, 2));
  console.log(
    `\nSaved ${candidates.length} candidates (${candidates.filter((c) => c.ast_parallelizable).length} parallelizable from AST analysis)`
  );
  return candidates;
}

async function saveInitialResults(parseResults) {
  const results = [];

  for (const fn of parseResults.asyncFunctions) {
    if (fn.astAnalysis.isParallelizable) {
      const originalOps = fn.astAnalysis.parallelizableOperations.map((op) => ({
        type: op.type,
        original_lines: `${op.lines[0]}-${op.lines[1]}`,
        sequential_calls: op.operations.map((call) => call.replace(/\(.*\)/, '()')),
        optimization: 'Potential candidate for Promise.all parallelization',
      }));

      results.push({
        name: fn.name,
        file: fn.relativePath,
        lines: `${fn.loc.start.line}-${fn.loc.end.line}`,
        original_implementation: {
          sequential_operations: originalOps,
        },
        optimized_implementation: {
          parallel_operations: originalOps
            .filter((op) => op.type === 'independent')
            .map((op) => ({
              functions: op.sequential_calls,
              optimization_applied: 'Candidate for Promise.all',
            })),
          remaining_sequential: [],
        },
        ast_analysis_only: true, // Flag to indicate this is from AST analysis only
      });
    }
  }

  // Create directory if it doesn't exist
  await fsPromises.mkdir(path.dirname(TRACKING_FILES.RESULTS), { recursive: true });
  await fsPromises.writeFile(TRACKING_FILES.RESULTS, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} initial results from AST analysis`);
  return results;
}

async function parseAllPackages(packagesDir) {
  const existingResults = await loadStageResults('PARSE');
  if (existingResults) {
    console.log('\nFound existing parse results, skipping parse stage...');
    return existingResults;
  }

  console.log('\n=== Finding Source Files ===\n');
  const sourceFiles = await findSourceFiles(packagesDir);
  console.log(`Found ${sourceFiles.length} source files to process`);

  console.log('\n=== Extracting and Analyzing Async Functions ===\n');
  const parseResults = {
    timestamp: new Date().toISOString(),
    sourceFiles,
    asyncFunctions: [],
    errors: [],
  };

  let totalAsyncFunctions = 0;
  let totalParallelizable = 0;
  let totalSkipped = 0;
  let totalProcessed = 0;

  for (const filePath of sourceFiles) {
    try {
      const functions = await extractAsyncFunctions(filePath);
      const relativePath = path.relative(packagesDir, filePath);

      if (functions.length === 0) {
        // Could be empty or parsing failed
        totalSkipped++;
        continue;
      }

      const functionsWithPath = functions.map((fn) => ({
        ...fn,
        relativePath,
      }));

      parseResults.asyncFunctions.push(...functionsWithPath);

      const parallelizableFns = functions.filter((fn) => fn.astAnalysis.isParallelizable);
      totalAsyncFunctions += functions.length;
      totalParallelizable += parallelizableFns.length;
      totalProcessed++;

      if (functions.length > 0) {
        console.log(
          `${relativePath}: ${functions.length} async functions ` +
            `(${parallelizableFns.length} potentially parallelizable)`
        );

        // Only log details for parallelizable functions if verbose logging is enabled
        if (VERBOSE_LOGGING) {
          for (const fn of parallelizableFns) {
            console.log(`\n  Function: ${fn.name}`);
            for (const op of fn.astAnalysis.parallelizableOperations) {
              console.log(`    Lines ${op.lines[0]}-${op.lines[1]}:`);
              console.log(`    Operations:`, op.operations);
            }
          }
        }
      }
    } catch (error) {
      parseResults.errors.push({
        file: filePath,
        error: error.message,
      });
      console.error(`Error processing ${filePath}:`, error);
    }
  }

  // Save both candidates and results based on AST analysis
  await saveInitialCandidates(parseResults);
  await saveInitialResults(parseResults);

  console.log('\n=== AST Analysis Summary ===');
  console.log(`Total source files: ${sourceFiles.length}`);
  console.log(`Files processed successfully: ${totalProcessed}`);
  console.log(`Files skipped/failed parsing: ${totalSkipped}`);
  console.log(`Total async functions found: ${totalAsyncFunctions}`);
  console.log(`Potentially parallelizable: ${totalParallelizable}`);
  console.log(`Errors encountered: ${parseResults.errors.length}`);

  await saveStageResults('PARSE', parseResults);
  return parseResults;
}

async function analyzeWithAI(parseResults) {
  // Initialize cache at the start
  await initializeCache();

  // Update total functions in metadata
  analysisCache.metadata.totalFunctions = parseResults.asyncFunctions.length;

  logVerbose('\n=== Analyzing Functions with Claude ===\n');
  const queue = new AsyncQueue(10);

  // Only analyze functions that aren't in cache
  const functionsToAnalyze = parseResults.asyncFunctions.filter((fn) => {
    const hash = generateFunctionHash(fn.code);
    return !analysisCache.functions[hash];
  });

  console.log(`Found ${functionsToAnalyze.length} new functions to analyze`);
  queue.setTotal(functionsToAnalyze.length);

  const analysisResults = {
    timestamp: new Date().toISOString(),
    parseTimestamp: parseResults.timestamp,
    results: {},
    errors: [],
    parallelizableFunctions: new Set(), // Track parallelizable functions
  };

  // First, load all cached results
  for (const fn of parseResults.asyncFunctions) {
    const hash = generateFunctionHash(fn.code);
    if (analysisCache.functions[hash]) {
      const cachedAnalysis = analysisCache.functions[hash].analysis;
      if (cachedAnalysis) {
        const key = `${fn.filePath}:${fn.name}`;
        analysisResults.results[key] = cachedAnalysis;
        analysisResults.results[key].sourceInfo = fn;

        // Track parallelizable functions from cache
        if (cachedAnalysis.isParallelizable) {
          analysisResults.parallelizableFunctions.add(key);
        }

        // Update tracking files for cached results
        await updateCandidates(fn, cachedAnalysis);
        await updateResults(fn, cachedAnalysis);
      }
    }
  }

  // Then analyze new functions
  const analysisPromises = functionsToAnalyze.map((fn) =>
    queue.add(async () => {
      try {
        const analysis = await analyzeWithClaude(fn.code, fn.name);
        if (!analysis) {
          analysisResults.errors.push({
            function: fn.name,
            file: fn.filePath,
            error: 'Claude analysis failed',
          });
          return;
        }

        // Update cache with new analysis
        await updateCache(fn, analysis);

        analysis.sourceInfo = fn;
        const key = `${fn.filePath}:${fn.name}`;
        analysisResults.results[key] = analysis;

        // Track parallelizable functions
        if (analysis.isParallelizable && analysis.parallelizableOperations?.length > 0) {
          analysisResults.parallelizableFunctions.add(key);
        }

        // Update tracking files
        await updateCandidates(fn, analysis);
        await updateResults(fn, analysis);

        // Log results for new analyses
        if (analysis.isParallelizable && analysis.parallelizableOperations?.length > 0) {
          logVerbose(`\n[${fn.name}] Analysis Results:`);
          logVerbose(`[${fn.name}] Parallelizable: true`);
          logVerbose(`[${fn.name}] Parallelizable Operations:`);
          analysis.parallelizableOperations.forEach((op) => {
            logVerbose(`[${fn.name}] - Type: ${op.type}`);
            logVerbose(`[${fn.name}]   Lines: ${op.lines.join('-')}`);
            logVerbose(`[${fn.name}]   Operations:`, op.operations);
            logVerbose(`[${fn.name}]   Suggestion: ${op.suggestion}`);
          });
        }
      } catch (error) {
        console.error(`[${fn.name}] Analysis error:`, error);
        analysisResults.errors.push({
          function: fn.name,
          file: fn.filePath,
          error: error.message || 'Unknown error',
        });
      }
    })
  );

  await Promise.all(analysisPromises);

  // Save results
  await saveStageResults('ANALYSIS', analysisResults);

  console.log('\n=== Analysis Summary ===');
  console.log(`Total functions analyzed: ${Object.keys(analysisResults.results).length}`);
  console.log(`Parallelizable functions found: ${analysisResults.parallelizableFunctions.size}`);
  console.log(`Errors encountered: ${analysisResults.errors.length}`);

  if (analysisResults.parallelizableFunctions.size > 0) {
    console.log('\nParallelizable Functions:');

    // Display each parallelizable function
    for (const key of analysisResults.parallelizableFunctions) {
      const analysis = analysisResults.results[key];
      console.log(`\n${key}:`);
      analysis.parallelizableOperations.forEach((op) => {
        console.log(`  - Type: ${op.type}`);
        console.log(`    Lines: ${op.lines.join('-')}`);
        console.log(`    Operations: ${op.operations.join(', ')}`);
      });
    }
  }

  return analysisResults;
}

async function generateOptimizations(analysisResults) {
  // Try to load existing final results
  const existingResults = await loadStageResults('FINAL');
  if (existingResults && !shouldApply) {
    logVerbose('\nFound existing final results, skipping optimization stage...');
    return existingResults;
  }

  const finalResults = {
    timestamp: new Date().toISOString(),
    analysisTimestamp: analysisResults.timestamp,
    optimizations: {},
    errors: [],
  };

  logVerbose('\n=== Applying Optimizations ===\n');
  console.log('\nApplying optimizations...');

  // Track statistics
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  // Debug: Log the parallelizable functions
  console.log('Parallelizable functions:', analysisResults.parallelizableFunctions);

  for (const [key, analysis] of Object.entries(analysisResults.results)) {
    // Check if the function is in the parallelizableFunctions set
    const isParallelizable = analysisResults.parallelizableFunctions.has(key);

    // Update the analysis object with the correct isParallelizable value
    analysis.isParallelizable = isParallelizable;

    if (
      !isParallelizable ||
      !analysis.parallelizableOperations ||
      analysis.parallelizableOperations.length === 0
    ) {
      console.log(`Skipping ${key} - not parallelizable or no operations`);
      skippedCount++;
      continue;
    }

    const { sourceInfo } = analysis;
    if (!sourceInfo || !sourceInfo.filePath || !sourceInfo.name) {
      console.warn(`Skipping invalid analysis result for ${key}`);
      skippedCount++;
      continue;
    }

    logVerbose(`\nApplying optimizations for ${sourceInfo.name} in ${sourceInfo.relativePath}...`);

    // Ensure we have optimized code
    if (!analysis.optimizedCode || typeof analysis.optimizedCode !== 'string') {
      logVerbose(`Generating default optimization for ${sourceInfo.name}`);
      analysis.optimizedCode = generateDefaultOptimization(
        sourceInfo.name,
        analysis.parallelizableOperations,
        sourceInfo.code
      );
    }

    try {
      await applyOptimizationToFile(sourceInfo.filePath, sourceInfo, analysis.optimizedCode);
      finalResults.optimizations[key] = {
        timestamp: new Date().toISOString(),
        sourceInfo: {
          name: sourceInfo.name,
          filePath: sourceInfo.filePath,
          relativePath: sourceInfo.relativePath,
        },
        operations: analysis.parallelizableOperations,
      };
      successCount++;
      logVerbose(`Successfully optimized ${sourceInfo.name}`);
    } catch (error) {
      console.error(`Error applying optimization to ${sourceInfo.name}:`, error);
      finalResults.errors.push({
        key,
        error: error.message,
      });
      errorCount++;
    }
  }

  // Save final results
  await saveStageResults('FINAL', finalResults);

  console.log('\n=== Optimization Summary ===');
  console.log(`Optimized: ${successCount} functions`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Skipped: ${skippedCount}`);

  return finalResults;
}

// Add function to update candidates with AI analysis results
async function updateCandidates(fn, analysis) {
  try {
    let candidates = [];
    try {
      const content = await fs.readFile(TRACKING_FILES.CANDIDATES, 'utf8');
      candidates = JSON.parse(content);
    } catch (error) {
      // If file doesn't exist or is invalid, start with empty array
    }

    // Get line information safely
    const lines = fn.loc ? `${fn.loc.start.line}-${fn.loc.end.line}` : 'unknown';

    // Find the existing candidate or create a new one
    let candidate = candidates.find((c) => c.name === fn.name && c.file === fn.relativePath);
    if (!candidate) {
      candidate = {
        name: fn.name,
        file: fn.relativePath,
        lines,
        ast_parallelizable: fn.astAnalysis?.isParallelizable || false,
        ai_parallelizable: false,
        parallelizable_functions: [],
        parallelizable_operations: [],
      };
      candidates.push(candidate);
    }

    // Update with AI analysis results
    if (analysis) {
      candidate.ai_parallelizable = analysis.isParallelizable;
      if (analysis.isParallelizable && analysis.parallelizableOperations) {
        candidate.parallelizable_operations = analysis.parallelizableOperations.map((op) => ({
          lines: op.lines ? `${op.lines[0]}-${op.lines[1]}` : 'unknown',
          operations: op.operations || [],
          suggestion: op.suggestion || '',
          potential_parallel_calls: (op.operations || []).map((call) => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            return match ? match[1] : call;
          }),
        }));

        // Extract unique function names from parallel operations
        const functionNames = new Set();
        analysis.parallelizableOperations.forEach((op) => {
          (op.operations || []).forEach((call) => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            if (match) functionNames.add(match[1]);
          });
        });
        candidate.parallelizable_functions = Array.from(functionNames);
      }
    }

    // Create directory if it doesn't exist
    await fsPromises.mkdir(path.dirname(TRACKING_FILES.CANDIDATES), { recursive: true });
    await fsPromises.writeFile(TRACKING_FILES.CANDIDATES, JSON.stringify(candidates, null, 2));
  } catch (error) {
    console.error('Error updating candidates:', error);
  }
}

// Add function to update results with AI analysis results
async function updateResults(fn, analysis) {
  try {
    let results = [];
    try {
      const content = await fsPromises.readFile(TRACKING_FILES.RESULTS, 'utf8');
      results = JSON.parse(content);
    } catch (error) {
      // If file doesn't exist or is invalid, start with empty array
    }

    // Get line information safely
    const lines = fn.loc ? `${fn.loc.start.line}-${fn.loc.end.line}` : 'unknown';

    // Find the existing result or create a new one
    let result = results.find((r) => r.name === fn.name && r.file === fn.relativePath);
    if (!result) {
      result = {
        name: fn.name,
        file: fn.relativePath,
        lines,
        original_implementation: {
          sequential_operations: [],
        },
        optimized_implementation: {
          parallel_operations: [],
          remaining_sequential: [],
        },
        ast_analysis_only: false,
      };
      results.push(result);
    }

    // Update with AI analysis results
    if (analysis) {
      result.ast_analysis_only = false;
      if (analysis.isParallelizable && analysis.parallelizableOperations) {
        result.optimized_implementation.parallel_operations = analysis.parallelizableOperations.map(
          (op) => ({
            type: op.type || 'independent',
            lines: op.lines ? `${op.lines[0]}-${op.lines[1]}` : 'unknown',
            operations: op.operations || [],
            suggestion: op.suggestion || '',
          })
        );
      }
      if (analysis.optimizedCode) {
        result.optimized_implementation.code = analysis.optimizedCode;
      }
    }

    // Create directory if it doesn't exist
    await fsPromises.mkdir(path.dirname(TRACKING_FILES.RESULTS), { recursive: true });
    await fsPromises.writeFile(TRACKING_FILES.RESULTS, JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Error updating results:', error);
  }
}

// Helper function to generate a basic optimization if Claude doesn't provide one
function generateDefaultOptimization(functionName, operations, originalCode) {
  try {
    // Extract the function declaration part (everything before the first '{')
    const functionDeclarationMatch = originalCode.match(/^(.*?)\{/s);
    const functionDeclaration = functionDeclarationMatch ? functionDeclarationMatch[1] : '';

    // Extract the return statement
    const returnMatch = originalCode.match(/\s*(return\s+[\s\S]*?;)/);
    const returnStatement = returnMatch ? returnMatch[1] : 'return;';

    // Group operations by their function name
    const groupedOperations = {};
    for (const op of operations) {
      if (!groupedOperations[op.functionName]) {
        groupedOperations[op.functionName] = [];
      }
      groupedOperations[op.functionName].push(op);
    }

    // Generate Promise.all for each group of operations
    let optimizedCode = '';

    for (const [funcName, ops] of Object.entries(groupedOperations)) {
      if (ops.length > 1) {
        // Create variable names for the results
        const varNames = ops.map((op, i) => {
          // Use the original variable name if available, otherwise generate a new one
          return op.variableName || `${op.variableName || 'result'}${i > 0 ? i : ''}`;
        });

        // Add a comment to indicate parallelized operations
        optimizedCode += '  // Parallelized operations\n';

        // Generate the Promise.all statement
        optimizedCode += `  const [${varNames.join(', ')}] = await Promise.all([\n`;
        for (const op of ops) {
          optimizedCode += `    ${op.functionName}(${op.args.join(', ')}),\n`;
        }
        optimizedCode += '  ]);\n\n';
      } else {
        // For single operations, keep them as is
        const op = ops[0];
        optimizedCode += `  const ${op.variableName} = await ${op.functionName}(${op.args.join(', ')});\n`;
      }
    }

    // Add the return statement
    optimizedCode += `  ${returnStatement}\n`;

    // Combine everything
    const finalCode = `${functionDeclaration}{\n${optimizedCode}}`;
    return finalCode;
  } catch (error) {
    console.error(`Error generating optimization for ${functionName}:`, error);
    return null;
  }
}

/**
 * Generates a markdown report of all optimization recommendations
 * @param {Object} analysisResults The results from Claude's analysis
 * @returns {string} Markdown formatted report
 */
async function generateMarkdownReport(analysisResults) {
  const reportParts = [];

  // Add report header
  reportParts.push('# Parallelization Optimization Report\n');
  reportParts.push(`Generated on: ${new Date().toLocaleString()}\n`);

  // Add summary
  reportParts.push('## Summary\n');
  reportParts.push(`- Total functions analyzed: ${Object.keys(analysisResults.results).length}`);
  reportParts.push(
    `- Parallelizable functions identified: ${analysisResults.parallelizableFunctions.size}`
  );
  reportParts.push(`- Errors encountered: ${analysisResults.errors.length}\n`);

  // If no parallelizable functions were found, note that
  if (analysisResults.parallelizableFunctions.size === 0) {
    reportParts.push('> No parallelizable functions were identified.');
    // Return early if there's nothing to report
    return reportParts.join('\n');
  }

  // Add detailed recommendations for each parallelizable function
  reportParts.push('## Detailed Recommendations\n');

  // Organize by files for a cleaner report
  const fileMap = {};

  for (const key of analysisResults.parallelizableFunctions) {
    const analysis = analysisResults.results[key];
    const { sourceInfo } = analysis;

    if (!sourceInfo || !sourceInfo.filePath) continue;

    // Group by file path
    if (!fileMap[sourceInfo.filePath]) {
      fileMap[sourceInfo.filePath] = [];
    }

    fileMap[sourceInfo.filePath].push({
      functionName: sourceInfo.name,
      analysis,
    });
  }

  // Now create markdown sections by file
  for (const [filePath, functions] of Object.entries(fileMap)) {
    // Get relative path for cleaner display
    const relativePath = filePath.includes(process.cwd())
      ? filePath.replace(process.cwd(), '').replace(/^\//, '')
      : filePath;

    reportParts.push(`### File: \`${relativePath}\`\n`);

    for (const { functionName, analysis } of functions) {
      reportParts.push(`#### Function: \`${functionName}\`\n`);

      // Add Claude's explanation
      if (analysis.dataFlow) {
        reportParts.push('**Analysis:**');
        reportParts.push(analysis.dataFlow);
        reportParts.push('');
      }

      // Add the parallelizable operations
      reportParts.push('**Parallelizable Operations:**\n');

      analysis.parallelizableOperations.forEach((op, index) => {
        reportParts.push(`${index + 1}. **Type:** ${op.type}`);
        reportParts.push(
          `   - **Lines:** ${op.lines && Array.isArray(op.lines) ? op.lines.join('-') : 'N/A'}`
        );
        reportParts.push(
          `   - **Operations:** ${op.operations && Array.isArray(op.operations) ? op.operations.join(', ') : 'N/A'}`
        );

        if (op.suggestion) {
          reportParts.push(`   - **Suggestion:** ${op.suggestion}`);
        }
        reportParts.push('');
      });

      // Add the optimized code section
      reportParts.push('**Recommended Implementation:**');
      reportParts.push('```javascript');
      reportParts.push(analysis.optimizedCode);
      reportParts.push('```\n');
    }
  }

  // Add error section if there were any errors
  if (analysisResults.errors.length > 0) {
    reportParts.push('## Errors\n');
    reportParts.push('The following errors were encountered during analysis:\n');

    analysisResults.errors.forEach((error, index) => {
      reportParts.push(`${index + 1}. Function: \`${error.function}\` in file \`${error.file}\``);
      reportParts.push(`   Error: ${error.error}\n`);
    });
  }

  return reportParts.join('\n');
}

/**
 * Uses regex-based analysis to find async functions and potential parallelization opportunities
 * This serves as a fallback when AST parsing fails or has issues
 * @param {string} filePath Path to the file to analyze
 * @returns {Object} Analysis results
 */
async function analyzeWithRegex(filePath) {
  try {
    logVerbose(`Analyzing ${filePath} with regex-based approach`);
    const code = await fsPromises.readFile(filePath, 'utf8');
    const relativeFilePath = path.relative(process.cwd(), filePath);

    // Find async functions
    const asyncFunctions = [];

    // Regular async function pattern - more permissive
    const asyncFnPattern =
      /async\s+function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)(?=\}\s*(?:\/\/|\/\*|$|\n\s*function|\n\s*async|\n\s*export|\n\s*const|\n\s*let|\n\s*var))/g;
    // Exported async function pattern - more permissive
    const asyncExportPattern =
      /export\s+async\s+function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)(?=\}\s*(?:\/\/|\/\*|$|\n\s*function|\n\s*async|\n\s*export|\n\s*const|\n\s*let|\n\s*var))/g;
    // Arrow async function pattern - more permissive
    const arrowAsyncPattern =
      /(?:const|let|var)?\s*(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)(?=\}\s*(?:\/\/|\/\*|$|\n\s*function|\n\s*async|\n\s*export|\n\s*const|\n\s*let|\n\s*var))/g;
    // Class method async pattern - more permissive
    const classMethodPattern =
      /async\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)(?=\}\s*(?:\/\/|\/\*|$|\n\s*function|\n\s*\}|\n\s*async|\n\s*[gs]et))/g;

    // Simpler patterns as fallbacks
    const simpleAsyncFnPattern = /async\s+function\s+(\w+)[^{]*\{([\s\S]*?)\}/g;
    const simpleExportAsyncFnPattern = /export\s+async\s+function\s+(\w+)[^{]*\{([\s\S]*?)\}/g;
    const simpleArrowAsyncPattern = /(\w+)\s*=\s*async[^{]*\{([\s\S]*?)\}/g;

    let match;

    // Find standard async functions
    while ((match = asyncFnPattern.exec(code)) !== null) {
      const fullMatch = match[0] + '}'; // Add closing brace
      const fnBody = match[2];
      const startLine = code.substring(0, match.index).split('\n').length;

      asyncFunctions.push({
        name: match[1],
        body: fnBody,
        start: match.index,
        end: match.index + fullMatch.length,
        startLine,
        type: 'standard',
        fullMatch,
      });
    }

    // Find exported async functions
    while ((match = asyncExportPattern.exec(code)) !== null) {
      const fullMatch = match[0] + '}'; // Add closing brace
      const fnBody = match[2];
      const startLine = code.substring(0, match.index).split('\n').length;

      asyncFunctions.push({
        name: match[1],
        body: fnBody,
        start: match.index,
        end: match.index + fullMatch.length,
        startLine,
        type: 'export',
        fullMatch,
      });
    }

    // Find arrow async functions
    while ((match = arrowAsyncPattern.exec(code)) !== null) {
      const fullMatch = match[0] + '}'; // Add closing brace
      const fnBody = match[2];
      const startLine = code.substring(0, match.index).split('\n').length;

      asyncFunctions.push({
        name: match[1],
        body: fnBody,
        start: match.index,
        end: match.index + fullMatch.length,
        startLine,
        type: 'arrow',
        fullMatch,
      });
    }

    // Find class method async functions
    while ((match = classMethodPattern.exec(code)) !== null) {
      const fullMatch = match[0] + '}'; // Add closing brace
      const fnBody = match[2];
      const startLine = code.substring(0, match.index).split('\n').length;

      asyncFunctions.push({
        name: match[1],
        body: fnBody,
        start: match.index,
        end: match.index + fullMatch.length,
        startLine,
        type: 'method',
        fullMatch,
      });
    }

    // Try simpler patterns if no functions found
    if (asyncFunctions.length === 0) {
      // Simple async function pattern
      while ((match = simpleAsyncFnPattern.exec(code)) !== null) {
        const fullMatch = match[0];
        const fnBody = match[2];
        const startLine = code.substring(0, match.index).split('\n').length;

        asyncFunctions.push({
          name: match[1],
          body: fnBody,
          start: match.index,
          end: match.index + fullMatch.length,
          startLine,
          type: 'standard-simple',
          fullMatch,
        });
      }

      // Simple exported async function pattern
      while ((match = simpleExportAsyncFnPattern.exec(code)) !== null) {
        const fullMatch = match[0];
        const fnBody = match[2];
        const startLine = code.substring(0, match.index).split('\n').length;

        asyncFunctions.push({
          name: match[1],
          body: fnBody,
          start: match.index,
          end: match.index + fullMatch.length,
          startLine,
          type: 'export-simple',
          fullMatch,
        });
      }

      // Simple arrow async function pattern
      while ((match = simpleArrowAsyncPattern.exec(code)) !== null) {
        const fullMatch = match[0];
        const fnBody = match[2];
        const startLine = code.substring(0, match.index).split('\n').length;

        asyncFunctions.push({
          name: match[1],
          body: fnBody,
          start: match.index,
          end: match.index + fullMatch.length,
          startLine,
          type: 'arrow-simple',
          fullMatch,
        });
      }
    }

    // If still no functions found, try a more aggressive approach
    if (asyncFunctions.length === 0) {
      console.log(
        'No async functions found with standard patterns, trying more aggressive approach'
      );

      // Find all async function declarations
      const allAsyncFunctions = code.match(/async\s+function\s+\w+[^{]*\{[\s\S]*?\}/g) || [];
      const allExportAsyncFunctions =
        code.match(/export\s+async\s+function\s+\w+[^{]*\{[\s\S]*?\}/g) || [];
      const allArrowAsyncFunctions = code.match(/\w+\s*=\s*async[^{]*\{[\s\S]*?\}/g) || [];

      // Process all found functions
      [...allAsyncFunctions, ...allExportAsyncFunctions, ...allArrowAsyncFunctions].forEach(
        (fnText) => {
          let name = 'unknown';
          let type = 'unknown';

          // Try to extract name
          const nameMatch = fnText.match(
            /(?:async\s+function\s+|export\s+async\s+function\s+|^|=\s*async[^(]*\()(\w+)/
          );
          if (nameMatch && nameMatch[1]) {
            name = nameMatch[1];
          }

          // Determine type
          if (fnText.startsWith('export')) {
            type = 'export-aggressive';
          } else if (fnText.includes('=')) {
            type = 'arrow-aggressive';
          } else {
            type = 'standard-aggressive';
          }

          // Extract body
          const bodyMatch = fnText.match(/\{([\s\S]*)\}/);
          const body = bodyMatch ? bodyMatch[1] : '';

          asyncFunctions.push({
            name,
            body,
            start: code.indexOf(fnText),
            end: code.indexOf(fnText) + fnText.length,
            startLine: code.substring(0, code.indexOf(fnText)).split('\n').length,
            type,
            fullMatch: fnText,
          });
        }
      );
    }

    console.log(`Found ${asyncFunctions.length} functions via AST/regex analysis`);

    const result = {
      file: relativeFilePath,
      functions: [],
      success: true,
    };

    // Analyze each function for parallelizable operations
    for (const fn of asyncFunctions) {
      // Look for consecutive await expressions using the same function call
      const awaitCalls = {};
      const awaitPattern = /const\s+([a-zA-Z0-9_]+)\s*=\s*await\s+([a-zA-Z0-9_.]+)\(([^)]*)\)/g;
      let awaitMatch;

      const fnBody = fn.body;
      while ((awaitMatch = awaitPattern.exec(fnBody)) !== null) {
        const varName = awaitMatch[1];
        const fnName = awaitMatch[2];
        if (!awaitCalls[fnName]) {
          awaitCalls[fnName] = [];
        }
        awaitCalls[fnName].push({
          fullMatch: awaitMatch[0],
          variableName: varName,
          args: awaitMatch[3],
          position: awaitMatch.index,
        });
      }

      // Also look for simpler await expressions
      const simpleAwaitPattern = /await\s+([a-zA-Z0-9_.]+)\(([^)]*)\)/g;
      while ((awaitMatch = simpleAwaitPattern.exec(fnBody)) !== null) {
        const fnName = awaitMatch[1];
        if (!awaitCalls[fnName]) {
          awaitCalls[fnName] = [];
        }

        // Check if this await is already captured by the more specific pattern
        const isDuplicate = awaitCalls[fnName].some((call) =>
          call.fullMatch.includes(awaitMatch[0])
        );

        if (!isDuplicate) {
          awaitCalls[fnName].push({
            fullMatch: awaitMatch[0],
            variableName: `result${awaitCalls[fnName].length}`,
            args: awaitMatch[2],
            position: awaitMatch.index,
          });
        }
      }

      // Check for parallelization opportunities
      let hasParallelizable = false;
      const parallelOps = [];

      for (const [calledFn, calls] of Object.entries(awaitCalls)) {
        if (calls.length > 1) {
          hasParallelizable = true;

          // Add each call as a separate operation
          for (const call of calls) {
            parallelOps.push({
              functionName: calledFn,
              variableName: call.variableName,
              args: call.args.split(',').map((arg) => arg.trim()),
              fullMatch: call.fullMatch,
            });
          }
        }
      }

      if (hasParallelizable) {
        const fnInfo = {
          name: fn.name,
          body: fn.fullMatch,
          type: fn.type,
          parallelizableOperations: parallelOps,
          canBeParallelized: true,
          file: relativeFilePath,
          regexAnalysis: true,
        };

        // Generate optimized version
        fnInfo.optimizedCode = generateDefaultOptimization(fn.name, parallelOps, fn.fullMatch);

        result.functions.push(fnInfo);
      } else {
        // Still add to results, but mark as not parallelizable
        result.functions.push({
          name: fn.name,
          body: fn.fullMatch,
          type: fn.type,
          canBeParallelized: false,
          file: relativeFilePath,
          regexAnalysis: true,
        });
      }
    }

    return result;
  } catch (error) {
    return {
      file: filePath,
      functions: [],
      success: false,
      error: error.message,
    };
  }
}

// Add getStageCachePath function
function getStageCachePath(stage) {
  const stageCachePaths = {
    parse: PARSE_CACHE_PATH,
    PARSE: PARSE_CACHE_PATH,
    ai: AI_CACHE_PATH,
    AI: AI_CACHE_PATH,
    final: FINAL_CACHE_PATH,
    FINAL: FINAL_CACHE_PATH,
  };

  const cachePath = stageCachePaths[stage];
  if (!cachePath) {
    console.warn(`Warning: Unknown stage "${stage}", using default cache path`);
    return PARSE_CACHE_PATH; // Default to parse cache path
  }

  return cachePath;
}

// Modify the main function to use both AST and regex analysis
async function main() {
  const packagesDir = path.join(__dirname, '..', 'packages');

  // Initialize cache if needed
  await initializeCache();

  // Parse command line arguments
  const cmdArgs = minimist(process.argv.slice(2), {
    boolean: [
      'analyze',
      'ai',
      'with-ai',
      'force-ai',
      'verbose',
      'regex-only',
      'force-parse',
      'skip-regex',
    ],
    string: ['file'],
  });

  // Set verbose mode if specified
  VERBOSE = cmdArgs.verbose || false;

  if (cmdArgs.analyze) {
    console.log('Starting analysis...');

    // Change let to const since it's assigned only once
    const parseResults = await (async () => {
      // Check if a specific file was provided
      if (
        cmdArgs.file &&
        (cmdArgs.file.endsWith('.js') ||
          cmdArgs.file.endsWith('.ts') ||
          cmdArgs.file.endsWith('.tsx'))
      ) {
        const filePath = path.resolve(process.cwd(), cmdArgs.file);
        console.log(`Analyzing specific file: ${filePath}`);

        // Try AST analysis first, unless regex-only is specified
        const astAnalysisResults = { functions: [], success: false };
        if (!cmdArgs['regex-only']) {
          try {
            logVerbose('Attempting AST analysis...');
            Object.assign(astAnalysisResults, await extractAsyncFunctions(filePath));
          } catch (error) {
            console.warn(`Warning: AST analysis failed for ${filePath}: ${error.message}`);
            astAnalysisResults.error = error.message;
          }
        }

        // If AST analysis found no functions or didn't complete successfully, try regex analysis
        const regexAnalysisResults = { functions: [] };
        if (
          cmdArgs['regex-only'] ||
          astAnalysisResults.functions.length === 0 ||
          !astAnalysisResults.success
        ) {
          logVerbose('Using regex analysis...');
          Object.assign(regexAnalysisResults, await analyzeWithRegex(filePath));
        }

        // Combine results (AST takes precedence for the same function names)
        const astFunctionNames = new Set(astAnalysisResults.functions.map((f) => f.name));
        const combinedFunctions = [
          ...astAnalysisResults.functions,
          ...regexAnalysisResults.functions.filter((f) => !astFunctionNames.has(f.name)),
        ];

        return {
          files: [filePath],
          functions: combinedFunctions,
          success: astAnalysisResults.success || regexAnalysisResults.success,
        };
      }

      // Process packages directory
      if (existsSync(PARSE_CACHE_PATH) && !cmdArgs['force-parse']) {
        const result = await loadStageResults('parse');
        console.log('Found existing parse results, using cached data');
        return result;
      }

      // Get the packages directory
      const packagesDir = path.resolve(process.cwd(), 'packages');

      if (!existsSync(packagesDir)) {
        console.error(`Packages directory not found: ${packagesDir}`);
        return { files: [], functions: [], success: false };
      }

      console.log(`Analyzing packages in: ${packagesDir}`);
      const result = await parseAllPackages(packagesDir);
      await saveStageResults('parse', result);
      return result;
    })();

    // Change this check to allow the script to continue with available results
    if (!parseResults) {
      console.error('Error during analysis: Parse results are undefined');
      return;
    }

    // Continue even if success is false, using what we have
    console.log(
      `Found ${parseResults.functions ? parseResults.functions.length : 0} functions via AST/regex analysis`
    );

    // Use regex analysis for files where AST analysis failed or found no functions
    if (!cmdArgs['skip-regex'] && parseResults.files && parseResults.files.length > 0) {
      const filesToReanalyze = parseResults.files.filter((file) => {
        // Add null check before filtering functions
        if (!parseResults.functions || !Array.isArray(parseResults.functions)) {
          return true; // If functions array doesn't exist, reanalyze this file
        }
        const functionsInFile = parseResults.functions.filter((fn) => fn.file === file);
        return functionsInFile.length === 0;
      });

      if (filesToReanalyze.length > 0) {
        logVerbose(`Reanalyzing ${filesToReanalyze.length} files with regex approach...`);

        for (const file of filesToReanalyze) {
          const regexResults = await analyzeWithRegex(file);
          if (regexResults.success && regexResults.functions.length > 0) {
            // Initialize functions array if it doesn't exist
            if (!parseResults.functions) {
              parseResults.functions = [];
            }
            parseResults.functions.push(...regexResults.functions);
          }
        }
      }
    }

    // Continue with the AI analysis if available
    const analysisResults = await (async () => {
      if (cmdArgs.ai || cmdArgs['with-ai']) {
        try {
          if (existsSync(AI_CACHE_PATH) && !cmdArgs['force-ai']) {
            const result = await loadStageResults('ai');
            console.log('Found existing AI analysis results, using cached data');
            return result;
          }

          console.log('Starting AI analysis with Claude...');
          const result = await analyzeWithAI(parseResults);
          await saveStageResults('ai', result);
          return result;
        } catch (error) {
          console.error('Error in AI analysis stage:', error);
          return { results: {}, parallelizableFunctions: new Set(), errors: [error] };
        }
      }

      // If no AI analysis, create results structure with parallelizable functions
      const result = {
        results: {},
        parallelizableFunctions: new Set(),
        errors: [],
      };

      // Ensure parseResults.functions exists before iterating
      if (parseResults && parseResults.functions && Array.isArray(parseResults.functions)) {
        // Add all functions with regex-identified parallelization opportunities
        parseResults.functions.forEach((fn) => {
          if (fn.canBeParallelized) {
            result.parallelizableFunctions.add(fn.name);
            result.results[fn.name] = {
              canBeParallelized: true,
              isParallelizable: true,
              parallelizableOperations: fn.parallelizableOperations || [],
              optimizedCode: fn.optimizedCode || fn.body,
              originalCode: fn.body,
              sourceInfo: {
                name: fn.name,
                filePath: fn.file,
                relativePath: fn.relativePath || fn.file,
                code: fn.body,
              },
            };
          } else {
            result.results[fn.name] = {
              canBeParallelized: false,
              originalCode: fn.body,
            };
          }
        });
      }

      return result;
    })();

    // Generate the final report
    try {
      console.log('Generating optimization report...');
      const reportPath = path.resolve(process.cwd(), 'scripts/optimization-report.md');
      const report = await generateMarkdownReport(analysisResults);

      // Use fsPromises.writeFile
      await fsPromises.writeFile(reportPath, report);
      console.log(`Report saved to: ${reportPath}`);
    } catch (error) {
      console.error('Error generating report:', error);
    }

    // Summary
    console.log('\nAnalysis Summary:');
    console.log(
      `- Files processed: ${parseResults && parseResults.files ? parseResults.files.length : 0}`
    );
    console.log(
      `- Async functions found: ${parseResults && parseResults.functions ? parseResults.functions.length : 0}`
    );
    console.log(
      `- Potentially parallelizable functions: ${analysisResults && analysisResults.parallelizableFunctions ? analysisResults.parallelizableFunctions.size : 0}`
    );
    console.log(
      `- Errors encountered: ${analysisResults && analysisResults.errors ? analysisResults.errors.length : 0}`
    );

    // Debug: Log the structure of analysisResults
    console.log('\nDebug: analysisResults structure:');
    console.log('- parallelizableFunctions:', analysisResults.parallelizableFunctions);
    console.log('- results keys:', Object.keys(analysisResults.results));
    if (Object.keys(analysisResults.results).length > 0) {
      const sampleKey = Object.keys(analysisResults.results)[0];
      console.log(`- Sample result (${sampleKey}):`, analysisResults.results[sampleKey]);
    }

    // Apply optimizations if --apply flag is used
    if (
      shouldApply &&
      analysisResults &&
      analysisResults.parallelizableFunctions &&
      analysisResults.parallelizableFunctions.size > 0
    ) {
      console.log('\nApplying optimizations...');
      await generateOptimizations(analysisResults);
    }
  }

  await saveCache();
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
