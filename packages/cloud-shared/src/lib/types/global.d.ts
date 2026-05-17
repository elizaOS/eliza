/**
 * Global Type Declarations
 *
 * Extends built-in types and declares missing module types.
 */

// =============================================================================
// Browser API Extensions
// =============================================================================

/**
 * Safari's prefixed AudioContext
 * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioContext
 */
interface Window {
  webkitAudioContext: typeof AudioContext;
}
