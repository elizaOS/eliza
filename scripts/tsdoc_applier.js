import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Define __dirname for ES modules
const __dirname = new URL('.', import.meta.url).pathname;

// Create readline interface for user interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

// Configuration
const COMMENTS_DIR = path.join(__dirname, 'tsdoc_comments');

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

// Check if a node already has JSDoc comments
function hasJSDocComment(node, sourceFile) {
  const jsDocComments = ts.getJSDocCommentRanges(node, sourceFile.text);
  return jsDocComments && jsDocComments.length > 0;
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

// Get comments file path for a TypeScript file
function getCommentsFilePath(tsFile) {
  const relativePath = path.relative(path.join(__dirname, '../packages'), tsFile.packageRoot);
  const commentsDir = path.join(COMMENTS_DIR, relativePath, path.dirname(tsFile.relativePath));

  if (!fs.existsSync(commentsDir)) {
    fs.mkdirSync(commentsDir, { recursive: true });
  }

  return path.join(commentsDir, `${path.basename(tsFile.path)}.json`);
}

// Apply comments back to the original files
async function applyCommentsToFiles(packagePath, options = {}) {
  const { dryRun = false, verbose = false, maxConcurrent = 10 } = options;

  try {
    const tsFiles = await findTypeScriptFiles(packagePath);

    // Use a queue-based approach for parallel processing
    const queue = [...tsFiles];
    const activePromises = new Map(); // Use Map to keep track of file -> promise
    const updatedFiles = [];
    let completed = 0;

    // Function to process a single file
    const processFile = async (tsFile) => {
      const commentsFilePath = getCommentsFilePath(tsFile);

      if (!fs.existsSync(commentsFilePath)) {
        if (verbose) {
          console.log(`No comments file found for ${tsFile.path}, skipping`);
        }
        return null;
      }

      const comments = JSON.parse(fs.readFileSync(commentsFilePath, 'utf8'));
      const fileContent = fs.readFileSync(tsFile.path, 'utf8');

      // Create a program for this file
      const program = ts.createProgram([tsFile.path], {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      });

      const sourceFile = program.getSourceFile(tsFile.path);

      // Collect nodes and their positions
      const nodes = [];

      function visit(node) {
        if (
          ts.isClassDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)
        ) {
          const name = getNodeName(node);
          if (comments[name] && !hasJSDocComment(node, sourceFile)) {
            nodes.push({
              name,
              position: node.getStart(sourceFile),
              comment: comments[name].comment,
            });
          }
        }

        if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach((declaration) => {
            const name = getNodeName(declaration);
            if (comments[name] && !hasJSDocComment(declaration, sourceFile)) {
              nodes.push({
                name,
                position: declaration.getStart(sourceFile),
                comment: comments[name].comment,
              });
            }
          });
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);

      // Sort nodes by position in descending order to avoid position shifts
      nodes.sort((a, b) => b.position - a.position);

      // Apply comments
      let updatedContent = fileContent;
      let changed = false;

      for (const node of nodes) {
        // Add the comment at the node position
        updatedContent =
          updatedContent.substring(0, node.position) +
          `${node.comment}\n` +
          updatedContent.substring(node.position);
        changed = true;
      }

      if (changed) {
        // Count lines before and after
        const originalLines = fileContent.split('\n').length;
        const updatedLines = updatedContent.split('\n').length;

        // Verify that we haven't lost any content
        if (updatedLines >= originalLines) {
          if (!dryRun) {
            fs.writeFileSync(tsFile.path, updatedContent);
          }

          const result = {
            path: tsFile.path,
            originalLines,
            updatedLines,
            addedComments: nodes.length,
          };

          console.log(
            `${dryRun ? '[DRY RUN] Would update' : 'Updated'} ${tsFile.path} with ${nodes.length} comments`
          );
          return result;
        } else {
          console.error(
            `Error: Updated file has fewer lines than original. Skipping: ${tsFile.path}`
          );
          return null;
        }
      } else if (verbose) {
        console.log(`No changes to make for ${tsFile.path}`);
        return null;
      }

      return null;
    };

    // Function to start processing a file from the queue
    const processNextFile = () => {
      if (queue.length === 0) return null;

      const tsFile = queue.shift();
      const filePromise = processFile(tsFile)
        .then((result) => {
          // File processing complete
          activePromises.delete(tsFile.path);
          completed++;

          if (result) {
            updatedFiles.push(result);
          }

          // Log progress
          if (verbose || completed % 10 === 0) {
            const percent = Math.round((completed / tsFiles.length) * 100);
            console.log(`[${percent}%] Processed ${tsFile.path} (${completed}/${tsFiles.length})`);
          }

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
    const initialBatchSize = Math.min(maxConcurrent, queue.length);
    for (let i = 0; i < initialBatchSize; i++) {
      processNextFile();
    }

    // Wait for all files to be processed
    while (activePromises.size > 0) {
      await Promise.race(Array.from(activePromises.values()));
    }

    return updatedFiles;
  } catch (error) {
    console.error('Error applying comments to files:', error);
    return [];
  }
}

// List comment files and their statistics
async function listCommentFiles() {
  if (!fs.existsSync(COMMENTS_DIR)) {
    console.log('No comments directory found. Generate comments first using tsdoc_generator.js');
    return [];
  }

  const commentFiles = [];

  function scanDir(dir) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        scanDir(itemPath);
      } else if (item.endsWith('.json')) {
        try {
          const comments = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
          const commentCount = Object.keys(comments).length;
          const autoGenCount = Object.values(comments).filter((c) => c.autoGenerated).length;

          commentFiles.push({
            path: itemPath,
            totalComments: commentCount,
            autoGenerated: autoGenCount,
            manual: commentCount - autoGenCount,
          });
        } catch (error) {
          console.error(`Error reading comment file ${itemPath}:`, error);
        }
      }
    }
  }

  scanDir(COMMENTS_DIR);
  return commentFiles;
}

// Main function
async function main() {
  try {
    console.log('TSDoc Comment Applier');
    console.log('====================\n');

    // List comment files
    console.log('Finding comment files...');
    const commentFiles = await listCommentFiles();

    if (commentFiles.length === 0) {
      console.log('No comment files found. Run tsdoc_generator.js first to generate comments.');
      rl.close();
      return;
    }

    console.log(
      `Found ${commentFiles.length} comment files with a total of ${commentFiles.reduce((sum, file) => sum + file.totalComments, 0)} comments`
    );
    console.log(
      `- Auto-generated comments: ${commentFiles.reduce((sum, file) => sum + file.autoGenerated, 0)}`
    );
    console.log(`- Manual comments: ${commentFiles.reduce((sum, file) => sum + file.manual, 0)}\n`);

    // Ask if user wants to apply comments
    const applyResponse = await prompt(
      'Do you want to apply these comments to the source files? (yes/no/dry): '
    );

    if (applyResponse.toLowerCase() !== 'yes' && applyResponse.toLowerCase() !== 'dry') {
      console.log('Operation cancelled.');
      rl.close();
      return;
    }

    const dryRun = applyResponse.toLowerCase() === 'dry';

    if (dryRun) {
      console.log('\nRunning in DRY RUN mode - no files will be modified\n');
    }

    // Ask for concurrency level
    const concurrencyResponse = await prompt(
      'How many files to process concurrently? (default: 10): '
    );
    const maxConcurrent = Number.parseInt(concurrencyResponse) || 10;
    console.log(`Processing with ${maxConcurrent} concurrent workers\n`);

    // Find all packages
    const packages = await findPackages();

    const updatedFilesStats = {
      updatedFiles: 0,
      totalCommentsAdded: 0,
    };

    // Apply comments to files for each package
    for (const packagePath of packages) {
      console.log(`\nApplying comments to package: ${path.basename(packagePath)}`);

      const updatedFiles = await applyCommentsToFiles(packagePath, {
        dryRun,
        verbose: false,
        maxConcurrent,
      });

      updatedFilesStats.updatedFiles += updatedFiles.length;
      updatedFilesStats.totalCommentsAdded += updatedFiles.reduce(
        (sum, file) => sum + file.addedComments,
        0
      );

      // Display per-file stats
      for (const file of updatedFiles) {
        console.log(
          `  - ${path.basename(file.path)}: ${dryRun ? 'Would add' : 'Added'} ${file.addedComments} comments (${file.originalLines} → ${file.updatedLines} lines)`
        );
      }
    }

    // Display final stats
    console.log('\n=== Final Results ===');
    console.log(
      `Files ${dryRun ? 'that would be updated' : 'updated'}: ${updatedFilesStats.updatedFiles}`
    );
    console.log(
      `Total comments ${dryRun ? 'that would be added' : 'added'}: ${updatedFilesStats.totalCommentsAdded}`
    );

    if (dryRun) {
      console.log('\nThis was a dry run. No files were modified.');
      console.log('Run again with "yes" to apply the changes.');
    }

    console.log('\nTSDoc application process complete!');
    rl.close();
  } catch (error) {
    console.error('Error in main function:', error);
    rl.close();
    process.exit(1);
  }
}

// Run the main function if this script is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import('url').then((url) => {
    global.fileURLToPath = url.fileURLToPath;
    main();
  });
}

export { applyCommentsToFiles };
