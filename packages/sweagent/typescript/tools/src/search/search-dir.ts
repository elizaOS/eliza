#!/usr/bin/env node
/**
 * Search directory tool
 * Search for a term in all files within a directory
 * Converted from tools/search/bin/search_dir
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { program } from 'commander';

function searchDir(searchTerm: string, dir: string = './'): void {
  // Check if directory exists
  if (!fs.existsSync(dir)) {
    console.error(`Directory ${dir} not found`);
    process.exit(1);
  }

  const absDir = path.resolve(dir);

  try {
    // Use grep to search files (excluding hidden files)
    const grepCmd = `find "${absDir}" -type f ! -path '*/.*' -exec grep -nIH -- "${searchTerm}" {} + 2>/dev/null | cut -d: -f1 | sort | uniq -c`;
    
    let matches: string;
    try {
      matches = execSync(grepCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error: unknown) {
      // grep returns non-zero when no matches found
      const execError = error as { status?: number; stdout?: string };
      if (execError.status === 1 || !execError.stdout) {
        console.log(`No matches found for "${searchTerm}" in ${absDir}`);
        return;
      }
      throw error;
    }

    if (!matches.trim()) {
      console.log(`No matches found for "${searchTerm}" in ${absDir}`);
      return;
    }

    // Parse matches
    const matchLines = matches.trim().split('\n');
    const fileMatches: Array<{ file: string; count: number }> = [];
    
    matchLines.forEach(line => {
      const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (match) {
        const count = parseInt(match[1], 10);
        const file = match[2];
        fileMatches.push({ file, count });
      }
    });

    // Check if too many files
    if (fileMatches.length > 100) {
      console.error(`More than ${fileMatches.length} files matched for "${searchTerm}" in ${absDir}. Please narrow your search.`);
      return;
    }

    // Calculate total matches
    const totalMatches = fileMatches.reduce((sum, fm) => sum + fm.count, 0);

    // Print results
    console.log(`Found ${totalMatches} matches for "${searchTerm}" in ${absDir}:`);
    fileMatches.forEach(fm => {
      const relPath = path.relative(process.cwd(), fm.file);
      console.log(`${relPath} (${fm.count} matches)`);
    });
    console.log(`End of matches for "${searchTerm}" in ${absDir}`);

  } catch (error) {
    console.error(`Error searching directory: ${error}`);
    process.exit(1);
  }
}

// CLI if run directly
// CLI setup
function setupCLI() {
  program
    .name('search-dir')
    .description('Search for a term in all files within a directory')
    .version('1.0.0')
    .argument('<search-term>', 'The term to search for')
    .argument('[dir]', 'The directory to search in (default: current directory)', './')
    .action((searchTerm, dir) => {
      searchDir(searchTerm, dir);
    });

  program.parse(process.argv);
}

// Run CLI if called directly or from bin script
if (require.main === module || require.main?.filename?.endsWith('/bin/search_dir')) {
  setupCLI();
}

export { searchDir };
