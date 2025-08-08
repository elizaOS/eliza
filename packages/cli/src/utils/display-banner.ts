// Export function to display banner and version

import { existsSync, readFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunExecSimple } from './bun-exec';
import { UserEnvironment } from './user-environment';

// Helper function to check if running from node_modules
export function isRunningFromNodeModules(): boolean {
  const __filename = fileURLToPath(import.meta.url);
  return __filename.includes('node_modules');
}

// Function to get the package version
// --- Utility: Get local CLI version from package.json ---
export function getVersion(): string {
  // Check if we're in the monorepo context
  const userEnv = UserEnvironment.getInstance();
  const monorepoRoot = userEnv.findMonorepoRoot(process.cwd());

  if (monorepoRoot) {
    // We're in the monorepo, return 'monorepo' as version
    return 'monorepo';
  }

  // Check if running from node_modules (proper installation)
  if (!isRunningFromNodeModules()) {
    // Running from local dist or development build, not properly installed
    return 'monorepo';
  }

  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!existsSync(packageJsonPath)) {
    console.error(`Warning: package.json not found at ${packageJsonPath}`);
  } else {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      version = packageJson.version || '0.0.0';
    } catch (error) {
      console.error(`Error reading or parsing package.json at ${packageJsonPath}:`, error);
    }
  }
  return version;
}

// --- Utility: Get install tag based on CLI version ---
export function getCliInstallTag(): string {
  const version = getVersion();
  if (version.includes('-alpha')) {
    return 'alpha';
  } else if (version.includes('beta')) {
    return 'beta';
  }
  return ''; // Return empty string for stable or non-tagged versions (implies latest)
}

// --- Utility: Check if terminal supports UTF-8 ---
export function isUtf8Locale() {
  for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG', 'LANGUAGE']) {
    const v = process.env[key];
    if (typeof v === 'string' && /UTF-?8/i.test(v)) {
      return true;
    }
  }
  return false;
}

// Cache for version check to avoid multiple network calls in same session
let versionCheckCache: { latestVersion: string | null; timestamp: number } | null = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// --- Utility: Get latest CLI version with caching ---
export async function getLatestCliVersion(currentVersion: string): Promise<string | null> {
  // Skip version check if we're in monorepo context
  if (currentVersion === 'monorepo') {
    return null;
  }

  try {
    // Check cache first
    if (versionCheckCache && Date.now() - versionCheckCache.timestamp < CACHE_DURATION) {
      return versionCheckCache.latestVersion;
    }

    // Get the time data for all published versions to find the most recent
    const { stdout } = await bunExecSimple('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Find the most recently published version
    let latestVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestVersion = version;
      }
    }

    // Return latest version if an update is available, null otherwise
    const result = latestVersion && latestVersion !== currentVersion ? latestVersion : null;

    // Cache the result
    versionCheckCache = {
      latestVersion: result,
      timestamp: Date.now(),
    };

    return result;
  } catch {
    // Silent failure - return null if check fails
    return null;
  }
}

// --- Utility: Display compact, professional update notification ---
export function showUpdateNotification(currentVersion: string, latestVersion: string) {
  const blue = '\x1b[38;5;27m'; // Blue border to match ASCII art
  const orange = '\x1b[38;5;208m'; // Bright orange for warning text
  const green = '\x1b[38;5;46m'; // Bright green for new version
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  // Friendly, conversational notification following CLI design principles
  const width = 68;
  const border = `${blue}${'─'.repeat(width)}${reset}`;

  console.log('');
  console.log(border);
  console.log(
    `${blue}│${orange} ${bold}Update available:${reset}${orange} ${currentVersion} → ${green}${bold}${latestVersion}${reset}${orange}${' '.repeat(width - 2 - ` Update available: ${currentVersion} → ${latestVersion}`.length)}${blue}│${reset}`
  );
  console.log(
    `${blue}│${orange} Run ${green}${bold}bun i -g @elizaos/cli@latest${reset}${orange} to get the latest features${' '.repeat(width - 2 - ` Run bun i -g @elizaos/cli@latest to get the latest features`.length)}${blue}│${reset}`
  );
  console.log(border);
  console.log('');
}

// --- Utility: Global update check that can be called from anywhere ---
export async function checkAndShowUpdateNotification(currentVersion: string): Promise<boolean> {
  // Skip update check if we're in monorepo context
  if (currentVersion === 'monorepo') {
    return false;
  }

  try {
    const latestVersion = await getLatestCliVersion(currentVersion);
    if (latestVersion) {
      showUpdateNotification(currentVersion, latestVersion);
      return true;
    }
    return false;
  } catch {
    // Silent failure
    return false;
  }
}

// --- Main: Display banner and version, then check for updates ---
export async function displayBanner(skipUpdateCheck: boolean = false) {
  if (!isUtf8Locale()) {
    // Terminal does not support UTF-8, skip banner
    return;
  }
  // Color ANSI escape codes
  const b = '\x1b[38;5;27m';
  const lightblue = '\x1b[38;5;51m';
  const w = '\x1b[38;5;255m';
  const r = '\x1b[0m';
  const orange = '\x1b[38;5;208m';
  let versionColor = lightblue;

  const version = getVersion();

  // if version includes "alpha" then use orange
  if (version?.includes('alpha')) {
    versionColor = orange;
  }
  const banners = [
    //     // Banner 2
    //     `
    // ${b}          ###                                  ${w}  # ###       #######  ${r}
    // ${b}         ###    #                            / ${w} /###     /       ###  ${r}
    // ${b}          ##   ###                          /  ${w}/  ###   /         ##  ${r}
    // ${b}          ##    #                          / ${w} ##   ###  ##        #   ${r}
    // ${b}          ##                              /  ${w}###    ###  ###          ${r}
    // ${b}   /##    ##  ###    ######      /###    ${w}##   ##     ## ## ###        ${r}
    // ${b}  / ###   ##   ###  /#######    / ###  / ${w}##   ##     ##  ### ###      ${r}
    // ${b} /   ###  ##    ## /      ##   /   ###/  ${w}##   ##     ##    ### ###    ${r}
    // ${b}##    ### ##    ##        /   ##    ##   ${w}##   ##     ##      ### /##  ${r}
    // ${b}########  ##    ##       /    ##    ##   ${w}##   ##     ##        #/ /## ${r}
    // ${b}#######   ##    ##      ###   ##    ##   ${w} ##  ##     ##         #/ ## ${r}
    // ${b}##        ##    ##       ###  ##    ##   ${w}  ## #      /           # /  ${r}
    // ${b}####    / ##    ##        ### ##    /#   ${w}   ###     /  /##        /   ${r}
    // ${b} ######/  ### / ### /      ##  ####/ ##  ${w}    ######/  /  ########/    ${r}
    // ${b}  #####    ##/   ##/       ##   ###   ## ${w}      ###   /     #####      ${r}
    // ${b}                           /             ${w}            |                ${r}
    // ${b}                          /              ${w}             \)              ${r}
    // ${b}                         /               ${w}                             ${r}
    // ${b}                        /                ${w}                             ${r}
    // `,

    //     // Banner 3
    //     `
    // ${b}      :::::::::::::      ::::::::::::::::::::    ::: ${w}    ::::::::  :::::::: ${r}
    // ${b}     :+:       :+:          :+:         :+:   :+: :+:${w}  :+:    :+::+:    :+: ${r}
    // ${b}    +:+       +:+          +:+        +:+   +:+   +:+${w} +:+    +:++:+         ${r}
    // ${b}   +#++:++#  +#+          +#+       +#+   +#++:++#++:${w}+#+    +:++#++:++#++   ${r}
    // ${b}  +#+       +#+          +#+      +#+    +#+     +#+${w}+#+    +#+       +#+    ${r}
    // ${b} #+#       #+#          #+#     #+#     #+#     #+##${w}+#    #+##+#    #+#     ${r}
    // ${b}##########################################     #### ${w}#######  ########       ${r}`,

    `
${b}⠀⠀⠀⠀⠀⠀⠀⠀⢀⣐⣿⣿⢰⡀⠀⠀⠀${w} ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⠀⠀⠀⢀⣴⠤⠾⠛⠛⣿⣶⣇⠀⠀⡆${w} ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⢰⣋⡳⡄⠀⢨⣭⡀⠀⡤⠀⣀⣝⢿⣶⣿⡅${w} ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⢸⣯⠀⣇⠀⣼⣿⣿⣆⢷⣴⣿⣿⡏⣛⡉⠀${w} ⢸⣿⣿⣿⣿⣿⣿⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⣾⣿⣿⣧⠀⠀⠀${w}⢸⠟⢀⣴⣿⣿⣿⣿⣦⡀⣠⣾⣿⣿⣿⣿⣦⡙⢿${r}
${b}⠀⠙⢷⣮⢸⣿⣿⣿⣿⣷⣯⣟⣏⣼⣷⣅⠾${w} ⢸⣿⣇⣀⣀⣀⠀⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⠀⠀⠀⣠⣿⣿⠟⠁⠀⠀⣼⣿⡟⣿⣿⣆⠀⠀${w}⠀⠀⣿⣿⠋⠀⠈⠻⣿⡇⣿⣿⣅⣀⣀⡛⠛⠃⠀${r}
${b}⠀⠀⠀⠁⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀${w} ⢸⣿⡿⠿⠿⠿⠀⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⠀⣠⣾⣿⠟⠁⠀⠀⠀⣰⣿⣿⣁⣸⣿⣿⡄⠀${w}⠀⠀⣿⣿ ⠀⠀ ⣿⣿⢈⣛⠿⠿⠿⣿⣷⡄⠀${r}
${b}⠀⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣉⡟⠀⠀${w} ⢸⣿⣧⣤⣤⣤⣤⢸⣿⣿⣦⣤⣤⣤⡄⣿⣿⡇⣾⣿⣿⣧⣤⣤⣤⡄⢰⣿⣿⠟⠛⠛⠻⣿⣿⡄${w}⢠⡀⠻⣿⣿⣦⣴⣿⣿⠇⢿⣿⣦⣤⣤⣿⣿⠇⣠${r}
${b}⠀⠀⠀⠀⢰⡈⠛⠿⣿⣿⣿⣿⣿⠋⠀  ${w} ⠘⠛⠛⠛⠛⠛⠛⠈⠛⠛⠛⠛⠛⠛⠃⠛⠛⠃⠛⠛⠛⠛⠛⠛⠛⠃⠛⠛⠃⠀⠀⠀⠀⠙⠛⠃${w}⠘⠛⠀⠈⠛⠛⠛⠛⠁⠀⠀⠙⠛⠛⠛⠛⠁⠚⠛${r}
${b}⠀⠀⠀⠀⢸⣿⡦⠀⠀⠉⠛⠿⠃⠀⠀⠀ ${w} ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
`,
  ];

  // Randomly select and log one banner
  const randomBanner = banners[Math.floor(Math.random() * banners.length)];

  console.log(randomBanner);

  if (version) {
    // log the version
    console.log(`${versionColor}Version: ${version}${r}`);
  }

  // Notify user if a new CLI version is available (unless we're skipping it)
  if (!skipUpdateCheck) {
    try {
      await checkAndShowUpdateNotification(version);
    } catch (error) {
      // Silently continue if update check fails
    }
  }
}
