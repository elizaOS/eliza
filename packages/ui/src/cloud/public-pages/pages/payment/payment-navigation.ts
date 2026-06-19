/** Redirect the browser to an external payment provider's checkout URL. */
export function navigateToExternalPayment(url: string): void {
  window.location.assign(url);
}
