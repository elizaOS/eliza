/**
 * Drives the production cockpit route in Chromium and preserves pixels, video,
 * console/network logs, and the exact create-then-spawn request receipt.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  compileTailwindTheme,
  writeFixturePage,
} from "../../../../packages/ui/src/testing/e2e-runner/fixture-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const uiRoot = join(repoRoot, "packages/ui");
const outDir = join(here, "output");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const css = await compileTailwindTheme({
  uiRoot,
  sources: [
    join(uiRoot, "src/components/cockpit"),
    join(
      uiRoot,
      "src/components/chat/widgets/agent-orchestrator-room-view.tsx",
    ),
    join(uiRoot, "src/components/ui"),
    join(repoRoot, "plugins/plugin-task-coordinator/src/CockpitRoute.tsx"),
  ],
});

const adapter = join(here, "cockpit-browser-ui-adapter.ts");
const inactivePanes = join(here, "cockpit-browser-inactive-panes.tsx");
const pageUrl = await writeFixturePage({
  entry: join(here, "cockpit-browser-fixture.tsx"),
  outDir,
  htmlName: "cockpit-browser.html",
  title: "Coding Cockpit browser proof",
  tailwind: { css },
  htmlClass: "dark",
  background: "#16121c",
  processShim: true,
  plugins: [
    {
      name: "cockpit-ui-boundary",
      setup(build) {
        build.onResolve({ filter: /^@elizaos\/ui$/ }, () => ({
          path: adapter,
        }));
        build.onResolve({ filter: /^@elizaos\/shared$/ }, () => ({
          path: adapter,
        }));
        build.onResolve(
          { filter: /^\.\/Cockpit(?:InteractiveTerminal|SessionPane)$/ },
          () => ({ path: inactivePanes }),
        );
      },
    },
  ],
});

const browser = await chromium.launch();
const requestReceipt = [];
const runSurface = async ({ name, width, height, drive }) => {
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: outDir, size: { width, height } },
  });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (message) =>
    logs.push({ kind: "console", level: message.type(), text: message.text() }),
  );
  page.on("request", (request) =>
    logs.push({
      kind: "request",
      method: request.method(),
      url: request.url(),
    }),
  );
  page.on("response", (response) =>
    logs.push({
      kind: "response",
      status: response.status(),
      url: response.url(),
    }),
  );
  await page.route("http://cockpit.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      requestReceipt.push({
        path: url.pathname,
        method: request.method(),
        body: request.postDataJSON(),
      });
    }
    const body =
      url.pathname === "/api/orchestrator/rooms"
        ? { rooms: [] }
        : url.pathname === "/api/projects"
          ? { projects: [{ repoUrl: "https://github.com/elizaOS/eliza" }] }
          : url.pathname === "/api/orchestrator/tasks"
            ? { id: "task-browser-proof" }
            : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  try {
    await page.goto(pageUrl);
    await page.getByTestId("cockpit-new-session-form").waitFor();
    await drive(page);
    await page.screenshot({
      path: join(outDir, `${name}.jpg`),
      type: "jpeg",
      quality: 90,
      fullPage: true,
    });
    await writeFile(
      join(outDir, `${name}-browser-log.json`),
      JSON.stringify(logs, null, 2),
    );
  } finally {
    await page.close();
    await context.close();
  }
};

try {
  for (const surface of [
    { name: "cockpit-desktop", width: 1440, height: 900 },
    { name: "cockpit-mobile", width: 390, height: 844 },
  ]) {
    await runSurface({
      ...surface,
      drive: async (page) => {
        const repo = page.getByTestId("cockpit-repo-input");
        await repo.waitFor();
        assert(
          (await repo.getAttribute("list")) !== null,
          "repo autocomplete was not loaded",
        );
        await page
          .getByTestId("cockpit-goal-input")
          .fill("Fix cockpit browser evidence and open a PR");
        await page.getByTestId("cockpit-workdir-input").fill("packages/ui");
        await page.getByTestId("cockpit-workdir-error").waitFor();
        assert(
          await page.getByTestId("cockpit-start-button").isDisabled(),
          "invalid target did not disable submit",
        );
        await page.screenshot({
          path: join(outDir, `${surface.name}-validation.jpg`),
          type: "jpeg",
          quality: 90,
          fullPage: true,
        });
        await repo.fill("elizaOS/eliza");
        await page
          .getByTestId("cockpit-workdir-error")
          .waitFor({ state: "detached" });
        await page.getByTestId("cockpit-start-button").click();
        await page.waitForResponse((response) =>
          response
            .url()
            .endsWith("/api/orchestrator/tasks/task-browser-proof/agents"),
        );
      },
    });
  }

  assert(
    requestReceipt.length === 4,
    `expected four POSTs across two surfaces, got ${requestReceipt.length}`,
  );
  for (let index = 0; index < requestReceipt.length; index += 2) {
    const create = requestReceipt[index];
    const spawn = requestReceipt[index + 1];
    assert(
      create.path === "/api/orchestrator/tasks",
      "task creation was not first",
    );
    assert(
      spawn.path === "/api/orchestrator/tasks/task-browser-proof/agents",
      "agent spawn was not second",
    );
    assert(
      create.body.providerPolicy.preferredFramework === "elizaos",
      "create policy lost framework",
    );
    assert(
      create.body.providerPolicy.providerSource === "eliza-cloud",
      "create policy lost provider",
    );
    assert(spawn.body.repo === "elizaOS/eliza", "spawn lost repo");
    assert(spawn.body.workdir === "packages/ui", "spawn lost workdir");
  }
  await writeFile(
    join(outDir, "cockpit-request-receipt.json"),
    JSON.stringify(requestReceipt, null, 2),
  );
} finally {
  await browser.close();
}

console.log(`Cockpit browser proof passed; artifacts: ${outDir}`);
