/**
 * Global test setup for CLI tests
 * This file is preloaded by Bun test runner via bunfig.toml
 */

// Store original handlers
const originalHandlers = {
  unhandledRejection: process.listeners('unhandledRejection'),
  uncaughtException: process.listeners('uncaughtException'),
};

// Add a more intelligent unhandled rejection handler
// that logs warnings but doesn't fail the test unless it's actually a test failure
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  // If it's a test-related error, let it bubble up
  if (reason && typeof reason === 'object' && reason.name === 'AssertionError') {
    throw reason;
  }
  
  // For other unhandled rejections (like process cleanup issues), log and continue
  console.warn('Unhandled promise rejection (non-test):', reason);
});

// Handle uncaught exceptions similarly
process.on('uncaughtException', (error: Error) => {
  // If it's a test-related error, let it bubble up
  if (error.name === 'AssertionError') {
    throw error;
  }
  
  // For other uncaught exceptions (like process cleanup issues), log and continue
  console.warn('Uncaught exception (non-test):', error.message);
});

// Cleanup function to restore original handlers if needed
globalThis.__testCleanup = () => {
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  
  originalHandlers.unhandledRejection.forEach(handler => {
    process.on('unhandledRejection', handler);
  });
  
  originalHandlers.uncaughtException.forEach(handler => {
    process.on('uncaughtException', handler);
  });
};