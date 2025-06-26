/**
 * Global teardown that runs after all tests complete
 * This ensures no orphaned processes remain
 */

export default async function globalTeardown() {
  console.log('[GLOBAL TEARDOWN] Cleaning up any remaining test processes...');
  
  // Only run cleanup on Unix-like systems
  if (process.platform !== 'win32') {
    try {
      const { execSync } = await import('child_process');
      
      // Kill any remaining elizaos processes
      const commands = [
        'pkill -f "elizaos start" || true',
        'pkill -f "elizaos dev" || true', 
        'pkill -f "bun.*dist/index.js" || true',
        'pkill -f "eliza-test" || true'
      ];
      
      for (const cmd of commands) {
        try {
          execSync(cmd, { stdio: 'ignore' });
        } catch (e) {
          // Ignore individual command failures
        }
      }
      
      // Kill processes on common test ports
      const testPorts = [3000, 3100, 3456];
      for (const port of testPorts) {
        try {
          execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { 
            stdio: 'ignore' 
          });
        } catch (e) {
          // Ignore port cleanup errors
        }
      }
      
    } catch (error) {
      console.error('[GLOBAL TEARDOWN] Error during cleanup:', error);
    }
  }
  
  console.log('[GLOBAL TEARDOWN] Complete');
} 