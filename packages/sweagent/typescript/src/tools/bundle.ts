/**
 * Tool bundle configuration
 * Converted from sweagent/tools/bundle.py
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseYAML, type YamlData } from "../agent/utils/yaml";
import type { IArgument } from "./commands";
import { Command } from "./commands";

/**
 * Tool configuration type
 */
export interface BundleToolConfig {
  signature?: string;
  format?: string;
  docstring?: string;
  hidden?: boolean;
  end_name?: string;
  arguments?: IArgument[];
}

/**
 * Bundle configuration
 */
export interface BundleConfig {
  tools: Record<string, BundleToolConfig>;
  stateCommand?: string | null;
}

function expectObject(
  v: YamlData,
  context: string,
): { [key: string]: YamlData } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`Invalid bundle config: expected object at ${context}`);
  }
  return v;
}

function expectString(v: YamlData, context: string): string {
  if (typeof v !== "string") {
    throw new Error(`Invalid bundle config: expected string at ${context}`);
  }
  return v;
}

function parseArgument(arg: YamlData, context: string): IArgument {
  const obj = expectObject(arg, context);

  const name = expectString(obj.name, `${context}.name`);
  const type = expectString(obj.type, `${context}.type`);
  const description =
    typeof obj.description === "string" ? obj.description : "";
  const required = typeof obj.required === "boolean" ? obj.required : false;

  const argumentFormat =
    typeof obj.argumentFormat === "string"
      ? obj.argumentFormat
      : typeof obj.argument_format === "string"
        ? obj.argument_format
        : "{{value}}";

  const enumVal = obj.enum;
  const enumOut =
    Array.isArray(enumVal) && enumVal.every((x) => typeof x === "string")
      ? (enumVal as string[])
      : null;

  const itemsVal = obj.items;
  let itemsOut: Record<string, string> | null = null;
  if (
    typeof itemsVal === "object" &&
    itemsVal !== null &&
    !Array.isArray(itemsVal)
  ) {
    const itemsObj = itemsVal as { [key: string]: YamlData };
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(itemsObj)) {
      if (typeof v === "string") {
        mapped[k] = v;
      }
    }
    itemsOut = mapped;
  }

  return {
    name,
    type,
    description,
    required,
    argumentFormat,
    enum: enumOut,
    items: itemsOut,
  };
}

function parseBundleConfig(yamlText: string, configPath: string): BundleConfig {
  const parsed = parseYAML(yamlText);
  const root = expectObject(parsed, configPath);
  const toolsVal = root.tools;
  const toolsObj = expectObject(toolsVal, `${configPath}.tools`);

  const tools: Record<string, BundleToolConfig> = {};
  for (const [toolName, toolVal] of Object.entries(toolsObj)) {
    const toolObj = expectObject(toolVal, `${configPath}.tools.${toolName}`);

    const signature =
      typeof toolObj.signature === "string" ? toolObj.signature : undefined;
    const format =
      typeof toolObj.format === "string" ? toolObj.format : undefined;
    const docstring =
      typeof toolObj.docstring === "string" ? toolObj.docstring : undefined;
    const hidden =
      typeof toolObj.hidden === "boolean" ? toolObj.hidden : undefined;
    const end_name =
      typeof toolObj.end_name === "string" ? toolObj.end_name : undefined;

    let args: IArgument[] | undefined;
    const argsVal = toolObj.arguments;
    if (Array.isArray(argsVal)) {
      args = argsVal.map((a, i) =>
        parseArgument(a, `${configPath}.tools.${toolName}.arguments[${i}]`),
      );
    }

    tools[toolName] = {
      signature,
      format,
      docstring,
      hidden,
      end_name,
      arguments: args,
    };
  }

  const stateCommand =
    typeof root.stateCommand === "string" || root.stateCommand === null
      ? root.stateCommand
      : undefined;

  return { tools, stateCommand };
}

/**
 * Tool bundle
 */
export class Bundle {
  path: string;
  hiddenTools: string[];
  private _config?: BundleConfig;

  constructor(config: { path: string; hiddenTools?: string[] }) {
    this.path = config.path;
    this.hiddenTools = config.hiddenTools || [];
    this.validateTools();
  }

  private validateTools(): void {
    // Validate that the bundle path exists
    if (!fs.existsSync(this.path)) {
      throw new Error(`Bundle path does not exist: ${this.path}`);
    }

    // Load and validate config
    const configPath = path.join(this.path, "config.yaml");
    if (!fs.existsSync(configPath)) {
      throw new Error(`Bundle config not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, "utf-8");
    this._config = parseBundleConfig(configContent, configPath);

    // Validate tools
    if (!this._config.tools || typeof this._config.tools !== "object") {
      throw new Error("Bundle config must contain tools object");
    }
  }

  get stateCommand(): string | null | undefined {
    return this.config.stateCommand;
  }

  get config(): BundleConfig {
    if (!this._config) {
      this.validateTools();
    }
    if (!this._config) {
      throw new Error("Failed to initialize bundle config");
    }
    return this._config;
  }

  get commands(): Command[] {
    const commands: Command[] = [];

    for (const [name, toolConfig] of Object.entries(this.config.tools)) {
      if (this.hiddenTools.includes(name)) {
        continue;
      }

      // Convert tool config to Command
      const command = new Command({
        name,
        docstring: toolConfig.docstring ?? null,
        signature: toolConfig.signature ?? null,
        endName: toolConfig.end_name ?? undefined,
        arguments: toolConfig.arguments ?? [],
      });

      commands.push(command);
    }

    return commands;
  }
}
