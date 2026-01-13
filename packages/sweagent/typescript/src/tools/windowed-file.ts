/**
 * WindowedFile class for managing windowed file editing
 * Converted from Python windowed_file.py
 */

import * as fs from 'fs';
import * as path from 'path';
import { registry } from './registry';

export class TextNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextNotFound';
  }
}

export interface WindowedFileConfig {
  exitOnException?: boolean;
  path?: string;
}

export class WindowedFile {
  private _path: string;
  private _content: string[];
  private _firstLine: number;
  private _window: number;
  public offsetMultiplier: number;
  private exitOnException: boolean;
  private editHistory: string[][] = [];

  constructor(config: WindowedFileConfig = {}) {
    this.exitOnException = config.exitOnException ?? true;
    this.offsetMultiplier = 0.25;

    // Load file path from config or registry
    this._path = config.path || (registry.get('CURRENT_FILE') as string) || '';

    // Load window settings from registry
    this._firstLine = parseInt((registry.get('FIRST_LINE') as string) || '0', 10);
    this._window = parseInt((registry.get('WINDOW') as string) || '10', 10);

    // Load file content if path is set
    if (this._path) {
      this.loadFile();
    } else {
      this._content = [];
    }

    // Ensure firstLine is within bounds after loading content
    // For single-line files, ensure firstLine is 0
    if (this.nLines <= 1) {
      this._firstLine = 0;
    } else {
      this._firstLine = Math.min(this._firstLine, Math.max(0, this.nLines - 1));
    }
  }

  private loadFile(): void {
    if (!fs.existsSync(this._path)) {
      if (this.exitOnException) {
        console.error(`File not found: ${this._path}`);
        process.exit(1);
      }
      throw new Error(`File not found: ${this._path}`);
    }

    const content = fs.readFileSync(this._path, 'utf-8');
    this._content = content.split('\n');

    // Handle empty file or file with only newlines
    // If the file is empty or contains only newlines, ensure we have exactly one empty line
    if (this._content.length === 0 || content.trim() === '') {
      this._content = [''];
    }
  }

  private saveFile(): void {
    const content = this._content.join('\n');
    fs.writeFileSync(this._path, content, 'utf-8');
  }

  private saveRegistry(): void {
    registry.set('CURRENT_FILE', this._path);
    registry.set('FIRST_LINE', this._firstLine.toString());
    registry.set('WINDOW', this._window.toString());
  }

  get path(): path.ParsedPath & { resolve: () => string } {
    const parsed = path.parse(this._path);
    return {
      ...parsed,
      resolve: () => path.resolve(this._path),
    };
  }

  get firstLine(): number {
    return this._firstLine;
  }

  set firstLine(value: number) {
    this._firstLine = Math.max(0, Math.min(value, this.nLines - 1));
    this.saveRegistry();
  }

  get window(): number {
    return this._window;
  }

  set window(value: number) {
    this._window = Math.max(1, value);
    this.saveRegistry();
  }

  get nLines(): number {
    return this._content.length;
  }

  get lineRange(): [number, number] {
    const start = this._firstLine;
    const end = Math.min(this._firstLine + this._window - 1, this.nLines - 1);
    return [start, end];
  }

  printWindow(): void {
    const [start, end] = this.lineRange;

    console.log(`[File: ${path.resolve(this._path)} (${this.nLines} lines total)]`);

    // Print lines above if any
    if (start > 0) {
      console.log(`(${start} more lines above)`);
    }

    // Print window content
    for (let i = start; i <= end; i++) {
      const lineNum = (i + 1).toString().padStart(0, ' ');
      console.log(`${lineNum}:${this._content[i]}`);
    }

    // Print lines below if any
    const remaining = this.nLines - end - 1;
    if (remaining > 0) {
      console.log(`(${remaining} more lines below)`);
    }
  }

  replaceInWindow(oldText: string, newText: string): void {
    const [start, end] = this.lineRange;
    const windowContent = this._content.slice(start, end + 1).join('\n');

    if (!windowContent.includes(oldText)) {
      if (this.exitOnException) {
        console.error(`Text not found in current window: ${oldText}`);
        process.exit(1);
      }
      throw new TextNotFound(`Text not found in current window: ${oldText}`);
    }

    // Replace text
    const newWindowContent = windowContent.replace(oldText, newText);
    const newLines = newWindowContent.split('\n');

    // Update content
    this._content = [...this._content.slice(0, start), ...newLines, ...this._content.slice(end + 1)];

    // Save file
    this.saveFile();

    // Adjust window position (keep it centered on the replacement)
    // Always adjust first line to keep window centered on the replacement
    // This ensures the window shows the replacement area
    const offset = Math.floor(this._window * this.offsetMultiplier) + 1;
    this.firstLine = Math.max(0, this._firstLine - offset);
  }

  goto(lineNumber: number, mode: 'top' | 'center' = 'center'): void {
    if (mode === 'top') {
      // Position window so the target line is offset from top
      const offset = Math.floor(this._window * this.offsetMultiplier);
      this.firstLine = Math.max(0, lineNumber - offset);
    } else {
      // Center the window on the target line
      this.firstLine = Math.max(0, lineNumber - Math.floor(this._window / 2));
    }
  }

  scroll(lines: number): void {
    this.firstLine = this._firstLine + lines;
  }

  getWindowText(header: boolean = false, lineNumbers: boolean = false, footer: boolean = false): string {
    const [start, end] = this.lineRange;
    const lines: string[] = [];

    // Add header
    if (header) {
      lines.push(`[File: ${path.resolve(this._path)} (${this.nLines} lines total)]`);
      if (start > 0) {
        lines.push(`(${start} more lines above)`);
      }
    }

    // Add window content
    for (let i = start; i <= end; i++) {
      if (lineNumbers) {
        const lineNum = (i + 1).toString();
        lines.push(`${lineNum}:${this._content[i]}`);
      } else {
        lines.push(this._content[i]);
      }
    }

    // Add footer
    if (footer) {
      const remaining = this.nLines - end - 1;
      if (remaining > 0) {
        lines.push(`(${remaining} more lines below)`);
      }
    }

    return lines.join('\n');
  }

  findAllOccurrences(searchText: string, zeroBased: boolean = false): number[] {
    const occurrences: number[] = [];

    for (let i = 0; i < this._content.length; i++) {
      if (this._content[i].includes(searchText)) {
        occurrences.push(zeroBased ? i : i + 1);
      }
    }

    return occurrences;
  }

  replace(oldText: string, newText: string): { nReplacements: number; firstReplacedLine: number } {
    // Save current state for undo
    this.editHistory.push([...this._content]);

    let nReplacements = 0;
    let firstReplacedLine = -1;

    for (let i = 0; i < this._content.length; i++) {
      if (this._content[i].includes(oldText)) {
        this._content[i] = this._content[i].replace(new RegExp(oldText, 'g'), newText);
        nReplacements++;
        if (firstReplacedLine === -1) {
          firstReplacedLine = i + 1; // 1-based line number
        }
      }
    }

    if (nReplacements > 0) {
      this.saveFile();
    }

    return { nReplacements, firstReplacedLine };
  }

  insert(text: string, lineNumber: number): { firstInsertedLine: number; nLinesAdded: number } {
    // Save current state for undo
    this.editHistory.push([...this._content]);

    // Convert to 0-based index
    const index = lineNumber;

    // Insert the text at the specified line
    const linesToInsert = text.split('\n');
    this._content.splice(index, 0, ...linesToInsert);

    this.saveFile();

    return {
      firstInsertedLine: lineNumber,
      nLinesAdded: linesToInsert.length,
    };
  }

  undoEdit(): void {
    if (this.editHistory.length > 0) {
      this._content = this.editHistory.pop()!;
      this.saveFile();
    }
  }
}
