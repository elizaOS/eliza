// optimize async and await

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { default as generate } from '@babel/generator';
import * as t from '@babel/types';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = process.argv.slice(2);
const shouldApply = args.includes('--apply');
const shouldAnalyze = args.includes('--analyze') || shouldApply;

// Configuration
const VERBOSE_LOGGING = false; // Set to true for detailed logs

// Utility for conditional logging
function logVerbose(...args) {
  if (VERBOSE_LOGGING) {
    console.log(...args);
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
  FINAL: path.join(__dirname, 'async-analysis-final.json')
};

// Add skip packages configuration
const SKIP_PACKAGES = new Set([
  'cli',           // Skip auto doc client CLI
  'create-eliza',  // Skip Eliza projects
  'project-starter',
  'plugin-starter',
  'plugin-example'
]);

const TRACKING_FILES = {
  CANDIDATES: path.join(__dirname, 'candidates.json'),
  RESULTS: path.join(__dirname, 'results.json')
};

// Add cache initialization at the top level
let analysisCache = {
  version: CACHE_VERSION,
  lastRun: null,
  metadata: {
    totalFunctions: 0,
    analyzedFunctions: 0,
    parallelizableFunctions: 0
  },
  functions: {}
};

async function loadCache() {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const content = await fs.readFile(CACHE_FILE, 'utf8');
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
        parallelizableFunctions: 0
      },
      functions: {}
    };
  }
}

async function initializeCache() {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const content = await fs.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(content);
    if (cache.version === CACHE_VERSION) {
      analysisCache = cache;
      logVerbose('\n=== Cache Status ===');
      logVerbose(`Last run: ${cache.lastRun || 'Never'}`);
      logVerbose(`Previously analyzed: ${cache.metadata.analyzedFunctions}/${cache.metadata.totalFunctions} functions`);
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
        parallelizableFunctions: 0
      },
      functions: {}
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
    analysis
  };

  // Update metadata
  analysisCache.lastRun = new Date().toISOString();
  analysisCache.metadata.analyzedFunctions = Object.keys(analysisCache.functions).length;
  analysisCache.metadata.parallelizableFunctions = Object.values(analysisCache.functions)
    .filter(f => f.analysis?.isParallelizable).length;

  // Save cache after each update
  await saveCache();
}

async function saveCache() {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    
    // Use a circular replacer to handle circular references
    const getCircularReplacer = () => {
      const seen = new WeakSet();
      return (key, value) => {
        // Skip properties that commonly cause circular references
        if (key === 'parent' || key === 'range' || key === 'loc' || 
            key === 'start' || key === 'end' || key === 'body' ||
            key === 'sourceInfo') {
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
    
    await fs.writeFile(CACHE_FILE, JSON.stringify(analysisCache, getCircularReplacer(), 2));
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

export async function fetchUserData(userId) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    id: userId,
    name: 'Test User',
    email: 'test@example.com'
  };
}
export async function fetchUserProducts(userId) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return [{
    id: 'p1',
    name: 'Product 1',
    price: 99.99
  }, {
    id: 'p2',
    name: 'Product 2',
    price: 149.99
  }];
}
export async function fetchUserAnalytics(userId) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    visits: 42,
    pageViews: 128,
    conversions: 3
  };
}
export async function createUser(userData) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    id: Math.random().toString(36).substring(7),
    name: userData.name || 'New User',
    email: userData.email || 'new@example.com'
  };
}
export async function fetchDefaultPreferences() {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    theme: 'light',
    notifications: true,
    language: 'en-US'
  };
}
export async function fetchWelcomeTemplate() {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return 'Welcome, {{name}}! We\'re glad to have you join us.';
}
export async function sendWelcomeEmail(email, template, preferences) {
  await new Promise(resolve => setTimeout(resolve, 1000));
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
      await new Promise(resolve => this.queue.push(resolve));
    }
    
    this.running++;
    try {
      // Add rate limiting delay
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
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
      messages: [{
        role: "user",
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
\`\`\``
      }]
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
      throw new Error(`Invalid type for isParallelizable: expected boolean, got ${typeof parsed.isParallelizable}`);
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
    if (parsed.isParallelizable && (!parsed.optimizedCode || typeof parsed.optimizedCode !== 'string')) {
      console.warn(`[${functionName}] Warning: Function is parallelizable but no optimized code provided. Generating default optimization.`);
      // Generate a basic optimization if none is provided
      parsed.optimizedCode = generateDefaultOptimization(cleanedCode, parsed.parallelizableOperations);
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
    duration
  };
}

const original = {
  async loadDashboardData(userId) {
    const [userData, userProducts, userAnalytics] = await Promise.all([fetchUserData(userId), fetchUserProducts(userId), fetchUserAnalytics(userId)]);
    return {
      userData,
      products: userProducts,
      analytics: userAnalytics,
      lastUpdated: new Date()
    };
  },
  async processUserList(userIds) {
    const results = await Promise.all(userIds.map(async id => {
      const userData = await fetchUserData(id);
      return userData;
    }));
    return results;
  },
  async createUserAndNotify(userData) {
    const [user, preferences] = await Promise.all([createUser(userData), fetchDefaultPreferences()]);
    const welcomeTemplate = await fetchWelcomeTemplate();
    user.preferences = preferences;
    await sendWelcomeEmail(user.email, welcomeTemplate, preferences);
    return user;
  }
};

async function applyOptimizations(analysisResults) {
  console.log('\n=== Applying Optimizations ===\n');
  const sourceFile = new URL(import.meta.url).pathname;
  const sourceCode = await fs.readFile(sourceFile, 'utf8');
  const ast = parse(sourceCode, {
    ecmaVersion: 2022,
    sourceType: 'module',
    range: true,
    loc: true
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
        sourceType: 'module'
      });
      functionNode.body = tempAst.body[0].body;
      hasChanges = true;
    } catch (error) {
      console.error(`Failed to apply optimization for ${name}:`, error);
    }
  }
  if (hasChanges) {
    const optimizedCode = generate(ast);
    await fs.writeFile(sourceFile, optimizedCode);
    console.log('\nOptimizations applied successfully!');
  } else {
    console.log('\nNo optimizations were applied.');
  }
}

function findFunctionNode(ast, functionName) {
  let result = null;
  function visit(node) {
    if (node.type === 'Property' && node.key.name === functionName && node.value.type === 'FunctionExpression') {
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
  const packages = await fs.readdir(packagesDir);
  
  for (const pkg of packages) {
    // Skip specified packages
    if (SKIP_PACKAGES.has(pkg)) {
      console.log(`Skipping package: ${pkg}`);
      continue;
    }

    const srcDir = path.join(packagesDir, pkg, 'src');
    try {
      await fs.access(srcDir);
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
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
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
  const sourceCode = await fs.readFile(filePath, 'utf8');
  const ast = parse(sourceCode, {
    ecmaVersion: 2022,
    sourceType: 'module',
    range: true,
    loc: true,
    jsx: true,
    tsx: filePath.endsWith('.tsx'),
    typescript: filePath.endsWith('.ts') || filePath.endsWith('.tsx')
  });
  
  const asyncFunctions = [];
  const visited = new WeakSet();
  
  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);

    if ((node.type === 'FunctionDeclaration' || 
         node.type === 'FunctionExpression' || 
         node.type === 'ArrowFunctionExpression') && 
        node.async) {
      const code = sourceCode.slice(node.range[0], node.range[1]);
      const name = node.id?.name || 'anonymous';
      
      // Analyze the function body for potential parallel operations
      const parallelOps = analyzeASTForParallelization(node.body, sourceCode);
      
      asyncFunctions.push({
        name,
        code,
        filePath,
        range: node.range,
        loc: node.loc,
        astAnalysis: {
          isParallelizable: parallelOps.length > 0,
          parallelizableOperations: parallelOps
        }
      });
    }
    
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object' && key !== 'parent') {
        visit(node[key]);
      }
    }
  }
  
  visit(ast);
  return asyncFunctions;
}

function analyzeASTForParallelization(node, sourceCode) {
  const parallelOps = [];
  const awaitExpressions = [];
  let hasPromiseAll = false;
  let promiseAllNodes = [];
  const visited = new WeakSet();
  
  // Refined blacklisted terms that prevent parallelization
  // Removing overly general terms like 'wait', 'create', etc.
  const BLACKLISTED_TERMS = [
    'transaction', 'lock', 'mutex', 'semaphore'
  ];

  // Helper to check if operation contains blacklisted terms
  function containsBlacklistedTerm(code) {
    return BLACKLISTED_TERMS.some(term => code.toLowerCase().includes(term.toLowerCase()));
  }

  // Helper to check if nodes are in different branches
  function areInDifferentBranches(node1, node2) {
    let parent1 = node1;
    let parent2 = node2;
    
    while (parent1) {
      if (parent1.type === 'IfStatement' || parent1.type === 'SwitchCase') {
        let branch1Parent = parent1;
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
    return false;
  }
  
  // Find all await expressions and Promise.all usage
  function collectNodes(node) {
    if (visited.has(node)) return;
    visited.add(node);

    if (node.type === 'AwaitExpression') {
      // Skip if the await expression contains blacklisted terms
      const awaitCode = sourceCode.slice(node.range[0], node.range[1]);
      if (!containsBlacklistedTerm(awaitCode)) {
        awaitExpressions.push(node);
      }
    }
    
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object' && key !== 'parent') {
        const child = node[key];
        if (child) {
          child.parent = node;
          collectNodes(child);
        }
      }
    }
  }
  
  collectNodes(node);

  // Group consecutive await expressions that could be parallelized
  let currentGroup = [];
  
  for (let i = 0; i < awaitExpressions.length; i++) {
    const awaitExpr = awaitExpressions[i];
    
    // Find the parent statement or declaration
    let parent = awaitExpr;
    let foundParent = false;
    while (parent && !foundParent) {
      if (parent.type === 'VariableDeclaration' || 
          parent.type === 'ExpressionStatement' ||
          parent.type === 'ReturnStatement') {
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
    
    // Check for dependencies between awaits with less restrictive criteria
    const hasComplexDeps = hasComplexDependencies(lastExpr.parent, parent, lastExpr.await, awaitExpr, sourceCode);
    const inDifferentBranches = areInDifferentBranches(lastExpr.await, awaitExpr);
    
    if (!hasComplexDeps && !inDifferentBranches) {
      currentGroup.push({ await: awaitExpr, parent });
    } else if (currentGroup.length > 1) {
      // If we have a group of parallelizable operations, add them
      const operations = currentGroup.map(item => 
        sourceCode.slice(item.await.argument.range[0], item.await.argument.range[1])
      );
      
      // Only add if none of the operations contain blacklisted terms
      if (!operations.some(containsBlacklistedTerm)) {
        parallelOps.push({
          type: 'sequential',
          lines: [
            currentGroup[0].await.loc.start.line,
            currentGroup[currentGroup.length - 1].await.loc.end.line
          ],
          operations,
          suggestion: 'These sequential operations can be parallelized with Promise.all'
        });
      }
      currentGroup = [{ await: awaitExpr, parent }];
    } else {
      currentGroup = [{ await: awaitExpr, parent }];
    }
  }
  
  // Handle any remaining group
  if (currentGroup.length > 1) {
    const operations = currentGroup.map(item => 
      sourceCode.slice(item.await.argument.range[0], item.await.argument.range[1])
    );
    
    // Only add if none of the operations contain blacklisted terms
    if (!operations.some(containsBlacklistedTerm)) {
      parallelOps.push({
        type: 'sequential',
        lines: [
          currentGroup[0].await.loc.start.line,
          currentGroup[currentGroup.length - 1].await.loc.end.line
        ],
        operations,
        suggestion: 'These sequential operations can be parallelized with Promise.all'
      });
    }
  }
  
  return parallelOps;
}

function hasComplexDependencies(startNode, endNode, awaitExpr1, awaitExpr2, sourceCode) {
  const inBetweenCode = sourceCode.slice(startNode.range[1], endNode.range[0]);
  
  // Get the variable names being assigned to
  const assignedVars = new Set();
  if (startNode.type === 'VariableDeclaration') {
    startNode.declarations.forEach(decl => {
      if (decl.id.type === 'Identifier') {
        assignedVars.add(decl.id.name);
      } else if (decl.id.type === 'ObjectPattern') {
        // Handle destructuring assignments
        decl.id.properties.forEach(prop => {
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
  const hasDependency = Array.from(assignedVars).some(v => usedVars.has(v));
  
  // Only consider assignments complex if they involve function calls that aren't simple
  const hasComplexAssignment = startNode.type === 'VariableDeclaration' &&
                              startNode.declarations.some(decl => 
                                decl.init?.type === 'CallExpression' &&
                                decl.init?.callee?.type !== 'MemberExpression');
  
  // Simplify control flow detection - only consider certain patterns as disruptive
  const hasComplexControlFlow = 
    /\b(if|for|while|switch)\s*\([^)]*\).*\{[^}]*await/.test(inBetweenCode);
  
  // Only consider method calls that might have observable side effects
  const potentiallyUnsafePatterns = [
    'write', 'delete', 'remove', 'update', 'create', 'insert', 'save', 'modify'
  ];

  const hasPotentiallyUnsafeCalls = 
    potentiallyUnsafePatterns.some(pattern => inBetweenCode.toLowerCase().includes(pattern)) &&
    inBetweenCode.includes('(') && 
    !inBetweenCode.includes('Promise.all');
  
  return hasDependency || hasComplexAssignment || hasComplexControlFlow || hasPotentiallyUnsafeCalls;
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
      sourceCode = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read source file ${filePath}: ${error.message}`);
    }

    let start = 0;
    let end = sourceCode.length;
    
    // Try to use range information if it exists and is valid
    if (functionInfo.range && Array.isArray(functionInfo.range) && functionInfo.range.length === 2) {
      const [rangeStart, rangeEnd] = functionInfo.range;
      
      // Validate range bounds
      if (rangeStart >= 0 && rangeEnd <= sourceCode.length && rangeStart < rangeEnd) {
        start = rangeStart;
        end = rangeEnd;
      } else {
        logVerbose(`Warning: Range [${rangeStart}, ${rangeEnd}] is out of bounds for file of length ${sourceCode.length}`);
        // We'll find the function by content below
      }
    } else {
      logVerbose(`Range information missing or invalid for ${functionInfo.name}. Will attempt to find by content.`);
    }
    
    // Verify the original code matches at the specified range
    const originalRangeCode = sourceCode.slice(start, end);
    let matchFound = originalRangeCode.trim() === functionInfo.code.trim();
    
    // If the range doesn't match the expected code, try to find the function in the file
    if (!matchFound) {
      logVerbose(`Original code at range does not match function info for ${functionInfo.name}. Searching for function...`);
      
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
        const namePattern = new RegExp(`(async\\s+function\\s+${functionInfo.name}\\s*\\(|${functionInfo.name}\\s*:\\s*async\\s+function\\s*\\(|${functionInfo.name}\\s*=\\s*async\\s*\\()`, 'g');
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
                  logVerbose(`Found function ${functionInfo.name} by name at position ${start}-${end}`);
                  break;
                }
              } else if (sourceCode[pos] === '"' || sourceCode[pos] === "'" || sourceCode[pos] === '`') {
                inString = true;
                stringChar = sourceCode[pos];
              }
            } else {
              if (sourceCode[pos] === stringChar && sourceCode[pos-1] !== '\\') {
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
    
    // Create a backup of the original file
    const backupPath = `${filePath}.backup`;
    await fs.writeFile(backupPath, sourceCode);
    
    // Write the new code
    try {
      await fs.writeFile(filePath, newCode);
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
  try {
    const content = await fs.readFile(STAGE_FILES[stage], 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveStageResults(stage, results) {
  // Remove circular references before stringifying
  const getCircularReplacer = () => {
    const seen = new WeakSet();
    return (key, value) => {
      // Skip parent references and internal AST properties
      if (key === 'parent' || key === 'range' || key === 'loc') {
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

  await fs.writeFile(
    STAGE_FILES[stage], 
    JSON.stringify(results, getCircularReplacer(), 2)
  );
}

async function saveInitialCandidates(parseResults) {
  const candidates = [];
  
  for (const fn of parseResults.asyncFunctions) {
    const candidateInfo = {
      name: fn.name,
      file: fn.relativePath,
      lines: `${fn.loc.start.line}-${fn.loc.end.line}`,
      ast_parallelizable: fn.astAnalysis.isParallelizable,
      parallelizable_functions: [],
      parallelizable_operations: []
    };

    if (fn.astAnalysis.isParallelizable) {
      const parallelOps = fn.astAnalysis.parallelizableOperations
        .filter(op => op.type === 'independent')
        .map(op => ({
          operations: op.operations,
          lines: `${op.lines[0]}-${op.lines[1]}`
        }));

      if (parallelOps.length > 0) {
        candidateInfo.parallelizable_operations = parallelOps.map(op => ({
          lines: op.lines,
          operations: op.operations,
          potential_parallel_calls: op.operations.map(call => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            return match ? match[1] : call;
          })
        }));

        // Extract unique function names from parallel operations
        const functionNames = new Set();
        parallelOps.forEach(op => {
          op.operations.forEach(call => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            if (match) functionNames.add(match[1]);
          });
        });
        candidateInfo.parallelizable_functions = Array.from(functionNames);
      }
    }

    candidates.push(candidateInfo);
  }
  
  await fs.writeFile(TRACKING_FILES.CANDIDATES, JSON.stringify(candidates, null, 2));
  console.log(`\nSaved ${candidates.length} candidates (${candidates.filter(c => c.ast_parallelizable).length} parallelizable from AST analysis)`);
  return candidates;
}

async function saveInitialResults(parseResults) {
  const results = [];
  
  for (const fn of parseResults.asyncFunctions) {
    if (fn.astAnalysis.isParallelizable) {
      const originalOps = fn.astAnalysis.parallelizableOperations.map(op => ({
        type: op.type,
        original_lines: `${op.lines[0]}-${op.lines[1]}`,
        sequential_calls: op.operations.map(call => call.replace(/\(.*\)/, '()')),
        optimization: "Potential candidate for Promise.all parallelization"
      }));

      results.push({
        name: fn.name,
        file: fn.relativePath,
        lines: `${fn.loc.start.line}-${fn.loc.end.line}`,
        original_implementation: {
          sequential_operations: originalOps
        },
        optimized_implementation: {
          parallel_operations: originalOps.filter(op => op.type === 'independent').map(op => ({
            functions: op.sequential_calls,
            optimization_applied: "Candidate for Promise.all"
          })),
          remaining_sequential: []
        },
        ast_analysis_only: true // Flag to indicate this is from AST analysis only
      });
    }
  }
  
  await fs.writeFile(TRACKING_FILES.RESULTS, JSON.stringify(results, null, 2));
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
    errors: []
  };

  let totalAsyncFunctions = 0;
  let totalParallelizable = 0;

  for (const filePath of sourceFiles) {
    try {
      const functions = await extractAsyncFunctions(filePath);
      const relativePath = path.relative(packagesDir, filePath);
      const functionsWithPath = functions.map(fn => ({
        ...fn,
        relativePath
      }));
      
      parseResults.asyncFunctions.push(...functionsWithPath);
      
      const parallelizableFns = functions.filter(fn => fn.astAnalysis.isParallelizable);
      totalAsyncFunctions += functions.length;
      totalParallelizable += parallelizableFns.length;
      
      if (functions.length > 0) {
        console.log(
          `${relativePath}: ${functions.length} async functions ` +
          `(${parallelizableFns.length} potentially parallelizable)`
        );
        
        // Log detailed AST analysis for parallelizable functions
        for (const fn of parallelizableFns) {
          console.log(`\n  Function: ${fn.name}`);
          for (const op of fn.astAnalysis.parallelizableOperations) {
            console.log(`    Lines ${op.lines[0]}-${op.lines[1]}:`);
            console.log(`    Operations:`, op.operations);
          }
        }
      }
    } catch (error) {
      parseResults.errors.push({
        file: filePath,
        error: error.message
      });
      console.error(`Error processing ${filePath}:`, error);
    }
  }

  // Save both candidates and results based on AST analysis
  await saveInitialCandidates(parseResults);
  await saveInitialResults(parseResults);

  console.log('\n=== AST Analysis Summary ===');
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
  const functionsToAnalyze = parseResults.asyncFunctions.filter(fn => {
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
    parallelizableFunctions: new Set() // Track parallelizable functions
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
  const analysisPromises = functionsToAnalyze.map(fn => 
    queue.add(async () => {
      try {
        const analysis = await analyzeWithClaude(fn.code, fn.name);
        if (!analysis) {
          analysisResults.errors.push({
            function: fn.name,
            file: fn.filePath,
            error: 'Claude analysis failed'
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
          analysis.parallelizableOperations.forEach(op => {
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
          error: error.message || 'Unknown error'
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
      analysis.parallelizableOperations.forEach(op => {
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
    errors: []
  };

  logVerbose('\n=== Applying Optimizations ===\n');
  console.log('\nApplying optimizations...');
  
  // Track statistics
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const [key, analysis] of Object.entries(analysisResults.results)) {
    if (!analysis.isParallelizable || !analysis.parallelizableOperations || analysis.parallelizableOperations.length === 0) {
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
      analysis.optimizedCode = generateDefaultOptimization(sourceInfo.code, analysis.parallelizableOperations);
    }
    
    try {
      await applyOptimizationToFile(sourceInfo.filePath, sourceInfo, analysis.optimizedCode);
      finalResults.optimizations[key] = {
        timestamp: new Date().toISOString(),
        sourceInfo: {
          name: sourceInfo.name,
          filePath: sourceInfo.filePath,
          relativePath: sourceInfo.relativePath
        },
        operations: analysis.parallelizableOperations
      };
      successCount++;
      logVerbose(`Successfully optimized ${sourceInfo.name}`);
    } catch (error) {
      console.error(`Error applying optimization to ${sourceInfo.name}:`, error);
      finalResults.errors.push({
        key,
        error: error.message
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
    const lines = fn.loc ? 
      `${fn.loc.start.line}-${fn.loc.end.line}` : 
      'unknown';

    // Find the existing candidate or create a new one
    let candidate = candidates.find(c => c.name === fn.name && c.file === fn.relativePath);
    if (!candidate) {
      candidate = {
        name: fn.name,
        file: fn.relativePath,
        lines,
        ast_parallelizable: fn.astAnalysis?.isParallelizable || false,
        ai_parallelizable: false,
        parallelizable_functions: [],
        parallelizable_operations: []
      };
      candidates.push(candidate);
    }

    // Update with AI analysis results
    if (analysis) {
      candidate.ai_parallelizable = analysis.isParallelizable;
      if (analysis.isParallelizable && analysis.parallelizableOperations) {
        candidate.parallelizable_operations = analysis.parallelizableOperations.map(op => ({
          lines: op.lines ? `${op.lines[0]}-${op.lines[1]}` : 'unknown',
          operations: op.operations || [],
          suggestion: op.suggestion || '',
          potential_parallel_calls: (op.operations || []).map(call => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            return match ? match[1] : call;
          })
        }));

        // Extract unique function names from parallel operations
        const functionNames = new Set();
        analysis.parallelizableOperations.forEach(op => {
          (op.operations || []).forEach(call => {
            const match = call.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)\(/);
            if (match) functionNames.add(match[1]);
          });
        });
        candidate.parallelizable_functions = Array.from(functionNames);
      }
    }

    await fs.writeFile(TRACKING_FILES.CANDIDATES, JSON.stringify(candidates, null, 2));
  } catch (error) {
    console.error('Error updating candidates:', error);
  }
}

// Add function to update results with AI analysis results
async function updateResults(fn, analysis) {
  try {
    let results = [];
    try {
      const content = await fs.readFile(TRACKING_FILES.RESULTS, 'utf8');
      results = JSON.parse(content);
    } catch (error) {
      // If file doesn't exist or is invalid, start with empty array
    }

    // Get line information safely
    const lines = fn.loc ? 
      `${fn.loc.start.line}-${fn.loc.end.line}` : 
      'unknown';

    // Find the existing result or create a new one
    let result = results.find(r => r.name === fn.name && r.file === fn.relativePath);
    if (!result) {
      result = {
        name: fn.name,
        file: fn.relativePath,
        lines,
        original_implementation: {
          sequential_operations: []
        },
        optimized_implementation: {
          parallel_operations: [],
          remaining_sequential: []
        },
        ast_analysis_only: false
      };
      results.push(result);
    }

    // Update with AI analysis results
    if (analysis) {
      result.ast_analysis_only = false;
      if (analysis.isParallelizable && analysis.parallelizableOperations) {
        result.optimized_implementation.parallel_operations = analysis.parallelizableOperations.map(op => ({
          type: op.type || 'independent',
          lines: op.lines ? `${op.lines[0]}-${op.lines[1]}` : 'unknown',
          operations: op.operations || [],
          suggestion: op.suggestion || ''
        }));
      }
      if (analysis.optimizedCode) {
        result.optimized_implementation.code = analysis.optimizedCode;
      }
    }

    await fs.writeFile(TRACKING_FILES.RESULTS, JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Error updating results:', error);
  }
}

// Helper function to generate a basic optimization if Claude doesn't provide one
function generateDefaultOptimization(originalCode, parallelizableOperations) {
  // If there are no parallelizable operations, return the original code
  if (!parallelizableOperations || parallelizableOperations.length === 0) {
    return originalCode;
  }

  // Find the async function declaration/expression pattern in the code
  const asyncFunctionMatch = originalCode.match(/async\s+function\s+(\w+)?\s*\(([\s\S]*?)\)\s*\{([\s\S]*)\}/);
  const asyncArrowMatch = originalCode.match(/(?:const|let|var)?\s*(\w+)?\s*=\s*async\s*\(([\s\S]*?)\)\s*=>\s*\{([\s\S]*)\}/);
  
  if (!asyncFunctionMatch && !asyncArrowMatch) {
    console.warn("Could not identify async function pattern, returning original code");
    return originalCode;
  }

  const match = asyncFunctionMatch || asyncArrowMatch;
  const functionName = match[1] || 'anonymous';
  const params = match[2].trim();
  const functionBody = match[3];

  // Extract the await expressions from the function body
  const sequentialOps = parallelizableOperations.filter(op => op.type === 'sequential');
  
  if (sequentialOps.length === 0) {
    console.warn("No sequential operations found for parallelization");
    return originalCode;
  }

  // For each sequential group, apply Promise.all
  let optimizedBody = functionBody;
  
  for (const op of sequentialOps) {
    const operationsCode = op.operations.join(',\n    ');
    const startLine = op.lines[0];
    const endLine = op.lines[1];
    
    // Get the code section to replace
    const lines = originalCode.split('\n');
    const sectionToReplace = lines.slice(startLine - 1, endLine).join('\n');
    
    // Create the Promise.all replacement
    const replacement = `// Parallelized operations
  const [${op.operations.map((_, i) => `result${i + 1}`).join(', ')}] = await Promise.all([
    ${operationsCode}
  ]);`;
    
    // Replace the section in the optimized body
    optimizedBody = optimizedBody.replace(sectionToReplace, replacement);
  }

  // Reconstruct the function
  if (asyncFunctionMatch) {
    return `async function ${functionName}(${params}) {${optimizedBody}}`;
  } else {
    return `const ${functionName} = async (${params}) => {${optimizedBody}}`;
  }
}

async function main() {
  const packagesDir = path.join(__dirname, '..', 'packages');
  
  // Stage 1: Parse all packages and perform AST analysis
  const parseResults = await parseAllPackages(packagesDir);
  
  // Check flags for further processing
  const shouldAnalyze = args.includes('--analyze') || args.includes('--apply');
  
  // Stop here unless --analyze or --apply flag is present
  if (!shouldAnalyze) {
    console.log('\nAST analysis complete. Both candidates.json and results.json have been generated.');
    console.log('Run with --analyze flag to proceed with detailed Claude analysis.');
    console.log('Run with --apply flag to analyze and apply optimizations.');
    return;
  }
  
  console.log('\nProceeding with Claude analysis...');
  
  // Stage 2: Analyze functions with Claude
  const analysisResults = await analyzeWithAI(parseResults);
  
  // Stage 3: Generate and apply optimizations (only if --apply flag is present)
  if (shouldApply) {
    console.log('\nProceeding with optimization application...');
    const finalResults = await generateOptimizations(analysisResults);
    
    // Print optimization results
    console.log(`\nOptimization Results:`);
    console.log(`- Functions optimized: ${Object.keys(finalResults.optimizations).length}`);
    console.log(`- Optimization errors: ${finalResults.errors.length}`);
  } else {
    console.log('\nRun with --apply flag to apply the optimizations.');
  }
  
  // Print final summary
  console.log('\n=== Final Summary ===');
  console.log(`Parse Results:`);
  console.log(`- Files processed: ${parseResults.sourceFiles.length}`);
  console.log(`- Async functions found: ${parseResults.asyncFunctions.length}`);
  console.log(`- Potentially parallelizable (AST analysis): ${
    parseResults.asyncFunctions.filter(fn => fn.astAnalysis.isParallelizable).length
  }`);
  console.log(`- Parse errors: ${parseResults.errors.length}`);
  
  console.log(`\nAnalysis Results:`);
  console.log(`- Functions analyzed with Claude: ${Object.keys(analysisResults.results).length}`);
  console.log(`- Confirmed parallelizable: ${Object.values(analysisResults.results).filter(a => a.isParallelizable).length}`);
  console.log(`- Analysis errors: ${analysisResults.errors.length}`);
}

main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
