#!/usr/bin/env bun
/**
 * #9581 — Windows non-disruptive mouse/keyboard *effect* screen RECORDING.
 *
 * The capture harness (`capture-windows-desktop-evidence.mjs`) proves the input
 * lands by reading the typed marker back; this companion produces the moving
 * picture the issue asks for — a real screen recording of CUA input taking
 * effect on a controlled Notepad window.
 *
 * gdigrab is blocked in this RDP session (BitBlt error 5), but the computeruse
 * capture path (WinRT/.NET) works, so we capture a dense frame burst through it
 * WHILE driving mouse_move → click → type (progressive, chunked) → select-all,
 * verify the marker via clipboard read-back, then ffmpeg the frames into an mp4
 * + gif. Non-disruptive: it drives a freshly-launched Notepad and kills it by
 * window id, never the user's apps.
 *
 * Run: bun scripts/record-windows-cua-input.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClipboard, writeClipboard } from "../src/platform/clipboard.ts";
import { ComputerUseService } from "../src/services/computer-use-service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = path.join(
  repoRoot,
  ".github/issue-evidence/9581-windows-cua/input-recording",
);
const framesDir = path.join(outDir, "frames");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createRuntime(settings = {}) {
  return {
    character: {},
    getSetting: (k) => settings[k],
    getService: () => null,
  };
}

function displayForPoint(displays, x, y) {
  return (
    displays.find((d) => {
      const [dx, dy, w, h] = d.bounds;
      return x >= dx && x < dx + w && y >= dy && y < dy + h;
    }) ??
    displays.find((d) => d.primary) ??
    displays[0]
  );
}

function looksLikeNotepad(w) {
  const hay = `${w?.app ?? ""} ${w?.title ?? ""}`.toLowerCase();
  return /notepad|untitled|\.txt|text editor/.test(hay);
}

let frameIndex = 0;
async function captureFrame(service, label, frames) {
  const shot = await service.executeCommand("screenshot");
  if (!shot.success || !shot.screenshot) {
    throw new Error(`screenshot failed: ${shot.error ?? "no payload"}`);
  }
  const buf = Buffer.from(shot.screenshot, "base64");
  const name = `frame-${String(frameIndex).padStart(3, "0")}.png`;
  await writeFile(path.join(framesDir, name), buf);
  frames.push({ index: frameIndex, name, label, bytes: buf.length });
  frameIndex++;
  return buf.length;
}

async function main() {
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(framesDir, { recursive: true });

  const token = `eliza-win-cua-${Date.now()}`;
  const phrase = `elizaOS CUA on Windows -- #9581 mouse+keyboard input proof ${token}`;
  const chunks = phrase.match(/.{1,12}/g) ?? [phrase];

  const service = await ComputerUseService.start(
    createRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      // Explicit captures only — no implicit post-action screenshots (faster,
      // and we control exactly which frames make the recording).
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
      COMPUTER_USE_BROWSER_HEADLESS: "true",
    }),
  );

  const frames = [];
  const originalClipboard = await readClipboard().catch(() => "");
  let notepadWindow = null;
  let verified = false;

  try {
    const displays = service.getDisplays();

    const launched = await service.executeCommand("launch", {
      app: "notepad.exe",
    });
    if (!launched.success) {
      throw new Error(`launch notepad failed: ${launched.error ?? "unknown"}`);
    }
    await sleep(1800);
    await captureFrame(service, "controlled Notepad launched (empty)", frames);

    // Resolve the real Notepad window (Win11 re-parents the editor under a new pid).
    const active = await service.executeWindowAction({
      action: "get_current_window_id",
    });
    if (active?.success && active.window && looksLikeNotepad(active.window)) {
      notepadWindow = active.window;
    } else {
      const found = await service.executeWindowAction({
        action: "get_application_windows",
        appName: "Notepad",
      });
      notepadWindow = (found?.windows ?? []).find(looksLikeNotepad) ?? null;
    }
    if (!notepadWindow?.id) {
      throw new Error("could not resolve the controlled Notepad window");
    }

    // Maximize Notepad so it fills the primary display — then a click at the
    // display centre ALWAYS lands inside its text area regardless of z-order,
    // and (crucially on Windows) a synthetic click foregrounds the window under
    // the cursor even when SetForegroundWindow is blocked by the foreground
    // lock. Each capture frame is a PowerShell/WinRT spawn that can steal focus,
    // so we re-click + ctrl+End to re-focus and re-home the caret before every
    // keystroke batch.
    await service
      .executeWindowAction({ action: "maximize", windowId: notepadWindow.id })
      .catch(() => {});
    await sleep(700);
    await captureFrame(service, "controlled Notepad maximized (empty)", frames);

    const display = displays.find((d) => d.primary) ?? displays[0];
    const [dx, dy, dw, dh] = display.bounds;
    // Aim at the upper-middle of the text area (well below the title/tab bar).
    const coordinate = [Math.round(dw / 2), Math.round(dh * 0.4)];

    // Click to focus + place the caret; `goEnd` re-homes the caret to the end so
    // re-clicks between chunks never split the text.
    const clickFocus = async () => {
      await service.executeCommand("click", {
        coordinate,
        displayId: display.id,
      });
      await sleep(150);
    };
    const goEnd = async () => {
      await service
        .executeCommand("key_combo", { key: "ctrl+End" })
        .catch(() => {});
    };

    await service
      .executeCommand("mouse_move", { coordinate, displayId: display.id })
      .catch(() => {});
    await clickFocus();
    await captureFrame(
      service,
      "clicked into the text area (caret active)",
      frames,
    );

    // Progressive, chunked typing so the recording shows text appearing.
    let typedSoFar = "";
    for (const chunk of chunks) {
      await clickFocus();
      await goEnd();
      const typed = await service.executeCommand("type", { text: chunk });
      if (!typed.success) throw new Error(`type failed: ${typed.error}`);
      typedSoFar += chunk;
      await captureFrame(
        service,
        `typed ${typedSoFar.length}/${phrase.length} chars`,
        frames,
      );
    }

    // Select-all (visible highlight), then verify via copy + clipboard read-back.
    await clickFocus();
    await service.executeCommand("key_combo", { key: "ctrl+a" });
    await captureFrame(service, "ctrl+a selected the typed text", frames);
    await sleep(300);
    await clickFocus();
    await service.executeCommand("key_combo", { key: "ctrl+a" });
    await service.executeCommand("key_combo", { key: "ctrl+c" });
    await sleep(350);
    const readBack = await readClipboard().catch(() => "");
    verified = readBack.includes(token);
    await captureFrame(
      service,
      verified
        ? "verified: marker read back from Notepad via clipboard"
        : "read-back did NOT contain the marker",
      frames,
    );

    if (!verified) {
      throw new Error(
        `read-back missing marker; clipboard=${JSON.stringify(readBack.slice(0, 80))}`,
      );
    }
  } finally {
    if (notepadWindow?.id) {
      const killed = await service
        .executeCommand("kill_app", { target: String(notepadWindow.id) })
        .catch(() => ({ success: false }));
      if (!killed.success) {
        await service
          .executeCommand("close_window", { windowId: notepadWindow.id })
          .catch(() => {});
      }
    }
    await writeClipboard(originalClipboard).catch(() => {});
    await service.stop().catch(() => {});
  }

  // Assemble the frame burst into an mp4 + gif (ffmpeg reads PNG files, not the
  // blocked gdigrab device). ~2.5 fps reads as a clear step-by-step recording.
  const fps = "5/2";
  const pattern = path.join(framesDir, "frame-%03d.png");
  const mp4 = path.join(outDir, "windows-cua-input.mp4");
  const gif = path.join(outDir, "windows-cua-input.gif");
  const palette = path.join(outDir, "palette.png");

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      fps,
      "-i",
      pattern,
      "-vf",
      "scale=1100:-2:flags=lanczos,format=yuv420p",
      "-r",
      "12",
      mp4,
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      fps,
      "-i",
      pattern,
      "-vf",
      "scale=1000:-1:flags=lanczos,palettegen",
      palette,
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      fps,
      "-i",
      pattern,
      "-i",
      palette,
      "-lavfi",
      "scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse",
      "-r",
      "6",
      gif,
    ],
    { stdio: "pipe" },
  );
  await rm(palette, { force: true }).catch(() => {});

  const summary = {
    issue: 9581,
    capturedAt: new Date().toISOString(),
    host: "Windows 11 Pro (QEMU)",
    verified,
    marker: token,
    phrase,
    frameCount: frames.length,
    frames,
    artifacts: {
      mp4: path.relative(repoRoot, mp4),
      gif: path.relative(repoRoot, gif),
      framesDir: path.relative(repoRoot, framesDir),
    },
  };
  await writeFile(
    path.join(outDir, "recording-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(
    JSON.stringify(
      {
        status: verified ? "passed" : "failed",
        ...summary.artifacts,
        frameCount: frames.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
