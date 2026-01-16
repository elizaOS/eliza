#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Read the workspace Cargo.toml
const workspaceCargoPath = path.join(__dirname, "../../Cargo.toml");
const cargoContent = fs.readFileSync(workspaceCargoPath, "utf8");

// Extract version from Cargo.toml
const versionMatch = cargoContent.match(/^version\s*=\s*"([^"]+)"/m);
if (!versionMatch) {
    console.error("Could not find version in workspace Cargo.toml");
    process.exit(1);
}

const version = versionMatch[1];
console.log(`Found version: ${version}`);

// Read package.json
const packagePath = path.join(__dirname, "../package.json");
const packageContent = JSON.parse(fs.readFileSync(packagePath, "utf8"));

// Update version and optionalDependencies
packageContent.version = version;
if (packageContent.optionalDependencies) {
    for (const dep in packageContent.optionalDependencies) {
        if (dep.startsWith("@mediar-ai/cli-")) {
            packageContent.optionalDependencies[dep] = version;
        }
    }
}
fs.writeFileSync(packagePath, JSON.stringify(packageContent, null, 2) + "\n");
console.log(`Updated package.json version to: ${version}`);

// Also update platform packages
const npmDir = path.join(__dirname, "../npm");
if (fs.existsSync(npmDir)) {
    const platforms = fs.readdirSync(npmDir);
    for (const platform of platforms) {
        const platformPath = path.join(npmDir, platform);
        const platformPackagePath = path.join(platformPath, "package.json");
        if (
            fs.existsSync(platformPackagePath) &&
            fs.statSync(platformPath).isDirectory()
        ) {
            try {
                const platformPackage = JSON.parse(
                    fs.readFileSync(platformPackagePath, "utf8"),
                );
                platformPackage.version = version;
                fs.writeFileSync(
                    platformPackagePath,
                    JSON.stringify(platformPackage, null, 2) + "\n",
                );
                console.log(`Updated ${platform} package version to: ${version}`);
            } catch (error) {
                console.warn(`Failed to update ${platform} package:`, error.message);
            }
        }
    }
}

