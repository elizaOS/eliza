/**
 * Validates package lists against the conditional grammar consumed by the
 * pinned Tails live-build fork. The checks run without APT or network access.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_LIST_DIRECTORY = fileURLToPath(
  new URL("../tails/config/chroot_local-packageslists", import.meta.url),
);
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.:~-]*$/;

function expandPackageList(source, architecture, sourceName = "package list") {
  const packages = [];
  let conditional = null;

  for (const [index, rawLine] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#if ")) {
      assert.equal(
        conditional,
        null,
        `${sourceName}:${lineNumber}: nested package-list conditionals are unsupported`,
      );
      const match = line.match(/^#if ARCHITECTURE ([a-z0-9_ -]+)$/);
      assert.ok(
        match,
        `${sourceName}:${lineNumber}: expected "#if ARCHITECTURE <arch>"`,
      );
      conditional = new Set(match[1].trim().split(/\s+/));
      continue;
    }

    if (line === "#endif") {
      assert.notEqual(
        conditional,
        null,
        `${sourceName}:${lineNumber}: unmatched #endif`,
      );
      conditional = null;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    assert.match(
      line,
      PACKAGE_NAME_PATTERN,
      `${sourceName}:${lineNumber}: package entries must be standalone names; inline architecture selectors become APT package regexes`,
    );
    if (conditional === null || conditional.has(architecture)) {
      packages.push(line);
    }
  }

  assert.equal(conditional, null, `${sourceName}: unterminated conditional`);
  return packages;
}

test("all Tails package lists use parser-safe package entries", async () => {
  const entries = await readdir(PACKAGE_LIST_DIRECTORY, {
    withFileTypes: true,
  });
  const packageLists = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".list"))
    .map((entry) => entry.name)
    .sort();

  assert.ok(packageLists.length > 0, "expected Tails package lists");
  const amd64Packages = [];
  for (const packageList of packageLists) {
    const source = await readFile(
      path.join(PACKAGE_LIST_DIRECTORY, packageList),
      "utf8",
    );
    amd64Packages.push(...expandPackageList(source, "amd64", packageList));
  }
  assert.equal(amd64Packages.includes("linux-image-riscv64"), false);
  assert.equal(amd64Packages.includes("grub-efi-riscv64"), false);
});

test("the amd64 queue includes Syslinux without selector expressions", async () => {
  const source = await readFile(
    path.join(PACKAGE_LIST_DIRECTORY, "tails-common.list"),
    "utf8",
  );
  const packages = expandPackageList(source, "amd64", "tails-common.list");

  assert.ok(packages.includes("syslinux"));
  assert.ok(packages.includes("syslinux-common"));
  assert.equal(
    packages.some((entry) => entry.includes("[")),
    false,
  );
});

test("the experimental riscv64 list remains available to its target", async () => {
  const source = await readFile(
    path.join(PACKAGE_LIST_DIRECTORY, "elizaos-riscv64-gui.list"),
    "utf8",
  );
  const packages = expandPackageList(
    source,
    "riscv64",
    "elizaos-riscv64-gui.list",
  );

  assert.ok(packages.includes("linux-image-riscv64"));
  assert.ok(packages.includes("grub-efi-riscv64"));
  assert.ok(packages.includes("gnome-shell"));
});

test("inline architecture selectors are rejected before APT sees them", () => {
  assert.throws(
    () => expandPackageList("syslinux [amd64]\n", "amd64", "unsafe.list"),
    /inline architecture selectors become APT package regexes/,
  );
});
