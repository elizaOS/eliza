#!/usr/bin/env node

// VS Code and VS Code Insiders config
const configObjVSCode = {
  "computeruse-mcp-agent": {
    command: "npx",
    args: ["-y", "computeruse-mcp-agent"],
  },
};
const configJSONVSCode = JSON.stringify(configObjVSCode);

// Cursor config (flat, not nested)
const configObjCursor = {
  command: "npx",
  args: ["-y", "computeruse-mcp-agent"],
};
const configJSONCursor = JSON.stringify(configObjCursor);
const configBase64Cursor = Buffer.from(configJSONCursor).toString("base64");

// Use the new Cursor deeplink format (as per https://docs.cursor.com/en/tools/developers#generate-install-link)
// Note: This deeplink works when clicked from a webpage or copied to browser, but GitHub blocks
// custom protocols like cursor:// in markdown for security reasons
const cursorWebUrl = `cursor://anysphere.cursor-deeplink/mcp/install?name=computeruse-mcp-agent&config=${configBase64Cursor}`;

const urlForVSCode = `vscode:mcp/install?${encodeURIComponent(
  configJSONVSCode
)}`;
const urlForVSCodeGithub = `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(
  urlForVSCode
)}`;

const urlForVSCodeInsiders = `vscode-insiders:mcp/install?${encodeURIComponent(
  configJSONVSCode
)}`;
const urlForVSCodeInsidersGithub = `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(
  urlForVSCodeInsiders
)}`;

// Just log the raw URLs, in order
console.log(urlForVSCodeGithub);
console.log(urlForVSCodeInsidersGithub);
console.log(cursorWebUrl);
