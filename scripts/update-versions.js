const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const packagesDir = path.join(__dirname, '../packages');
const externalDirs = ['../agent', '../client', '../docs'];
const lernaPath = path.join(__dirname, '../lerna.json');

// Simple Logger
function log(level, message) {
  const timestamp = new Date().toISOString().split('T').join(' ').slice(0, 19);
  console.log(`${timestamp} [${level.toUpperCase()}]: ${message}`);
}

// Helper to simplify file path for logs
function simplifyPath(filePath) {
  const relativePath = path.relative(path.join(__dirname, '..'), filePath);
  return `/${relativePath.replace(/\\/g, '/')}`;
}

// Prompt for version input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askVersion() {
  return new Promise((resolve) => {
    rl.question('Enter the new version: ', (version) => {
      resolve(version);
      rl.close();
    });
  });
}

function runPrettier(filePaths) {
  try {
    execSync(`npx prettier --write ${filePaths.join(' ')}`, { stdio: 'ignore' });
    log('info', `Formatted ${filePaths.length} files with Prettier.`);
  } catch (error) {
    log('error', `Failed to format files with Prettier: ${error.message}`);
  }
}

// Update versions in all package.json files
async function updateVersions() {
  const NEW_VERSION = await askVersion();
  log('info', `Starting version update process to ${NEW_VERSION}.`);

  const updatedFiles = [];

  const updateDirectory = (dirPath) => {
    const packagePath = path.join(dirPath, 'package.json');

    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      const oldVersion = packageJson.version;

      if (oldVersion) {
        packageJson.version = NEW_VERSION;
        fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
        log('info', `Updated ${simplifyPath(packagePath)}: ${oldVersion} -> ${packageJson.version}`);
        updatedFiles.push(packagePath);
      } else {
        log('warn', `Version not found in ${simplifyPath(packagePath)}`);
      }
    } else {
      log('warn', `No package.json found in ${simplifyPath(packagePath)}`);
    }
  };

  // Update packages folder
  if (fs.existsSync(packagesDir)) {
    const packageDirs = fs.readdirSync(packagesDir);
    packageDirs.forEach((dir) => updateDirectory(path.join(packagesDir, dir)));
  } else {
    log('warn', `Packages directory not found at ${packagesDir}`);
  }

  // Update external folders
  externalDirs.forEach((dir) => {
    const fullPath = path.join(__dirname, dir);
    if (fs.existsSync(fullPath)) {
      updateDirectory(fullPath);
    } else {
      log('warn', `External directory not found: ${simplifyPath(fullPath)}`);
    }
  });

  // Update lerna.json
  if (fs.existsSync(lernaPath)) {
    const lernaJson = JSON.parse(fs.readFileSync(lernaPath, 'utf-8'));
    const oldVersion = lernaJson.version;

    if (oldVersion) {
      lernaJson.version = NEW_VERSION;
      fs.writeFileSync(lernaPath, JSON.stringify(lernaJson, null, 2) + '\n');
      log('info', `Updated ${simplifyPath(lernaPath)}: ${oldVersion} -> ${lernaJson.version}`);
      updatedFiles.push(lernaPath);
    } else {
      log('warn', `Version not found in ${simplifyPath(lernaPath)}`);
    }
  } else {
    log('warn', `lerna.json not found at ${lernaPath}`);
  }

  if (updatedFiles.length > 0) {
    runPrettier(updatedFiles);
  } else {
    log('info', 'No files updated, skipping Prettier formatting.');
  }

  log('info', 'Version update process completed.');
}

updateVersions();
