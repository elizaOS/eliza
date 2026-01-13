#!/usr/bin/env node
/**
 * Filemap tool
 * Print Python file contents, skipping lengthy function bodies
 * Converted from tools/filemap/bin/filemap
 */

import { program } from 'commander';
import * as fs from 'fs';
import Parser from 'tree-sitter';
import * as Python from 'tree-sitter-python';

interface ElidedRange {
  start: number;
  end: number;
}

function createFilemap(filePath: string): void {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Read file content
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  
  // Initialize parser
  const parser = new Parser();
  parser.setLanguage(Python as any);
  
  // Parse the file
  const tree = parser.parse(fileContent);
  
  // Query for function bodies
  const query = new Parser.Query(
    Python as any,
    `(function_definition body: (_) @body)`
  );
  
  const captures = query.captures(tree.rootNode);
  const elideRanges: ElidedRange[] = [];
  
  // Find ranges to elide (function bodies with 5+ lines)
  for (const { node } of captures) {
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    
    if (endLine - startLine >= 5) {
      elideRanges.push({ start: startLine, end: endLine });
    }
  }
  
  // Build output with elided ranges
  const lines = fileContent.split('\n');
  const elidedLines = new Set<number>();
  const elideMessages: Array<{ line: number; message: string }> = [];
  
  for (const range of elideRanges) {
    for (let i = range.start; i <= range.end; i++) {
      elidedLines.add(i);
    }
    elideMessages.push({
      line: range.start,
      message: `... eliding lines ${range.start + 1}-${range.end + 1} ...`
    });
  }
  
  // Combine regular lines and elide messages
  const output: Array<{ line: number; content: string }> = [];
  
  lines.forEach((line, index) => {
    if (!elidedLines.has(index)) {
      output.push({ line: index, content: line });
    }
  });
  
  elideMessages.forEach(msg => {
    output.push({ line: msg.line, content: msg.message });
  });
  
  // Sort by line number and print
  output.sort((a, b) => a.line - b.line);
  
  output.forEach(item => {
    const lineNum = (item.line + 1).toString().padStart(6, ' ');
    console.log(`${lineNum} ${item.content}`);
  });
}

// CLI if run directly
if (require.main === module) {
  program
    .name('filemap')
    .description('Print Python file contents, skipping lengthy function bodies')
    .version('1.0.0')
    .argument('<file-path>', 'Path to the Python file to process')
    .action((filePath) => {
      createFilemap(filePath);
    });

  program.parse(process.argv);
}

export { createFilemap };
