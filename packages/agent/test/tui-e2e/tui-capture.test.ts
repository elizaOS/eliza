/**
 * Capture/record artifacts for the TUI e2e lane (#9944 for the terminal surface).
 *
 * Drives a full session through the real shell and proves it produces the three
 * reviewable artifacts: an asciicast `.cast` recording (the "video walkthrough"),
 * a viewport snapshot (screen capture), and a scrollback snapshot (output
 * capture). Writes them to `TUI_EVIDENCE_DIR` when set (the CI job points it at
 * `test-results/evidence/9969-tui-e2e/` and uploads the dir); otherwise to a
 * temp dir so local runs stay clean.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTerminalView, truncateToWidth } from "@elizaos/tui";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { dumpTuiArtifacts, parseAsciicast, toAsciicast } from "./capture.ts";
import {
  bootShell,
  chatRoutes,
  drive,
  KEYS,
  okViewRoutes,
  type,
  viewsRoute,
} from "./harness.ts";

const evidenceDir =
  process.env.TUI_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "eliza-tui-e2e-"));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("TUI e2e capture artifacts", () => {
  it("records a full session as a valid asciicast v2 + viewport/scrollback snapshots", async () => {
    cleanups.push(
      registerTerminalView("wallet", {
        render: (width) => [truncateToWidth("WALLET BODY", width)],
        handleInput: () => {},
        invalidate: () => {},
      }),
    );
    const { terminal } = await bootShell({
      routes: [
        viewsRoute([{ id: "wallet", label: "Wallet TUI" }]),
        ...okViewRoutes,
        ...chatRoutes(),
      ],
    });
    // On failure, leave the artifacts behind for the CI upload.
    onTestFailed(() =>
      dumpTuiArtifacts(terminal, "failure", { dir: evidenceDir }),
    );

    // A representative session: open a view, chat, return to the list.
    await drive(terminal, [KEYS.CTRL_L, "1"]);
    await drive(terminal, [KEYS.CTRL_L]);
    await type(terminal, "record this session");
    await drive(terminal, [KEYS.ENTER]);

    const artifacts = dumpTuiArtifacts(terminal, "session", {
      dir: evidenceDir,
      title: "elizaOS terminal tui e2e",
    });

    // The .cast is a valid asciicast v2 recording with one frame per render.
    const { header, events } = parseAsciicast(artifacts.cast);
    expect(header.version).toBe(2);
    expect(header.width).toBe(80);
    expect(header.height).toBe(24);
    expect(events.length).toBeGreaterThan(0);
    // Frames are monotonically timed (fixed interval, no clock).
    expect(events[events.length - 1][0]).toBeGreaterThan(events[0][0]);
    // The recording's raw stream replays the rendered shell.
    expect(events.map((e) => e[2]).join("")).toContain("elizaOS terminal tui");

    // Screen capture + output capture are non-empty and consistent.
    expect(artifacts.viewport).toContain("elizaOS terminal tui");
    expect(artifacts.scrollback.length).toBeGreaterThanOrEqual(
      artifacts.viewport.length,
    );

    // Files were written for upload.
    expect(artifacts.paths).toBeTruthy();
    for (const path of Object.values(artifacts.paths ?? {})) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("dumps viewport + scrollback to disk on failure for CI attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eliza-tui-fail-"));
    const { terminal } = await bootShell({
      routes: [viewsRoute([{ id: "messages", label: "Messages TUI" }])],
    });
    const dumped = dumpTuiArtifacts(terminal, "boot-failure", { dir });
    expect(dumped.paths).toBeTruthy();
    const viewport = readFileSync(dumped.paths?.viewport ?? "", "utf8");
    expect(viewport).toContain("1. Messages TUI");
    // The .cast round-trips through the parser.
    const cast = readFileSync(dumped.paths?.cast ?? "", "utf8");
    expect(parseAsciicast(cast).header.version).toBe(2);
  });

  it("builds a deterministic recording (fixed frame interval, no clock)", async () => {
    const { terminal } = await bootShell({
      routes: [viewsRoute([{ id: "messages", label: "Messages TUI" }])],
    });
    const a = toAsciicast(terminal, { intervalSec: 0.05 });
    const b = toAsciicast(terminal, { intervalSec: 0.05 });
    expect(a).toBe(b); // same frames → byte-identical recording
  });
});
