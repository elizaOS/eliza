import type { Terminal } from "@elizaos/tui";
import { ProcessTerminal } from "@elizaos/tui";

/**
 * Wraps {@link ProcessTerminal} so the app can handle global shortcuts before
 * the focused TUI component receives stdin.
 */
export class FilteringTerminal implements Terminal {
  private readonly inner = new ProcessTerminal();

  constructor(private readonly onIntercept: (data: string) => boolean) {
    // onIntercept returns true when the event was handled and should not reach the TUI
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start((data: string) => {
      if (this.onIntercept(data)) {
        return;
      }
      onInput(data);
    }, onResize);
  }

  stop(): void {
    this.inner.stop();
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.inner.write(data);
  }

  get columns(): number {
    return this.inner.columns;
  }

  get rows(): number {
    return this.inner.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }

  hideCursor(): void {
    this.inner.hideCursor();
  }

  showCursor(): void {
    this.inner.showCursor();
  }

  clearLine(): void {
    this.inner.clearLine();
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor();
  }

  clearScreen(): void {
    this.inner.clearScreen();
  }

  setTitle(title: string): void {
    this.inner.setTitle(title);
  }
}
