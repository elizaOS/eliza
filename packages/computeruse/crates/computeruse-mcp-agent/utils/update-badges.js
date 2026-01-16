#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const readmePath = path.join(__dirname, "../README.md");
const generateLinksPath = path.join(__dirname, "generate-links.js");

// Run generate-links.js and capture output
const output = execSync(`node ${generateLinksPath}`).toString();
const lines = output.split(/\r?\n/).filter(Boolean);

const vscodeUrl = lines[0];
const insidersUrl = lines[1];
const cursorUrl = lines[2];

// Note: Cursor deeplinks (cursor://) don't work in GitHub markdown,
// so we only include VS Code badges here. Cursor installation instructions
// are provided in the Quick Install section.
const badgeBlock = `<!-- BADGES:START -->
[<img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF">](${vscodeUrl})
[<img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Server&color=24bfa5">](${insidersUrl})
<!-- BADGES:END -->`;

let readme = fs.readFileSync(readmePath, "utf8");

// Remove all existing badge blocks (non-greedy match)
readme = readme.replace(
  /<!-- BADGES:START -->[\s\S]*?<!-- BADGES:END -->?/g,
  ""
);

// Insert the new badge block after the first heading or at the top
const headingMatch = readme.match(/^#+ .+$/m);
if (headingMatch) {
  const idx = readme.indexOf(headingMatch[0]) + headingMatch[0].length;
  readme = readme.slice(0, idx) + "\n" + badgeBlock + readme.slice(idx);
} else {
  readme = badgeBlock + readme;
}

fs.writeFileSync(readmePath, readme);
console.log("Badges section updated in README.md");
