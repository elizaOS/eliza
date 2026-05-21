import { readFileSync } from "node:fs";
import ts from "typescript";

const pluginFile = "packages/core/src/types/plugin.ts";
const capabilityFile = "packages/core/src/capabilities/index.ts";
const conformanceFile =
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts";
const fixtureServerFile =
  "packages/scripts/capability-router-fixture-server.ts";
const liveReportValidatorFile =
  "packages/scripts/validate-capability-router-live-reports.ts";

const remoteSupported = new Map<string, string>([
  ["name", "name"],
  ["description", "description"],
  ["init", "lifecycle:init"],
  ["dispose", "lifecycle:dispose"],
  ["applyConfig", "lifecycle:applyConfig"],
  ["config", "config"],
  ["services", "services"],
  ["componentTypes", "componentTypes"],
  ["actions", "actions"],
  ["providers", "providers"],
  ["evaluators", "evaluators"],
  ["responseHandlerEvaluators", "responseHandlerEvaluators"],
  ["responseHandlerFieldEvaluators", "responseHandlerFieldEvaluators"],
  ["models", "models"],
  ["events", "events"],
  ["routes", "routes"],
  ["priority", "priority"],
  ["schema", "schema"],
  ["app", "app"],
  ["appBridge", "appBridge"],
  ["views", "views"],
  ["widgets", "widgets"],
  ["contexts", "contexts"],
]);

const localOnly = new Set([
  "mode",
  "remote",
  "adapter",
  "tests",
  "dependencies",
  "testDependencies",
  "autoEnable",
  "mode",
  "remote",
]);

const remoteManifestKeys = new Set(
  readTypeMembers(capabilityFile, "RemotePluginModuleManifest"),
);
const pluginKeys = readInterfaceMembers(pluginFile, "Plugin");
const failures: string[] = [];

for (const key of pluginKeys) {
  const remoteKey = remoteSupported.get(key);
  if (remoteKey) {
    if (
      !remoteKey.startsWith("lifecycle:") &&
      !remoteManifestKeys.has(remoteKey)
    ) {
      failures.push(
        `Plugin.${key} is marked remote-supported but RemotePluginModuleManifest lacks ${remoteKey}.`,
      );
    }
    continue;
  }
  if (localOnly.has(key)) continue;
  failures.push(
    `Plugin.${key} is not classified for capability-router remote plugins.`,
  );
}

for (const key of [...remoteSupported.keys(), ...localOnly]) {
  if (!pluginKeys.includes(key)) {
    failures.push(`Surface audit references missing Plugin.${key}.`);
  }
}

if (!remoteManifestKeys.has("lifecycle")) {
  failures.push(
    "RemotePluginModuleManifest must keep lifecycle for init/dispose/applyConfig.",
  );
}

const pluginRpcMethods = readStringUnionMembers(
  capabilityFile,
  "RuntimeBrokerCapabilityMethod",
).filter((method) => method.startsWith("plugin."));
const conformanceRequiredMethods = pluginRpcMethods.filter(
  (method) => method !== "plugin.modules.list",
);
const conformanceSource = readFileSync(conformanceFile, "utf8");
const fixtureServerSource = readFileSync(fixtureServerFile, "utf8");
const conformanceSurfaces = readStringUnionMembers(
  conformanceFile,
  "RemoteCapabilityEndpointConformanceSurface",
);
const liveReportValidatorSurfaces = readStringArrayLiteral(
  liveReportValidatorFile,
  "REQUIRED_SURFACES",
);
const liveReportValidatorRpcMethodRecord = readStringArrayRecord(
  liveReportValidatorFile,
  "REQUIRED_SURFACE_RPC_METHODS",
);
const liveReportValidatorRpcMethods = new Set(
  Object.values(liveReportValidatorRpcMethodRecord).flat(),
);

compareSets(
  failures,
  "Remote capability endpoint conformance surfaces",
  conformanceSurfaces,
  "live report required surfaces",
  liveReportValidatorSurfaces,
);

compareSets(
  failures,
  "Live report required surfaces",
  liveReportValidatorSurfaces,
  "live report RPC method matrix keys",
  Object.keys(liveReportValidatorRpcMethodRecord),
);

for (const method of pluginRpcMethods) {
  if (!fixtureServerSource.includes(`case "${method}"`)) {
    failures.push(
      `RuntimeBrokerCapabilityMethod.${method} is not implemented by capability-router-fixture-server.`,
    );
  }
}

for (const method of conformanceRequiredMethods) {
  if (!conformanceSource.includes(`"${method}"`)) {
    failures.push(
      `RuntimeBrokerCapabilityMethod.${method} is not exercised by remote capability endpoint conformance.`,
    );
  }
  if (!liveReportValidatorRpcMethods.has(method)) {
    failures.push(
      `RuntimeBrokerCapabilityMethod.${method} is not required by live report validation.`,
    );
  }
}

for (const method of liveReportValidatorRpcMethods) {
  if (!conformanceRequiredMethods.includes(method)) {
    failures.push(
      `Live report validation requires ${method}, but it is not a canonical non-list plugin RPC method.`,
    );
  }
}

if (failures.length > 0) {
  console.error("[capability-router-surface-audit] failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      pluginFields: pluginKeys.length,
      remoteSupported: remoteSupported.size,
      localOnly: localOnly.size,
      pluginRpcMethods: pluginRpcMethods.length,
      conformanceRequiredMethods: conformanceRequiredMethods.length,
    },
    null,
    2,
  ),
);

function readInterfaceMembers(
  fileName: string,
  interfaceName: string,
): string[] {
  const source = readSourceFile(fileName);
  for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      return memberNames(node.members);
    }
  }
  throw new Error(`Could not find interface ${interfaceName} in ${fileName}.`);
}

function readTypeMembers(fileName: string, typeName: string): string[] {
  const source = readSourceFile(fileName);
  for (const node of source.statements) {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName &&
      ts.isTypeLiteralNode(node.type)
    ) {
      return memberNames(node.type.members);
    }
  }
  throw new Error(`Could not find type literal ${typeName} in ${fileName}.`);
}

function readStringUnionMembers(fileName: string, typeName: string): string[] {
  const source = readSourceFile(fileName);
  for (const node of source.statements) {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName &&
      ts.isUnionTypeNode(node.type)
    ) {
      return node.type.types.flatMap((member) => {
        if (
          ts.isLiteralTypeNode(member) &&
          ts.isStringLiteral(member.literal)
        ) {
          return [member.literal.text];
        }
        return [];
      });
    }
  }
  throw new Error(`Could not find string union ${typeName} in ${fileName}.`);
}

function readStringArrayLiteral(
  fileName: string,
  variableName: string,
): string[] {
  const source = readSourceFile(fileName);
  for (const node of source.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === variableName &&
        declaration.initializer
      ) {
        const initializer = unwrapExpression(declaration.initializer);
        if (!ts.isArrayLiteralExpression(initializer)) {
          throw new Error(`${variableName} must be a string array.`);
        }
        return initializer.elements.map((element) => {
          if (!ts.isStringLiteral(element)) {
            throw new Error(
              `${variableName} must contain only string literals.`,
            );
          }
          return element.text;
        });
      }
    }
  }
  throw new Error(
    `Could not find string array ${variableName} in ${fileName}.`,
  );
}

function readStringArrayRecord(
  fileName: string,
  variableName: string,
): Record<string, string[]> {
  const source = readSourceFile(fileName);
  for (const node of source.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === variableName &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        return Object.fromEntries(
          declaration.initializer.properties.map((property) => {
            if (
              !ts.isPropertyAssignment(property) ||
              !property.name ||
              !ts.isArrayLiteralExpression(property.initializer)
            ) {
              throw new Error(
                `${variableName} must be an object of string array properties.`,
              );
            }
            const propertyName = propertyNameText(property.name);
            const values = property.initializer.elements.map((element) => {
              if (!ts.isStringLiteral(element)) {
                throw new Error(
                  `${variableName}.${propertyName} must contain only string literals.`,
                );
              }
              return element.text;
            });
            return [propertyName, values] as const;
          }),
        );
      }
    }
  }
  throw new Error(
    `Could not find string array record ${variableName} in ${fileName}.`,
  );
}

function compareSets(
  failures: string[],
  leftLabel: string,
  left: readonly string[],
  rightLabel: string,
  right: readonly string[],
): void {
  const rightSet = new Set(right);
  for (const item of left) {
    if (!rightSet.has(item)) {
      failures.push(
        `${leftLabel} include ${item}, missing from ${rightLabel}.`,
      );
    }
  }
  const leftSet = new Set(left);
  for (const item of right) {
    if (!leftSet.has(item)) {
      failures.push(
        `${rightLabel} include ${item}, missing from ${leftLabel}.`,
      );
    }
  }
}

function propertyNameText(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error("Unsupported computed property name.");
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function memberNames(members: ts.NodeArray<ts.TypeElement>): string[] {
  return members.flatMap((member) => {
    if (
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.name
    ) {
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        return [member.name.text];
      }
    }
    return [];
  });
}

function readSourceFile(fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    readFileSync(fileName, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
