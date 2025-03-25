// Export function to display banner and version

import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function displayBanner() {
  // Color ANSI escape codes
  const b = '\x1b[38;5;27m';
  const lightblue = '\x1b[38;5;51m';
  const w = '\x1b[38;5;255m';
  const r = '\x1b[0m';
  const red = '\x1b[38;5;196m';
  let versionColor = lightblue;

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

  // if version includes "beta" or "alpha" then use red
  if (version?.includes('beta') || version?.includes('alpha')) {
    versionColor = red;
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
${b}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⣿⠀⠙⠛⠿⢤⣦⣐⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣐⣿⣿⢰⡀⠀⠀⠀⠈⠻⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠤⠾⠛⠛⣿⣶⣇⠀⠀⡆⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⢰⣋⡳⡄⠀⠀⠀⢨⣭⡀⠀⡤⠀⣀⣝⢿⣶⣿⡅⠀⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⢸⣯⠀⣇⠀⠀⠀⣼⣿⣿⣆⢷⣴⣿⣿⡏⣛⡉⠀⠀⠀⠀${w}⢸⣿⣿⣿⣿⣿⣿⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⣾⣿⣿⣧⠀⠀⠀⢸⠟⢀⣴⣿⣿⣿⣿⣦⡀⣠⣾⣿⣿⣿⣿⣦⡙⢿⠀${r}
${b}⠀⠀⠀⠙⢷⣮⠀⠀⢸⣿⣿⣿⣿⣷⣯⣟⣏⣼⣷⣅⠾⡟⠀⠀${w}⢸⣿⣇⣀⣀⣀⠀⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⠀⠀⠀⣠⣿⣿⠟⠁⠀⠀⣼⣿⡟⣿⣿⣆⠀⠀⠀⠀⣿⣿⠋⠀⠈⠻⣿⡇⣿⣿⣅⣀⣀⡛⠛⠃⠀⠀${r}
${b}⠀⠀⠀⠀⠀⠁⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀⠀${w}⢸⣿⡿⠿⠿⠿⠀⢸⣿⣿⠀⠀⠀⠀⠀⣿⣿⡇⠀⣠⣾⣿⠟⠁⠀⠀⠀⣰⣿⣿⣁⣸⣿⣿⡄⠀⠀⠀⣿⣿⡀⠀⠀⢘⣿⣿⢈⣛⠿⠿⠿⣿⣷⡄⠀⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣉⡟⠀⠀⠀⠀⠀${w}⢸⣿⣧⣤⣤⣤⣤⢸⣿⣿⣦⣤⣤⣤⡄⣿⣿⡇⣾⣿⣿⣧⣤⣤⣤⡄⢰⣿⣿⠟⠛⠛⠻⣿⣿⡄⢠⡀⠻⣿⣿⣦⣴⣿⣿⠇⢿⣿⣦⣤⣤⣿⣿⠇⣠⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⢰⡈⠛⠿⣿⣿⣿⣿⣿⠋⠀⣦⣤⣄⠀⠀${w}⠘⠛⠛⠛⠛⠛⠛⠈⠛⠛⠛⠛⠛⠛⠃⠛⠛⠃⠛⠛⠛⠛⠛⠛⠛⠃⠛⠛⠃⠀⠀⠀⠀⠙⠛⠃⠘⠛⠀⠈⠛⠛⠛⠛⠁⠀⠀⠙⠛⠛⠛⠛⠁⠚⠛⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⡦⠀⠀⠉⠛⠿⠃⠀⠀⠀⠁⠉⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
${b}⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⢾⡃⠀⠀${w}⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀${r}
`,
  ];

  // Randomly select and log one banner
  const randomBanner = banners[Math.floor(Math.random() * banners.length)];

  console.log(randomBanner);

  if (version) {
    // log the version
    console.log(`${versionColor}Version: ${version}${r}`);
  }
}
