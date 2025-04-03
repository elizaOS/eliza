const fs = require('fs');
const path = require('path');
const https = require('https');

const REGISTRY_URL =
  'https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json';
const OUTPUT_FILE = path.join(__dirname, '../src/data/registry-users.tsx');
const DESCRIPTIONS_FILE = path.join(__dirname, '../src/data/plugin-descriptions.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Optional GitHub token for higher rate limits

/**
 * Get GitHub preview URL for repository
 */
function getGithubPreviewUrl(repoPath) {
  return `https://opengraph.githubassets.com/1/${repoPath}`;
}

/**
 * Fix image URL by removing /eliza/ prefix if present
 */
function fixImageUrl(url) {
  if (!url) return null;
  return url.replace(/^\/eliza\//, '/');
}

/**
 * Fetch repository description from GitHub API
 */
function fetchGithubDescription(repoPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'ElizaOS-Registry-Update',
        ...(GITHUB_TOKEN && { Authorization: `token ${GITHUB_TOKEN}` }),
      },
    };

    https
      .get(`https://api.github.com/repos/${repoPath}`, options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const repo = JSON.parse(data);
            resolve(repo.description || null);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Transform a registry entry to extract plugin information
 */
function processRegistryEntry(name, repoUrl) {
  const repoPath = repoUrl.replace('github:', '');

  const displayName = name
    .replace('@elizaos-plugins/plugin-', '')
    .replace('@elizaos-plugins/client-', '')
    .replace('@elizaos-plugins/adapter-', '')
    .replace(/-/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const type = name.includes('client-')
    ? 'client'
    : name.includes('adapter-')
      ? 'adapter'
      : 'plugin';

  return {
    id: name,
    name: name,
    repo_url: repoUrl,
    repo_path: repoPath,
    display_name: displayName,
    type: type,
  };
}

/**
 * Load custom descriptions from JSON file
 */
function loadCustomDescriptions() {
  try {
    if (fs.existsSync(DESCRIPTIONS_FILE)) {
      const data = fs.readFileSync(DESCRIPTIONS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn('Failed to load custom descriptions:', error);
  }

  return {};
}

/**
 * Create initial descriptions JSON if it doesn't exist
 */
function createInitialDescriptionsJSON(plugins) {
  // If file already exists, don't overwrite it
  if (fs.existsSync(DESCRIPTIONS_FILE)) {
    return;
  }

  const descriptions = {};

  plugins.forEach((plugin) => {
    const defaultDescription = `${plugin.type.charAt(0).toUpperCase() + plugin.type.slice(1)} for ${plugin.display_name}`;
    descriptions[plugin.id] = {
      description: defaultDescription,
      custom_preview: null,
    };
  });

  fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(descriptions, null, 2));
  console.log(`Created initial descriptions file at ${DESCRIPTIONS_FILE}`);
}

/**
 * Fetch registry data from GitHub
 */
function fetchRegistry() {
  return new Promise((resolve, reject) => {
    https
      .get(REGISTRY_URL, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Update descriptions with GitHub data
 */
async function updateDescriptions(plugins, customData) {
  const updatedDescriptions = { ...customData };
  let updated = false;

  // Fix image URLs in existing descriptions
  for (const pluginId in updatedDescriptions) {
    if (updatedDescriptions[pluginId].custom_preview) {
      updatedDescriptions[pluginId].custom_preview = fixImageUrl(
        updatedDescriptions[pluginId].custom_preview
      );
      updated = true;
    }
  }

  for (const plugin of plugins) {
    // Skip if we already have a custom description
    if (updatedDescriptions[plugin.id]?.description) {
      continue;
    }

    try {
      const githubDescription = await fetchGithubDescription(plugin.repo_path);
      if (githubDescription) {
        updatedDescriptions[plugin.id] = {
          ...updatedDescriptions[plugin.id],
          description: githubDescription,
        };
        updated = true;
        console.log(`Updated description for ${plugin.id}`);
      }
    } catch (error) {
      console.warn(`Failed to fetch description for ${plugin.id}:`, error);
    }

    // Add a small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (updated) {
    fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(updatedDescriptions, null, 2));
    console.log('Updated descriptions file with GitHub data');
  }

  return updatedDescriptions;
}

/**
 * Generate the TypeScript file with registry users
 */
function generateUsersFile(plugins, customData) {
  // Extract names of plugins from GitHub
  const registryPluginNames = plugins.map((plugin) => plugin.id);

  // Find plugins in descriptions that aren't in the registry
  const missingPlugins = [];
  for (const pluginId in customData) {
    if (!registryPluginNames.includes(pluginId)) {
      // Create plugin data for missing plugins
      const displayName = pluginId
        .replace('@elizaos-plugins/plugin-', '')
        .replace('@elizaos-plugins/client-', '')
        .replace('@elizaos-plugins/adapter-', '')
        .replace(/-/g, ' ')
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      const type = pluginId.includes('client-')
        ? 'client'
        : pluginId.includes('adapter-')
          ? 'adapter'
          : 'plugin';

      // Create the missing plugin entry
      missingPlugins.push({
        id: pluginId,
        name: pluginId,
        // For missing plugins, we'll use the elizaos-plugins org as fallback
        repo_url: `github:elizaos-plugins/${pluginId.split('/').pop()}`,
        repo_path: `elizaos-plugins/${pluginId.split('/').pop()}`,
        display_name: displayName,
        type: type,
      });
    }
  }

  // Combine existing plugins with missing ones
  const allPlugins = [...plugins, ...missingPlugins];

  // Continue with normal processing
  const users = allPlugins.map((plugin) => {
    const pluginData = customData[plugin.id] || {};

    const description =
      pluginData.description ||
      `${plugin.type.charAt(0).toUpperCase() + plugin.type.slice(1)} for ${plugin.display_name}`;

    // Use the actual repository path from the registry for GitHub preview
    const previewUrl =
      fixImageUrl(pluginData.custom_preview) || getGithubPreviewUrl(plugin.repo_path);

    // Check if this plugin is marked as featured
    const tags = [plugin.type];
    if (pluginData.featured) {
      tags.push('favorite');
    }

    // Check if this plugin is marked as open source
    if (pluginData.opensource) {
      tags.push('opensource');
    }

    return {
      title: plugin.display_name,
      description: description,
      preview: previewUrl,
      website: `https://github.com/${plugin.repo_path}`,
      source: `https://github.com/${plugin.repo_path}`,
      tags: tags,
    };
  });

  const fileContent = `// This file is auto-generated. Do not edit directly.
import {type User} from './users';

export const registryUsers: User[] = ${JSON.stringify(users, null, 2)};
`;

  fs.writeFileSync(OUTPUT_FILE, fileContent);
  console.log('Successfully updated registry users data!');
}

/**
 * Main function to run the script
 */
async function main() {
  try {
    // Fetch registry data from GitHub
    const registryData = await fetchRegistry();

    // Process registry entries
    const plugins = Object.entries(registryData).map(([name, repoUrl]) =>
      processRegistryEntry(name, repoUrl)
    );

    // Create initial descriptions file if it doesn't exist
    createInitialDescriptionsJSON(plugins);

    // Load custom descriptions from JSON
    const customData = loadCustomDescriptions();

    // Update descriptions with GitHub data
    const updatedDescriptions = await updateDescriptions(plugins, customData);

    // Generate the TypeScript file
    generateUsersFile(plugins, updatedDescriptions);
  } catch (error) {
    console.error('Failed to update registry:', error);
    process.exit(1);
  }
}

main();
