/**
 * Email type definitions for the email service.
 */

/**
 * Options for sending an email.
 */
export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
  }>;
}

/**
 * Data for welcome email template.
 */
export interface WelcomeEmailData {
  email: string;
  userName: string;
  organizationName: string;
  creditBalance: number;
  dashboardUrl: string;
}

/**
 * Data for low credits warning email template.
 */
export interface LowCreditsEmailData {
  email: string;
  organizationName: string;
  currentBalance: number;
  threshold: number;
  billingUrl: string;
}

/**
 * Data for organization invite email template.
 */
export interface InviteEmailData {
  email: string;
  inviterName: string;
  organizationName: string;
  role: string;
  inviteToken: string;
  expiresAt: string;
}

/**
 * Data for auto top-up success email template.
 */
export interface AutoTopUpSuccessEmailData {
  email: string;
  organizationName: string;
  amount: number;
  previousBalance: number;
  newBalance: number;
  paymentMethod: string;
  invoiceUrl: string;
  billingUrl: string;
}

/**
 * Data for auto top-up disabled email template.
 */
export interface AutoTopUpDisabledEmailData {
  email: string;
  organizationName: string;
  reason: string;
  currentBalance: number;
  settingsUrl: string;
}

/**
 * Data for purchase confirmation email template.
 */
export interface PurchaseConfirmationEmailData {
  email: string;
  organizationName: string;
  purchaseAmount: number;
  creditsAdded: number;
  previousBalance: number;
  newBalance: number;
  paymentMethod: string;
  transactionDate: string;
  invoiceNumber?: string;
  invoiceUrl?: string;
  dashboardUrl: string;
}

/**
 * Data for container shutdown warning email template.
 */
export interface ContainerShutdownWarningEmailData {
  email: string;
  organizationName: string;
  containerName: string;
  projectName: string;
  dailyCost: number;
  monthlyCost: number;
  currentBalance: number;
  requiredCredits: number;
  minimumRecommended: number;
  shutdownTime: string;
  billingUrl: string;
  dashboardUrl: string;
}
