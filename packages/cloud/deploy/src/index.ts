/**
 * Programmatic surface of `@elizaos/cloud-deploy`: validate a deployment
 * file, render a component's Wrangler configuration, and check a rendered
 * configuration offline. The `cloud-deploy` command wraps these.
 */

export {
  type CheckOptions,
  type CheckResult,
  checkRenderedConfig,
  findWrangler,
} from "./check";
export {
  CLOUD_API_PACKAGE,
  installedApiDir,
  parseRenderedConfig,
  RenderError,
  type RenderedConfig,
  type RenderOptions,
  renderedFileNames,
  renderWranglerConfig,
} from "./render";
export {
  type ComponentRenderOptions,
  definedComponents,
  renderComponent,
} from "./render-components";
export {
  DEPLOYMENT_COMPONENTS,
  DEPLOYMENT_ENVIRONMENTS,
  type Deployment,
  type DeploymentComponentName,
  type DeploymentEnvironment,
  type DeploymentEnvironmentName,
  DeploymentFileError,
  validateDeployment,
} from "./schema";
