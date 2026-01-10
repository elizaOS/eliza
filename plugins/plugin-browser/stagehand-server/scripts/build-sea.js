import { readFile, writeFile, copyFile, mkdir, chmod, access } from 'fs/promises';
import { createRequire } from 'module';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const platforms = [
  {
    name: 'linux',
    arch: 'x64',
    nodeUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.gz',
  },
  {
    name: 'darwin',
    arch: 'x64',
    nodeUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-darwin-x64.tar.gz',
  },
  {
    name: 'darwin',
    arch: 'arm64',
    nodeUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-darwin-arm64.tar.gz',
  },
  {
    name: 'win32',
    arch: 'x64',
    nodeUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip',
  },
];

async function downloadNodeBinary(platform, arch) {
  const fs = await import('fs');
  const https = await import('https');
  const tar = await import('tar');
  const unzipper = await import('unzipper');

  const tempDir = join(__dirname, '../temp');
  await mkdir(tempDir, { recursive: true });

  const url = platforms.find((p) => p.name === platform && p.arch === arch)?.nodeUrl;
  if (!url) {
    throw new Error(`No URL found for platform ${platform} ${arch}`);
  }

  const isZip = url.endsWith('.zip');
  const downloadPath = join(tempDir, `node-${platform}-${arch}.${isZip ? 'zip' : 'tar.gz'}`);

  // Download if not already cached
  if (!existsSync(downloadPath)) {
    console.log(`Downloading Node.js for ${platform}-${arch}...`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(downloadPath);
      https
        .get(url, (response) => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', reject);
    });
  }

  // Extract
  const extractDir = join(tempDir, `node-${platform}-${arch}`);
  await mkdir(extractDir, { recursive: true });

  if (isZip) {
    await fs
      .createReadStream(downloadPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();
  } else {
    await tar.extract({
      file: downloadPath,
      cwd: extractDir,
      strip: 1,
    });
  }

  // Find the node binary
  const ext = platform === 'win32' ? '.exe' : '';
  let nodeBinary;

  if (platform === 'win32') {
    // For Windows, the ZIP extraction creates a subdirectory like node-v20.18.1-win-x64
    // We need to find this directory and get the node.exe from there
    const fs = await import('fs');
    const subdirs = await fs.promises.readdir(extractDir);
    const nodeDir = subdirs.find((dir) => dir.startsWith('node-v'));
    if (nodeDir) {
      nodeBinary = join(extractDir, nodeDir, `node${ext}`);
    } else {
      nodeBinary = join(extractDir, `node${ext}`);
    }
  } else {
    nodeBinary = join(extractDir, 'bin', `node${ext}`);
  }

  // Verify the node binary exists
  try {
    await access(nodeBinary);
  } catch (error) {
    throw new Error(`Node binary not found at ${nodeBinary}. Extraction may have failed.`);
  }

  return nodeBinary;
}

async function buildSEA() {
  console.log('Building Stagehand Server SEA binaries...');

  // Ensure directories exist
  await mkdir(join(__dirname, '../dist'), { recursive: true });
  await mkdir(join(__dirname, '../binaries'), { recursive: true });

  try {
    // Step 1: Build the TypeScript code
    console.log('Building TypeScript...');
    await execAsync('npm run build', {
      cwd: join(__dirname, '..'),
    });

    // Step 2: Bundle with esbuild
    console.log('Bundling with esbuild...');
    await execAsync(
      'npx esbuild dist/index.js --bundle --platform=node --target=node20 --format=cjs --outfile=dist/bundle.cjs --external:playwright --external:@browserbasehq/stagehand --external:bufferutil --external:utf-8-validate',
      {
        cwd: join(__dirname, '..'),
      }
    );

    // Create SEA config pointing to bundled file
    const seaConfig = {
      main: './dist/bundle.cjs',
      output: './binaries/stagehand-server.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    };

    await writeFile(join(__dirname, '../sea-config.json'), JSON.stringify(seaConfig, null, 2));

    // Step 3: Create the blob
    console.log('Creating SEA blob...');
    await execAsync('node --experimental-sea-config sea-config.json', {
      cwd: join(__dirname, '..'),
    });

    // Step 4: Create binaries for each platform
    const currentPlatform = process.platform;
    const currentArch = process.arch;

    for (const platform of platforms) {
      console.log(`Building for ${platform.name}-${platform.arch}...`);

      const ext = platform.name === 'win32' ? '.exe' : '';
      const outputName = `stagehand-server-${platform.name}-${platform.arch}${ext}`;
      const outputPath = join(__dirname, '../binaries', outputName);

      let nodeBinaryPath;

      if (platform.name === currentPlatform && platform.arch === currentArch) {
        // For current platform, use local node
        nodeBinaryPath = process.execPath;
      } else {
        // For cross-platform builds in CI/CD environments
        if (process.env.CI || process.env.BUILD_ALL_PLATFORMS === 'true') {
          try {
            nodeBinaryPath = await downloadNodeBinary(platform.name, platform.arch);
          } catch (error) {
            console.error(
              `Failed to download Node.js for ${platform.name}-${platform.arch}: ${error.message}`
            );
            console.log(`Skipping ${platform.name}-${platform.arch} build`);
            continue;
          }
        } else {
          console.log(`Skipping cross-platform build for ${platform.name}-${platform.arch}`);
          console.log('Set BUILD_ALL_PLATFORMS=true to build for all platforms');
          continue;
        }
      }

      // Copy the node binary
      await copyFile(nodeBinaryPath, outputPath);

      // Step 5: Inject the blob using postject
      const postjectCommand =
        platform.name === 'darwin'
          ? `npx postject ${outputPath} NODE_SEA_BLOB ./binaries/stagehand-server.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`
          : `npx postject ${outputPath} NODE_SEA_BLOB ./binaries/stagehand-server.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;

      console.log('Running postject...');
      try {
        await execAsync(postjectCommand, {
          cwd: join(__dirname, '..'),
        });
      } catch (error) {
        console.error(`Postject failed for ${platform.name}-${platform.arch}: ${error.message}`);
        // Continue with other platforms
        continue;
      }

      // Make executable on Unix systems
      if (platform.name !== 'win32') {
        await chmod(outputPath, 0o755);
      }

      console.log(`Created: ${outputPath}`);
    }

    // Step 6: Create platform-agnostic symlinks for backward compatibility
    const mainPlatforms = ['linux', 'darwin', 'win32'];
    for (const platform of mainPlatforms) {
      const ext = platform === 'win32' ? '.exe' : '';
      const defaultArch = platform === 'darwin' && process.arch === 'arm64' ? 'arm64' : 'x64';
      const sourceName = `stagehand-server-${platform}-${defaultArch}${ext}`;
      const targetName = `stagehand-server-${platform}${ext}`;
      const sourcePath = join(__dirname, '../binaries', sourceName);
      const targetPath = join(__dirname, '../binaries', targetName);

      if (existsSync(sourcePath) && !existsSync(targetPath)) {
        await copyFile(sourcePath, targetPath);
        if (platform !== 'win32') {
          await chmod(targetPath, 0o755);
        }
        console.log(`Created compatibility link: ${targetName} -> ${sourceName}`);
      }
    }

    // Clean up temp directory
    if (existsSync(join(__dirname, '../temp'))) {
      await execAsync(`rm -rf ${join(__dirname, '../temp')}`);
    }

    console.log('SEA build completed successfully!');
  } catch (error) {
    console.error('Error building SEA:', error);
    process.exit(1);
  }
}

// Run the build
buildSEA().catch(console.error);
