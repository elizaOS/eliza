#!/usr/bin/env node

// This script removes dependencies from package.json for publishing
// Because we bundle all dependencies in the final output, we don't need them
// in the published package.json

const fs = require('node:fs');
const path = require('node:path');

// Read the package.json
const pkgPath = path.join(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Clean dependencies
pkg.dependencies = {};
pkg.devDependencies = {};

// Write the cleaned package.json
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

console.log('Package.json cleaned for publishing!');
