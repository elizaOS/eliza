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
  await expect(firstRow.locator(".score-evidence li > a")).toHaveCount(0);
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

    const highCompressionArchivePath = join(
      downloadsRoot,
      "contribute-to-eliza.skill",
    );
    const highCompressionArchive = spawnSync(
      "python3",
      [
        "-c",
        `
import stat
import sys
import zipfile

archive_path = sys.argv[1]
with zipfile.ZipFile(
    archive_path,
    "w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=9,
) as archive:
    entries = [
        ("contribute-to-eliza/SKILL.md", b"---\\nname: contribute-to-eliza\\ndescription: fixture\\n---\\n"),
        ("contribute-to-eliza/PROVENANCE.json", b"{}\\n"),
    ]
    entries.extend(
        (f"contribute-to-eliza/high-compression-{index}.bin", b"\\0" * 900000)
        for index in range(5)
    )
    for name, contents in entries:
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | 0o644) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, contents)
`,
        highCompressionArchivePath,
      ],
      { encoding: "utf8" },
    );
    expect(highCompressionArchive.status, highCompressionArchive.stderr).toBe(
      0,
    );
    const compressedBomb = readFileSync(highCompressionArchivePath);
    expect(compressedBomb.length).toBeLessThan(10_000);
    writeFileSync(
      join(downloadsRoot, "contribute-to-eliza.skill.sha256"),
      `${createHash("sha256").update(compressedBomb).digest("hex")}  contribute-to-eliza.skill\n`,
    );
    const highCompressionHome = join(
      installSandbox,
      "high-compression-codex-home",
    );
    const highCompressionInstall = spawnSync("/bin/sh", ["-c", localCommand], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: highCompressionHome },
    });
    expect(highCompressionInstall.status).not.toBe(0);
    expect(highCompressionInstall.stderr).toContain(
      "Archive failed bounded integrity and path checks.",
    );
    expect(
      existsSync(join(highCompressionHome, "skills", "contribute-to-eliza")),
    ).toBe(false);

    const oversizedDirectoryArchive = Buffer.from(archive);
    const centralDirectoryOffset = oversizedDirectoryArchive.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    expect(centralDirectoryOffset).toBeGreaterThanOrEqual(0);
    oversizedDirectoryArchive.writeUInt32LE(
      1048577,
      centralDirectoryOffset + 24,
    );
    writeFileSync(highCompressionArchivePath, oversizedDirectoryArchive);
    writeFileSync(
      join(downloadsRoot, "contribute-to-eliza.skill.sha256"),
      `${createHash("sha256").update(oversizedDirectoryArchive).digest("hex")}  contribute-to-eliza.skill\n`,
    );
    const oversizedDirectoryHome = join(
      installSandbox,
      "oversized-directory-codex-home",
    );
    const oversizedDirectoryInstall = spawnSync(
      "/bin/sh",
      ["-c", localCommand],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: oversizedDirectoryHome },
      },
    );
    expect(oversizedDirectoryInstall.status).not.toBe(0);
    expect(oversizedDirectoryInstall.stderr).toContain(
      "Archive failed bounded integrity and path checks.",
    );
    expect(
      existsSync(join(oversizedDirectoryHome, "skills", "contribute-to-eliza")),
    ).toBe(false);

    const forgedActualSizeArchive = spawnSync(
      "python3",
      [
        "-c",
        `
import binascii
import hashlib
import json
import struct
import sys
import zipfile

archive_path = sys.argv[1]
bomb_name = "contribute-to-eliza/forged-actual-size.bin"
skill = b"---\\nname: contribute-to-eliza\\ndescription: fixture\\n---\\n"
bomb = b"A" * 20_000_000
bomb_prefix = bomb[:100]
provenance = (
    json.dumps(
        {
            "schemaVersion": "1",
            "name": "contribute-to-eliza",
            "repository": "elizaOS/eliza",
            "revision": None,
            "revisionStatus": "working-tree",
            "source": {
                "path": "packages/skills/skills/contribute-to-eliza/SKILL.md",
                "sha256": hashlib.sha256(skill).hexdigest(),
            },
            "files": [
                {
                    "path": "SKILL.md",
                    "sha256": hashlib.sha256(skill).hexdigest(),
                },
                {
                    "path": "forged-actual-size.bin",
                    "sha256": hashlib.sha256(bomb_prefix).hexdigest(),
                },
            ],
        },
        indent=2,
    )
    + "\\n"
).encode()
with zipfile.ZipFile(
    archive_path,
    "w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=9,
) as archive:
    archive.writestr("contribute-to-eliza/SKILL.md", skill)
    archive.writestr("contribute-to-eliza/PROVENANCE.json", provenance)
    archive.writestr(bomb_name, bomb)

payload = bytearray(open(archive_path, "rb").read())
encoded_name = bomb_name.encode()
local_name_offset = payload.find(encoded_name)
central_name_offset = payload.find(encoded_name, local_name_offset + len(encoded_name))
if local_name_offset < 0 or central_name_offset < 0:
    raise RuntimeError("bomb entry headers were not found")
local_header = payload.rfind(b"PK\\x03\\x04", 0, local_name_offset)
central_header = payload.rfind(b"PK\\x01\\x02", 0, central_name_offset)
if local_header < 0 or central_header < 0:
    raise RuntimeError("bomb entry header signatures were not found")
prefix_crc = binascii.crc32(bomb_prefix) & 0xFFFFFFFF
struct.pack_into("<I", payload, local_header + 14, prefix_crc)
struct.pack_into("<I", payload, central_header + 16, prefix_crc)
struct.pack_into("<I", payload, local_header + 22, 100)
struct.pack_into("<I", payload, central_header + 24, 100)
open(archive_path, "wb").write(payload)
with zipfile.ZipFile(archive_path, "r") as archive:
    if archive.read(bomb_name) != bomb_prefix:
        raise RuntimeError("forged archive did not exercise the prefix-acceptance path")
`,
        highCompressionArchivePath,
      ],
      { encoding: "utf8" },
    );
    expect(forgedActualSizeArchive.status, forgedActualSizeArchive.stderr).toBe(
      0,
    );
    const forgedActualSizePayload = readFileSync(highCompressionArchivePath);
    expect(forgedActualSizePayload.length).toBeLessThan(30_000);
    writeFileSync(
      join(downloadsRoot, "contribute-to-eliza.skill.sha256"),
      `${createHash("sha256").update(forgedActualSizePayload).digest("hex")}  contribute-to-eliza.skill\n`,
    );
    const forgedActualSizeHome = join(
      installSandbox,
      "forged-actual-size-codex-home",
    );
    const forgedActualSizeInstall = spawnSync("/bin/sh", ["-c", localCommand], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: forgedActualSizeHome },
    });
    expect(forgedActualSizeInstall.status).not.toBe(0);
    expect(forgedActualSizeInstall.stderr).toContain(
      "Archive failed bounded integrity and path checks.",
    );
    expect(
      existsSync(join(forgedActualSizeHome, "skills", "contribute-to-eliza")),
    ).toBe(false);
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

  const overflow = await page.evaluate(() => {
    const tableWrap = document.querySelector(".table-wrap");
    if (!(tableWrap instanceof HTMLElement)) {
      throw new Error("leaderboard table wrapper is missing");
    }
    return {
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      leaderboard: tableWrap.scrollWidth - tableWrap.clientWidth,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.leaderboard).toBeLessThanOrEqual(1);

  const buildIssueTarget = await page
    .getByRole("link", { name: "Build issue" })
    .boundingBox();
  expect(buildIssueTarget).not.toBeNull();
  expect(buildIssueTarget?.width).toBeGreaterThanOrEqual(44);
  expect(buildIssueTarget?.height).toBeGreaterThanOrEqual(44);
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
