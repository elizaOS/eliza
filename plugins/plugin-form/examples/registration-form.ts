/**
 * Example: User Registration Form
 *
 * A simple registration form demonstrating:
 * - Required and optional fields
 * - Field validation (email, min age)
 * - Custom ask prompts
 * - Submission handling via hooks
 *
 * Usage:
 * 1. Import and register this form in your plugin
 * 2. Call formService.startSession('registration', entityId, roomId)
 * 3. The agent will guide the user through registration
 */

import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { Form, C, FormService, type FormSubmission } from '../src/index';

// ============================================================================
// FORM DEFINITION
// ============================================================================

/**
 * Registration form definition.
 *
 * Uses the fluent builder API for type-safe form creation.
 */
export const registrationForm = Form.create('registration')
  .name('User Registration')
  .description('Create your account to get started')

  // Email - required, with custom prompt
  .control(
    C.email('email')
      .required()
      .ask("What's your email address? We'll use this to log you in.")
      .example('user@example.com')
      .confirmThreshold(0.95) // High confidence required
  )

  // Username - required, with validation
  .control(
    C.text('username')
      .required()
      .minLength(3)
      .maxLength(20)
      .pattern('^[a-z0-9_]+$')
      .ask('Choose a username (letters, numbers, underscore only)')
      .example('john_doe')
      .hint('handle', 'nickname', 'user name')
  )

  // Display name - optional
  .control(
    C.text('displayName')
      .label('Display Name')
      .ask("What name should we show publicly? (Optional, we'll use your username if you skip)")
      .example('John Doe')
  )

  // Age - required, with minimum
  .control(
    C.number('age')
      .required()
      .min(13)
      .ask('How old are you? (Must be 13 or older)')
  )

  // Newsletter opt-in - optional boolean
  .control(
    C.boolean('newsletter')
      .label('Newsletter')
      .default(false)
      .ask('Would you like to receive our newsletter?')
  )

  // Hooks
  .onStart('registration_started')
  .onSubmit('handle_registration')

  // Settings
  .allowMultiple() // Users can register multiple accounts (for demo)

  .build();

// ============================================================================
// HOOK HANDLERS
// ============================================================================

/**
 * Called when a registration session starts.
 */
export const registrationStartedWorker = {
  name: 'registration_started',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { session, form } = options;
    runtime.logger.info(`[Registration] New registration started for entity ${session.entityId}`);
  },
};

/**
 * Called when registration form is submitted.
 *
 * This is where you would:
 * - Create the user account
 * - Send welcome email
 * - Initialize user data
 */
export const handleRegistrationWorker = {
  name: 'handle_registration',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { submission } = options as { submission: FormSubmission };
    const { email, username, displayName, age, newsletter } = submission.values;

    runtime.logger.info('[Registration] New user registration:', {
      email,
      username,
      displayName: displayName || username,
      age,
      newsletter: newsletter ?? false,
    });

    // In a real implementation, you would:
    // 1. Create user in database
    // 2. Send verification email
    // 3. Initialize user profile
    // 4. etc.

    // Example: Store in memory (replace with actual database)
    const memory = await runtime.createMemory({
      entityId: submission.entityId,
      content: {
        text: `User registered: ${username} (${email})`,
        type: 'registration',
      },
      roomId: runtime.agentId, // Store in agent's room
      metadata: {
        email,
        username,
        displayName: displayName || username,
        age,
        newsletter: newsletter ?? false,
        registeredAt: submission.submittedAt,
      },
    });

    runtime.logger.info(`[Registration] User ${username} registered successfully`);
  },
};

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Example plugin that uses the registration form.
 *
 * This plugin:
 * 1. Depends on the form plugin
 * 2. Registers the registration form
 * 3. Provides an action to start registration
 */
export const registrationPlugin: Plugin = {
  name: 'example-registration',
  description: 'Example registration form using plugin-form',
  dependencies: ['form'],

  // Register form and workers on init
  init: async (runtime: IAgentRuntime) => {
    // Get form service
    const formService = runtime.getService('FORM') as FormService;
    if (!formService) {
      runtime.logger.error('[RegistrationPlugin] Form service not found');
      return;
    }

    // Register the form
    formService.registerForm(registrationForm);

    // Register task workers for hooks
    runtime.registerTaskWorker(registrationStartedWorker);
    runtime.registerTaskWorker(handleRegistrationWorker);

    runtime.logger.info('[RegistrationPlugin] Initialized');
  },

  // Action to start registration
  actions: [
    {
      name: 'START_REGISTRATION',
      similes: ['REGISTER', 'SIGN_UP', 'CREATE_ACCOUNT'],
      description: 'Start the user registration process',

      validate: async (runtime, message) => {
        const text = message.content?.text?.toLowerCase() || '';
        return (
          text.includes('register') ||
          text.includes('sign up') ||
          text.includes('create account') ||
          text.includes('new account')
        );
      },

      handler: async (runtime, message, state, options, callback) => {
        const formService = runtime.getService('FORM') as FormService;
        if (!formService) {
          await callback?.({ text: "Sorry, I can't process registrations right now." });
          return { success: false };
        }

        const entityId = message.entityId;
        const roomId = message.roomId;

        if (!entityId || !roomId) {
          await callback?.({ text: "Sorry, I couldn't identify you." });
          return { success: false };
        }

        try {
          // Check for existing session
          const existing = await formService.getActiveSession(entityId as any, roomId as any);
          if (existing) {
            const form = formService.getForm(existing.formId);
            await callback?.({
              text: `You already have a "${form?.name || 'form'}" in progress. Would you like to continue with that?`,
            });
            return { success: false };
          }

          // Start registration session
          await formService.startSession('registration', entityId as any, roomId as any);

          await callback?.({
            text: "Great! Let's get you registered. I'll ask you a few questions.\n\nFirst, what's your email address?",
          });

          return { success: true };
        } catch (error) {
          runtime.logger.error('[RegistrationPlugin] Error starting registration:', error);
          await callback?.({ text: 'Sorry, something went wrong. Please try again.' });
          return { success: false };
        }
      },

      examples: [
        [
          { name: '{{user1}}', content: { text: 'I want to register' } },
          { name: '{{agentName}}', content: { text: "Great! Let's get you registered. First, what's your email address?" } },
        ],
        [
          { name: '{{user1}}', content: { text: 'Sign me up!' } },
          { name: '{{agentName}}', content: { text: "Great! Let's get you registered. First, what's your email address?" } },
        ],
      ],
    },
  ],
};

export default registrationPlugin;

