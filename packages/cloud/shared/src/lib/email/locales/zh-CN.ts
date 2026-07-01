/**
 * Simplified Chinese (zh-CN) email message catalog. 你-form, casual.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 欢迎加入 Eliza Cloud — 一起开始吧！",
  },
  invite: {
    subject: "🎉 你被邀请加入 Eliza Cloud 上的 {{organizationName}}",
  },
  lowCredits: {
    subject: "⚠️ 余额不足提醒 — 请尽快处理",
  },
  autoTopUpSuccess: {
    subject: "✓ 自动充值成功 — 余额已到账",
    heading: "✓ 自动充值成功",
    greeting: "{{organizationName}} 团队你好，",
    body: "你的账户已自动充值 <strong>${{amount}}</strong>。",
    bodyText: "你的账户已自动充值 ${{amount}}。",
    detailsTitle: "交易详情",
    detailsTitleText: "交易详情",
    previousBalanceLabel: "之前余额：",
    amountAddedLabel: "充值金额：",
    newBalanceLabel: "当前余额：",
    paymentMethodLabel: "支付方式：",
    note: "自动充值让你的服务不会中断。你可以在控制台调整自动充值设置。",
  },
  autoTopUpDisabled: {
    subject: "⚠ 自动充值已关闭 — 请尽快处理",
    heading: "⚠ 自动充值已关闭",
    greeting: "{{organizationName}} 团队你好，",
    body: "你的自动充值已自动关闭。",
    reasonLabel: "原因：",
    currentBalanceLabel: "当前余额：",
    detailsTitleText: "详情",
    whatToDo: "你需要做什么？",
    step1: "登录控制台，检查支付方式设置",
    step2: "如有需要，更新支付信息",
    step3: "在账单设置中重新开启自动充值",
    note: "为避免服务中断，请尽快处理。你的当前余额显示在上方。",
  },
  purchaseConfirmation: {
    subject: "✓ 购买成功 — 余额已添加到你的账户",
  },
  containerShutdownWarning: {
    subject: '🚨 紧急：容器 "{{containerName}}" 将在 48 小时内关闭',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. 保留所有权利。",
  },
};
