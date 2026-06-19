/**
 * Portuguese (pt-BR) email message catalog. Você-form.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Boas-vindas ao Eliza Cloud — bora começar!",
  },
  invite: {
    subject: "🎉 Você foi convidado para {{organizationName}} no Eliza Cloud",
  },
  lowCredits: {
    subject: "⚠️ Créditos baixos — ação necessária",
  },
  autoTopUpSuccess: {
    subject: "✓ Recarga automática concluída — saldo atualizado",
    heading: "✓ Recarga automática concluída",
    greeting: "Oi, time {{organizationName}},",
    body: "Sua conta foi recarregada automaticamente com <strong>${{amount}}</strong>.",
    bodyText: "Sua conta foi recarregada automaticamente com ${{amount}}.",
    detailsTitle: "Detalhes da transação",
    detailsTitleText: "DETALHES DA TRANSAÇÃO",
    previousBalanceLabel: "Saldo anterior:",
    amountAddedLabel: "Valor adicionado:",
    newBalanceLabel: "Novo saldo:",
    paymentMethodLabel: "Forma de pagamento:",
    note: "A recarga automática mantém seus serviços rodando sem interrupção. Você pode ajustar as configurações no painel.",
  },
  autoTopUpDisabled: {
    subject: "⚠ Recarga automática desativada — ação necessária",
    heading: "⚠ Recarga automática desativada",
    greeting: "Oi, time {{organizationName}},",
    body: "Sua recarga automática foi desativada automaticamente.",
    reasonLabel: "Motivo:",
    currentBalanceLabel: "Saldo atual:",
    detailsTitleText: "DETALHES",
    whatToDo: "O que fazer agora?",
    step1: "Entre na conta e revise sua forma de pagamento",
    step2: "Atualize os dados de pagamento se precisar",
    step3: "Reative a recarga automática nas configurações de cobrança",
    note: "Para evitar interrupções, resolva isso o quanto antes. Seu saldo atual está acima.",
  },
  purchaseConfirmation: {
    subject: "✓ Compra confirmada — créditos adicionados à sua conta",
  },
  containerShutdownWarning: {
    subject: '🚨 URGENTE: o container "{{containerName}}" será desligado em 48 horas',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. Todos os direitos reservados.",
  },
};
