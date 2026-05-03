import { getAppHost, getAppUrl } from "@/lib/utils/app-url";
import type { Metadata, MetadataRoute } from "./metadata-types";

const DEFAULT_INDEXABLE_HOSTS = ["elizacloud.ai", "www.elizacloud.ai"] as const;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function getIndexableHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredHosts = env.NEXT_PUBLIC_INDEXABLE_HOSTS?.split(",")
    .map((host) => normalizeHost(host))
    .filter(Boolean);

  return configuredHosts?.length ? configuredHosts : [...DEFAULT_INDEXABLE_HOSTS];
}

export function shouldIndexSite(env: NodeJS.ProcessEnv = process.env): boolean {
  const currentHost = normalizeHost(getAppHost(env));
  return getIndexableHosts(env).includes(currentHost);
}

export function getRobotsMetadata(
  options: { noIndex?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Metadata["robots"] {
  const index = !options.noIndex && shouldIndexSite(env);

  return {
    index,
    follow: index,
    googleBot: {
      index,
      follow: index,
      "max-video-preview": index ? -1 : 0,
      "max-image-preview": index ? "large" : "none",
      "max-snippet": index ? -1 : 0,
    },
  };
}

export function generateRobotsFile(env: NodeJS.ProcessEnv = process.env): MetadataRoute.Robots {
  const index = shouldIndexSite(env);
  const appUrl = getAppUrl(env);

  return {
    rules: index
      ? {
          userAgent: "*",
          allow: "/",
        }
      : {
          userAgent: "*",
          disallow: "/",
        },
    host: appUrl,
    sitemap: index ? `${appUrl}/sitemap.xml` : undefined,
  };
}
