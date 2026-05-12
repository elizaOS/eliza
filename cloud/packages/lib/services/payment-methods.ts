import type Stripe from "stripe";
import { type Organization, organizationsRepository } from "@/db/repositories";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";

/**
 * Service for managing Stripe payment methods
 * Handles attaching, detaching, and managing payment methods for organizations
 */
export class PaymentMethodsService {
  /**
   * Get or create Stripe customer for an organization
   * Used internally to ensure organization has a Stripe customer before operations
   *
   * @param org - The organization object
   * @returns Stripe customer ID
   * @throws Error if customer creation fails
   */
  private async ensureStripeCustomer(org: Organization): Promise<string> {
    if (org.stripe_customer_id) {
      return org.stripe_customer_id;
    }

    logger.info(`[PaymentMethodsService] Creating Stripe customer for org ${org.id} (${org.name})`);

    try {
      const customer = await requireStripe().customers.create({
        name: org.name,
        email: org.billing_email || undefined,
        metadata: {
          organization_id: org.id,
        },
      });

      await organizationsRepository.update(org.id, {
        stripe_customer_id: customer.id,
        updated_at: new Date(),
      });

      logger.info(
        `[PaymentMethodsService] ✓ Created Stripe customer ${customer.id} for org ${org.id}`,
      );

      return customer.id;
    } catch (error) {
      logger.error(
        `[PaymentMethodsService] Failed to create Stripe customer for org ${org.id}:`,
        error,
      );
      throw new Error("Failed to create payment customer. Please try again.");
    }
  }

  /**
   * Attach a payment method to an organization's Stripe customer
   * If no default payment method exists, this will be set as default
   * Automatically creates Stripe customer if one doesn't exist
   *
   * @param organizationId - The organization ID
   * @param paymentMethodId - The Stripe payment method ID to attach
   * @returns void
   */
  async attachPaymentMethod(organizationId: string, paymentMethodId: string): Promise<void> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org) {
      throw new Error("Organization not found");
    }

    // Ensure organization has a Stripe customer (create if needed)
    const customerId = await this.ensureStripeCustomer(org);

    // Attach payment method to customer
    try {
      await requireStripe().paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to attach payment method: ${error.message}`);
      }
      throw error;
    }

    // If no default payment method exists, set this as default
    if (!org.stripe_default_payment_method) {
      await this.setDefaultPaymentMethod(organizationId, paymentMethodId);
    } else {
      // Just store the payment method ID
      await organizationsRepository.update(organizationId, {
        stripe_payment_method_id: paymentMethodId,
        updated_at: new Date(),
      });
    }
  }

  /**
   * Set a payment method as the default for an organization
   * Updates both Stripe customer and local database
   *
   * @param organizationId - The organization ID
   * @param paymentMethodId - The Stripe payment method ID to set as default
   * @throws Error if organization doesn't have a Stripe customer
   * @returns void
   */
  async setDefaultPaymentMethod(organizationId: string, paymentMethodId: string): Promise<void> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org) {
      throw new Error("Organization not found");
    }

    if (!org.stripe_customer_id) {
      throw new Error("Organization does not have a Stripe customer. Please contact support.");
    }

    // Verify the payment method belongs to this customer
    try {
      const paymentMethod = await requireStripe().paymentMethods.retrieve(paymentMethodId);
      if (paymentMethod.customer !== org.stripe_customer_id) {
        throw new Error("Payment method does not belong to this customer");
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to verify payment method: ${error.message}`);
      }
      throw error;
    }

    // Update customer's default payment method in Stripe
    try {
      await requireStripe().customers.update(org.stripe_customer_id, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to update default payment method in Stripe: ${error.message}`);
      }
      throw error;
    }

    // Update in our database
    await organizationsRepository.update(organizationId, {
      stripe_default_payment_method: paymentMethodId,
      stripe_payment_method_id: paymentMethodId,
      updated_at: new Date(),
    });
  }

  /**
   * Remove (detach) a payment method from an organization
   * Clears the payment method from database if it was stored
   *
   * @param organizationId - The organization ID
   * @param paymentMethodId - The Stripe payment method ID to remove
   * @throws Error if this is the last payment method and auto-top-up is enabled
   * @returns void
   */
  async removePaymentMethod(organizationId: string, paymentMethodId: string): Promise<void> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org) {
      throw new Error("Organization not found");
    }

    // SECURITY: If auto-top-up is enabled, prevent removing the last payment method
    // This prevents auto-top-up from failing when balance falls below threshold
    if (org.auto_top_up_enabled) {
      // Get all payment methods for this organization
      const paymentMethods = await this.listPaymentMethods(organizationId);

      // Check if this is the only payment method
      if (paymentMethods.length <= 1) {
        throw new Error(
          "Cannot remove the last payment method while auto-top-up is enabled. Please disable auto-top-up first or add another payment method before removing this one.",
        );
      }

      // If removing the default payment method, ensure there's another one to take its place
      if (org.stripe_default_payment_method === paymentMethodId) {
        throw new Error(
          "Cannot remove the default payment method while auto-top-up is enabled. Please set another payment method as default first, or disable auto-top-up.",
        );
      }
    }

    // Detach from Stripe
    try {
      await requireStripe().paymentMethods.detach(paymentMethodId);
    } catch (error) {
      if (error instanceof Error) {
        // If payment method is already detached, that's fine
        if (
          !error.message.includes("already been detached") &&
          !error.message.includes("No such payment_method")
        ) {
          throw new Error(`Failed to detach payment method: ${error.message}`);
        }
      } else {
        throw error;
      }
    }

    // Clear from database if it was the stored one
    const updates: Partial<Organization> = { updated_at: new Date() };

    if (org.stripe_payment_method_id === paymentMethodId) {
      updates.stripe_payment_method_id = null;
    }

    if (org.stripe_default_payment_method === paymentMethodId) {
      updates.stripe_default_payment_method = null;
    }

    if (
      updates.stripe_payment_method_id !== undefined ||
      updates.stripe_default_payment_method !== undefined
    ) {
      await organizationsRepository.update(organizationId, updates);
    }
  }

  /**
   * List all payment methods for an organization
   * Returns an empty array if organization doesn't have a Stripe customer
   *
   * @param organizationId - The organization ID
   * @returns Array of Stripe payment methods
   */
  async listPaymentMethods(organizationId: string): Promise<Stripe.PaymentMethod[]> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org?.stripe_customer_id) {
      return [];
    }

    const paymentMethods = await requireStripe().paymentMethods.list({
      customer: org.stripe_customer_id,
      type: "card",
    });

    return paymentMethods.data;
  }

  /**
   * Get a specific payment method by ID
   * Verifies the payment method belongs to the organization
   *
   * @param organizationId - The organization ID
   * @param paymentMethodId - The Stripe payment method ID
   * @returns The payment method or null if not found/not authorized
   */
  async getPaymentMethod(
    organizationId: string,
    paymentMethodId: string,
  ): Promise<Stripe.PaymentMethod | null> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org?.stripe_customer_id) {
      return null;
    }

    const paymentMethod = await requireStripe().paymentMethods.retrieve(paymentMethodId);

    // Verify it belongs to this customer
    if (paymentMethod.customer !== org.stripe_customer_id) {
      return null;
    }

    return paymentMethod;
  }

  /**
   * Check if an organization has any payment methods
   *
   * @param organizationId - The organization ID
   * @returns True if organization has at least one payment method
   */
  async hasPaymentMethods(organizationId: string): Promise<boolean> {
    const paymentMethods = await this.listPaymentMethods(organizationId);
    return paymentMethods.length > 0;
  }

  /**
   * Get the default payment method for an organization
   *
   * @param organizationId - The organization ID
   * @returns The default payment method or null if none exists
   */
  async getDefaultPaymentMethod(organizationId: string): Promise<Stripe.PaymentMethod | null> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org?.stripe_default_payment_method) {
      return null;
    }

    return await this.getPaymentMethod(organizationId, org.stripe_default_payment_method);
  }
}

// Export singleton instance
export const paymentMethodsService = new PaymentMethodsService();
