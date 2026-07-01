/**
 * Korean (ko) email message catalog. 해요체 polite-casual.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Eliza Cloud에 오신 걸 환영해요 — 같이 시작해봐요!",
  },
  invite: {
    subject: "🎉 {{organizationName}}에서 Eliza Cloud 초대장이 도착했어요",
  },
  lowCredits: {
    subject: "⚠️ 크레딧이 얼마 안 남았어요 — 확인이 필요해요",
  },
  autoTopUpSuccess: {
    subject: "✓ 자동 충전 완료 — 잔액이 채워졌어요",
    heading: "✓ 자동 충전 완료",
    greeting: "{{organizationName}} 팀 안녕하세요,",
    body: "계정에 <strong>${{amount}}</strong>이(가) 자동으로 충전됐어요.",
    bodyText: "계정에 ${{amount}}이(가) 자동으로 충전됐어요.",
    detailsTitle: "거래 내역",
    detailsTitleText: "거래 내역",
    previousBalanceLabel: "이전 잔액:",
    amountAddedLabel: "충전 금액:",
    newBalanceLabel: "현재 잔액:",
    paymentMethodLabel: "결제 수단:",
    note: "자동 충전 덕분에 서비스가 끊김 없이 이어져요. 자동 충전 설정은 대시보드에서 바꿀 수 있어요.",
  },
  autoTopUpDisabled: {
    subject: "⚠ 자동 충전이 해제됐어요 — 확인이 필요해요",
    heading: "⚠ 자동 충전 해제",
    greeting: "{{organizationName}} 팀 안녕하세요,",
    body: "자동 충전이 자동으로 해제됐어요.",
    reasonLabel: "사유:",
    currentBalanceLabel: "현재 잔액:",
    detailsTitleText: "세부 정보",
    whatToDo: "어떻게 해야 할까요?",
    step1: "로그인해서 결제 수단을 확인해주세요",
    step2: "필요하면 결제 정보를 업데이트해주세요",
    step3: "결제 설정에서 자동 충전을 다시 켜주세요",
    note: "서비스가 끊기지 않도록 최대한 빨리 처리해주세요. 현재 잔액은 위에 적혀 있어요.",
  },
  purchaseConfirmation: {
    subject: "✓ 결제 완료 — 크레딧이 계정에 추가됐어요",
  },
  containerShutdownWarning: {
    subject: '🚨 긴급: 컨테이너 "{{containerName}}"이(가) 48시간 안에 꺼져요',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. All rights reserved.",
  },
};
