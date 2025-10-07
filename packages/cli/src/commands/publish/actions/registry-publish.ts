import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PackageMetadata } from '../types';

// Registry integration constants
const REGISTRY_PACKAGES_PATH = 'packages';
const LOCAL_REGISTRY_PATH = 'packages/registry';

/**
 * Update the registry index with the package information
 */
export async function updateRegistryIndex(
  packageMetadata: PackageMetadata,
  dryRun = false
): Promise<boolean> {
  try {
    const indexPath = dryRun
      ? path.join(process.cwd(), LOCAL_REGISTRY_PATH, 'index.json')
      : path.join(process.cwd(), 'temp-registry', 'index.json');

    // Create registry directory if it doesn't exist in dry run
    try {
      await fs.access(path.dirname(indexPath));
    } catch {
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      // Create empty index file if it doesn't exist
      try {
        await fs.access(indexPath);
      } catch {
        await fs.writeFile(
          indexPath,
          JSON.stringify(
            {
              v1: { packages: {} },
              v2: { packages: {} },
            },
            null,
            2
          )
        );
      }
    }

    // Read current index
    let indexContent;
    try {
      indexContent = await fs.readFile(indexPath, 'utf-8');
    } catch (error) {
      // Create default index if it doesn't exist
      indexContent = JSON.stringify({
        v1: { packages: {} },
        v2: { packages: {} },
      });
    }

    const index = JSON.parse(indexContent);

    // Update v2 section of index
    if (!index.v2) {
      index.v2 = { packages: {} };
    }

    if (!index.v2.packages) {
      index.v2.packages = {};
    }

    if (!index.v2.packages[packageMetadata.name]) {
      index.v2.packages[packageMetadata.name] = {
        name: packageMetadata.name,
        description: packageMetadata.description,
        type: packageMetadata.type,
        versions: {},
      };
    }

    // Update package info
    const packageInfo = index.v2.packages[packageMetadata.name];
    packageInfo.description = packageMetadata.description;
    packageInfo.type = packageMetadata.type;

    // Add version
    packageInfo.versions[packageMetadata.version] = {
      version: packageMetadata.version,
      runtimeVersion: packageMetadata.runtimeVersion,
      platform: packageMetadata.platform,
      publishedAt: packageMetadata.publishedAt,
      published: !dryRun,
    };

    // Write updated index
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    console.info(
      `Registry index ${dryRun ? '(dry run) ' : ''}updated with ${packageMetadata.name}@${packageMetadata.version}`
    );

    return true;
  } catch (error) {
    console.error(
      `Failed to update registry index: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Save package metadata to registry
 */
export async function savePackageToRegistry(
  packageMetadata: PackageMetadata,
  dryRun = false
): Promise<boolean> {
  try {
    // Define paths
    const packageDir = dryRun
      ? path.join(process.cwd(), LOCAL_REGISTRY_PATH, REGISTRY_PACKAGES_PATH, packageMetadata.name)
      : path.join(process.cwd(), 'temp-registry', REGISTRY_PACKAGES_PATH, packageMetadata.name);
    const metadataPath = path.join(packageDir, `${packageMetadata.version}.json`);

    // Create directory if it doesn't exist
    await fs.mkdir(packageDir, { recursive: true });

    // Write metadata file
    await fs.writeFile(metadataPath, JSON.stringify(packageMetadata, null, 2));

    console.info(`Package metadata ${dryRun ? '(dry run) ' : ''}saved to ${metadataPath}`);

    // Update index file
    await updateRegistryIndex(packageMetadata, dryRun);

    return true;
  } catch (error) {
    console.error(
      `Failed to save package metadata: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
