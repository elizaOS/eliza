/** Browser build entrypoint — re-exports the plugin definition; browser routes through `ZAI_BROWSER_BASE_URL` rather than holding the API key. */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
