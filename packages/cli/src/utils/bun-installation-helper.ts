import { emoji } from './emoji-handler';
import { bunExec, commandExists } from './bun-exec';

export interface BunInstallationResult {
  installed: boolean;
  message: string;
  error?: string;
}

export async function checkBunInstallation(): Promise<BunInstallationResult> {
  try {
    // Check if bun is available
    const bunExists = await commandExists('bun');

    if (bunExists) {
      // Get bun version
      const result = await bunExec('bun', ['--version']);

      if (result.success) {
        const version = result.stdout.trim();

        return {
          installed: true,
          message: `Bun ${version} is installed`,
        };
      } else {
        return {
          installed: false,
          message: 'Bun command failed',
          error: result.stderr || 'Unknown error',
        };
      }
    } else {
      return {
        installed: false,
        message: 'Bun is not installed',
      };
    }
  } catch (error) {
    return {
      installed: false,
      message: 'Failed to check Bun installation',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function displayBunInstallInstructions(): void {
  const platform = process.platform;

  console.error(
    emoji.error('Bun is required for ElizaOS CLI but is not installed or not found in PATH.')
  );
  console.error('');
  console.error(emoji.rocket('Install Bun using the appropriate command for your system:'));
  console.error('');

  if (platform === 'win32') {
    console.error('   Windows: powershell -c "irm bun.sh/install.ps1 | iex"');
  } else {
    console.error('   Linux/macOS: curl -fsSL https://bun.sh/install | bash');
    if (platform === 'darwin') {
      console.error('   macOS (Homebrew): brew install bun');
    }
  }
  console.error('');
  console.error('   More options: https://bun.sh/docs/installation');
  console.error('   After installation, restart your terminal or source your shell profile');
  console.error('');
}

/**
 * Returns a compact installation tip for bun
 */
export function displayBunInstallationTipCompact(): string {
  return 'Please install Bun from https://bun.sh';
}
