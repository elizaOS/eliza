import { logger } from '@elizaos/core';

/**
 * Display helpful bun installation instructions with OS-specific commands
 */
export function displayBunInstallationTips(): void {
  logger.error('\n❌ Bun is not installed or not found in PATH');
  logger.info('\n🚀 Install Bun using the appropriate command for your system:');
  
  // Detect OS and show relevant command
  const platform = process.platform;
  
  if (platform === 'win32') {
    logger.info('\n📦 Windows:');
    logger.info('   powershell -c "irm bun.sh/install.ps1 | iex"');
    logger.info('   # or use Scoop: scoop install bun');
    logger.info('   # or use Chocolatey: choco install bun');
  } else {
    logger.info('\n🐧 Linux/macOS:');
    logger.info('   curl -fsSL https://bun.sh/install | bash');
    
    if (platform === 'darwin') {
      logger.info('   # or use Homebrew: brew install bun');
    }
  }
  
  logger.info('\n🔗 More installation options: https://bun.sh/docs/installation');
  logger.info('\n💡 After installation, restart your terminal or run:');
  logger.info('   source ~/.bashrc  # Linux');
  logger.info('   source ~/.zshrc   # macOS with zsh');
  logger.info('   # or restart your terminal');
}

/**
 * Display compact bun installation tip for inline use
 */
export function displayBunInstallationTipCompact(): string {
  const platform = process.platform;
  
  if (platform === 'win32') {
    return 'Install bun: powershell -c "irm bun.sh/install.ps1 | iex" (see https://bun.sh/docs/installation)';
  } else {
    return 'Install bun: curl -fsSL https://bun.sh/install | bash (see https://bun.sh/docs/installation)';
  }
}

/**
 * Check if bun is available and provide installation tips if not
 */
export async function ensureBunAvailable(): Promise<boolean> {
  try {
    const { execa } = await import('execa');
    await execa('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    displayBunInstallationTips();
    return false;
  }
}
