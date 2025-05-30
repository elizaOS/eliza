import { Content, ActionExample as ActionExampleFromTypes } from './types';
import { ActionExample as ActionExampleV2, Content as ContentV2 } from '../v2';

/**
 * Example content with associated user for demonstration purposes
 * This is exported from types.ts in v1, but we're recreating it here for the adapter
 */
export type ActionExample = ActionExampleFromTypes;

/**
 * Safely converts a V2 content object to a V1 Content type
 * Maps known properties and preserves additional ones
 *
 * @param content V2 content object
 * @returns Content compatible with V1
 */
export function convertContentToV1(content: ContentV2): Content {
  if (!content) {
    return { text: '' } as Content;
  }

  return {
    text: content.text || '',
    // V2 uses 'actions' array, V1 might use 'action' string
    action:
      Array.isArray(content.actions) && content.actions.length > 0 ? content.actions[0] : undefined,
    // Copy all other properties
    ...Object.entries(content)
      .filter(([key]) => !['text', 'actions', 'action'].includes(key))
      .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {}),
  } as Content;
}

/**
 * Safely converts a V1 Content object to a V2 compatible content type
 * Maps known properties and preserves additional ones
 *
 * @param content V1 Content object
 * @returns Content compatible with V2
 */
export function convertContentToV2(content: Content): ContentV2 {
  if (!content) {
    return { text: '' } as ContentV2;
  }

  return {
    text: content.text || '',
    // V1 uses 'action' string, V2 uses 'actions' array
    actions: content.action ? [content.action] : [],
    // Copy all other properties
    ...Object.entries(content)
      .filter(([key]) => !['text', 'action'].includes(key))
      .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {}),
  } as ContentV2;
}

/**
 * Converts v2 ActionExample to v1 compatible ActionExample
 *
 * @param exampleV2 The V2 action example to convert
 * @returns V1 compatible ActionExample
 */
export function fromV2ActionExample(exampleV2: ActionExampleV2): ActionExample {
  if (!exampleV2) {
    return { user: '', content: { text: '' } as Content };
  }

  // The main difference is that v2 uses 'name' instead of 'user'
  return {
    user: exampleV2.name || '',
    content: convertContentToV1(exampleV2.content),
  };
}

/**
 * Converts v1 ActionExample to v2 ActionExample
 *
 * @param example The V1 action example to convert
 * @returns V2 compatible ActionExample
 */
export function toV2ActionExample(example: ActionExample): ActionExampleV2 {
  if (!example) {
    return { name: '', content: { text: '' } as ContentV2 };
  }

  // Convert v1 format to v2 format
  return {
    name: example.user || '',
    content: convertContentToV2(example.content),
  };
}
