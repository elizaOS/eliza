/**
 * String replace editor tool
 * Anthropic-style text editor with view, create, and edit capabilities
 * Converted from tools/edit_anthropic/bin/str_replace_editor
 */

import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import { registry } from '../registry';
import { execSync } from 'child_process';

const MAX_RESPONSE_LEN = 16000;
const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';

interface FileHistory {
  [filePath: string]: string[];
}

class EditTool {
  private fileHistory: FileHistory = {};
  private encoding: BufferEncoding = 'utf-8';

  constructor() {
    // Load file history from registry if available
    const historyStr = registry.get('file_history', '{}');
    try {
      this.fileHistory = JSON.parse(String(historyStr));
    } catch {
      this.fileHistory = {};
    }
  }

  private saveHistory(): void {
    registry.set('file_history', JSON.stringify(this.fileHistory));
  }

  private validatePath(command: string, filePath: string): string {
    // Convert relative paths to absolute
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(filePath);
    }

    if (!fs.existsSync(filePath) && command !== 'create') {
      console.error(`The path ${filePath} does not exist. Please provide a valid path.`);
      process.exit(7);
    }

    if (fs.existsSync(filePath) && command === 'create') {
      console.error(`File already exists at: ${filePath}. Cannot overwrite files using command \`create\`.`);
      process.exit(8);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() && command !== 'view') {
      console.error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`);
      process.exit(9);
    }
    
    return filePath;
  }

  private readFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, this.encoding);
    } catch (error) {
      console.error(`Error reading file ${filePath}: ${error}`);
      process.exit(19);
    }
  }

  private writeFile(filePath: string, content: string): void {
    try {
      fs.writeFileSync(filePath, content, this.encoding);
    } catch (error) {
      console.error(`Error writing file ${filePath}: ${error}`);
      process.exit(20);
    }
  }

  private truncate(content: string): string {
    if (content.length <= MAX_RESPONSE_LEN) {
      return content;
    }
    return content.substring(0, MAX_RESPONSE_LEN) + TRUNCATED_MESSAGE;
  }

  private formatOutput(content: string, descriptor: string, initLine: number = 1): string {
    const truncated = this.truncate(content);
    const lines = truncated.split('\n');
    const numbered = lines.map((line, i) => {
      const lineNum = (i + initLine).toString().padStart(6, ' ');
      return `${lineNum}\t${line}`;
    }).join('\n');
    
    return `Here's the result of running \`cat -n\` on ${descriptor}:\n${numbered}\n`;
  }

  view(filePath: string, viewRange?: [number, number]): void {
    filePath = this.validatePath('view', filePath);

    if (fs.statSync(filePath).isDirectory()) {
      // List directory contents
      try {
        const output = execSync(
          `find "${filePath}" -maxdepth 2 -not -path '*/\\.*'`,
          { encoding: 'utf-8' }
        );
        console.log(`Here's the files and directories up to 2 levels deep in ${filePath}, excluding hidden items:\n${output}\n`);
      } catch (error) {
        console.error(`Error listing directory: ${error}`);
      }
      return;
    }

    const content = this.readFile(filePath);
    const lines = content.split('\n');

    if (viewRange) {
      const [start, end] = viewRange;
      if (start < 1 || start > lines.length) {
        console.error(`Invalid view_range: [${start}, ${end}]. First element should be within [1, ${lines.length}]`);
        process.exit(12);
      }
      if (end !== -1 && end > lines.length) {
        console.error(`Invalid view_range: [${start}, ${end}]. Second element should be <= ${lines.length}`);
        process.exit(13);
      }
      if (end !== -1 && end < start) {
        console.error(`Invalid view_range: [${start}, ${end}]. Second element should be >= ${start}`);
        process.exit(14);
      }

      const finalEnd = end === -1 ? lines.length : end;
      const rangeContent = lines.slice(start - 1, finalEnd).join('\n');
      console.log(this.formatOutput(rangeContent, filePath, start));
    } else {
      console.log(this.formatOutput(content, filePath));
    }
  }

  create(filePath: string, fileText: string): void {
    filePath = this.validatePath('create', filePath);
    
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      console.error(`The parent directory ${dir} does not exist. Please create it first.`);
      process.exit(21);
    }

    this.writeFile(filePath, fileText);
    if (!this.fileHistory[filePath]) {
      this.fileHistory[filePath] = [];
    }
    this.fileHistory[filePath].push(fileText);
    this.saveHistory();
    
    console.log(`File created successfully at: ${filePath}`);
  }

  strReplace(filePath: string, oldStr: string, newStr?: string): void {
    filePath = this.validatePath('str_replace', filePath);
    
    const content = this.readFile(filePath);
    const expandedOldStr = oldStr.replace(/\t/g, '    ');
    const expandedNewStr = (newStr || '').replace(/\t/g, '    ');
    const expandedContent = content.replace(/\t/g, '    ');

    // Check occurrences
    const occurrences = (expandedContent.match(new RegExp(expandedOldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    
    if (occurrences === 0) {
      console.error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`);
      process.exit(15);
    }
    
    if (occurrences > 1) {
      const lines = expandedContent.split('\n');
      const matchingLines = lines
        .map((line, i) => expandedOldStr.split('\n').some(oldLine => line.includes(oldLine)) ? i + 1 : null)
        .filter(n => n !== null);
      console.error(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines ${matchingLines}. Please ensure it is unique`);
      process.exit(16);
    }

    if (expandedNewStr === expandedOldStr) {
      console.error(`No replacement was performed, old_str \`${oldStr}\` is the same as new_str \`${newStr}\`.`);
      process.exit(161);
    }

    // Save history
    if (!this.fileHistory[filePath]) {
      this.fileHistory[filePath] = [];
    }
    this.fileHistory[filePath].push(content);
    this.saveHistory();

    // Perform replacement
    const newContent = expandedContent.replace(expandedOldStr, expandedNewStr);
    this.writeFile(filePath, newContent);

    // Create snippet
    const replacementLine = expandedContent.split(expandedOldStr)[0].split('\n').length;
    const snippetStart = Math.max(1, replacementLine - 4);
    const snippetEnd = Math.min(replacementLine + 4 + expandedNewStr.split('\n').length, newContent.split('\n').length);
    const snippet = newContent.split('\n').slice(snippetStart - 1, snippetEnd).join('\n');

    console.log(`The file ${filePath} has been edited. ${this.formatOutput(snippet, `a snippet of ${filePath}`, snippetStart)}Review the changes and make sure they are as expected. Edit the file again if necessary.`);
  }

  insert(filePath: string, insertLine: number, newStr: string): void {
    filePath = this.validatePath('insert', filePath);
    
    const content = this.readFile(filePath);
    const lines = content.split('\n');
    
    if (insertLine < 0 || insertLine > lines.length) {
      console.error(`Invalid insert_line parameter: ${insertLine}. Should be within [0, ${lines.length}]`);
      process.exit(17);
    }

    // Save history
    if (!this.fileHistory[filePath]) {
      this.fileHistory[filePath] = [];
    }
    this.fileHistory[filePath].push(content);
    this.saveHistory();

    // Insert new content
    const newLines = newStr.split('\n');
    const updatedLines = [
      ...lines.slice(0, insertLine),
      ...newLines,
      ...lines.slice(insertLine)
    ];
    
    const newContent = updatedLines.join('\n');
    this.writeFile(filePath, newContent);

    // Create snippet
    const snippetStart = Math.max(0, insertLine - 4);
    const snippetEnd = insertLine + newLines.length + 4;
    const snippet = updatedLines.slice(snippetStart, snippetEnd).join('\n');

    console.log(`The file ${filePath} has been edited. ${this.formatOutput(snippet, 'a snippet of the edited file', snippetStart + 1)}Review the changes and make sure they are as expected.`);
  }

  undoEdit(filePath: string): void {
    filePath = this.validatePath('undo_edit', filePath);
    
    if (!this.fileHistory[filePath] || this.fileHistory[filePath].length === 0) {
      console.error(`No edit history found for ${filePath}.`);
      process.exit(18);
    }

    const oldText = this.fileHistory[filePath].pop()!;
    this.saveHistory();
    this.writeFile(filePath, oldText);
    
    console.log(`Last edit to ${filePath} undone successfully. ${this.formatOutput(oldText, filePath)}`);
  }
}

// CLI if run directly
// CLI setup - runs when module is loaded
const editor = new EditTool();

program
  .name('str-replace-editor')
  .description('Text editor with view, create, and edit capabilities')
  .version('1.0.0');

program
  .command('view <path>')
  .description('View a file or directory')
  .option('--view-range <start> <end>', 'View specific line range')
  .action((filePath, options) => {
    const viewRange = options.viewRange ? 
      [parseInt(options.viewRange[0]), parseInt(options.viewRange[1])] as [number, number] : 
      undefined;
    editor.view(filePath, viewRange);
  });

program
  .command('create <path>')
  .description('Create a new file')
  .requiredOption('--file-text <text>', 'Content of the file to create')
  .action((filePath, options) => {
    editor.create(filePath, options.fileText);
  });

program
  .command('str_replace <path>')
  .description('Replace text in a file')
  .requiredOption('--old-str <text>', 'Text to replace')
  .option('--new-str <text>', 'Text to replace with')
  .action((filePath, options) => {
    editor.strReplace(filePath, options.oldStr, options.newStr);
  });

program
  .command('insert <path>')
  .description('Insert text at a specific line')
  .requiredOption('--insert-line <line>', 'Line number to insert after', parseInt)
  .requiredOption('--new-str <text>', 'Text to insert')
  .action((filePath, options) => {
    editor.insert(filePath, options.insertLine, options.newStr);
  });

program
  .command('undo_edit <path>')
  .description('Undo the last edit to a file')
  .action((filePath) => {
    editor.undoEdit(filePath);
  });

// Parse arguments when loaded
if (require.main === module || require.main?.filename?.endsWith('/bin/str_replace_editor')) {
  program.parse(process.argv);
}

export { EditTool };
