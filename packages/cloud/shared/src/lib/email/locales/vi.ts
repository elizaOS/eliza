/**
 * Vietnamese (vi) email message catalog. Loanword-friendly, bạn-form.
 */

import type { EmailMessages } from "./en";

export const emailMessages: EmailMessages = {
  welcome: {
    subject: "🎉 Chào mừng bạn đến với Eliza Cloud — bắt đầu thôi nào!",
  },
  invite: {
    subject: "🎉 Bạn được mời vào {{organizationName}} trên Eliza Cloud",
  },
  lowCredits: {
    subject: "⚠️ Sắp hết credit — cần xử lý sớm",
  },
  autoTopUpSuccess: {
    subject: "✓ Auto top-up thành công — số dư đã được nạp lại",
    heading: "✓ Auto top-up thành công",
    greeting: "Chào team {{organizationName}},",
    body: "Tài khoản của bạn vừa được tự động nạp <strong>${{amount}}</strong>.",
    bodyText: "Tài khoản của bạn vừa được tự động nạp ${{amount}}.",
    detailsTitle: "Chi tiết giao dịch",
    detailsTitleText: "CHI TIẾT GIAO DỊCH",
    previousBalanceLabel: "Số dư trước:",
    amountAddedLabel: "Số tiền nạp thêm:",
    newBalanceLabel: "Số dư mới:",
    paymentMethodLabel: "Phương thức thanh toán:",
    note: "Auto top-up giúp dịch vụ của bạn chạy liên tục. Bạn có thể chỉnh cài đặt auto top-up trong dashboard.",
  },
  autoTopUpDisabled: {
    subject: "⚠ Auto top-up đã tắt — cần xử lý",
    heading: "⚠ Auto top-up đã tắt",
    greeting: "Chào team {{organizationName}},",
    body: "Auto top-up của bạn đã tự động bị tắt.",
    reasonLabel: "Lý do:",
    currentBalanceLabel: "Số dư hiện tại:",
    detailsTitleText: "CHI TIẾT",
    whatToDo: "Bạn nên làm gì?",
    step1: "Đăng nhập và kiểm tra cài đặt phương thức thanh toán",
    step2: "Cập nhật thông tin thanh toán nếu cần",
    step3: "Bật lại auto top-up trong cài đặt billing",
    note: "Để tránh gián đoạn dịch vụ, hãy xử lý sớm. Số dư hiện tại của bạn hiển thị bên trên.",
  },
  purchaseConfirmation: {
    subject: "✓ Đã xác nhận thanh toán — credit đã được thêm vào tài khoản",
  },
  containerShutdownWarning: {
    subject: '🚨 KHẨN: container "{{containerName}}" sẽ bị tắt trong 48 giờ',
  },
  footer: {
    copyright: "© {{year}} Eliza Cloud. Bảo lưu mọi quyền.",
  },
};
