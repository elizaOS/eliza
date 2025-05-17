#!/usr/bin/env node

const { execSync } = require('child_process')
const pathUtil = require('path')
const fs = require('fs')
const { Command } = require('commander')
const program = new Command()
const { version } = require('./package.json')
const JSON5 = require('json5')
//const axios = require('axios')

const { buildPluginFromDir, migratePlugin } = require('./lib.migrate')

const pluginPkgPath = (pluginRepo) => {
  const parts = pluginRepo.split('/')
  const elizaOSroot = pathUtil.resolve(__dirname, '../..')
  const pkgPath = elizaOSroot + '/packages/' + parts[1]
  return pkgPath
}

const packagedPlugins = ['cli', '@elizaos/client-direct', '@elizaos/core',
  '@elizaos/core-plugin-v1', 'dynamic-imports', '@elizaos/plugin-bootstrap']

const getInstalledPackages = (baseDir) => {
  const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)

  const packageNames = []

  for (const dir of dirs) {
    const pkgPath = pathUtil.join(baseDir, dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.name) {
        packageNames.push(pkg.name)
      }
    }
  }
  return packageNames
}

program
  .name('elizaos')
  .description('elizaOS CLI - Manage your plugins')
  .version(version);

const pluginsCmd = new Command()
  .name('plugins')
  .description('manage elizaOS plugins')

let metadata = {}

async function getPlugins() {
  const resp = await fetch('https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json')
  const mostlyJson = await resp.text();
  //const resp = await axios.get('https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json')
  //const object = resp.data
  const jsonLike = []
  for(const l of mostlyJson.split('\n')) {
    if (l.match(/""/)) {
      const parts = l.split(/:/, 2)
      const noLQte = parts[1].substr(2)
      const parts2 = noLQte.substr(0, noLQte.length -2).split('/', 2)
      metadata[parts2[0]] = parts2[1].split(/,\W*/)
    } else {
      jsonLike.push(l)
    }
  }
  const json = jsonLike.join("\n")
  const plugins = JSON5.parse(json)
  return plugins
}

function remoteBranchExists(repoDir, branchName) {
  try {
    const output = execSync(`git ls-remote --heads origin`, {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    return output.includes(`refs/heads/${branchName}`);
  } catch (err) {
    console.error('Failed to check remote branches:', err);
    return false;
  }
}

pluginsCmd
  .command('list')
  .alias('l')
  .alias('ls')
  .description('list available plugins')
  .option("-t, --type <type>", "filter by type (adapter, client, plugin)")
  .action(async (opts) => {
    try {
      const plugins = await getPlugins()
      //console.log('metadata', metadata)
      const pluginNames = Object.keys(plugins)
        .filter(name => !opts.type || name.includes(opts.type))
        .sort()

      const elizaOSroot = pathUtil.resolve(__dirname, '../..')
      const installled = getInstalledPackages(elizaOSroot + '/packages')
      const installedPlugins = installled.filter(p => !packagedPlugins.includes(p))
      //console.log('installled', installled)

      console.info("\nAvailable plugins:")
      for (const plugin of pluginNames) {
        console.info(` ${installled.includes(plugin) ? '✅' : '  '}  ${plugin} `)
      }
      for(const plugin of installedPlugins) {
        if (!pluginNames.includes(plugin)) {
          console.info(` ✅  ${plugin} (Not in registry)`)
        }
      }
      console.info("")
    } catch (error) {
      console.error(error)
    }
  })

pluginsCmd
  .command('add')
  .alias('install')
  .description('add a plugin')
  .argument('<plugin>', 'plugin name')
  .action(async (plugin, opts) => {
    // ensure git is installed
    try {
      const gitVersion = execSync('git --version', { stdio: 'pipe' }).toString().trim();
      console.log('using', gitVersion)
    } catch(e) {
      console.error('Please install git to use this utility')
      return
    }

    const plugins = await getPlugins()

    // ensure prefix
    const nameParts = plugin.split('/', 2)
    const namePart = nameParts[1]
    const pluginName = plugin
    const elizaOSroot = pathUtil.resolve(__dirname, '../..')

    let repo = ''
    if (namePart === 'plugin-trustdb') {
      repo = 'elizaos-plugins/plugin-trustdb'
    } else {
      const repoData = plugins[pluginName]?.split(':')
      if (!repoData) {
        console.error('Plugin', plugin, 'not found')
        return
      }
      // repo type
      if (repoData[0] !== 'github') {
        console.error('Plugin', plugin, 'uses', repoData[0], ' but this utility only currently support github')
        return
      }
      repo = repoData[1]
    }
    const pkgPath = elizaOSroot + '/packages/' + namePart

    // add to packages
    if (!fs.existsSync(pkgPath + '/package.json')) {
      // clone it
      console.log('cloning', namePart, 'to', pkgPath)
      const gitOutput = execSync('git clone https://github.com/' + repo + ' "' + pkgPath + '"', { stdio: 'pipe' }).toString().trim();
      // submodule init & update?
    }

    // branch detection
    const x1Compat = remoteBranchExists(pkgPath, '0.x')
    if (x1Compat) {
      // switch branches
      console.log('Checking out 0.x branch') // log for education
      const gitOutput = execSync('git checkout 0.x', { stdio: 'pipe', cwd: pkgPath }).toString().trim();
    } else {
      // sniff main
      const packageJsonPath = pkgPath + '/package.json'
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

      let isV2 = false
      for(const d in packageJson.dependencies) {
        if (d.match(/core-plugin-v2/)) {
          isV2 = true
        }
      }

      if (isV2) {
        console.error('Plugin', plugin, 'not compatible with 0.x, deleting', pkgPath)
        try {
          fs.rmSync(pkgPath, { recursive: true, force: true });
        } catch (err) {
          console.error('Error removing package plugin directory:', err);
        }
        return
      }
    }

    // we need to check for dependencies

    // Read the current package.json
    const packageJsonPath = pkgPath + '/package.json'
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

    /*
    const updateDependencies = (deps) => {
      if (!deps) return false
      let changed = false
      const okPackages = ['@elizaos/client-direct', '@elizaos/core', '@elizaos/core-plugin-v1', '@elizaos/plugin-bootstrap']
      for (const dep in deps) {
        if (okPackages.indexOf(dep) !== -1) continue // skip these, they're fine
        // do we want/need to preserve local packages like core?
        if (dep.startsWith("@elizaos/")) {
          const newDep = dep.replace("@elizaos/", "@elizaos-plugins/")
          deps[newDep] = deps[dep]
          delete deps[dep]
          changed = true
        }
      }
      return changed
    }

    // normalize @elizaos => @elizaos-plugins
    if (updateDependencies(packageJson.dependencies)) {
      console.log('updating plugin\'s package.json to not use @elizos/ for dependencies')
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
      // I don't think will cause the lockfile from getting out of date
    }
    */
    const swapCoreDependencies = (deps) => {
      console.log('Ensuring plugin\'s core dependencies')
      delete deps['@elizaos/core']
      deps['@elizaos/core-plugin-v1'] = 'workspace:*'
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
    }
    swapCoreDependencies(packageJson.dependencies)

    const installled = getInstalledPackages(elizaOSroot + '/packages')
    const installedPlugins = installled.filter(p => !packagedPlugins.includes(p))

    //console.log('packageJson', packageJson.dependencies)
    for(const d in packageJson.dependencies) {
      // if it's not installed and it's in the registry
      if (!installedPlugins.includes(d)) {
        // do we have this plugin?
        if (Object.keys(plugins).includes(d)) {
          // install from registry
          console.log('attempting installation of dependency', d)
          try {
            const pluginAddDepOutput = execSync('npx elizaos plugins add ' + d, { cwd: elizaOSroot, stdio: 'pipe' }).toString().trim();
            //console.log('pluginAddDepOutput', pluginAddDepOutput)
          } catch (e) {
            console.error('pluginAddDepOutput error', e)
          }
        //} else {
          // maybe pnpm i call? I think pnpm will take care of these
        }
      }
    }

    // add core to plugin
    // # pnpm add @elizaos/core@workspace:* --filter ./packages/client-twitter

    // ok this can be an issue if it's referencing a plugin it couldn't be
    console.log('Making sure plugin has access to @elizaos/core-plugin-v1')
    try {
      const pluginAddCoreOutput = execSync('pnpm add @elizaos/core-plugin-v1@workspace:* --filter ./packages/' + plugin, { cwd: elizaOSroot, stdio: 'pipe' }).toString().trim();
    } catch(e) {
      console.error('pluginAddCoreOutput error', e)
    }

    // is this needed? if we want it to be assumed and hard coded but might not work with npm
    if (packageJson.name !== '@elizaos-plugins/' + namePart) {
      packageJson.name = '@elizaos-plugins/' + namePart
      console.log('Updating plugins package.json name to', packageJson.name)
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2))
    }

    // now take care of anything inside the source
    const pluginObj = buildPluginFromDir(pkgPath)
    migratePlugin(pluginObj)

    // ensure we have all needed NPMs
    console.log('installing NPMs', elizaOSroot)
    try {
      const projectInstallOutput = execSync('pnpm i --no-frozen-lockfile', { cwd: elizaOSroot, stdio: 'pipe' }).toString().trim();
      //console.log('projectInstallOutput', projectInstallOutput)
    } catch (e) {
      console.error('projectInstallOutput error', e)
    }

    if (pluginObj.hasSrcRefs) {
      console.log('building plugin', pkgPath)
      try {
        const pluginAddAgentOutput = execSync('pnpm build', { cwd: pkgPath, stdio: 'pipe' }).toString().trim();
        //console.log('pluginAddAgentOutput', pluginAddAgentOutput)
      } catch (e) {
        console.error('error', e)
      }
    }

    // add to agent
    const agentPackageJsonPath = elizaOSroot + '/agent/package.json'
    const agentPackageJson = JSON.parse(fs.readFileSync(agentPackageJsonPath, 'utf-8'));
    //console.log('agentPackageJson', agentPackageJson.dependencies[pluginName])
    if (!agentPackageJson.dependencies[pluginName]) {
      console.log('Adding plugin', plugin, 'to agent/package.json')
      try {
        const pluginAddAgentOutput = execSync('pnpm add ' + pluginName + '@workspace:* --filter ./agent', { cwd: elizaOSroot, stdio: 'pipe' }).toString().trim();
        //console.log('pluginAddAgentOutput', pluginAddAgentOutput)
      } catch (e) {
        console.error('error', e)
      }
    }

    console.log(plugin, 'attempted installation is complete')
    // can't add to char file because we don't know which character
    console.log('Remember to add it to your character file\'s plugin field: ["' + pluginName + '"]')
  })

// doesn't remove dependencies because can't tell if they're in use
pluginsCmd
  .command('remove')
  .alias('delete')
  .alias('del')
  .alias('rm')
  .description('remove a plugin')
  .argument("<plugin>", "plugin name")
  .action(async (plugin, opts) => {
    // ensure prefix
    const nameParts = plugin.split('/', 2)
    const namePart = nameParts[1]
    const pluginName = plugin
    const elizaOSroot = pathUtil.resolve(__dirname, '../..')
    const pkgPath = elizaOSroot + '/packages/' + namePart
    const plugins = await getPlugins()

    let repo = ''
    if (namePart === 'plugin-trustdb') {
      repo = 'elizaos-plugins/plugin-trustdb'
    } else {
      const repoData = plugins[pluginName]?.split(':')
      if (!repoData) {
        console.error('Plugin', pluginName, 'not found')
        return
      }
      const parts = repoData[1].split('/')
      repo = parts[1]
    }

    // remove from agent: pnpm remove some-plugin --filter ./agent
    try {
      console.log('Removing', pluginName, 'from agent')
      const pluginRemoveAgentOutput = execSync('pnpm remove ' + pluginName + ' --filter ./agent', { cwd: elizaOSroot, stdio: 'pipe' }).toString().trim();
    } catch (e) {
      console.error('removal from agent, error', e)
    }

    if (fs.existsSync(pkgPath)) {
      // rm -fr packages/path
      console.log('deleting', pkgPath)
      //const gitOutput = execSync('git clone https://github.com/' + repoData[1] + ' ' + pkgPath, { stdio: 'pipe' }).toString().trim();
      try {
        fs.rmSync(pkgPath, { recursive: true, force: true });
      } catch (err) {
        console.error('Error removing package plugin directory:', err);
      }
    }
    console.log(plugin, 'attempted plugin removal is complete')
  })


program.addCommand(pluginsCmd)

program.parse(process.argv)
