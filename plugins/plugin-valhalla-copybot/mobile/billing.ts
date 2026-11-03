/** Store product. Play Billing on Android, Apple IAP on iOS. Not Lemon Squeezy. */
export const PRO_PRODUCT_ID = "valhalla_pro_monthly";

export function proPurchaseMessage(): string {
  return `Pro uses ${PRO_PRODUCT_ID} through Google Play Billing or Apple In-App Purchase. This unsigned build cannot charge you. The website keeps Lemon Squeezy.`;
}
