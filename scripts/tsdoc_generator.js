import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import ts from 'typescript';

import dotenv from 'dotenv';

dotenv.config();

// Define __dirname for ES modules
const __dirname = new URL('.', import.meta.url).pathname;

// Create readline interface for user interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

// Configuration
const CACHE_DIR = path.join(__dirname, 'tsdoc_cache');
const COMMENTS_DIR = path.join(__dirname, 'tsdoc_comments');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';

if (!ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
  process.exit(1);
}

// Ensure cache and comments directories exist
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

if (!fs.existsSync(COMMENTS_DIR)) {
  fs.mkdirSync(COMMENTS_DIR, { recursive: true });
}

// Function to call Claude API
async function callClaude(content, context) {
  try {
    const response = await fetch(CLAUDE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: content,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`API call failed with status: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Error calling Claude API:', error);
    return null;
  }
}

// Find all packages in the packages directory
async function findPackages() {
  try {
    const packagesDir = path.join(__dirname, '../packages');
    if (!fs.existsSync(packagesDir)) {
      console.error('Error: packages directory not found');
      process.exit(1);
    }

    const packages = fs
      .readdirSync(packagesDir)
      .filter((item) => {
        const itemPath = path.join(packagesDir, item);
        return fs.statSync(itemPath).isDirectory();
      })
      .map((pkg) => path.join(packagesDir, pkg));

    console.log(`Found ${packages.length} packages`);
    return packages;
  } catch (error) {
    console.error('Error finding packages:', error);
    process.exit(1);
  }
}

// Find src directories in a package
function findSrcDirs(packagePath) {
  try {
    const result = [];
    const dirs = [packagePath];

    while (dirs.length > 0) {
      const currentDir = dirs.pop();
      const items = fs.readdirSync(currentDir);

      for (const item of items) {
        const itemPath = path.join(currentDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          if (item === 'src') {
            result.push(itemPath);
          } else if (!item.startsWith('.') && item !== 'node_modules' && item !== 'dist') {
            dirs.push(itemPath);
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error(`Error finding src directories in ${packagePath}:`, error);
    return [];
  }
}

// Find all TypeScript files in src directories
async function findTypeScriptFiles(packagePath) {
  try {
    const srcDirs = findSrcDirs(packagePath);
    let tsFiles = [];

    for (const srcDir of srcDirs) {
      const files = await findTsFilesInDir(srcDir, packagePath);
      tsFiles = tsFiles.concat(files);
    }

    return tsFiles;
  } catch (error) {
    console.error(`Error finding TypeScript files in ${packagePath}:`, error);
    return [];
  }
}

// Recursively find TypeScript files in a directory
async function findTsFilesInDir(dir, packageRoot) {
  try {
    const result = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        if (!item.startsWith('.') && item !== 'node_modules' && item !== 'dist') {
          const subFiles = await findTsFilesInDir(itemPath, packageRoot);
          result.push(...subFiles);
        }
      } else if (item.endsWith('.ts') && !item.endsWith('.d.ts') && !item.endsWith('.test.ts')) {
        // Create relative path from package root
        const relativePath = path.relative(packageRoot, itemPath);
        result.push({
          path: itemPath,
          packageRoot,
          relativePath,
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`Error finding TypeScript files in ${dir}:`, error);
    return [];
  }
}

// Read the project's README file
async function readReadme() {
  try {
    const readmePath = path.join(__dirname, 'README.md');
    if (fs.existsSync(readmePath)) {
      return fs.readFileSync(readmePath, 'utf8');
    } else {
      console.warn('Warning: README.md not found in root directory');
      return '';
    }
  } catch (error) {
    console.error('Error reading README:', error);
    return '';
  }
}

// Get cache file path for a TypeScript file
function getCacheFilePath(tsFile) {
  const relativePath = path.relative(path.join(__dirname, '../packages'), tsFile.packageRoot);
  const cacheDir = path.join(CACHE_DIR, relativePath);

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  return path.join(cacheDir, `${path.basename(tsFile.path)}.json`);
}

// Get comments file path for a TypeScript file
function getCommentsFilePath(tsFile) {
  const relativePath = path.relative(path.join(__dirname, '../packages'), tsFile.packageRoot);
  const commentsDir = path.join(COMMENTS_DIR, relativePath, path.dirname(tsFile.relativePath));

  if (!fs.existsSync(commentsDir)) {
    fs.mkdirSync(commentsDir, { recursive: true });
  }

  return path.join(commentsDir, `${path.basename(tsFile.path)}.json`);
}

// Check if a node already has JSDoc comments
function hasJSDocComment(node, sourceFile) {
  const jsDocComments = ts.getJSDocCommentRanges(node, sourceFile.text);
  return jsDocComments && jsDocComments.length > 0;
}

// Extract existing JSDoc comments from a node
function extractJSDocComment(node, sourceFile) {
  const jsDocComments = ts.getJSDocCommentRanges(node, sourceFile.text);
  if (jsDocComments && jsDocComments.length > 0) {
    return sourceFile.text.substring(jsDocComments[0].pos, jsDocComments[0].end);
  }
  return null;
}

// Get node name for various node types
function getNodeName(node) {
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name ? node.name.text : 'anonymous';
  }
  return 'unknown';
}

// Get node kind as string
function getNodeKindString(node) {
  if (ts.isPropertyDeclaration(node)) return 'property';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isVariableDeclaration(node)) return 'variable';
  return 'unknown';
}

// Extract relevant information about a node for documentation
function extractNodeInfo(node, sourceFile) {
  const name = getNodeName(node);
  const kind = getNodeKindString(node);
  const hasComment = hasJSDocComment(node, sourceFile);
  const existingComment = hasComment ? extractJSDocComment(node, sourceFile) : null;

  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const text = sourceFile.text.substring(start, end);

  return {
    name,
    kind,
    hasComment,
    existingComment,
    nodeText: text,
    start,
    end,
  };
}

// Extract all nodes from a source file that could have JSDoc comments
function extractNodesFromSourceFile(sourceFile) {
  const nodes = [];

  function visit(node) {
    // Check for node types that can have JSDoc comments
    if (
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      nodes.push(extractNodeInfo(node, sourceFile));
    }

    // Check for variable declarations
    if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((declaration) => {
        nodes.push(extractNodeInfo(declaration, sourceFile));
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return nodes;
}

// Process a TypeScript file to extract and generate comments
async function processTypeScriptFile(tsFile, readme, stats) {
  const filePath = tsFile.path;
  const cacheFilePath = getCacheFilePath(tsFile);
  const commentsFilePath = getCommentsFilePath(tsFile);

  console.log(`Processing ${filePath}`);

  // Check if we've already processed this file and it hasn't changed
  if (fs.existsSync(cacheFilePath)) {
    const cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
    const fileStats = fs.statSync(filePath);

    if (cache.lastModified === fileStats.mtimeMs.toString()) {
      console.log(`Using cached data for ${filePath}`);
      return cache;
    }
  }

  try {
    // Create a program for this file
    const program = ts.createProgram([filePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    });

    const sourceFile = program.getSourceFile(filePath);
    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Extract nodes from source file
    const nodes = extractNodesFromSourceFile(sourceFile);

    // Load existing comments if available
    let existingComments = {};
    if (fs.existsSync(commentsFilePath)) {
      existingComments = JSON.parse(fs.readFileSync(commentsFilePath, 'utf8'));
    }

    // Collect nodes that need comments
    const nodesToProcess = [];

    for (const node of nodes) {
      stats.totalNodes++;

      if (node.hasComment) {
        stats.nodesWithComments++;

        // Store existing comment in comments file
        existingComments[node.name] = {
          kind: node.kind,
          comment: node.existingComment,
          autoGenerated: false,
        };
      } else {
        stats.nodesWithoutComments++;

        // Check if we already have a generated comment for this node
        if (!existingComments[node.name]) {
          nodesToProcess.push(node);
        } else {
          console.log(`Using existing generated comment for ${node.kind} ${node.name}`);
        }
      }
    }

    // Process nodes in a single batch if there are any to process
    if (nodesToProcess.length > 0) {
      console.log(`Generating comments for ${nodesToProcess.length} nodes in ${filePath}`);

      // Create a single prompt for all nodes
      const batchPrompt = `
I need TSDoc comments for the following ${nodesToProcess.length} TypeScript entities in a file:

${nodesToProcess
  .map(
    (node, index) => `
-------- Node ${index + 1}: ${node.kind} '${node.name}' --------
\`\`\`typescript
${node.nodeText}
\`\`\`
`
  )
  .join('\n')}

Project context from README:
${readme.slice(0, 1000)}...

For each entity, please write a comprehensive TSDoc comment. Include:
- A brief description
- @param tags for any parameters
- @returns tag if applicable
- @throws tag if applicable
- Any other relevant TSDoc tags

Format your response with a clear separator for each entity, like this:

=== COMMENT FOR: ${nodesToProcess.length > 0 ? nodesToProcess[0].name : 'example'} ===
/** 
 * Description
 * @param ... 
 */

=== COMMENT FOR: ... ===
...

Return only the TSDoc comments without any explanations or markdown formatting, just the raw comments with /** */ format.
`;

      const batchResponse = await callClaude(batchPrompt);

      if (batchResponse) {
        // Parse the batch response to extract individual comments
        const commentSections = batchResponse
          .split(/===\s*COMMENT FOR:\s*([^=]+)\s*===/)
          .filter(Boolean);

        // Process pairs of [nodeName, comment]
        for (let i = 0; i < commentSections.length; i += 2) {
          if (i + 1 < commentSections.length) {
            const nodeName = commentSections[i].trim();
            const comment = commentSections[i + 1].trim();

            // Find the matching node
            const matchingNode = nodesToProcess.find(
              (node) => node.name === nodeName || nodeName.includes(node.name)
            );

            if (matchingNode) {
              existingComments[matchingNode.name] = {
                kind: matchingNode.kind,
                comment: comment,
                autoGenerated: true,
              };
              stats.generatedComments++;
            }
          }
        }
      }
    }

    // Write back to comments file
    fs.writeFileSync(commentsFilePath, JSON.stringify(existingComments, null, 2));

    // Update cache
    const fileStats = fs.statSync(filePath);
    const cache = {
      filePath,
      relativePath: tsFile.relativePath,
      packageRoot: tsFile.packageRoot,
      lastModified: fileStats.mtimeMs.toString(),
      totalNodes: nodes.length,
      nodesWithComments: nodes.filter((n) => n.hasComment).length,
      nodesWithoutComments: nodes.filter((n) => !n.hasComment).length,
    };

    fs.writeFileSync(cacheFilePath, JSON.stringify(cache, null, 2));

    return cache;
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
    return null;
  }
}

// Main function
async function main() {
  try {
    console.log('Starting TSDoc generation process...');

    // Read project README
    const readme = await readReadme();

    // Find all packages
    const packages = await findPackages();

    const stats = {
      totalFiles: 0,
      totalNodes: 0,
      nodesWithComments: 0,
      nodesWithoutComments: 0,
      generatedComments: 0,
    };

    // Collect all files to process
    let allTsFiles = [];
    for (const packagePath of packages) {
      console.log(`Finding TypeScript files in package: ${path.basename(packagePath)}`);
      const tsFiles = await findTypeScriptFiles(packagePath);
      allTsFiles = allTsFiles.concat(tsFiles);
    }

    stats.totalFiles = allTsFiles.length;
    console.log(`Found ${stats.totalFiles} TypeScript files to process`);

    // Process files in parallel with a queue
    const MAX_CONCURRENT = 10;
    const queue = [...allTsFiles];
    const activePromises = new Map(); // Use Map to keep track of file -> promise
    let completed = 0;

    // Function to start processing a file from the queue
    const processNextFile = () => {
      if (queue.length === 0) return null;

      const tsFile = queue.shift();
      const filePromise = processTypeScriptFile(tsFile, readme, stats)
        .then((result) => {
          // File processing complete
          activePromises.delete(tsFile.path);
          completed++;

          // Log progress
          const percent = Math.round((completed / stats.totalFiles) * 100);
          console.log(`[${percent}%] Processed ${tsFile.path} (${completed}/${stats.totalFiles})`);

          // Start processing the next file
          const next = processNextFile();
          return result;
        })
        .catch((error) => {
          console.error(`Error processing ${tsFile.path}:`, error);
          activePromises.delete(tsFile.path);
          completed++;

          // Start processing the next file despite error
          const next = processNextFile();
        });

      activePromises.set(tsFile.path, filePromise);
      return filePromise;
    };

    // Start initial batch of file processing
    console.log(`\nProcessing files with ${MAX_CONCURRENT} concurrent workers...`);
    const initialBatchSize = Math.min(MAX_CONCURRENT, queue.length);
    for (let i = 0; i < initialBatchSize; i++) {
      processNextFile();
    }

    // Wait for all files to be processed
    while (activePromises.size > 0) {
      await Promise.race(Array.from(activePromises.values()));
    }

    // Display stats
    console.log('\n=== Comment Extraction and Generation Complete ===');
    console.log(`Total files processed: ${stats.totalFiles}`);
    console.log(`Total nodes found: ${stats.totalNodes}`);
    console.log(`Nodes with existing comments: ${stats.nodesWithComments}`);
    console.log(`Nodes without comments: ${stats.nodesWithoutComments}`);
    console.log(`Comments generated: ${stats.generatedComments}`);

    console.log('\nTo apply these comments to your source files, run:');
    console.log('node tsdoc_applier.js');

    rl.close();
  } catch (error) {
    console.error('Error in main function:', error);
    rl.close();
    process.exit(1);
  }
}

// Export functions for use in other modules
export { findPackages, findTypeScriptFiles, processTypeScriptFile, readReadme };

main();
