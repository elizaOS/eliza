/**
 * Device matrix fixtures for UI-smoke specs that compare desktop and mobile
 * app layouts.
 */
export const ASSERTION_GRADE_DASHBOARD_SPECS =
  /(browser-workspace|character-editor|wallet-inventory|workflow-editor)\.spec\.ts/;

export const DASHBOARD_E2E_DEVICE_MATRIX = [
  {
    id: "mobile-portrait",
    label: "Mobile Portrait",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "mobile-landscape",
    label: "Mobile Landscape",
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "desktop-landscape",
    label: "Desktop Landscape",
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
  },
  {
    id: "ipad-portrait",
    label: "iPad Portrait",
    viewport: { width: 820, height: 1180 },
    isMobile: true,
    hasTouch: true,
  },
] as const;
