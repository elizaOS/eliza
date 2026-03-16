#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function getPlatformInfo() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === "win32" && arch === "x64")
        return {
            pkg: "@mediar-ai/cli-win32-x64-msvc",
            bin: "computeruse.exe",
            npmDir: "win32-x64-msvc",
        };
    if (platform === "win32" && arch === "arm64")
        return {
            pkg: "@mediar-ai/cli-win32-arm64-msvc",
            bin: "computeruse.exe",
            npmDir: "win32-arm64-msvc",
        };
    if (platform === "linux" && arch === "x64")
        return {
            pkg: "@mediar-ai/cli-linux-x64-gnu",
            bin: "computeruse",
            npmDir: "linux-x64-gnu",
        };
    if (platform === "darwin" && arch === "x64")
        return {
            pkg: "@mediar-ai/cli-darwin-x64",
            bin: "computeruse",
            npmDir: "darwin-x64",
        };
    if (platform === "darwin" && arch === "arm64")
        return {
            pkg: "@mediar-ai/cli-darwin-arm64",
            bin: "computeruse",
            npmDir: "darwin-arm64",
        };
    throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

const packageInfo = require('./package.json');

// Display version banner
console.error(`🚀 ComputerUse CLI v${packageInfo.version}`);
console.error(`📦 Platform: ${process.platform}-${process.arch}`);
console.error('');

const { pkg, bin, npmDir } = getPlatformInfo();
let binary;

// 1. Try local build (for dev)
const localPath = path.join(__dirname, "npm", npmDir, bin);
if (fs.existsSync(localPath)) {
    binary = localPath;
    console.error(`🔧 Using local binary: ${path.relative(process.cwd(), binary)}`);
} else {
    // 2. Try installed npm package
    try {
        binary = require.resolve(pkg);
        console.error(`📦 Using npm package: ${pkg}`);
    } catch (e) {
        console.error(`❌ Failed to find platform binary: ${pkg}`);
        console.error(`   Please install the platform-specific package: npm install ${pkg}`);
        process.exit(1);
    }
}
console.error('');

// Forward all arguments to the binary
const args = process.argv.slice(2);

let child = spawn(binary, args, {
    stdio: ["inherit", "inherit", "inherit"],
    shell: false,
});

child.on("exit", (code) => {
    process.exit(code || 0);
});

// Handle signals
process.on("SIGINT", () => {
    child.kill("SIGINT");
});

process.on("SIGTERM", () => {
    child.kill("SIGTERM");
});

