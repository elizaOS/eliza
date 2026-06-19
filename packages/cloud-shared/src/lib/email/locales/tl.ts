/**
 * Tagalog (tl) email message catalog. Taglish-aware, friendly.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Welcome sa Eliza Cloud — simulan na natin!",
  },
  invite: {
    subject: "🎉 Inimbitahan ka sa {{organizationName}} sa Eliza Cloud",
  },
  lowCredits: {
    subject: "⚠️ Mababa na ang credits mo — kailangan ng aksyon",
  },
  autoTopUpSuccess: {
    subject: "✓ Tagumpay ang auto top-up — na-recharge na ang balance",
    heading: "✓ Tagumpay ang auto top-up",
    greeting: "Hi {{organizationName}} team,",
    body: "Awtomatikong na-top up ang account mo ng <strong>${{amount}}</strong>.",
    bodyText: "Awtomatikong na-top up ang account mo ng ${{amount}}.",
    detailsTitle: "Detalye ng transaksyon",
    detailsTitleText: "DETALYE NG TRANSAKSYON",
    previousBalanceLabel: "Dating balance:",
    amountAddedLabel: "Halagang idinagdag:",
    newBalanceLabel: "Bagong balance:",
    paymentMethodLabel: "Paraan ng bayad:",
    note: "Tuloy-tuloy ang serbisyo mo dahil sa auto top-up na 'to. Pwede mong baguhin ang setting sa dashboard.",
  },
  autoTopUpDisabled: {
    subject: "⚠ Naka-off ang auto top-up — kailangan ng aksyon",
    heading: "⚠ Naka-off ang auto top-up",
    greeting: "Hi {{organizationName}} team,",
    body: "Awtomatikong na-off ang auto top-up mo.",
    reasonLabel: "Dahilan:",
    currentBalanceLabel: "Kasalukuyang balance:",
    detailsTitleText: "DETALYE",
    whatToDo: "Ano ang gagawin?",
    step1: "Mag-log in at tingnan ang payment method settings mo",
    step2: "I-update ang payment info kung kinakailangan",
    step3: "I-enable ulit ang auto top-up sa billing settings",
    note: "Para hindi mahinto ang serbisyo, ayusin mo ito agad. Nasa itaas ang kasalukuyang balance mo.",
  },
  purchaseConfirmation: {
    subject: "✓ Kumpirmado ang purchase — naidagdag na ang credits sa account mo",
  },
  containerShutdownWarning: {
    subject: '🚨 URGENT: ang container na "{{containerName}}" ay ipa-shut down sa loob ng 48 oras',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. Lahat ng karapatan ay nakalaan.",
  },
};
