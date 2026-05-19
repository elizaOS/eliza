/**
 * Japanese (ja) email message catalog. です・ます polite-casual.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Eliza Cloud へようこそ — さっそく始めましょう！",
  },
  invite: {
    subject: "🎉 Eliza Cloud の {{organizationName}} に招待されました",
  },
  lowCredits: {
    subject: "⚠️ クレジット残高が少なめです — 対応をお願いします",
  },
  autoTopUpSuccess: {
    subject: "✓ 自動チャージ完了 — 残高が補充されました",
    heading: "✓ 自動チャージ完了",
    greeting: "{{organizationName}} チームのみなさん、",
    body: "アカウントに <strong>${{amount}}</strong> が自動でチャージされました。",
    bodyText: "アカウントに ${{amount}} が自動でチャージされました。",
    detailsTitle: "取引の詳細",
    detailsTitleText: "取引の詳細",
    previousBalanceLabel: "前回の残高：",
    amountAddedLabel: "チャージ金額：",
    newBalanceLabel: "新しい残高：",
    paymentMethodLabel: "支払い方法：",
    note: "自動チャージのおかげでサービスは止まらずに使えます。設定はダッシュボードから変更できます。",
  },
  autoTopUpDisabled: {
    subject: "⚠ 自動チャージがオフになりました — 対応をお願いします",
    heading: "⚠ 自動チャージがオフ",
    greeting: "{{organizationName}} チームのみなさん、",
    body: "自動チャージが自動的にオフになりました。",
    reasonLabel: "理由：",
    currentBalanceLabel: "現在の残高：",
    detailsTitleText: "詳細",
    whatToDo: "次にやることは？",
    step1: "サインインして支払い方法の設定を確認してください",
    step2: "必要なら支払い情報を更新してください",
    step3: "請求設定から自動チャージを再度オンにしてください",
    note: "サービスが止まらないよう、できるだけ早めにご対応ください。現在の残高は上の通りです。",
  },
  purchaseConfirmation: {
    subject: "✓ お支払い完了 — クレジットがアカウントに追加されました",
  },
  containerShutdownWarning: {
    subject: '🚨 緊急：コンテナ "{{containerName}}" は 48 時間以内に停止されます',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. All rights reserved.",
  },
};
