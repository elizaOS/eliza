import { publishToGitHub } from '@/src/utils';
import { Credentials, PackageJson, PublishResult } from '../types';

/**
 * Publish package to GitHub and optionally to registry
 */
export async function publishToGitHubAction(
  cwd: string,
  packageJson: PackageJson,
  credentials: Credentials,
  skipRegistry: boolean = false,
  dryRun: boolean = false
): Promise<PublishResult> {
  console.info('Publishing to GitHub and registry...');

  const result = await publishToGitHub(
    cwd,
    packageJson,
    credentials.username,
    skipRegistry,
    dryRun
  );

  if (!result) {
    throw new Error('GitHub publishing failed');
  }

  console.log(
    `[√] Successfully published plugin ${packageJson.name}@${packageJson.version} to GitHub`
  );

  return result;
}
