/**
 * elizaOS Plugin OpenRouter - Multi-model AI gateway integration
 *
 * This package provides OpenRouter integration for elizaOS,
 * supporting text generation, object generation, image handling,
 * and embeddings through multiple AI providers.
 *
 * @example
 * ```typescript
 * import { openrouterPlugin } from '@elizaos/plugin-openrouter';
 *
 * // Add to your agent's plugins
 * const agent = createAgent({
 *   plugins: [openrouterPlugin],
 * });
 * ```
 */

export { openrouterPlugin, openrouterPlugin as default } from './plugin';
export * from './types';
export * from './utils/config';


