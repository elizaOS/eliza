/**
 * Windowed file editor
 * Provides windowed view and editing of files
 * Converted from tools/windowed/
 */

import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import { registry } from '../registry';

interface WindowState {
  currentFile?: string;
  firstLine: number;
  windowSize: number;
  fileContent?: string[];
}

class WindowedEditor {
  private state: WindowState;
  private stateFile: string;

  constructor() {
    // Use ROOT environment variable or temp directory for state file
    const rootDir = process.env.ROOT || process.env.TMPDIR || '/tmp';
    this.stateFile = path.join(rootDir, 'window_state.json');
    this.state = this.loadState();
  }

  private loadState(): WindowState {
    // Try to load from state file
    if (fs.existsSync(this.stateFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      } catch {
        // Fall through to defaults
      }
    }

    // Load from registry or use defaults
    return {
      currentFile: registry.get('CURRENT_FILE', undefined) as string | undefined,
      firstLine: parseInt(String(registry.get('FIRST_LINE', '1'))),
      windowSize: parseInt(String(registry.get('WINDOW_SIZE', '50'))),
    };
  }

  private saveState(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    
    // Also save to registry for compatibility
    if (this.state.currentFile) {
      registry.set('CURRENT_FILE', this.state.currentFile);
    }
    registry.set('FIRST_LINE', this.state.firstLine.toString());
    registry.set('WINDOW_SIZE', this.state.windowSize.toString());
  }

  private loadFile(filePath: string): string[] {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n');
  }

  private saveFile(filePath: string, lines: string[]): void {
    const content = lines.join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  private printWindow(showLineNumbers: boolean = true, showStatus: boolean = true): void {
    if (!this.state.currentFile || !this.state.fileContent) {
      console.error('No file open. Use the open command first.');
      return;
    }

    const endLine = Math.min(
      this.state.firstLine + this.state.windowSize - 1,
      this.state.fileContent.length
    );

    // Print window content
    for (let i = this.state.firstLine - 1; i < endLine; i++) {
      if (showLineNumbers) {
        const lineNum = (i + 1).toString().padStart(6, ' ');
        console.log(`${lineNum}:${this.state.fileContent[i]}`);
      } else {
        console.log(this.state.fileContent[i]);
      }
    }

    // Print status line
    if (showStatus) {
      console.log(`[File: ${this.state.currentFile} (${this.state.fileContent.length} lines total)]`);
      console.log(`[Window: ${this.state.firstLine} - ${endLine}]`);
    }
  }

  open(filePath: string, line?: number): void {
    const absPath = path.resolve(filePath);
    this.state.currentFile = absPath;
    this.state.fileContent = this.loadFile(absPath);
    this.state.firstLine = line || 1;
    this.saveState();
    
    console.log(`Opened ${absPath}`);
    this.printWindow();
  }

  goto(line: number): void {
    if (!this.state.fileContent) {
      console.error('No file open.');
      return;
    }

    if (line < 1 || line > this.state.fileContent.length) {
      console.error(`Line ${line} out of range. File has ${this.state.fileContent.length} lines.`);
      return;
    }

    this.state.firstLine = line;
    this.saveState();
    this.printWindow();
  }

  scrollDown(lines?: number): void {
    if (!this.state.fileContent) {
      console.error('No file open.');
      return;
    }

    const scrollAmount = lines || 10;
    const maxLine = Math.max(1, this.state.fileContent.length - this.state.windowSize + 1);
    this.state.firstLine = Math.min(this.state.firstLine + scrollAmount, maxLine);
    this.saveState();
    this.printWindow();
  }

  scrollUp(lines?: number): void {
    if (!this.state.fileContent) {
      console.error('No file open.');
      return;
    }

    const scrollAmount = lines || 10;
    this.state.firstLine = Math.max(1, this.state.firstLine - scrollAmount);
    this.saveState();
    this.printWindow();
  }

  edit(startLine: number, endLine: number, newContent: string): void {
    if (!this.state.currentFile || !this.state.fileContent) {
      console.error('No file open.');
      return;
    }

    if (startLine < 1 || endLine > this.state.fileContent.length || startLine > endLine) {
      console.error(`Invalid line range: ${startLine}-${endLine}`);
      return;
    }

    // Replace lines with new content
    const newLines = newContent.split('\n');
    const before = this.state.fileContent.slice(0, startLine - 1);
    const after = this.state.fileContent.slice(endLine);
    
    this.state.fileContent = [...before, ...newLines, ...after];
    
    // Save file
    this.saveFile(this.state.currentFile, this.state.fileContent);
    this.saveState();
    
    console.log(`Edited lines ${startLine}-${endLine} in ${this.state.currentFile}`);
    this.printWindow();
  }

  create(filePath: string, content?: string): void {
    const absPath = path.resolve(filePath);
    
    if (fs.existsSync(absPath)) {
      console.error(`File already exists: ${absPath}`);
      return;
    }

    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const initialContent = content || '';
    fs.writeFileSync(absPath, initialContent, 'utf-8');
    
    console.log(`Created ${absPath}`);
    this.open(absPath);
  }
}

// CLI if run directly
// CLI setup
const editor = new WindowedEditor();

// Only set up CLI commands if running as a script
function setupCLI() {
  program
    .name('windowed-editor')
    .description('Windowed file editor')
    .version('1.0.0');

  program
    .command('open <file>')
    .description('Open a file')
    .option('-l, --line <line>', 'Start at specific line', parseInt)
    .action((file, options) => {
      editor.open(file, options.line);
    });

  program
    .command('goto <line>')
    .description('Go to a specific line')
    .action((line) => {
      editor.goto(parseInt(line));
    });

  program
    .command('scroll_down [lines]')
    .description('Scroll down')
    .action((lines) => {
      editor.scrollDown(lines ? parseInt(lines) : undefined);
    });

  program
    .command('scroll_up [lines]')
    .description('Scroll up')
    .action((lines) => {
      editor.scrollUp(lines ? parseInt(lines) : undefined);
    });

  program
    .command('edit <start> <end>')
    .description('Edit lines')
    .requiredOption('-c, --content <text>', 'New content')
    .action((start, end, options) => {
      editor.edit(parseInt(start), parseInt(end), options.content);
    });

  program
    .command('create <file>')
    .description('Create a new file')
    .option('-c, --content <text>', 'Initial content')
    .action((file, options) => {
      editor.create(file, options.content);
    });
}

// Set up and parse CLI
if (require.main === module) {
  setupCLI();
  program.parse(process.argv);
}

export { WindowedEditor };
