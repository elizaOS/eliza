/**
 * Covers the `FilteringTerminal` wrapper: the interception gate must swallow
 * input the app claims before it reaches the TUI host, and every remaining
 * `Terminal` operation must delegate verbatim to the stdio-backed
 * {@link ProcessTerminal} instance the wrapper owns. Deterministic harness —
 * each test stubs only the inner terminal's stdio methods at instance level
 * (never real stdin/stdout) and drives the real wrapper logic.
 */
import { ProcessTerminal } from "@elizaos/tui";
import { describe, expect, it } from "vitest";
import { FilteringTerminal } from "./filtering-terminal.js";

type InnerAccess = { inner: ProcessTerminal };

function innerOf(terminal: FilteringTerminal): ProcessTerminal {
  return (terminal as unknown as InnerAccess).inner;
}

/** Records start() wiring without touching process.stdin/stdout. */
function captureStart(inner: ProcessTerminal) {
  const captured: {
    input?: (data: string) => void;
    resize?: () => void;
  } = {};
  inner.start = (onInput, onResize) => {
    captured.input = onInput;
    captured.resize = onResize;
  };
  return captured;
}

describe("FilteringTerminal", () => {
  it("binds a real ProcessTerminal as its inner terminal", () => {
    const terminal = new FilteringTerminal(() => false);
    expect(innerOf(terminal)).toBeInstanceOf(ProcessTerminal);
  });

  it("forwards non-intercepted input to the host handler in order", () => {
    const terminal = new FilteringTerminal(() => false);
    const captured = captureStart(innerOf(terminal));
    const received: string[] = [];

    terminal.start(
      (data) => received.push(data),
      () => {},
    );
    captured.input?.("a");
    captured.input?.("b");
    captured.input?.("c");

    expect(received).toEqual(["a", "b", "c"]);
  });

  it("swallows intercepted input so it never reaches the host handler", () => {
    const terminal = new FilteringTerminal(() => true);
    const captured = captureStart(innerOf(terminal));
    let received = 0;

    terminal.start(
      () => received++,
      () => {},
    );
    captured.input?.("x");
    captured.input?.("\x1b[16~");

    expect(received).toBe(0);
  });

  it("evaluates the interceptor per chunk, so a mixed stream splits cleanly", () => {
    const shortcuts = new Set(["\x01", "\x05"]); // Ctrl+A, Ctrl+E
    const terminal = new FilteringTerminal((data) => shortcuts.has(data));
    const captured = captureStart(innerOf(terminal));
    const received: string[] = [];

    terminal.start(
      (data) => received.push(data),
      () => {},
    );
    captured.input?.("h");
    captured.input?.("\x01");
    captured.input?.("i");
    captured.input?.("\x05");
    captured.input?.("!"); // not in the set despite the earlier intercept

    expect(received).toEqual(["h", "i", "!"]);
  });

  it("hands the interceptor the whole paste-sized chunk as one decision", () => {
    let inspected = "";
    const terminal = new FilteringTerminal((data) => {
      inspected = data;
      return data.length > 3;
    });
    const captured = captureStart(innerOf(terminal));
    const received: string[] = [];

    terminal.start(
      (data) => received.push(data),
      () => {},
    );
    const paste = "a long pasted sentence";
    captured.input?.(`\x1b[200~${paste}\x1b[201~`);

    expect(inspected).toBe(`\x1b[200~${paste}\x1b[201~`);
    expect(received).toEqual([]); // chunk exceeded the limit: swallowed whole
  });

  it("passes the host resize handler through by reference", () => {
    const terminal = new FilteringTerminal(() => false);
    const captured = captureStart(innerOf(terminal));
    const appResize = () => {};

    terminal.start(() => {}, appResize);

    expect(captured.resize).toBe(appResize);
  });

  it("keeps instances independent: separate inner terminals and verdicts", () => {
    const alwaysIntercept = new FilteringTerminal(() => true);
    const neverIntercept = new FilteringTerminal(() => false);
    const interceptedStart = captureStart(innerOf(alwaysIntercept));
    const passthroughStart = captureStart(innerOf(neverIntercept));
    expect(innerOf(alwaysIntercept)).not.toBe(innerOf(neverIntercept));

    let passthroughReceived = "";
    let interceptedReceived = "";
    neverIntercept.start(
      (data) => {
        passthroughReceived += data;
      },
      () => {},
    );
    alwaysIntercept.start(
      (data) => {
        interceptedReceived += data;
      },
      () => {},
    );

    interceptedStart.input?.("q");
    passthroughStart.input?.("q");

    // The intercepting wrapper swallowed its chunk without touching the other.
    expect(interceptedReceived).toBe("");
    expect(passthroughReceived).toBe("q");
  });
});

describe("FilteringTerminal delegation", () => {
  it("stop() delegates to the inner terminal exactly once", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    let stops = 0;
    inner.stop = () => stops++;

    terminal.stop();

    expect(stops).toBe(1);
  });

  it("drainInput() forwards both timeouts and resolves with the inner result", async () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const seen: Array<number | undefined> = [];
    inner.drainInput = async (maxMs?: number, idleMs?: number) => {
      seen.push(maxMs, idleMs);
    };

    await expect(terminal.drainInput(7, 3)).resolves.toBeUndefined();
    expect(seen).toEqual([7, 3]);
  });

  it("drainInput() without arguments forwards no timeouts", async () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const seen: Array<number | undefined> = [];
    inner.drainInput = async (maxMs?: number, idleMs?: number) => {
      seen.push(maxMs, idleMs);
    };

    await terminal.drainInput();

    expect(seen).toEqual([undefined, undefined]);
  });

  it("write() delegates the payload verbatim", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const written: string[] = [];
    inner.write = (data) => written.push(data);

    const frame = "\x1b[2J\x1b[Hhello";
    terminal.write(frame);

    expect(written).toEqual([frame]);
  });

  it("moveBy() delegates positive and negative line counts unchanged", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const moved: number[] = [];
    inner.moveBy = (lines) => moved.push(lines);

    terminal.moveBy(4);
    terminal.moveBy(-2);
    terminal.moveBy(0);

    expect(moved).toEqual([4, -2, 0]);
  });

  it("cursor and screen operations each delegate once", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const calls: string[] = [];
    const record = (method: string) => () => calls.push(method);
    inner.hideCursor = record("hideCursor");
    inner.showCursor = record("showCursor");
    inner.clearLine = record("clearLine");
    inner.clearFromCursor = record("clearFromCursor");
    inner.clearScreen = record("clearScreen");

    terminal.hideCursor();
    terminal.showCursor();
    terminal.clearLine();
    terminal.clearFromCursor();
    terminal.clearScreen();

    expect(calls).toEqual([
      "hideCursor",
      "showCursor",
      "clearLine",
      "clearFromCursor",
      "clearScreen",
    ]);
  });

  it("setTitle() delegates the title verbatim", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);
    const titles: string[] = [];
    inner.setTitle = (title) => titles.push(title);

    terminal.setTitle("eliza-code — project");

    expect(titles).toEqual(["eliza-code — project"]);
  });

  it("routes columns, rows and kittyProtocolActive getters to the inner terminal", () => {
    const terminal = new FilteringTerminal(() => false);
    const inner = innerOf(terminal);

    // Real initial state of a fresh ProcessTerminal.
    expect(terminal.kittyProtocolActive).toBe(false);

    Object.defineProperty(inner, "columns", {
      get: () => 101,
      configurable: true,
    });
    Object.defineProperty(inner, "rows", { get: () => 24, configurable: true });
    Object.defineProperty(inner, "kittyProtocolActive", {
      get: () => true,
      configurable: true,
    });

    expect(terminal.columns).toBe(101);
    expect(terminal.rows).toBe(24);
    expect(terminal.kittyProtocolActive).toBe(true);
  });
});
