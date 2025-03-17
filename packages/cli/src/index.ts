#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { agent } from './commands/agent.js';
import { create } from './commands/create.js';
import { dev } from './commands/dev.js';
import { env } from './commands/env.js';
import { plugin } from './commands/plugin.js';
import { project } from './commands/project.js';
import { publish } from './commands/publish.js';
import { start } from './commands/start.js';
import { teeCommand as tee } from './commands/tee.js';
import { test } from './commands/test.js';
import { update } from './commands/update.js';
import { loadEnvironment } from './utils/get-config.js';
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * Asynchronous function that serves as the main entry point for the application.
 * It loads environment variables, initializes the CLI program, and parses the command line arguments.
 * @returns {Promise<void>}
 */
async function main() {
  // Load environment variables, trying project .env first, then global ~/.eliza/.env
  await loadEnvironment();

  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!fs.existsSync(packageJsonPath)) {
  } else {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    version = packageJson.version;
  }

  // Color ANSI escape codes
  const b = '\x1b[38;5;27m';
  const lightblue = '\x1b[38;5;51m';
  const w = '\x1b[38;5;255m';
  const r = '\x1b[0m';
  const red = '\x1b[38;5;196m';
  let versionColor = lightblue;

  // if version includes "beta" or "alpha" then use red
  if (version.includes('beta') || version.includes('alpha')) {
    versionColor = red;
  }
  const banners = [
    // Banner 1
    `
${b}      _ _         ${w} _____ _____ ${r}
${b}     | (_)        ${w}|  _  /  ___|${r}
${b}  ___| |_ ______ _${w}| | | \\ \`--.${r} 
${b} / _ \\ | |_  / _\` ${w}| | | |\`--. \\${r}
${b}|  __/ | |/ / (_| ${w}\\ \\_/ /\\__/ /${r}
${b} \\___|_|_/___\\__,_|${w}\\___/\\____/ ${r}
    `,

    // Banner 2
    `
${b}          ###                                  ${w}  # ###       #######  ${r}
${b}         ###    #                            / ${w} /###     /       ###  ${r}
${b}          ##   ###                          /  ${w}/  ###   /         ##  ${r}
${b}          ##    #                          / ${w} ##   ###  ##        #   ${r}
${b}          ##                              /  ${w}###    ###  ###          ${r}
${b}   /##    ##  ###    ######      /###    ${w}##   ##     ## ## ###        ${r}
${b}  / ###   ##   ###  /#######    / ###  / ${w}##   ##     ##  ### ###      ${r}
${b} /   ###  ##    ## /      ##   /   ###/  ${w}##   ##     ##    ### ###    ${r}
${b}##    ### ##    ##        /   ##    ##   ${w}##   ##     ##      ### /##  ${r}
${b}########  ##    ##       /    ##    ##   ${w}##   ##     ##        #/ /## ${r}
${b}#######   ##    ##      ###   ##    ##   ${w} ##  ##     ##         #/ ## ${r}
${b}##        ##    ##       ###  ##    ##   ${w}  ## #      /           # /  ${r}
${b}####    / ##    ##        ### ##    /#   ${w}   ###     /  /##        /   ${r}
${b} ######/  ### / ### /      ##  ####/ ##  ${w}    ######/  /  ########/    ${r}
${b}  #####    ##/   ##/       ##   ###   ## ${w}      ###   /     #####      ${r}
${b}                           /             ${w}            |                ${r}
${b}                          /              ${w}             \)              ${r}
${b}                         /               ${w}                             ${r}
${b}                        /                ${w}                             ${r}
`,

    // Banner 3
    `
${b}      :::::::::::::      ::::::::::::::::::::    ::: ${w}    ::::::::  :::::::: ${r}
${b}     :+:       :+:          :+:         :+:   :+: :+:${w}  :+:    :+::+:    :+: ${r}
${b}    +:+       +:+          +:+        +:+   +:+   +:+${w} +:+    +:++:+         ${r}
${b}   +#++:++#  +#+          +#+       +#+   +#++:++#++:${w}+#+    +:++#++:++#++   ${r}
${b}  +#+       +#+          +#+      +#+    +#+     +#+${w}+#+    +#+       +#+    ${r}
${b} #+#       #+#          #+#     #+#     #+#     #+##${w}+#    #+##+#    #+#     ${r}
${b}##########################################     #### ${w}#######  ########       ${r}`,
  ];

  // Randomly select and log one banner
  const randomBanner = banners[Math.floor(Math.random() * banners.length)];

  if (!process.argv.includes('--nobanner')) {
    console.log(randomBanner);
  } else {
    console.log(`*** elizaOS ***`);
  }

  // log the version
  console.log(`${versionColor}Version: ${version}${r}`);

  const program = new Command().name('elizaos').version(version);

  program
    .addCommand(create)
    .addCommand(project)
    .addCommand(plugin)
    .addCommand(agent)
    .addCommand(tee)
    .addCommand(start)
    .addCommand(update)
    .addCommand(test)
    .addCommand(env)
    .addCommand(dev)
    .addCommand(publish);

  await program.parseAsync();
}

main().catch((error) => {
  logger.error('An error occurred:', error);
  process.exit(1);
});
