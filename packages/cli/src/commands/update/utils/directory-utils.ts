import { type DirectoryInfo } from '@/src/utils/directory-detection';

/**
 * Handle invalid directory scenarios using the new boolean flag system
 */
export function handleInvalidDirectory(directoryInfo: DirectoryInfo) {
  let messages: string[] = [];

  if (directoryInfo.isNonElizaOS) {
    messages = [
      "This directory doesn't appear to be an ElizaOS project.",
      directoryInfo.packageName ? `Found package: ${directoryInfo.packageName}` : undefined,
      'ElizaOS update only works in ElizaOS projects, plugins, the ElizaOS monorepo, and ElizaOS infrastructure packages (e.g. client, cli).',
      'To create a new ElizaOS project, use: elizaos create <project-name>',
    ].filter(Boolean);
  } else if (!directoryInfo.hasPackageJson) {
    // Handle invalid/missing package.json
    messages = [
      'Cannot update packages in this directory.',
      "No package.json found. This doesn't appear to be a valid project directory.",
      'To create a new ElizaOS project, use: elizaos create <project-name>',
    ];
  } else {
    // Handle other invalid scenarios (e.g., corrupted package.json)
    messages = [
      'Cannot update packages in this directory.',
      'The package.json file appears to be invalid or unreadable.',
      'To create a new ElizaOS project, use: elizaos create <project-name>',
    ];
  }

  if (messages.length > 0) {
    messages.forEach((msg) => console.warn(msg));
  } else {
    console.error(`Unexpected directory type: ${directoryInfo.type}`);
  }
}
