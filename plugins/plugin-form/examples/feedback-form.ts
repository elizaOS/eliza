/**
 * Example: Feedback Form with File Upload
 *
 * Demonstrates:
 * - File upload fields
 * - Rating/satisfaction fields
 * - Textarea for long text
 * - Conditional fields (follow-up based on rating)
 * - Debug mode for development
 *
 * Usage:
 * 1. Import and register this form in your plugin
 * 2. Call formService.startSession('feedback', entityId, roomId)
 */

import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { Form, C, FormService, type FormSubmission } from '../src/index';

// ============================================================================
// FORM DEFINITION
// ============================================================================

/**
 * Customer feedback form.
 *
 * Collects satisfaction rating, comments, and optional screenshots.
 */
export const feedbackForm = Form.create('feedback')
  .name('Feedback')
  .description('Share your experience with us')

  // ═══ RATING ═══

  .control(
    C.select('satisfaction', [
      { value: '5', label: '😍 Excellent' },
      { value: '4', label: '😊 Good' },
      { value: '3', label: '😐 Okay' },
      { value: '2', label: '😕 Poor' },
      { value: '1', label: '😞 Terrible' },
    ])
      .required()
      .label('Satisfaction')
      .ask('How would you rate your overall experience?')
      .section('Rating')
      .order(1)
  )

  .control(
    C.select('recommend', [
      { value: 'yes', label: 'Yes, definitely!' },
      { value: 'maybe', label: 'Maybe' },
      { value: 'no', label: 'Probably not' },
    ])
      .required()
      .label('Would Recommend')
      .ask('Would you recommend us to a friend?')
      .section('Rating')
      .order(2)
  )

  // ═══ FEEDBACK DETAILS ═══

  .control(
    C.text('whatWentWell')
      .label('What Went Well')
      .ask('What did you like most about your experience?')
      .maxLength(1000)
      .widget('textarea')
      .section('Details')
      .order(1)
  )

  .control(
    C.text('whatCouldImprove')
      .label('Areas for Improvement')
      .ask('What could we do better?')
      .maxLength(1000)
      .widget('textarea')
      .section('Details')
      .order(2)
  )

  .control(
    C.text('specificIssue')
      .label('Specific Issue')
      .ask('Did you encounter any specific problems? Please describe.')
      .maxLength(1000)
      .widget('textarea')
      .section('Details')
      .order(3)
      // Future: Show only if satisfaction <= 3
      // .dependsOn('satisfaction', 'lte', '3')
  )

  // ═══ FILE ATTACHMENTS ═══

  .control(
    C.file('screenshots')
      .label('Screenshots')
      .ask('Would you like to attach any screenshots? (Optional)')
      .accept(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
      .maxSize(10 * 1024 * 1024) // 10MB per file
      .maxFiles(5)
      .multiple()
      .section('Attachments')
      .order(1)
  )

  // ═══ CONTACT ═══

  .control(
    C.boolean('contactMe')
      .label('Contact Me')
      .default(false)
      .ask('Would you like us to follow up with you about this feedback?')
      .section('Contact')
      .order(1)
  )

  .control(
    C.email('contactEmail')
      .label('Email for Follow-up')
      .ask("What's the best email to reach you?")
      .section('Contact')
      .order(2)
      // Future: Only show if contactMe is true
      // .dependsOn('contactMe', 'equals', true)
  )

  // ═══ SETTINGS ═══

  // Feedback forms are quick - shorter TTL
  .ttl({
    minDays: 7,
    maxDays: 30,
  })

  // Don't nudge for feedback - it's optional
  .noNudge()

  // Allow multiple submissions (feedback can be given multiple times)
  .allowMultiple()

  // Hooks
  .onSubmit('process_feedback')

  // Enable debug mode during development
  .debug()

  .build();

// ============================================================================
// HOOK HANDLERS
// ============================================================================

/**
 * Process submitted feedback.
 */
export const processFeedbackWorker = {
  name: 'process_feedback',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { submission } = options as { submission: FormSubmission };
    const values = submission.values;

    const satisfaction = parseInt(values.satisfaction as string, 10);
    const isNegative = satisfaction <= 2;
    const isPositive = satisfaction >= 4;

    runtime.logger.info('[Feedback] New feedback received:', {
      satisfaction,
      sentiment: isPositive ? 'positive' : isNegative ? 'negative' : 'neutral',
      wouldRecommend: values.recommend,
      hasIssue: !!values.specificIssue,
      wantsFollowUp: values.contactMe,
    });

    // Handle file attachments
    if (submission.files?.screenshots) {
      runtime.logger.info('[Feedback] Screenshots attached:', {
        count: submission.files.screenshots.length,
        files: submission.files.screenshots.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.mimeType,
        })),
      });
    }

    // In a real implementation:

    // 1. Store feedback in database
    // await database.feedback.create({
    //   entityId: submission.entityId,
    //   satisfaction,
    //   recommend: values.recommend,
    //   whatWentWell: values.whatWentWell,
    //   whatCouldImprove: values.whatCouldImprove,
    //   specificIssue: values.specificIssue,
    //   screenshots: submission.files?.screenshots,
    //   contactMe: values.contactMe,
    //   contactEmail: values.contactEmail,
    //   submittedAt: submission.submittedAt,
    // });

    // 2. If negative, alert support team
    if (isNegative) {
      runtime.logger.warn('[Feedback] ALERT: Negative feedback received', {
        satisfaction,
        issue: values.specificIssue,
        contactEmail: values.contactEmail,
      });
      // await notifySupport({ ... });
    }

    // 3. If wants follow-up, create support ticket
    if (values.contactMe && values.contactEmail) {
      runtime.logger.info('[Feedback] Creating follow-up ticket for:', values.contactEmail);
      // await createSupportTicket({ ... });
    }

    // 4. If positive with recommendation, maybe ask for review
    if (isPositive && values.recommend === 'yes') {
      runtime.logger.info('[Feedback] Potential reviewer identified');
      // await scheduleReviewRequest({ ... });
    }
  },
};

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

export const feedbackPlugin: Plugin = {
  name: 'example-feedback',
  description: 'Example feedback form with file uploads',
  dependencies: ['form'],

  init: async (runtime: IAgentRuntime) => {
    const formService = runtime.getService('FORM') as FormService;
    if (!formService) {
      runtime.logger.error('[FeedbackPlugin] Form service not found');
      return;
    }

    formService.registerForm(feedbackForm);
    runtime.registerTaskWorker(processFeedbackWorker);

    runtime.logger.info('[FeedbackPlugin] Initialized');
  },

  actions: [
    {
      name: 'START_FEEDBACK',
      similes: ['GIVE_FEEDBACK', 'LEAVE_REVIEW'],
      description: 'Start the feedback form',

      validate: async (runtime, message) => {
        const text = message.content?.text?.toLowerCase() || '';
        return (
          text.includes('feedback') ||
          text.includes('review') ||
          text.includes('rate') ||
          text.includes('opinion') ||
          text.includes('suggestion')
        );
      },

      handler: async (runtime, message, state, options, callback) => {
        const formService = runtime.getService('FORM') as FormService;
        if (!formService) {
          await callback?.({ text: "Sorry, I can't collect feedback right now." });
          return { success: false };
        }

        const entityId = message.entityId;
        const roomId = message.roomId;

        if (!entityId || !roomId) {
          await callback?.({ text: "Sorry, I couldn't identify you." });
          return { success: false };
        }

        try {
          await formService.startSession('feedback', entityId as any, roomId as any);

          await callback?.({
            text: "I'd love to hear your feedback! It only takes a minute.\n\nFirst, how would you rate your overall experience?\n\n😍 Excellent | 😊 Good | 😐 Okay | 😕 Poor | 😞 Terrible",
          });

          return { success: true };
        } catch (error) {
          runtime.logger.error('[FeedbackPlugin] Error starting feedback:', error);
          await callback?.({ text: 'Sorry, something went wrong. Please try again.' });
          return { success: false };
        }
      },

      examples: [
        [
          { name: '{{user1}}', content: { text: 'I want to give feedback' } },
          { name: '{{agentName}}', content: { text: "I'd love to hear your feedback! How would you rate your overall experience?" } },
        ],
        [
          { name: '{{user1}}', content: { text: 'Leave a review' } },
          { name: '{{agentName}}', content: { text: "I'd love to hear your feedback! How would you rate your overall experience?" } },
        ],
      ],
    },
  ],
};

export default feedbackPlugin;

