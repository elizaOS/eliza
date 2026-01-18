/**
 * Example: Product Order Form
 *
 * A more complex form demonstrating:
 * - Multiple field types
 * - Select options
 * - Conditional fields (dependsOn - for future)
 * - Database binding (dbbind)
 * - Section grouping
 * - Custom TTL and nudge settings
 *
 * Usage:
 * 1. Import and register this form in your plugin
 * 2. Call formService.startSession('product-order', entityId, roomId)
 * 3. The agent guides user through the order
 */

import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { Form, C, FormService, type FormSubmission } from '../src/index';

// ============================================================================
// FORM DEFINITION
// ============================================================================

/**
 * Product order form.
 *
 * Demonstrates more advanced form features.
 */
export const productOrderForm = Form.create('product-order')
  .name('Product Order')
  .description('Order a product for delivery')

  // ═══ PRODUCT SECTION ═══

  .control(
    C.select('product', [
      { value: 'basic', label: 'Basic Plan - $9.99/mo' },
      { value: 'pro', label: 'Pro Plan - $19.99/mo' },
      { value: 'enterprise', label: 'Enterprise - $49.99/mo' },
    ])
      .required()
      .label('Product')
      .ask('Which plan would you like?')
      .section('Product Selection')
      .order(1)
      .dbbind('product_id')
  )

  .control(
    C.number('quantity')
      .required()
      .min(1)
      .max(100)
      .default(1)
      .ask('How many licenses do you need?')
      .section('Product Selection')
      .order(2)
      .dbbind('qty')
  )

  // ═══ CUSTOMER INFO SECTION ═══

  .control(
    C.text('companyName')
      .required()
      .label('Company Name')
      .ask('What company is this order for?')
      .hint('organization', 'business', 'firm')
      .section('Customer Information')
      .order(1)
      .dbbind('company_name')
  )

  .control(
    C.email('billingEmail')
      .required()
      .label('Billing Email')
      .ask('What email should we send the invoice to?')
      .section('Customer Information')
      .order(2)
      .dbbind('billing_email')
  )

  .control(
    C.text('contactName')
      .label('Contact Name')
      .ask("Who's the primary contact for this order?")
      .section('Customer Information')
      .order(3)
      .dbbind('contact_name')
  )

  // ═══ BILLING ADDRESS SECTION ═══

  .control(
    C.text('addressLine1')
      .required()
      .label('Address')
      .ask("What's your billing address?")
      .hint('street', 'address line 1')
      .section('Billing Address')
      .order(1)
      .dbbind('address_1')
  )

  .control(
    C.text('addressLine2')
      .label('Address Line 2')
      .ask('Any apartment, suite, or unit number?')
      .section('Billing Address')
      .order(2)
      .dbbind('address_2')
  )

  .control(
    C.text('city')
      .required()
      .ask('What city?')
      .section('Billing Address')
      .order(3)
      .dbbind('city')
  )

  .control(
    C.text('state')
      .label('State/Province')
      .ask('What state or province?')
      .section('Billing Address')
      .order(4)
      .dbbind('state')
  )

  .control(
    C.text('postalCode')
      .required()
      .label('Postal Code')
      .ask('And the postal/zip code?')
      .section('Billing Address')
      .order(5)
      .dbbind('postal_code')
  )

  .control(
    C.select('country', [
      { value: 'us', label: 'United States' },
      { value: 'ca', label: 'Canada' },
      { value: 'uk', label: 'United Kingdom' },
      { value: 'de', label: 'Germany' },
      { value: 'fr', label: 'France' },
      { value: 'other', label: 'Other' },
    ])
      .required()
      .default('us')
      .ask('What country?')
      .section('Billing Address')
      .order(6)
      .dbbind('country_code')
  )

  // ═══ PAYMENT SECTION ═══

  .control(
    C.select('paymentMethod', [
      { value: 'card', label: 'Credit Card' },
      { value: 'invoice', label: 'Invoice (Net 30)' },
      { value: 'wire', label: 'Wire Transfer' },
    ])
      .required()
      .label('Payment Method')
      .ask('How would you like to pay?')
      .section('Payment')
      .order(1)
      .dbbind('payment_method')
  )

  // ═══ NOTES ═══

  .control(
    C.text('notes')
      .label('Special Instructions')
      .ask('Any special instructions or notes for this order?')
      .maxLength(500)
      .section('Additional')
      .order(1)
      .widget('textarea')
      .dbbind('order_notes')
  )

  // ═══ FORM SETTINGS ═══

  // Orders are important - longer retention
  .ttl({
    minDays: 30,
    maxDays: 90,
    effortMultiplier: 1, // 1 day per minute spent
  })

  // Nudge after 24 hours
  .nudgeAfter(24)
  .nudgeMessage("You have an incomplete order. Would you like to finish it?")

  // Hooks
  .onReady('order_ready_for_review')
  .onSubmit('process_order')
  .onCancel('order_cancelled')

  // Don't allow multiple concurrent orders
  // (One order per user at a time)

  .build();

// ============================================================================
// PRICING LOGIC
// ============================================================================

const PRICES: Record<string, number> = {
  basic: 9.99,
  pro: 19.99,
  enterprise: 49.99,
};

function calculateTotal(product: string, quantity: number): number {
  return (PRICES[product] || 0) * quantity;
}

// ============================================================================
// HOOK HANDLERS
// ============================================================================

/**
 * Called when all required fields are filled.
 * Good place to show order summary.
 */
export const orderReadyWorker = {
  name: 'order_ready_for_review',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { session } = options;
    
    // Get current values
    const product = session.fields?.product?.value;
    const quantity = session.fields?.quantity?.value || 1;
    const total = calculateTotal(product, quantity);
    
    runtime.logger.info('[Order] Ready for review:', {
      product,
      quantity,
      total: `$${total.toFixed(2)}`,
    });
  },
};

/**
 * Called when order is submitted.
 */
export const processOrderWorker = {
  name: 'process_order',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { submission } = options as { submission: FormSubmission };
    const values = submission.values;
    const mappedValues = submission.mappedValues || {};
    
    const total = calculateTotal(
      values.product as string,
      (values.quantity as number) || 1
    );

    runtime.logger.info('[Order] Processing order:', {
      orderId: submission.id,
      customer: values.companyName,
      product: values.product,
      quantity: values.quantity,
      total: `$${total.toFixed(2)}`,
      paymentMethod: values.paymentMethod,
    });

    // In a real implementation:
    // 1. Validate inventory
    // 2. Create order in database
    // 3. Process payment or create invoice
    // 4. Send confirmation email
    // 5. Notify fulfillment team

    // Example: Log the database-ready values
    runtime.logger.info('[Order] Database values:', mappedValues);
  },
};

/**
 * Called when order is cancelled.
 */
export const orderCancelledWorker = {
  name: 'order_cancelled',
  validate: async () => true,
  execute: async (runtime: IAgentRuntime, options: any) => {
    const { session } = options;
    runtime.logger.info('[Order] Order cancelled:', {
      sessionId: session.id,
      entityId: session.entityId,
    });
    // Could log analytics, trigger follow-up, etc.
  },
};

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

export const orderPlugin: Plugin = {
  name: 'example-order',
  description: 'Example order form using plugin-form',
  dependencies: ['form'],

  init: async (runtime: IAgentRuntime) => {
    const formService = runtime.getService('FORM') as FormService;
    if (!formService) {
      runtime.logger.error('[OrderPlugin] Form service not found');
      return;
    }

    // Register form
    formService.registerForm(productOrderForm);

    // Register workers
    runtime.registerTaskWorker(orderReadyWorker);
    runtime.registerTaskWorker(processOrderWorker);
    runtime.registerTaskWorker(orderCancelledWorker);

    runtime.logger.info('[OrderPlugin] Initialized');
  },

  actions: [
    {
      name: 'START_ORDER',
      similes: ['ORDER', 'BUY', 'PURCHASE'],
      description: 'Start a product order',

      validate: async (runtime, message) => {
        const text = message.content?.text?.toLowerCase() || '';
        return (
          text.includes('order') ||
          text.includes('buy') ||
          text.includes('purchase') ||
          text.includes('subscribe')
        );
      },

      handler: async (runtime, message, state, options, callback) => {
        const formService = runtime.getService('FORM') as FormService;
        if (!formService) {
          await callback?.({ text: "Sorry, I can't process orders right now." });
          return { success: false };
        }

        const entityId = message.entityId;
        const roomId = message.roomId;

        if (!entityId || !roomId) {
          await callback?.({ text: "Sorry, I couldn't identify you." });
          return { success: false };
        }

        try {
          await formService.startSession('product-order', entityId as any, roomId as any);

          await callback?.({
            text: "I'd be happy to help you place an order!\n\nWe have three plans available:\n• Basic - $9.99/mo\n• Pro - $19.99/mo\n• Enterprise - $49.99/mo\n\nWhich plan would you like?",
          });

          return { success: true };
        } catch (error) {
          runtime.logger.error('[OrderPlugin] Error starting order:', error);
          await callback?.({ text: 'Sorry, something went wrong. Please try again.' });
          return { success: false };
        }
      },

      examples: [
        [
          { name: '{{user1}}', content: { text: "I'd like to place an order" } },
          { name: '{{agentName}}', content: { text: "I'd be happy to help you place an order! Which plan would you like?" } },
        ],
      ],
    },
  ],
};

export default orderPlugin;

