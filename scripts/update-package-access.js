const fs = require('node:fs');
const path = require('node:path');
const glob = require('glob');
const { execSync } = require('node:child_process');

const packages = glob.sync('packages/*/package.json');

for (const packageJsonPath of packages) {
  const packageJson = require(path.resolve(packageJsonPath));

  if (packageJson.name.startsWith('@elizaos/') && !packageJson.private && !packageJson.publishConfig) {
    packageJson.publishConfig = { access: 'public' };

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(`Updated: ${packageJson.name}`);

    // Format the file using npx Prettier
    try {
      execSync(`npx prettier --write ${packageJsonPath}`, { stdio: 'inherit' });
      console.log(`Formatted: ${packageJsonPath}`);
    } catch (error) {
      console.error(`Error formatting file: ${packageJsonPath}`, error.message);
    }
  }
}
