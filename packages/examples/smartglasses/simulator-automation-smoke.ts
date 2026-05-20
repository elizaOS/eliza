import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const appPort = Number(process.env.SMARTGLASSES_SIMULATOR_APP_PORT ?? 5178);
const automationPort = Number(
  process.env.SMARTGLASSES_SIMULATOR_AUTOMATION_PORT ?? 9898,
);
const appUrl = `http://127.0.0.1:${appPort}/evenhub-smoke.html`;
const automationUrl = `http://127.0.0.1:${automationPort}`;
const audioDevice = process.env.SMARTGLASSES_SIMULATOR_AUDIO_DEVICE;
const readyMarker = "[eliza-smartglasses] ready";
const timeoutMs = Number(
  process.env.SMARTGLASSES_SIMULATOR_TIMEOUT_MS ?? 60_000,
);
const scriptDir = dirname(fileURLToPath(import.meta.url));

type ConsoleEntry = {
  id?: number;
  message?: string;
  args?: unknown[];
  level?: string;
};

type ConsoleResponse = {
  entries?: ConsoleEntry[];
  total?: number;
};

const children: ChildProcessWithoutNullStreams[] = [];

function startProcess(
  label: string,
  command: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: scriptDir,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (chunk) =>
    process.stdout.write(`[${label}] ${chunk}`),
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(`[${label}] ${chunk}`),
  );
  return child;
}

async function main(): Promise<void> {
  startProcess("vite", "bun", [
    "x",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(appPort),
  ]);
  await waitForHttp(`http://127.0.0.1:${appPort}/evenhub-smoke.html`);

  startProcess("simulator", "bun", [
    "x",
    "@evenrealities/evenhub-simulator@latest",
    appUrl,
    "--automation-port",
    String(automationPort),
    "--no-glow",
    ...(audioDevice ? ["--aid", audioDevice] : []),
  ]);
  await waitForPing();
  await waitForConsoleMessage((text) => text.includes(readyMarker));

  const boot = await getGlassesScreenshot();
  const bootLitPixels = litPixelCount(boot);
  if (bootLitPixels < 100) {
    throw new Error(
      `Simulator framebuffer is blank: litPixels=${bootLitPixels}`,
    );
  }
  await sleep(1_000);

  await postInput("down");
  await sleep(500);
  await postInput("click");
  await waitForConsoleMessage(
    (text) => text.includes("single_tap"),
    "single_tap",
  );

  await postInput("double_click");
  await waitForConsoleMessage(
    (text) => text.includes("double_tap"),
    "double_tap",
  );

  if (audioDevice) {
    await postInput("click");
    await waitForConsoleMessage(
      (text) => text.includes("audio"),
      "audio event",
    );
  }

  const after = await getGlassesScreenshot();
  const afterLitPixels = litPixelCount(after);
  console.log(
    JSON.stringify(
      {
        appUrl,
        automationUrl,
        bootLitPixels,
        afterLitPixels,
      },
      null,
      2,
    ),
  );
}

async function waitForPing(): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${automationUrl}/api/ping`);
    if (!response.ok) return false;
    return (await response.text()).includes("pong");
  }, "simulator automation ping");
}

async function waitForHttp(url: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url);
    return response.ok;
  }, url);
}

async function waitForConsoleMessage(
  predicate: (text: string) => boolean,
  label = "console marker",
): Promise<void> {
  let sinceId = 0;
  try {
    await waitFor(async () => {
      const response = await fetch(
        `${automationUrl}/api/console?since_id=${sinceId}`,
      );
      if (!response.ok) return false;
      const data = (await response.json()) as ConsoleResponse;
      for (const entry of data.entries ?? []) {
        sinceId = Math.max(sinceId, entry.id ?? sinceId);
        const text = consoleEntryText(entry);
        if (predicate(text)) return true;
      }
      return false;
    }, label);
  } catch (error) {
    const tail = await getConsoleTail().catch(() => []);
    throw new Error(`${String(error)}\nConsole tail:\n${tail.join("\n")}`);
  }
}

async function getConsoleTail(): Promise<string[]> {
  const response = await fetch(`${automationUrl}/api/console`);
  if (!response.ok) return [];
  const data = (await response.json()) as ConsoleResponse;
  return (data.entries ?? []).slice(-20).map(consoleEntryText);
}

async function postInput(
  action: "click" | "double_click" | "up" | "down",
): Promise<void> {
  const response = await fetch(`${automationUrl}/api/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) {
    throw new Error(`POST /api/input ${action} failed with ${response.status}`);
  }
}

async function getGlassesScreenshot(): Promise<InstanceType<typeof PNG>> {
  const response = await fetch(`${automationUrl}/api/screenshot/glasses`);
  if (!response.ok) {
    throw new Error(`/api/screenshot/glasses failed with ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const png = PNG.sync.read(bytes);
  if (png.width !== 576 || png.height !== 288) {
    throw new Error(`Unexpected screenshot size ${png.width}x${png.height}`);
  }
  return png;
}

function litPixelCount(png: InstanceType<typeof PNG>): number {
  let count = 0;
  for (let index = 3; index < png.data.length; index += 4) {
    if (png.data[index] > 0) count += 1;
  }
  return count;
}

function consoleEntryText(entry: ConsoleEntry): string {
  return [entry.level, entry.message, ...(entry.args ?? []).map(String)]
    .filter(Boolean)
    .join(" ");
}

async function waitFor(
  probe: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}${
      lastError ? `: ${String(lastError)}` : ""
    }`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup(): Promise<void> {
  for (const child of [...children].reverse()) {
    killProcessTree(child, "SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of [...children].reverse()) {
    killProcessTree(child, "SIGKILL");
  }
}

function killProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

main()
  .finally(cleanup)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
