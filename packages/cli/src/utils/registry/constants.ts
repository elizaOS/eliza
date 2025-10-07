// Registry configuration constants - centralized for maintainability
export const REGISTRY_ORG = 'elizaos-plugins';
export const REGISTRY_REPO_NAME = 'registry';
export const REGISTRY_REPO = `${REGISTRY_ORG}/${REGISTRY_REPO_NAME}`;

// Derived URLs
export const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_REPO}/refs/heads/main/index.json`;
export const REGISTRY_GITHUB_URL = `https://github.com/${REGISTRY_REPO}`;

// Legacy exports for backward compatibility
export const RAW_REGISTRY_URL = REGISTRY_URL;
