/**
 * Patch formatter utilities
 * Converted from sweagent/utils/patch_formatter.py
 */

interface PatchHunk {
  sourceStart: number;
  sourceLines: number;
  targetStart: number;
  targetLines: number;
  lines: string[];
}

interface PatchFile {
  source: string;
  target: string;
  hunks: PatchHunk[];
}

export class PatchFormatter {
  private readMethod: (path: string) => string;
  private parsedPatch: PatchFile[];
  private fileContents: Map<string, string> = new Map();

  constructor(patch: string, readMethod: (path: string) => string) {
    this.readMethod = readMethod;
    this.parsedPatch = this.parsePatch(patch);
  }

  /**
   * Parse a unified diff patch
   */
  private parsePatch(patch: string): PatchFile[] {
    // This is a simplified patch parser
    // In production, you'd want to use a library like 'diff' or 'unidiff'
    const files: PatchFile[] = [];
    const lines = patch.split('\n');
    let currentFile: PatchFile | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        if (currentFile) {
          files.push(currentFile);
        }
        currentFile = {
          source: line.substring(4),
          target: '',
          hunks: [],
        };
      } else if (line.startsWith('+++ ') && currentFile) {
        currentFile.target = line.substring(4);
      } else if (line.startsWith('@@') && currentFile) {
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          currentFile.hunks.push({
            sourceStart: parseInt(match[1]),
            sourceLines: parseInt(match[2] || '1'),
            targetStart: parseInt(match[3]),
            targetLines: parseInt(match[4] || '1'),
            lines: [],
          });
        }
      } else if (currentFile && currentFile.hunks.length > 0) {
        const currentHunk = currentFile.hunks[currentFile.hunks.length - 1];
        currentHunk.lines.push(line);
      }
    }

    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }

  /**
   * Merge overlapping intervals
   */
  private static mergeIntervals(starts: number[], stops: number[]): [number[], number[]] {
    if (starts.length === 0) {
      return [[], []];
    }

    const intervals = starts.map((start, i) => ({ start, stop: stops[i] })).sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; stop: number }> = [intervals[0]];

    for (let i = 1; i < intervals.length; i++) {
      const current = intervals[i];
      const last = merged[merged.length - 1];

      if (current.start <= last.stop + 1) {
        last.stop = Math.max(last.stop, current.stop);
      } else {
        merged.push(current);
      }
    }

    return [merged.map((interval) => interval.start), merged.map((interval) => interval.stop)];
  }

  /**
   * Format a file with line numbers
   */
  formatFile(text: string, starts: number[], stops: number[], options: { linenos?: boolean } = {}): string {
    const { linenos = true } = options;
    const lines = text.split('\n');
    const result: string[] = [];

    for (let i = 0; i < starts.length; i++) {
      const start = Math.max(0, starts[i] - 1);
      const stop = Math.min(lines.length, stops[i]);

      for (let lineNum = start; lineNum < stop; lineNum++) {
        if (linenos) {
          result.push(`${String(lineNum + 1).padStart(6)} | ${lines[lineNum]}`);
        } else {
          result.push(lines[lineNum]);
        }
      }

      if (i < starts.length - 1) {
        result.push('...');
      }
    }

    return result.join('\n');
  }

  /**
   * Get hunk line ranges
   */
  private getHunkLines(original: boolean, contextLength: number = 50): Map<string, [number[], number[]]> {
    const fileRanges = new Map<string, [number[], number[]]>();

    for (const file of this.parsedPatch) {
      const filename = original ? file.source : file.target;
      const cleanName = filename.replace(/^[ab]\//, '');
      const starts: number[] = [];
      const stops: number[] = [];

      for (const hunk of file.hunks) {
        const start = original ? hunk.sourceStart : hunk.targetStart;
        const lines = original ? hunk.sourceLines : hunk.targetLines;

        starts.push(Math.max(1, start - contextLength));
        stops.push(start + lines + contextLength);
      }

      const [mergedStarts, mergedStops] = PatchFormatter.mergeIntervals(starts, stops);
      fileRanges.set(cleanName, [mergedStarts, mergedStops]);
    }

    return fileRanges;
  }

  /**
   * Read files referenced in the patch
   */
  private readFiles(original: boolean): void {
    for (const file of this.parsedPatch) {
      const filename = original ? file.source : file.target;
      const cleanName = filename.replace(/^[ab]\//, '');

      if (!this.fileContents.has(cleanName)) {
        try {
          const content = this.readMethod(cleanName);
          this.fileContents.set(cleanName, content);
        } catch (error) {
          console.error(`Failed to read file ${cleanName}:`, error);
          this.fileContents.set(cleanName, '');
        }
      }
    }
  }

  /**
   * Concatenate file strings
   */
  static concatFilesStrings(files: Map<string, string>): string {
    const result: string[] = [];
    for (const [filename, content] of files) {
      result.push(`[${filename}]`);
      result.push(content);
      result.push('');
    }
    return result.join('\n');
  }

  /**
   * Get formatted files as string
   */
  getFilesStr(
    options: {
      original?: boolean;
      contextLength?: number;
      linenos?: boolean;
    } = {},
  ): string {
    const { original = false, contextLength = 50, linenos = true } = options;

    const fileRanges = this.getHunkLines(original, contextLength);
    this.readFiles(original);

    const formattedFiles = new Map<string, string>();

    for (const [filename, [starts, stops]] of fileRanges) {
      const content = this.fileContents.get(filename);
      if (content) {
        const formatted = this.formatFile(content, starts, stops, { linenos });
        formattedFiles.set(filename, formatted);
      }
    }

    return PatchFormatter.concatFilesStrings(formattedFiles);
  }
}
