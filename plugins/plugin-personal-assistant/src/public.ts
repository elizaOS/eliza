/**
 * Additional public re-exports for the plugin (routes plugin, website-block
 * action, SelfControl permission helpers).
 */
export { personalAssistantRoutesPlugin } from "./routes/plugin.js";
export {
  getSelfControlPermissionState,
  openSelfControlPermissionLocation,
  requestSelfControlPermission,
  websiteBlockAction,
} from "./website-blocker/public.js";
