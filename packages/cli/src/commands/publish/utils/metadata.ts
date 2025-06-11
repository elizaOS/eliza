import { PackageMetadata, PackageJson } from '../types';

/**
 * Generate package metadata for the registry
 */
export async function generatePackageMetadata(
  packageJson: PackageJson,
  cliVersion: string,
  username: string
): Promise<PackageMetadata> {
  const metadata: PackageMetadata = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description || '',
    type: packageJson.type || 'plugin', // plugin or project
    platform: packageJson.platform || 'universal', // node, browser, or universal
    runtimeVersion: cliVersion, // Compatible CLI/runtime version
    repository: packageJson.repository?.url || '',
    maintainers: packageJson.maintainers || [username],
    publishedAt: new Date().toISOString(),
    publishedBy: username,
    dependencies: packageJson.dependencies || {},
    tags: packageJson.keywords || [],
    license: packageJson.license || 'UNLICENSED',
  };

  // Add npm or GitHub specific data
  if (packageJson.npmPackage) {
    metadata.npmPackage = packageJson.npmPackage;
  }

  if (packageJson.githubRepo) {
    metadata.githubRepo = packageJson.githubRepo;
  }

  // Ensure appropriate tag is included based on type
  if (metadata.type === 'plugin' && !metadata.tags.includes('plugin')) {
    metadata.tags.push('plugin');
  } else if (metadata.type === 'project' && !metadata.tags.includes('project')) {
    metadata.tags.push('project');
  }

  return metadata;
}
