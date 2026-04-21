/**
 * Side-effect entry point — registers the companion overlay app.
 *
 * Import this module when you want auto-registration:
 *   import "@elizaos/app-companion/register";
 *
 * For explicit control, import `registerCompanionApp` from the main entry:
 *   import { registerCompanionApp } from "@elizaos/app-companion";
 *   registerCompanionApp();
 */
import { registerCompanionApp } from "./components/companion/companion-app";

registerCompanionApp();
