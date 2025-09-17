// Export function to display banner and version

import { existsSync, readFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserEnvironment } from './user-environment';
import { getLatestCliVersionForChannel } from './version-channel';

// Import the version module - this will be bundled at build time
// Using dynamic import within the function to avoid top-level await
let cachedVersion: string | null = null;

// Helper function to check if running from node_modules
export function isRunningFromNodeModules(): boolean {
  const __filename = fileURLToPath(import.meta.url);
  // Check for both node_modules and .bun paths (for global bun installs)
  return __filename.includes('node_modules') || __filename.includes('/.bun/');
}

// Function to get the package version
// --- Utility: Get local CLI version from embedded version file ---
export function getVersion(): string {
  // Check if we're in the monorepo context based on the CLI's location, not the current working directory
  const __filename = fileURLToPath(import.meta.url);
  const userEnv = UserEnvironment.getInstance();
  const monorepoRoot = userEnv.findMonorepoRoot(__filename);

  if (monorepoRoot && !isRunningFromNodeModules()) {
    // We're running from within the monorepo source (not from a global install)
    return 'monorepo';
  }

  // Check if running from node_modules or .bun (proper installation)
  if (!isRunningFromNodeModules()) {
    // Running from local dist or development build, but not in monorepo
    // This shouldn't normally happen, but let's try to get the version anyway
  }

  // Return cached version if we have it
  if (cachedVersion) {
    return cachedVersion;
  }

  // Try to load the version synchronously using require-like pattern
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Try multiple possible locations for version.js
    const possiblePaths = [
      path.resolve(__dirname, '../version.js'), // Standard location in development
      path.resolve(__dirname, 'version.js'), // Same directory (for bundled dist)
      path.resolve(__dirname, './version.js'), // Alternative same directory
    ];

    // Special handling for when everything is bundled into index.js
    if (__filename.endsWith('index.js')) {
      const distDir = path.dirname(__filename);
      possiblePaths.unshift(path.resolve(distDir, 'version.js'));
    }

    for (const versionPath of possiblePaths) {
      if (existsSync(versionPath)) {
        // Read the version file and extract the version
        const versionContent = readFileSync(versionPath, 'utf-8');

        // Try to extract CLI_VERSION constant
        const versionMatch = versionContent.match(/export const CLI_VERSION = ['"]([^'"]+)['"]/);
        if (versionMatch && versionMatch[1]) {
          cachedVersion = versionMatch[1];
          return cachedVersion;
        }

        // Try to extract from default export
        const defaultMatch = versionContent.match(/version:\s*['"]([^'"]+)['"]/);
        if (defaultMatch && defaultMatch[1]) {
          cachedVersion = defaultMatch[1];
          return cachedVersion;
        }
      }
    }
  } catch (error) {
    // Silent fallback
  }

  // Final fallback version
  return '0.0.0';
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

    // Use the shared utility to get the latest version for the channel
    const latestVersion = await getLatestCliVersionForChannel(currentVersion);

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
