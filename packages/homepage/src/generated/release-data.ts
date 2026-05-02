export const releaseData = {
  generatedAt: "2026-05-02T04:14:08.087Z",
  scripts: {
    shell: {
      url: "https://eliza.ai/install.sh",
      command: "curl -fsSL https://eliza.ai/install.sh | bash",
    },
    powershell: {
      url: "https://eliza.ai/install.ps1",
      command: "irm https://eliza.ai/install.ps1 | iex",
    },
  },
  cdn: {
    tagName: "v2.0.0-alpha.526",
    appAssetBaseUrl:
      "https://raw.githubusercontent.com/elizaos/eliza/v2.0.0-alpha.526/packages/app/public/",
    homepageAssetBaseUrl:
      "https://raw.githubusercontent.com/elizaos/eliza/v2.0.0-alpha.526/packages/homepage/public/",
  },
  release: {
    tagName: "v2.0.0-alpha.526",
    publishedAtLabel: "Apr 30, 2026",
    prerelease: true,
    url: "https://github.com/elizaOS/eliza/releases/tag/v2.0.0-alpha.526",
    downloads: [],
    checksum: null,
  },
  stableRelease: {
    tagName: "v2.0.0-alpha.526",
    publishedAtLabel: "Apr 30, 2026",
    prerelease: true,
    url: "https://github.com/elizaOS/eliza/releases/tag/v2.0.0-alpha.526",
    downloads: [],
    checksum: null,
  },
  canaryRelease: {
    tagName: "v2.0.0-alpha.526",
    publishedAtLabel: "Apr 30, 2026",
    prerelease: true,
    url: "https://github.com/elizaOS/eliza/releases/tag/v2.0.0-alpha.526",
    downloads: [],
    checksum: null,
  },
} as const;
