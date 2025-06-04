import { ToastAction } from '@/components/ui/toast';
import info from '@/lib/info.json';
import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router';
import semver from 'semver';
import { useQuery } from '@tanstack/react-query';
import { useToast } from './use-toast';
import clientLogger from '../lib/logger';

async function getLatestRelease(repo: string) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'eliza-client',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest release: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.tag_name;
}

export default function useVersion() {
  const { toast } = useToast();
  const hasShownToast = useRef(false);

  const { data: latestVersion, error } = useQuery({
    queryKey: ['latest-release', 'elizaos/eliza'],
    queryFn: () => getLatestRelease('elizaos/eliza'),
    staleTime: 1000 * 60 * 60, // 1 hour
    gcTime: 1000 * 60 * 60 * 24, // 24 hours
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: 1,
  });

  useEffect(() => {
    if (error) {
      clientLogger.error(`Unable to retrieve latest version from GitHub: ${error}`);
      return;
    }

    if (latestVersion && info?.version && !hasShownToast.current) {
      const thisVersion = info.version;
      if (semver.gt(latestVersion.replace('v', ''), thisVersion.replace('v', ''))) {
        hasShownToast.current = true;
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
  }, [latestVersion, error, toast]);

  return null;
}
