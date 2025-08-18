// Test file to verify logger works in both Node.js and browser environments
// This can be run with Node.js or loaded in a browser

const testLogger = async () => {
  // Get the logger - works in both environments
  const { logger } = await import('./dist/index.js');
  
  console.log('=== Testing Logger Compatibility ===');
  console.log('Environment:', typeof window !== 'undefined' ? 'Browser' : 'Node.js');
  console.log('');
  
  // Test basic logging
  console.log('Testing basic log methods:');
  logger.trace('This is a trace message');
  logger.debug('This is a debug message');
  logger.info('This is an info message');
  logger.warn('This is a warning message');
  logger.error('This is an error message');
  
  // Test with objects
  console.log('\nTesting with objects:');
  logger.info({ user: 'john', action: 'login' }, 'User logged in');
  
  // Test with errors
  console.log('\nTesting with errors:');
  const testError = new Error('Test error message');
  logger.error(testError, 'An error occurred');
  
  // Test clear method
  console.log('\nTesting clear method:');
  if (typeof logger.clear === 'function') {
    logger.clear();
    console.log('✓ Clear method exists and was called');
  } else {
    console.log('✗ Clear method not available');
  }
  
  console.log('\n=== Test Complete ===');
};

// Run the test
testLogger().catch(console.error);
