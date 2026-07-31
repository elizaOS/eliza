/**
 * Drives the built contribution site through its real static server, live
 * generated GitHub snapshot, raw skill endpoints, archive, and responsive UI.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";
import { assertLeaderboardSnapshot } from "../../src/lib/leaderboard";

const test = base.extend<{ browserDiagnostics: undefined }>({
  browserDiagnostics: [
    async ({ baseURL, page }, use) => {
      const errors: string[] = [];
      const origin = new URL(baseURL ?? "http://127.0.0.1:4466").origin;
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (
          new URL(response.url()).origin === origin &&
          response.status() >= 400
        ) {
          errors.push(`${response.status()} ${response.url()}`);
        }
      });
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).origin === origin) {
          errors.push(
            `${request.failure()?.errorText ?? "failed"} ${request.url()}`,
          );
        }
      });
      await use(undefined);
      expect(errors, "browser console and page errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
});

test("loads live ledger, switches queues, and exposes provenance", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", {
      name: /your agent can finish elizaOS work/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Live GitHub ledger|Ledger update delayed/),
  ).toBeVisible();
  await expect(page.getByText("7-day proof review")).toBeVisible();
  await expect(page.locator("#methodology")).toContainText(
    /complete verification coverage \d+(?:\.\d+)?[KM]? merged PRs \+ \d+(?:\.\d+)?[KM]? closed issues \/ 7 days/i,
  );
  await expect(
    page.getByRole("heading", { name: /Choose work/ }),
  ).toBeVisible();

  const issuesButton = page.getByRole("button", { name: /^Issues/ });
  const pullRequestsButton = page.getByRole("button", {
    name: /^Pull requests/,
  });
  await expect(issuesButton).toHaveAttribute("aria-pressed", "true");
  await pullRequestsButton.click();
  await expect(pullRequestsButton).toHaveAttribute("aria-pressed", "true");

  await page.locator("#leaders").scrollIntoViewIfNeeded();
  const ledger = page.locator("#leaders");
  await expect(ledger).toContainText(/self-reported|Not reported/);
  await expect(page.locator("#methodology")).toContainText("Model provenance");
});

test("links every displayed leader to their score ledger", async ({
  page,
  request,
}) => {
  const response = await request.get("/data/leaderboard.json");
  expect(response.status()).toBe(200);
  const snapshot: unknown = await response.json();
  assertLeaderboardSnapshot(snapshot);

  if (snapshot.leaders.length === 0) {
    expect(snapshot.ledger).toEqual([]);
    await expect(
      page.getByText("The rolling window has no accepted outcomes yet."),
    ).toBeVisible();
    return;
  }

  const leader = snapshot.leaders[0];
  const events = snapshot.ledger.filter(
    (event) => event.actor.id === leader.actor.id,
  );
  expect(events.length).toBeGreaterThan(0);
  expect(events.reduce((total, event) => total + event.points, 0)).toBe(
    leader.score,
  );

  const firstRow = page.locator(".leaderboard-table tbody tr").first();
  const summary = firstRow.locator("summary");
  await expect(summary).toHaveText(
    `${events.length} linked score ${events.length === 1 ? "event" : "events"}`,
  );
  await summary.click();

  const evidenceLinks = firstRow.locator(".score-evidence li > a");
  await expect(evidenceLinks).toHaveCount(events.length);
  const renderedLinks = await evidenceLinks.evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute("href"),
      rel: anchor.getAttribute("rel"),
      target: anchor.getAttribute("target"),
    })),
  );
  expect(renderedLinks).toEqual(
    events.map((event) => ({
      href: event.source.url,
      rel: "noreferrer",
      target: "_blank",
    })),
  );
});

test("installs safely, copies the selected command, and serves verified artifacts", async ({
  context,
  page,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const siteOrigin = new URL(page.url()).origin;
  await expect(page.locator(".console-host")).toHaveText(siteOrigin);
  await page.getByRole("tab", { name: "Codex" }).click();
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(
    page.getByText("Codex command copied to the clipboard."),
  ).toBeVisible();
  const copiedCommand = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(copiedCommand).toContain(
    `${siteOrigin}/downloads/contribute-to-eliza.skill`,
  );
  expect(copiedCommand).not.toContain("https://eliza.army/");

  const skillResponse = await request.get("/skill.md");
  expect(skillResponse.status()).toBe(200);
  expect(skillResponse.headers()["content-type"]).toContain("text/markdown");
  expect(await skillResponse.text()).toContain("name: contribute-to-eliza");

  const archiveResponse = await request.get(
    "/downloads/contribute-to-eliza.skill",
  );
  expect(archiveResponse.status()).toBe(200);
  const archive = await archiveResponse.body();
  expect(archive.length).toBeGreaterThan(1000);
  const archiveIndex = archive.toString("latin1");
  expect(archiveIndex).toContain(
    "contribute-to-eliza/references/repository-contract.md",
  );
  expect(archiveIndex).toContain(
    "contribute-to-eliza/references/evidence-review-rubric.md",
  );
  expect(archiveIndex).toContain("contribute-to-eliza/scripts/live-report.mjs");

  const checksumResponse = await request.get(
    "/downloads/contribute-to-eliza.skill.sha256",
  );
  const checksum = await checksumResponse.text();
  const expectedHash = checksum.split(/\s+/)[0];
  expect(createHash("sha256").update(archive).digest("hex")).toBe(expectedHash);

  const installSandbox = mkdtempSync(
    join(tmpdir(), "eliza-computer-visible-install-"),
  );
  try {
    const publicRoot = join(installSandbox, "public");
    const downloadsRoot = join(publicRoot, "downloads");
    mkdirSync(downloadsRoot, { recursive: true });
    writeFileSync(join(downloadsRoot, "contribute-to-eliza.skill"), archive);
    writeFileSync(
      join(downloadsRoot, "contribute-to-eliza.skill.sha256"),
      checksum,
    );
    const localOrigin = pathToFileURL(publicRoot).href.replace(/\/$/u, "");
    const localCommand = copiedCommand.replaceAll(siteOrigin, localOrigin);
    const codexHome = join(installSandbox, "codex-home");
    const target = join(codexHome, "skills", "contribute-to-eliza");
    const validInstall = spawnSync("/bin/sh", ["-c", localCommand], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    expect(validInstall.status, validInstall.stderr).toBe(0);
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "PROVENANCE.json"))).toBe(true);
    const installedSkill = readFileSync(join(target, "SKILL.md"));

    const overwriteAttempt = spawnSync("/bin/sh", ["-c", localCommand], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    expect(overwriteAttempt.status).not.toBe(0);
    expect(overwriteAttempt.stderr).toContain(
      "Refusing to overwrite existing skill",
    );
    expect(readFileSync(join(target, "SKILL.md"))).toEqual(installedSkill);

    writeFileSync(
      join(downloadsRoot, "contribute-to-eliza.skill.sha256"),
      `${"0".repeat(64)}  contribute-to-eliza.skill\n`,
    );
    const corruptHome = join(installSandbox, "corrupt-codex-home");
    const corruptInstall = spawnSync("/bin/sh", ["-c", localCommand], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: corruptHome },
    });
    expect(corruptInstall.status).not.toBe(0);
    expect(existsSync(join(corruptHome, "skills", "contribute-to-eliza"))).toBe(
      false,
    );
  } finally {
    rmSync(installSandbox, { force: true, recursive: true });
  }
});

test("supports the complete install-tab keyboard pattern", async ({ page }) => {
  const noInstall = page.getByRole("tab", { name: "No install" });
  const codex = page.getByRole("tab", { name: "Codex" });
  const claude = page.getByRole("tab", { name: "Claude Code" });

  await noInstall.focus();
  await page.keyboard.press("ArrowRight");
  await expect(codex).toBeFocused();
  await expect(codex).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("SKILLS_ROOT=");

  await page.keyboard.press("End");
  await expect(claude).toBeFocused();
  await expect(claude).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(noInstall).toBeFocused();
  await expect(noInstall).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText(
    `${new URL(page.url()).origin}/mission.md`,
  );

  await page.keyboard.press("ArrowLeft");
  await expect(claude).toBeFocused();
  await expect(claude).toHaveAttribute("aria-selected", "true");
});

test("keeps clipboard failure visible and actionable", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("clipboard unavailable")),
      },
    });
  });

  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
  await expect(
    page.getByText(
      "Clipboard access was unavailable. Select the command and copy it manually.",
    ),
  ).toBeVisible();
});

test("has no accessibility violations or horizontal page overflow", async ({
  page,
}) => {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  const overflow = await page.evaluate(() => ({
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    leaderboard: (() => {
      const tableWrap = document.querySelector(".table-wrap");
      if (!(tableWrap instanceof HTMLElement)) {
        throw new Error("leaderboard table wrapper is missing");
      }
      return tableWrap.scrollWidth - tableWrap.clientWidth;
    })(),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.leaderboard).toBeLessThanOrEqual(1);
});

test("surfaces an invalid leaderboard snapshot as an error state", async ({
  page,
}) => {
  let interceptedRequests = 0;
  await page.route(/\/data\/leaderboard\.json(?:\?.*)?$/u, async (route) => {
    interceptedRequests += 1;
    await route.fulfill({
      body: JSON.stringify({ error: "invalid snapshot" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.reload({ waitUntil: "networkidle" });

  expect(interceptedRequests).toBe(1);
  const alert = page.getByRole("alert");
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText("did not load");
  await expect(alert).toContainText("No empty result has been substituted");
  await expect(page.locator("#leaders")).not.toContainText(
    "The rolling window has no accepted outcomes",
  );
});
