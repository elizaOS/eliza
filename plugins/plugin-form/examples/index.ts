/**
 * @module examples
 * @description Example plugins demonstrating plugin-form usage
 *
 * These examples show various use cases for the form plugin:
 *
 * ## Registration Form
 * Simple user registration with email, username, age.
 * Shows: Required fields, validation, hooks.
 *
 * ## Order Form
 * Complex product order with multiple sections.
 * Shows: Select options, sections, database binding, TTL/nudge settings.
 *
 * ## Custom Types
 * Web3 profile and contact forms with custom validators.
 * Shows: Registering custom type handlers, domain-specific validation.
 *
 * ## Feedback Form
 * Customer feedback with ratings and file uploads.
 * Shows: File uploads, multiple submissions, conditional logic (future).
 *
 * ## Usage
 *
 * These examples are for reference. To use them:
 *
 * ```typescript
 * // Copy the relevant form definition to your plugin
 * import { Form, C } from '@elizaos/plugin-form';
 *
 * const myForm = Form.create('my-form')
 *   // ... customize based on examples
 *   .build();
 * ```
 *
 * Or import directly for testing:
 *
 * ```typescript
 * import { registrationPlugin } from '@elizaos/plugin-form/examples';
 *
 * const agent = {
 *   plugins: [formPlugin, registrationPlugin],
 * };
 * ```
 */

// Registration form example
export {
  registrationForm,
  registrationStartedWorker,
  handleRegistrationWorker,
  registrationPlugin,
} from './registration-form';

// Order form example
export {
  productOrderForm,
  orderReadyWorker,
  processOrderWorker,
  orderCancelledWorker,
  orderPlugin,
} from './order-form';

// Custom types example
export {
  solanaAddressHandler,
  evmAddressHandler,
  usPhoneHandler,
  urlHandler,
  twitterHandleHandler,
  discordUsernameHandler,
  registerCustomTypes,
  web3ProfileForm,
  contactForm,
  customTypesPlugin,
} from './custom-types';

// Feedback form example
export {
  feedbackForm,
  processFeedbackWorker,
  feedbackPlugin,
} from './feedback-form';

// Convenient access to all example plugins
export const examplePlugins = {
  registration: async () => (await import('./registration-form')).registrationPlugin,
  order: async () => (await import('./order-form')).orderPlugin,
  customTypes: async () => (await import('./custom-types')).customTypesPlugin,
  feedback: async () => (await import('./feedback-form')).feedbackPlugin,
};

export default examplePlugins;

