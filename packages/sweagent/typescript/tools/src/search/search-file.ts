#!/usr/bin/env node
/**
 * Search file tool
 * Search for a term within a specific file
 * Converted from tools/search/bin/search_file
 */

import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import { registry } from '../registry';

function searchFile(searchTerm: string, filePath?: string): void {
  // Get current file from registry if not provided
  if (!filePath) {
    filePath = String(registry.get('CURRENT_FILE', ''));
    if (!filePath) {
      console.error('No file open. Use the open command first or provide a file path.');
      process.exit(1);
    }
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File name ${filePath} not found. Please provide a valid file name.`);
    process.exit(1);
  }

  // Resolve to absolute path
  filePath = path.resolve(filePath);

  // Read file and search
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const matches: Array<{ line: number; content: string }> = [];

    lines.forEach((line, index) => {
      if (line.includes(searchTerm)) {
        matches.push({ line: index + 1, content: line });
      }
    });

    if (matches.length === 0) {
      console.log(`No matches found for "${searchTerm}" in ${filePath}`);
      return;
    }

    // Check if too many matches
    const uniqueLines = new Set(matches.map(m => m.line));
    if (uniqueLines.size > 100) {
      console.error(`More than ${uniqueLines.size} lines matched for "${searchTerm}" in ${filePath}. Please narrow your search.`);
      return;
    }

    // Print results
    console.log(`Found ${matches.length} matches for "${searchTerm}" in ${filePath}:`);
    matches.forEach(match => {
      console.log(`Line ${match.line}:${match.content}`);
    });
    console.log(`End of matches for "${searchTerm}" in ${filePath}`);

  } catch (error) {
    console.error(`Error reading file: ${error}`);
    process.exit(1);
  }
}

// CLI if run directly
// CLI setup
function setupCLI() {
  program
    .name('search-file')
    .description('Search for a term within a file')
    .version('1.0.0')
    .argument('<search-term>', 'The term to search for')
    .argument('[file]', 'The file to search in (if not provided, uses current open file)')
    .action((searchTerm, file) => {
      searchFile(searchTerm, file);
    });

  program.parse(process.argv);
}

// Run CLI if called directly or from bin script
if (require.main === module || require.main?.filename?.endsWith('/bin/search_file')) {
  setupCLI();
}

export { searchFile };
