#!/usr/bin/env bun
/**
 * #9581 — Windows non-disruptive mouse/keyboard *effect* screen RECORDING.
 *
 * The capture harness (`capture-windows-desktop-evidence.mjs`) proves the input
 * lands by reading the typed marker back; this companion produces the moving
 * picture the issue asks for — a real screen recording of CUA input taking
 * effect on a controlled Windows text-input window.
 *
 * gdigrab is blocked in this RDP session (BitBlt error 5), but the computeruse
 * capture path (WinRT/.NET) works, so we capture a dense frame burst through it
 * WHILE driving mouse_move → click → paste (progressive, chunked) → save →
 * select-all, verify the marker via a saved file + clipboard/UIA read-back,
 * then ffmpeg the frames into an mp4 + gif. Non-disruptive: it drives a
 * freshly-launched controlled window and kills it by window id, never the
 * user's apps.
 *
 * Run: bun scripts/record-windows-cua-input.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClipboard, writeClipboard } from "../src/platform/clipboard.ts";
import { ComputerUseService } from "../src/services/computer-use-service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = path.join(
  repoRoot,
  "test-results/evidence/9581-windows-cua/input-recording",
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

function windowHaystack(w) {
  return `${w?.app ?? ""} ${w?.title ?? ""}`.toLowerCase();
}

function looksLikeTargetWindow(w, targetTitle) {
  return windowHaystack(w).includes(targetTitle.toLowerCase());
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createInputTargetScript(title, savePath) {
  const savedTitle = `${title} (saved)`;
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$savePath = ${psSingleQuote(savePath)}
$form = New-Object System.Windows.Forms.Form
$form.Text = ${psSingleQuote(title)}
$form.Width = 920
$form.Height = 680
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.AcceptsReturn = $true
$box.AcceptsTab = $true
$box.ScrollBars = 'Both'
$box.WordWrap = $false
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 16)
$form.Controls.Add($box)
$save = {
  [System.IO.File]::WriteAllText($savePath, $box.Text)
  $form.Text = ${psSingleQuote(savedTitle)}
}
$box.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::S) {
    & $save
    $_.SuppressKeyPress = $true
  }
})
$form.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::S) {
    & $save
    $_.SuppressKeyPress = $true
  }
})
$form.Add_Shown({ $box.Focus() })
[void]$form.ShowDialog()
`;
}

function readWindowTextViaUia(windowId) {
  const pid = Number.parseInt(String(windowId), 10);
  if (!Number.isFinite(pid) || pid <= 0) return "";
  const ps = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if ($null -eq $root) { exit 0 }
$nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $nodes.Count; $i++) {
  $el = $nodes.Item($i)
  try {
    $pattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $text = $pattern.DocumentRange.GetText(-1)
      if ($text) { [void]$out.Add($text) }
    }
  } catch {}
  try {
    $pattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = $pattern.Current.Value
      if ($value) { [void]$out.Add($value) }
    }
  } catch {}
  try {
    $name = $el.Current.Name
    if ($name) { [void]$out.Add($name) }
  } catch {}
}
$out -join "\`n"
`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
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
  const phrase = token;
  const chunks = phrase.match(/.{1,12}/g) ?? [phrase];
  const targetTitle = `elizaOS CUA Input Target ${process.pid}`;
  const targetTextFile = path.join(outDir, "windows-cua-input-target.txt");
  const targetScript = path.join(outDir, "windows-cua-input-target.ps1");
  await writeFile(targetTextFile, "", "utf8");
  await writeFile(
    targetScript,
    createInputTargetScript(targetTitle, targetTextFile),
    "utf8",
  );

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
  let targetWindow = null;
  let verified = false;
  let verificationMethod = "none";
  let verificationReadback = "";

  try {
    const displays = service.getDisplays();

    const launched = await service.executeCommand("launch", {
      app: "cmd.exe",
      appArgs: [
        "/c",
        "start",
        "",
        "powershell.exe",
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        targetScript,
      ],
    });
    if (!launched.success) {
      throw new Error(
        `launch input target failed: ${launched.error ?? "unknown"}`,
      );
    }

    // Resolve the real target window by the generated title. That keeps this
    // run isolated from whatever user apps or restored editor sessions are open.
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await service.executeWindowAction({ action: "list" });
      targetWindow =
        (found?.windows ?? []).find((window) =>
          looksLikeTargetWindow(window, targetTitle),
        ) ?? null;
      if (targetWindow?.id) break;
      await sleep(250);
    }
    if (!targetWindow?.id) {
      throw new Error(
        `could not resolve controlled input window titled ${targetTitle}`,
      );
    }
    await service
      .executeWindowAction({ action: "focus", windowId: targetWindow.id })
      .catch(() => {});
    await sleep(500);
    await captureFrame(
      service,
      "controlled text target launched (empty)",
      frames,
    );

    // Maximize the target, then read its actual bounds. Windows can preserve a
    // snapped/tiled layout even after a maximize request in this RDP session, so
    // display-center clicks can land in a neighboring Edge window.
    await service
      .executeWindowAction({ action: "maximize", windowId: targetWindow.id })
      .catch(() => {});
    await sleep(700);
    await captureFrame(
      service,
      "controlled text target maximized (empty)",
      frames,
    );

    const bounds = await service.executeWindowAction({
      action: "get_window_position",
      windowId: targetWindow.id,
    });
    if (!bounds.success || !bounds.bounds) {
      throw new Error(
        `could not read target bounds: ${bounds.error ?? "unknown"}`,
      );
    }
    const b = bounds.bounds;
    // Aim at the center of the multiline text box.
    const globalX = Math.round(b.x + b.width / 2);
    const globalY = Math.round(b.y + b.height / 2);
    const display = displayForPoint(displays, globalX, globalY);
    if (!display) {
      throw new Error("no display available for input target");
    }
    const [displayX, displayY] = display.bounds;
    const coordinate = [globalX - displayX, globalY - displayY];

    // Click to focus + place the caret; Ctrl+End re-homes the caret so re-clicks
    // between chunks never split the text.
    const focusControlledTarget = async () => {
      if (!targetWindow?.id) {
        throw new Error("Input target window is not resolved");
      }
      await service
        .executeWindowAction({ action: "focus", windowId: targetWindow.id })
        .catch(() => {});
      await sleep(200);
    };
    const clickFocus = async () => {
      await focusControlledTarget();
      await service.executeCommand("click", {
        coordinate,
        displayId: display.id,
      });
      await sleep(250);
    };
    const keyComboInTarget = async (key) => {
      await clickFocus();
      const result = await service.executeCommand("key_combo", { key });
      if (!result.success) {
        throw new Error(`key_combo ${key} failed: ${result.error}`);
      }
      await sleep(250);
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
      await keyComboInTarget("ctrl+End");
      await writeClipboard(chunk);
      await keyComboInTarget("ctrl+v");
      typedSoFar += chunk;
      await captureFrame(
        service,
        `pasted ${typedSoFar.length}/${phrase.length} chars via ctrl+v`,
        frames,
      );
    }
    await keyComboInTarget("ctrl+s");
    await sleep(700);
    await captureFrame(service, "ctrl+s saved the typed text file", frames);

    // Ask for select-all (visible when the legacy SendKeys driver manages to
    // keep focus), then verify by clipboard. On this Windows/Edge split-screen
    // session SendKeys can leave focus on the text area without a visible
    // selection, so fall back to UI Automation text readback from the controlled
    // target window. These methods read the real app/window, not a mock.
    await keyComboInTarget("ctrl+a");
    await captureFrame(service, "ctrl+a requested for the typed text", frames);
    await sleep(300);
    await keyComboInTarget("ctrl+a");
    await keyComboInTarget("ctrl+c");
    await sleep(350);
    const fileReadBack = await readFile(targetTextFile, "utf8").catch(() => "");
    const readBack = await readClipboard().catch(() => "");
    const uiaReadBack = readWindowTextViaUia(targetWindow.id);
    const freshWindows = await service.executeCommand("list_windows");
    const titleReadBack = Array.isArray(freshWindows.windows)
      ? freshWindows.windows
          .filter((window) => looksLikeTargetWindow(window, targetTitle))
          .map((window) => `${window.title ?? ""} ${window.app ?? ""}`.trim())
          .join("\n")
      : "";
    if (fileReadBack.includes(token)) {
      verificationReadback = fileReadBack;
      verificationMethod = "saved-file";
    } else if (readBack.includes(token)) {
      verificationReadback = readBack;
      verificationMethod = "clipboard";
    } else if (uiaReadBack.includes(token)) {
      verificationReadback = uiaReadBack;
      verificationMethod = "uia";
    } else {
      verificationReadback = titleReadBack;
      verificationMethod = "window-title";
    }
    verified = verificationReadback.includes(token);
    await captureFrame(
      service,
      verified
        ? `verified: marker read back from target via ${verificationMethod}`
        : "read-back did NOT contain the marker",
      frames,
    );

    if (!verified) {
      throw new Error(
        `read-back missing marker; clipboard=${JSON.stringify(
          readBack.slice(0, 80),
        )}; savedFile=${JSON.stringify(
          fileReadBack.slice(0, 120),
        )}; uia=${JSON.stringify(
          uiaReadBack.slice(0, 120),
        )}; title=${JSON.stringify(titleReadBack.slice(0, 120))}`,
      );
    }
  } finally {
    if (targetWindow?.id) {
      const killed = await service
        .executeCommand("kill_app", { target: String(targetWindow.id) })
        .catch(() => ({ success: false }));
      if (!killed.success) {
        await service
          .executeCommand("close_window", { windowId: targetWindow.id })
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

  const initialFrame = frames[1] ?? frames[0];
  const finalFrame = frames[frames.length - 1];
  const initialStill = path.join(outDir, "initial-empty-input-window.png");
  const finalStill = path.join(outDir, "final-typed-selected.png");
  if (initialFrame) {
    await copyFile(path.join(framesDir, initialFrame.name), initialStill);
  }
  if (finalFrame) {
    await copyFile(path.join(framesDir, finalFrame.name), finalStill);
  }

  const readme = `# #9581 — Windows non-disruptive mouse/keyboard effect screen recording

The capture harness proves Windows CUA input lands by reading the typed marker
back. This is the moving-picture companion: a real screen recording of CUA mouse
and keyboard input taking effect on a controlled Windows text-input window.

Captured on a real Windows 11 Pro host (QEMU), 1728x1052, via
\`plugins/plugin-computeruse/scripts/record-windows-cua-input.mjs\`:

1. launch a generated Windows Forms text target through computeruse
2. click inside the controlled text box bounds
3. progressively paste a marker with \`Ctrl+V\` while capturing frames
4. save with \`Ctrl+S\` and verify the marker from the real saved file/window

Frames are captured through the computeruse WinRT/.NET capture path and
assembled into MP4/GIF with ffmpeg.

| File | What it is |
|------|------------|
| \`windows-cua-input.gif\` | Inline recording of the run. |
| \`windows-cua-input.mp4\` | Same recording, H.264. |
| \`final-typed-selected.png\` | Final frame after verification; the typed marker is visible in the target. |
| \`initial-empty-input-window.png\` | Early frame before typing. |
| \`windows-cua-input-target.txt\` | The real text file saved by the \`Ctrl+S\` step. |
| \`windows-cua-input-target.ps1\` | The generated controlled Windows Forms target used for the run. |
| \`recording-summary.json\` | Run metadata, including \`verified: true\` and verification method. |

Verification method for this run: \`${verificationMethod}\`.
`;
  await writeFile(path.join(outDir, "README.md"), readme);

  const summary = {
    issue: 9581,
    capturedAt: new Date().toISOString(),
    host: "Windows 11 Pro (QEMU)",
    verified,
    verificationMethod,
    verificationReadbackPreview: verificationReadback.slice(0, 240),
    marker: token,
    phrase,
    frameCount: frames.length,
    frames,
    artifacts: {
      mp4: path.relative(repoRoot, mp4),
      gif: path.relative(repoRoot, gif),
      initialStill: path.relative(repoRoot, initialStill),
      finalStill: path.relative(repoRoot, finalStill),
      savedTextFile: path.relative(repoRoot, targetTextFile),
      targetScript: path.relative(repoRoot, targetScript),
      readme: path.relative(repoRoot, path.join(outDir, "README.md")),
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
