/**
 * Spanish (es) email message catalog. Latin-American neutral, tú-form.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Te damos la bienvenida a Eliza Cloud — ¡empecemos!",
  },
  invite: {
    subject: "🎉 Te invitaron a unirte a {{organizationName}} en Eliza Cloud",
  },
  lowCredits: {
    subject: "⚠️ Créditos bajos — se requiere acción",
  },
  autoTopUpSuccess: {
    subject: "✓ Recarga automática exitosa — saldo actualizado",
    heading: "✓ Recarga automática exitosa",
    greeting: "Hola equipo de {{organizationName}},",
    body: "Tu cuenta se recargó automáticamente con <strong>${{amount}}</strong>.",
    bodyText: "Tu cuenta se recargó automáticamente con ${{amount}}.",
    detailsTitle: "Detalles de la transacción",
    detailsTitleText: "DETALLES DE LA TRANSACCIÓN",
    previousBalanceLabel: "Saldo anterior:",
    amountAddedLabel: "Monto añadido:",
    newBalanceLabel: "Saldo nuevo:",
    paymentMethodLabel: "Método de pago:",
    note: "Esta recarga automática mantiene tus servicios funcionando sin interrupciones. Puedes ajustar la recarga automática desde tu panel.",
  },
  autoTopUpDisabled: {
    subject: "⚠ Recarga automática desactivada — se requiere acción",
    heading: "⚠ Recarga automática desactivada",
    greeting: "Hola equipo de {{organizationName}},",
    body: "Tu recarga automática se desactivó automáticamente.",
    reasonLabel: "Motivo:",
    currentBalanceLabel: "Saldo actual:",
    detailsTitleText: "DETALLES",
    whatToDo: "¿Qué hacer?",
    step1: "Inicia sesión y revisa tu método de pago",
    step2: "Actualiza la información de pago si hace falta",
    step3: "Reactiva la recarga automática en tu configuración de facturación",
    note: "Para evitar interrupciones, te recomendamos resolverlo lo antes posible. Tu saldo actual aparece arriba.",
  },
  purchaseConfirmation: {
    subject: "✓ Compra confirmada — créditos añadidos a tu cuenta",
  },
  containerShutdownWarning: {
    subject: '🚨 URGENTE: el contenedor "{{containerName}}" se apagará en 48 horas',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. Todos los derechos reservados.",
  },
};
