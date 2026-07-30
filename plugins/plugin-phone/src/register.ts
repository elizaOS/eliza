/**
 * Side-effect entry point for bundled phone surfaces.
 *
 * Both native Phone surfaces register in-process so mobile builds never depend
 * on loading a remote JavaScript bundle. Web hosts may still resolve the
 * manifest bundle first; the registry is the supported native fallback.
 */

import "./register-phone-page";
import "./register-companion-page";
