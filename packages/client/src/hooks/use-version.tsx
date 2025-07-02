import { ToastAction } from '@/components/ui/toast';
import { useEffect, useCallback } from 'react';
import { NavLink } from 'react-router';
import semver from 'semver';
import { useToast } from './use-toast';
import { useServerVersion } from './use-server-version';
import clientLogger from '../lib/logger';

export default function useVersion() {
  const { toast } = useToast();
  const { data: versionInfo } = useServerVersion();

  async function getLatestRelease(repo: string) {
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

    try {
      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'fetch-latest-release',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch latest release: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      const latestVersion = data.tag_name;
      return latestVersion;
    } catch {}
  }

  const compareVersion = useCallback(async () => {
    try {
      const latestVersion = await getLatestRelease('elizaos/eliza');
      const thisVersion = versionInfo?.version;
      if (latestVersion && thisVersion) {
        if (semver.gt(latestVersion.replace('v', ''), thisVersion.replace('v', ''))) {
          toast({
            variant: 'default',
            title: `New version ${latestVersion} is available.`,
            description: 'Visit GitHub for more information.',
            action: (
              <NavLink to="https://github.com/elizaos/eliza/releases" target="_blank">
                <ToastAction altText="Update">Update</ToastAction>
              </NavLink>
            ),
          });
        }
      }
    } catch (e) {
      clientLogger.error(`Unable to retrieve latest version from GitHub: ${e}`);
    }
  }, [toast, versionInfo?.version]);

  useEffect(() => {
    compareVersion();
  }, [compareVersion]);

  return null;
}
