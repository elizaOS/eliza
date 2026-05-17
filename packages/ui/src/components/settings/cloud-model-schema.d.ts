/**
 * Cloud model tier schema + hints builder.
 *
 * The AI Model settings panel exposes 7 dropdowns (nano, small, medium, large,
 * mega, responseHandler, actionPlanner). Each is a `ConfigRenderer` select
 * field with the same shape — this module produces the schema and hints so
 * the component stays readable.
 */
import type { OnboardingOptions } from "../../api";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { ConfigUiHint } from "../../types";
export declare const DEFAULT_RESPONSE_HANDLER_MODEL =
  "__DEFAULT_RESPONSE_HANDLER__";
export declare const DEFAULT_ACTION_PLANNER_MODEL =
  "__DEFAULT_ACTION_PLANNER__";
export interface CloudModelSchema {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
}
/**
 * Build the JSONSchema + UI hints for the cloud model tier grid.
 *
 * `allChoices` is the union of every tier's catalog, de-duped by id, used by
 * the override selectors (responseHandler, actionPlanner) which accept any
 * model.
 */
export declare function buildCloudModelSchema(
  options: OnboardingOptions["models"],
): CloudModelSchema;
//# sourceMappingURL=cloud-model-schema.d.ts.map
