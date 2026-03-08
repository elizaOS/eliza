#!/usr/bin/env node
/**
 * Preview the bootstrap banner with ANSI colors.
 * Run from repo root: node packages/typescript/scripts/preview-banner.mjs
 */
const c = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  brightBlue: "\x1b[94m",
  brightCyan: "\x1b[96m",
  yellow: "\x1b[33m",
};

const sym = [
  "  ___  ",
  " |   | ",
  " | | | ",
  " |___| ",
  "   |   ",
  "   |   ",
].map((line) => `${c.yellow}${line}${c.reset}`);

const artLines = [
  ["    ____              __       __                        ", sym[0]],
  ["   / __ )____  ____  / /______/ /__________ _____       ", sym[1]],
  ["  / __  / __ \\/ __ \\/ __/ ___/ __/ ___/ __ '/ __ \\     ", sym[2]],
  [" / /_/ / /_/ / /_/ / /_(__  ) /_/ /  / /_/ / /_/ /     ", sym[3]],
  ["/_____/\\____/\\____/\\__/____/\\__/_/   \\__,_/ .___/     ", sym[4]],
  ["                                             \\__/     ", sym[5]],
];

const border = `${c.bright}${c.brightBlue}+${"-".repeat(78)}+${c.reset}`;
const pipe = `${c.bright}${c.brightBlue}|${c.reset}`;

function artLine(cyanText, symPart, suffix = "") {
  const symVisible = symPart.replace(/\x1b\[[0-9;]*m/g, "");
  const suffixVisible = suffix.replace(/\x1b\[[0-9;]*m/g, "");
  const used = cyanText.length + symVisible.length + suffixVisible.length;
  const pad = Math.max(0, 78 - used);
  return `${pipe}${c.brightCyan}${cyanText}${c.reset}${symPart}${suffix}${" ".repeat(pad)}${pipe}`;
}

const artContent = [
  artLine(artLines[0][0], artLines[0][1]),
  artLine(artLines[1][0], artLines[1][1]),
  artLine(artLines[2][0], artLines[2][1]),
  artLine(artLines[3][0], artLines[3][1]),
  artLine(artLines[4][0], artLines[4][1]),
  artLine(artLines[5][0], artLines[5][1], `${c.dim}plugin${c.reset}`),
].join("\n");

console.log(`\n${border}\n${artContent}\n${border}\n`);
