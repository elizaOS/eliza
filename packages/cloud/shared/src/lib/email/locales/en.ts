/**
 * English (en) email message catalog. Source of truth for shape and copy.
 */

export interface EmailMessages {
  welcome: { subject: string };
  invite: { subject: string };
  lowCredits: { subject: string };
  autoTopUpSuccess: {
    subject: string;
    heading: string;
    greeting: string;
    body: string;
    bodyText: string;
    detailsTitle: string;
    detailsTitleText: string;
    previousBalanceLabel: string;
    amountAddedLabel: string;
    newBalanceLabel: string;
    paymentMethodLabel: string;
    note: string;
  };
  autoTopUpDisabled: {
    subject: string;
    heading: string;
    greeting: string;
    body: string;
    reasonLabel: string;
    currentBalanceLabel: string;
    detailsTitleText: string;
    whatToDo: string;
    step1: string;
    step2: string;
    step3: string;
    note: string;
  };
  purchaseConfirmation: { subject: string };
  containerShutdownWarning: { subject: string };
  footer: { copyright: string };
}

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Welcome to Eliza Cloud — let's get started!",
  },
  invite: {
    subject: "🎉 You've been invited to join {{organizationName}} on Eliza Cloud",
  },
  lowCredits: {
    subject: "⚠️ Low credits alert — action required",
  },
  autoTopUpSuccess: {
    subject: "✓ Auto top-up successful — balance recharged",
    heading: "✓ Auto top-up successful",
    greeting: "Hi {{organizationName}} team,",
    body: "Your account has been automatically topped up with <strong>${{amount}}</strong>.",
    bodyText: "Your account has been automatically topped up with ${{amount}}.",
    detailsTitle: "Transaction details",
    detailsTitleText: "TRANSACTION DETAILS",
    previousBalanceLabel: "Previous balance:",
    amountAddedLabel: "Amount added:",
    newBalanceLabel: "New balance:",
    paymentMethodLabel: "Payment method:",
    note: "This auto top-up keeps your services running without interruption. You can manage auto top-up settings in your dashboard.",
  },
  autoTopUpDisabled: {
    subject: "⚠ Auto top-up disabled — action required",
    heading: "⚠ Auto top-up disabled",
    greeting: "Hi {{organizationName}} team,",
    body: "Your auto top-up has been turned off automatically.",
    reasonLabel: "Reason:",
    currentBalanceLabel: "Current balance:",
    detailsTitleText: "DETAILS",
    whatToDo: "What should you do?",
    step1: "Sign in and review your payment method settings",
    step2: "Update your payment info if needed",
    step3: "Turn auto top-up back on in billing settings",
    note: "To avoid service interruptions, please sort this out as soon as possible. Your current balance is shown above.",
  },
  purchaseConfirmation: {
    subject: "✓ Purchase confirmed — credits added to your account",
  },
  containerShutdownWarning: {
    subject: '🚨 URGENT: container "{{containerName}}" will be shut down in 48 hours',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. All rights reserved.",
  },
};
