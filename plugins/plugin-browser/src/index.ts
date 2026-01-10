// Export service
export { StagehandService, BrowserSession } from './service.js';

// Export actions for testing
export {
  browserNavigateAction,
  browserClickAction,
  browserTypeAction,
  browserSelectAction,
  browserExtractAction,
  browserScreenshotAction,
} from './plugin.js';

// Re-export plugin
export { stagehandPlugin } from './plugin.js';
import { stagehandPlugin } from './plugin.js';
export default stagehandPlugin;
