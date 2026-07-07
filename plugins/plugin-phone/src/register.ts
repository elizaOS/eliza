/**
 * Side-effect entry point for bundled phone surfaces.
 *
 * The Phone Companion is an app-shell page and must register on every host
 * where the app shell can route to `/phone-companion`. The dialer + recent-calls
 * surface ships as the unified `phone` plugin view (PhoneView), so there is no
 * separate overlay-app registration here.
 */

import "./register-companion-page";
