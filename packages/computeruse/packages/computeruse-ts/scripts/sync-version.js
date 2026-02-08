#!/usr/bin/env node

/**
 * Sync platform package versions to match the main package.json version.
 *
 * The main package version is managed by lerna (2.0.0-alpha.x style).
 * This script propagates that version to the platform-specific npm packages
 * (e.g. @elizaos/computeruse-darwin-arm64) so they stay in lockstep.
 */

const fs = require('fs');
const path = require('path');

// Read the main package.json (version managed by lerna)
const packagePath = path.join(__dirname, '../package.json');
const packageContent = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = packageContent.version;

console.log(`Main package version: ${version}`);

// Update optionalDependencies to use the same version
let changed = false;
if (packageContent.optionalDependencies) {
    for (const dep in packageContent.optionalDependencies) {
        if (dep.startsWith('@elizaos/computeruse-')) {
            if (packageContent.optionalDependencies[dep] !== version) {
                packageContent.optionalDependencies[dep] = version;
                changed = true;
            }
        }
    }
}

if (changed) {
    fs.writeFileSync(packagePath, JSON.stringify(packageContent, null, 2) + '\n');
    console.log(`Updated optionalDependencies to: ${version}`);
}

// Also update platform packages in npm/
const npmDir = path.join(__dirname, '../npm');
if (fs.existsSync(npmDir)) {
    const platforms = fs.readdirSync(npmDir);
    for (const platform of platforms) {
        const platformPath = path.join(npmDir, platform);
        const platformPackagePath = path.join(platformPath, 'package.json');
        
        if (fs.existsSync(platformPackagePath) && fs.statSync(platformPath).isDirectory()) {
            try {
                const platformPackage = JSON.parse(fs.readFileSync(platformPackagePath, 'utf8'));
                if (platformPackage.version !== version) {
                    platformPackage.version = version;
                    fs.writeFileSync(platformPackagePath, JSON.stringify(platformPackage, null, 2) + '\n');
                    console.log(`Updated ${platform} package version to: ${version}`);
                }
            } catch (error) {
                console.warn(`Failed to update ${platform} package:`, error.message);
            }
        }
    }
}

console.log('Version sync complete.');
