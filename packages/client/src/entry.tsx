/**
 * Entry point that ensures polyfills are loaded before anything else
 */

// Critical: Load polyfills synchronously before any other imports
import './polyfills';

// Now that polyfills are loaded, import and start the main app
import('./main');

export {};
