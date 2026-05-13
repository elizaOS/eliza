import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SOURCE_ROOTS = ["packages", "plugins", "cloud"];
const EXCLUDE_RE =
  /(^|\/)(dist|build|coverage|node_modules|\.turbo|\.next|generated)(\/|$)|(\.d\.ts$)|(\.(test|spec)\.tsx?$)|(^|\/)(__tests__|test|tests|templates)(\/|$)/;

type ImportedBinding = {
  file: string;
  imported: string;
};

type StaticBindings = {
  stringBindings: Map<string, string>;
  arrayBindings: Map<string, string[]>;
  objectBindings: Map<string, ts.ObjectLiteralExpression>;
  specBindings: Map<string, string>;
  importBindings: Map<string, ImportedBinding>;
};

type ExportedStaticBindings = {
  strings: Map<string, string>;
  arrays: Map<string, string[]>;
};

export type ActionScanSort = "name" | "filepath";

type ScannedParameter = {
  name: string;
  description: string;
  required?: boolean;
  schemaType?: string;
  enumValues: string[];
  source: string;
};

type SubActionReference = {
  raw: string;
  name: string;
  kind: "name" | "ref" | "inline" | "spread" | "expression";
  found: boolean;
  targetId?: string;
  targetFile?: string;
  targetLine?: number;
};

type InferredSubAction = {
  name: string;
  parameter: string;
  source: "parameter-enum" | "parameter-description";
};

type ScannedAction = {
  id: string;
  name: string;
  nameStatic: boolean;
  declarationName: string;
  actionType: string;
  detectedBy: "shape" | "type";
  source: string;
  file: string;
  absoluteFile: string;
  line: number;
  description: string;
  contexts: string[];
  tags: string[];
  similes: string[];
  mode: string;
  roleGate: string;
  contextGate: string;
  validation: "always_true" | "conditional" | "missing";
  subPlanner: boolean;
  parameters: ScannedParameter[];
  parameterSummary: string[];
  subActions: string[];
  resolvedSubActions: SubActionReference[];
  inferredSubActions: InferredSubAction[];
  parentIds: string[];
  parentNames: string[];
};

type ActionTreeNode = {
  id: string;
  name: string;
  kind: "action" | "missing" | "inferred";
  file?: string;
  absoluteFile?: string;
  line?: number;
  source?: string;
  actionId?: string;
  ref?: string;
  parameter?: string;
  inferredSource?: InferredSubAction["source"];
  cycle?: boolean;
  children: ActionTreeNode[];
};

type ActionScanResult = {
  generatedAt: string;
  repoRoot: string;
  sourceRoots: string[];
  filesScanned: number;
  actionCount: number;
  rootCount: number;
  parentCount: number;
  unresolvedSubActionCount: number;
  inferredSubActionCount: number;
  dynamicNameCount: number;
  sort: ActionScanSort;
  sourceGroups: Array<{ source: string; count: number }>;
  roots: ActionTreeNode[];
  actions: ScannedAction[];
};

const exportedBindingCache = new Map<string, ExportedStaticBindings>();

function toRepoPath(file: string): string {
  return file.split(sep).join("/");
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function unwrapExpression(
  expr: ts.Expression | undefined,
): ts.Expression | undefined {
  let current = expr;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propName(prop: ts.ObjectLiteralElementLike): string | undefined {
  const name = prop.name;
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return name.getText();
}

function getProp(
  obj: ts.ObjectLiteralExpression,
  names: string | string[],
): ts.ObjectLiteralElementLike | undefined {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  for (const prop of obj.properties) {
    if (
      (ts.isPropertyAssignment(prop) ||
        ts.isMethodDeclaration(prop) ||
        ts.isShorthandPropertyAssignment(prop)) &&
      wanted.has(propName(prop) ?? "")
    ) {
      return prop;
    }
  }
  return undefined;
}

function getPropExpression(
  prop: ts.ObjectLiteralElementLike | undefined,
): ts.Expression | undefined {
  if (!prop) return undefined;
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  return undefined;
}

function literalText(expr: ts.Expression | undefined): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return undefined;
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isNumericLiteral(unwrapped)) return unwrapped.text;
  return undefined;
}

function exprText(
  expr: ts.Node | undefined,
  sf: ts.SourceFile,
  max = 220,
): string {
  if (!expr) return "";
  const text = expr.getText(sf).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function propSource(
  obj: ts.ObjectLiteralExpression,
  names: string | string[],
  sf: ts.SourceFile,
  max = 220,
): string {
  return exprText(getPropExpression(getProp(obj, names)), sf, max);
}

function readArrayFromExpression(
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  bindings?: StaticBindings | ExportedStaticBindings,
): string[] | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return undefined;
  if (!ts.isArrayLiteralExpression(unwrapped)) return undefined;

  const values = unwrapped.elements.flatMap((element): string[] => {
    if (ts.isStringLiteralLike(element)) return [element.text];
    if (ts.isIdentifier(element)) {
      if (bindings && "stringBindings" in bindings) {
        const stringValue = bindings.stringBindings.get(element.text);
        if (stringValue) return [stringValue];
        const arrayValue = bindings.arrayBindings.get(element.text);
        if (arrayValue) return arrayValue;
      } else if (bindings) {
        const stringValue = bindings.strings.get(element.text);
        if (stringValue) return [stringValue];
        const arrayValue = bindings.arrays.get(element.text);
        if (arrayValue) return arrayValue;
      }
    }
    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      if (bindings && "arrayBindings" in bindings) {
        return bindings.arrayBindings.get(element.expression.text) ?? [];
      }
      if (bindings && "arrays" in bindings) {
        return bindings.arrays.get(element.expression.text) ?? [];
      }
    }
    return [exprText(element, sf, 120)].filter(Boolean);
  });

  return values.length > 0 ? values : undefined;
}

function collectExportedStaticBindings(
  repoRoot: string,
  file: string,
): ExportedStaticBindings {
  const cached = exportedBindingCache.get(file);
  if (cached) return cached;

  const result: ExportedStaticBindings = {
    strings: new Map(),
    arrays: new Map(),
  };
  exportedBindingCache.set(file, result);

  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return result;

  const source = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          continue;

        const initializer = unwrapExpression(declaration.initializer);
        const text = literalText(initializer);
        if (text !== undefined) {
          result.strings.set(declaration.name.text, text);
          continue;
        }

        const array = readArrayFromExpression(initializer, sf, result);
        if (array) result.arrays.set(declaration.name.text, array);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

function importedBindingValue(
  repoRoot: string,
  bindings: StaticBindings,
  localName: string,
) {
  const imported = bindings.importBindings.get(localName);
  if (!imported) return undefined;

  const exported = collectExportedStaticBindings(repoRoot, imported.file);
  const stringValue = exported.strings.get(imported.imported);
  if (stringValue) return { type: "string" as const, value: stringValue };

  const arrayValue = exported.arrays.get(imported.imported);
  if (arrayValue) return { type: "array" as const, value: arrayValue };

  return undefined;
}

function collectStaticBindings(
  repoRoot: string,
  sf: ts.SourceFile,
  file: string,
): StaticBindings {
  const stringBindings = new Map<string, string>();
  const arrayBindings = new Map<string, string[]>();
  const objectBindings = new Map<string, ts.ObjectLiteralExpression>();
  const specBindings = new Map<string, string>();
  const importBindings = new Map<string, ImportedBinding>();

  function resolveImportPath(specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;

    const fromDir = dirname(file);
    const candidate = normalize(join(fromDir, specifier));
    const candidates = [
      candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".ts") : "",
      candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".tsx") : "",
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      `${candidate}.js`,
      join(candidate, "index.ts"),
      join(candidate, "index.tsx"),
    ].filter(Boolean);

    return candidates
      .map(toRepoPath)
      .find((item) => existsSync(join(repoRoot, item)));
  }

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const resolvedFile = resolveImportPath(node.moduleSpecifier.text);
      const namedBindings = node.importClause?.namedBindings;
      if (resolvedFile && namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const local = element.name.text;
          importBindings.set(local, { file: resolvedFile, imported });
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = unwrapExpression(node.initializer);
      if (initializer) {
        const literal = literalText(initializer);
        if (literal !== undefined) {
          stringBindings.set(node.name.text, literal);
        } else if (ts.isObjectLiteralExpression(initializer)) {
          objectBindings.set(node.name.text, initializer);
        } else {
          const array = readArrayFromExpression(initializer, sf, {
            stringBindings,
            arrayBindings,
            objectBindings,
            specBindings,
            importBindings,
          });
          if (array) arrayBindings.set(node.name.text, array);
        }

        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "requireActionSpec"
        ) {
          const [firstArg] = initializer.arguments;
          const specName =
            literalText(firstArg) ||
            (ts.isIdentifier(firstArg)
              ? stringBindings.get(firstArg.text)
              : undefined);
          if (specName) specBindings.set(node.name.text, specName);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return {
    stringBindings,
    arrayBindings,
    objectBindings,
    specBindings,
    importBindings,
  };
}

function resolvedLiteralText(
  repoRoot: string,
  expr: ts.Expression | undefined,
  bindings: StaticBindings,
): string | undefined {
  const direct = literalText(expr);
  if (direct !== undefined) return direct;
  if (!expr) return undefined;

  if (ts.isIdentifier(expr)) {
    const imported = importedBindingValue(repoRoot, bindings, expr.text);
    return (
      bindings.stringBindings.get(expr.text) ||
      (imported?.type === "string" ? imported.value : undefined)
    );
  }

  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "name" &&
    ts.isIdentifier(expr.expression)
  ) {
    return bindings.specBindings.get(expr.expression.text);
  }

  return undefined;
}

function stringArray(
  repoRoot: string,
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  bindings: StaticBindings,
  options: { refs?: boolean } = {},
): string[] {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return [];

  if (ts.isIdentifier(unwrapped)) {
    const arrayValue = bindings.arrayBindings.get(unwrapped.text);
    if (arrayValue) return arrayValue;
    const stringValue = bindings.stringBindings.get(unwrapped.text);
    if (stringValue) return [stringValue];
    const imported = importedBindingValue(repoRoot, bindings, unwrapped.text);
    if (imported?.type === "array") return imported.value;
    if (imported?.type === "string") return [imported.value];
    return options.refs
      ? [`{ref:${unwrapped.text}}`]
      : [exprText(unwrapped, sf, 120)];
  }

  if (!ts.isArrayLiteralExpression(unwrapped)) {
    return [exprText(unwrapped, sf, 120)].filter(Boolean);
  }

  return unwrapped.elements.flatMap((element): string[] => {
    if (ts.isStringLiteralLike(element)) return [element.text];

    if (ts.isSpreadElement(element)) {
      if (ts.isIdentifier(element.expression)) {
        const imported = importedBindingValue(
          repoRoot,
          bindings,
          element.expression.text,
        );
        if (imported?.type === "array") return imported.value;
        const localArray = bindings.arrayBindings.get(element.expression.text);
        if (localArray) return localArray;
      }
      return [`...${exprText(element.expression, sf, 80)}`];
    }

    if (ts.isIdentifier(element)) {
      const stringValue = bindings.stringBindings.get(element.text);
      if (stringValue) return [stringValue];
      const arrayValue = bindings.arrayBindings.get(element.text);
      if (arrayValue) return arrayValue;
      const imported = importedBindingValue(repoRoot, bindings, element.text);
      if (imported?.type === "array") return imported.value;
      if (imported?.type === "string") return [imported.value];
      return options.refs
        ? [`{ref:${element.text}}`]
        : [exprText(element, sf, 100)];
    }

    if (ts.isObjectLiteralExpression(element)) {
      const name = literalText(getPropExpression(getProp(element, "name")));
      return name ? [`{inline:${name}}`] : [exprText(element, sf, 100)];
    }

    return [exprText(element, sf, 100)].filter(Boolean);
  });
}

function declarationName(node: ts.ObjectLiteralExpression): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    if (ts.isPropertyAssignment(current)) return propName(current) ?? "";
    if (ts.isExportAssignment(current)) return "default";
    current = current.parent;
  }
  return "";
}

function nearestFunctionReturnType(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.type
    ) {
      return current.type.getText();
    }
    current = current.parent;
  }
  return "";
}

function declarationType(node: ts.ObjectLiteralExpression): string {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const parent: ts.Node = current.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === current &&
      parent.type
    ) {
      return parent.type.getText();
    }
    if (
      (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      return parent.type.getText();
    }
    if (ts.isReturnStatement(parent)) {
      return nearestFunctionReturnType(parent);
    }
    current = parent;
  }
  return "";
}

function hasActionType(typeText: string): boolean {
  return /\b\w*Action\b/.test(typeText);
}

function hasFullActionShape(obj: ts.ObjectLiteralExpression): boolean {
  return Boolean(
    getProp(obj, "name") &&
      getProp(obj, "description") &&
      getProp(obj, "parameters") &&
      getProp(obj, "validate") &&
      getProp(obj, "handler"),
  );
}

function lineFor(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function sourceKind(file: string): string {
  if (file.startsWith("packages/core/")) return "core";
  if (file.startsWith("packages/agent/")) return "agent";
  if (file.startsWith("packages/app-core/")) return "app-core";
  const plugin = file.match(/^plugins\/([^/]+)\//);
  if (plugin) return `plugin:${plugin[1]}`;
  const cloudPlugin = file.match(
    /^cloud\/packages\/lib\/eliza\/(plugin-[^/]+)\//,
  );
  if (cloudPlugin) return `cloud:${cloudPlugin[1]}`;
  const cloudEliza = file.match(/^cloud\/packages\/lib\/eliza\/([^/]+)\//);
  if (cloudEliza) return `cloud:${cloudEliza[1]}`;
  if (file.startsWith("cloud/")) return "cloud";
  if (file.startsWith("packages/")) return `package:${file.split("/")[1]}`;
  return "repo";
}

function validationKind(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
): ScannedAction["validation"] {
  const validate = getProp(obj, "validate");
  if (!validate) return "missing";
  const text = validate.getText(sf);
  return /=>\s*true|return\s+true\b/.test(text) ? "always_true" : "conditional";
}

function enumValuesFromSchema(
  repoRoot: string,
  schema: ts.Expression | undefined,
  sf: ts.SourceFile,
  bindings: StaticBindings,
): string[] {
  const unwrapped = unwrapExpression(schema);
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return [];
  const enumExpr =
    getPropExpression(getProp(unwrapped, "enum")) ||
    getPropExpression(getProp(unwrapped, "enumValues"));
  return stringArray(repoRoot, enumExpr, sf, bindings);
}

function schemaType(
  schema: ts.Expression | undefined,
  sf: ts.SourceFile,
): string | undefined {
  const unwrapped = unwrapExpression(schema);
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return undefined;
  const typeExpr = getPropExpression(getProp(unwrapped, "type"));
  return literalText(typeExpr) ?? (exprText(typeExpr, sf, 80) || undefined);
}

function parameterFromObject(
  repoRoot: string,
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  bindings: StaticBindings,
): ScannedParameter {
  const nameExpr = getPropExpression(getProp(obj, "name"));
  const descriptionExpr = getPropExpression(
    getProp(obj, [
      "descriptionCompressed",
      "compressedDescription",
      "description",
    ]),
  );
  const requiredExpr = getPropExpression(getProp(obj, "required"));
  const schemaExpr = getPropExpression(getProp(obj, "schema"));
  const name =
    resolvedLiteralText(repoRoot, nameExpr, bindings) ??
    exprText(nameExpr, sf, 100);
  const description =
    resolvedLiteralText(repoRoot, descriptionExpr, bindings) ??
    exprText(descriptionExpr, sf, 180);

  return {
    name,
    description,
    required: literalText(requiredExpr) === "true" ? true : undefined,
    schemaType: schemaType(schemaExpr, sf),
    enumValues: enumValuesFromSchema(repoRoot, schemaExpr, sf, bindings),
    source: exprText(obj, sf, 220),
  };
}

function parameterDetails(
  repoRoot: string,
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  bindings: StaticBindings,
): ScannedParameter[] {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return [];
  if (!ts.isArrayLiteralExpression(unwrapped)) {
    return [
      {
        name: exprText(unwrapped, sf, 100),
        description: "",
        enumValues: [],
        source: exprText(unwrapped, sf, 180),
      },
    ].filter((p) => p.name);
  }

  return unwrapped.elements.flatMap((element): ScannedParameter[] => {
    if (ts.isSpreadElement(element)) {
      return [
        {
          name: `...${exprText(element.expression, sf, 80)}`,
          description: "",
          enumValues: [],
          source: exprText(element, sf, 180),
        },
      ];
    }

    if (ts.isIdentifier(element)) {
      const object = bindings.objectBindings.get(element.text);
      if (object) return [parameterFromObject(repoRoot, object, sf, bindings)];
      return [
        {
          name: `{ref:${element.text}}`,
          description: "",
          enumValues: [],
          source: exprText(element, sf, 120),
        },
      ];
    }

    if (!ts.isObjectLiteralExpression(element)) {
      return [
        {
          name: exprText(element, sf, 100),
          description: "",
          enumValues: [],
          source: exprText(element, sf, 180),
        },
      ].filter((p) => p.name);
    }

    return [parameterFromObject(repoRoot, element, sf, bindings)];
  });
}

function parameterSummary(parameters: ScannedParameter[]): string[] {
  return parameters.map((param) => {
    const required = param.required ? " required" : "";
    const schema = param.schemaType ? `:${param.schemaType}` : "";
    const enumText = param.enumValues.length
      ? ` [${param.enumValues.join("|")}]`
      : "";
    return `${param.name}${schema}${required}${enumText}`;
  });
}

function subActionsFromDescription(description: string): string[] {
  const match = description.match(
    /(?:one of|subactions?|operations?|ops?|op)\s*(?:to perform|to run|are|is)?\s*:\s*([^.\n]+)/i,
  );
  if (!match) return [];
  return match[1]
    .replace(/\bor\b/gi, ",")
    .split(/[,|]/)
    .map((value) => value.trim().replace(/[`"'()]/g, ""))
    .map((value) => value.split(/\s+/)[0] ?? "")
    .filter((value) => /^[a-z0-9_-]{2,64}$/i.test(value));
}

function inferredSubActions(
  parameters: ScannedParameter[],
): InferredSubAction[] {
  const byName = new Map<string, InferredSubAction>();
  for (const param of parameters) {
    if (!/^(subaction|subactions|op|operation|mode)$/i.test(param.name))
      continue;

    for (const value of param.enumValues) {
      byName.set(value, {
        name: value,
        parameter: param.name,
        source: "parameter-enum",
      });
    }

    if (param.enumValues.length === 0) {
      for (const value of subActionsFromDescription(param.description)) {
        byName.set(value, {
          name: value,
          parameter: param.name,
          source: "parameter-description",
        });
      }
    }
  }
  return [...byName.values()];
}

function parseSubActionRaw(
  raw: string,
): Pick<SubActionReference, "kind" | "name"> {
  const ref = raw.match(/^\{ref:(.+)\}$/)?.[1];
  if (ref) return { kind: "ref", name: ref };

  const inline = raw.match(/^\{inline:(.+)\}$/)?.[1];
  if (inline) return { kind: "inline", name: inline };

  if (raw.startsWith("...")) return { kind: "spread", name: raw.slice(3) };
  if (raw.includes("(") || raw.includes("{") || raw.includes("=>")) {
    return { kind: "expression", name: raw };
  }
  return { kind: "name", name: raw };
}

function makeActionRecord(
  repoRoot: string,
  file: string,
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  bindings: StaticBindings,
  detectedBy: ScannedAction["detectedBy"],
  actionType: string,
): Omit<ScannedAction, "resolvedSubActions" | "parentIds" | "parentNames"> {
  const nameExpr = getPropExpression(getProp(obj, "name"));
  const resolvedName = resolvedLiteralText(repoRoot, nameExpr, bindings);
  const name = resolvedName ?? exprText(nameExpr, sf, 120);
  const descriptionExpr = getPropExpression(
    getProp(obj, [
      "descriptionCompressed",
      "compressedDescription",
      "description",
    ]),
  );
  const description =
    resolvedLiteralText(repoRoot, descriptionExpr, bindings) ??
    exprText(descriptionExpr, sf, 500);
  const parameters = parameterDetails(
    repoRoot,
    getPropExpression(getProp(obj, "parameters")),
    sf,
    bindings,
  );
  const subActions = stringArray(
    repoRoot,
    getPropExpression(getProp(obj, "subActions")),
    sf,
    bindings,
    { refs: true },
  );
  const line = lineFor(sf, obj);

  return {
    id: `${file}:${line}:${declarationName(obj) || name || obj.pos}`,
    name,
    nameStatic: Boolean(resolvedName),
    declarationName: declarationName(obj),
    actionType,
    detectedBy,
    source: sourceKind(file),
    file,
    absoluteFile: join(repoRoot, file),
    line,
    description,
    contexts: stringArray(
      repoRoot,
      getPropExpression(getProp(obj, "contexts")),
      sf,
      bindings,
    ),
    tags: stringArray(
      repoRoot,
      getPropExpression(getProp(obj, "tags")),
      sf,
      bindings,
    ),
    similes: stringArray(
      repoRoot,
      getPropExpression(getProp(obj, "similes")),
      sf,
      bindings,
    ),
    mode: propSource(obj, "mode", sf, 100),
    roleGate: propSource(obj, "roleGate", sf, 180),
    contextGate: propSource(obj, "contextGate", sf, 220),
    validation: validationKind(obj, sf),
    subPlanner: Boolean(getProp(obj, "subPlanner")),
    parameters,
    parameterSummary: parameterSummary(parameters),
    subActions,
    inferredSubActions: inferredSubActions(parameters),
  };
}

function scanFile(
  repoRoot: string,
  file: string,
): Array<
  Omit<ScannedAction, "resolvedSubActions" | "parentIds" | "parentNames">
> {
  const abs = join(repoRoot, file);
  const source = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectStaticBindings(repoRoot, sf, file);
  const records: Array<
    Omit<ScannedAction, "resolvedSubActions" | "parentIds" | "parentNames">
  > = [];
  const seen = new Set<number>();

  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node) && !seen.has(node.pos)) {
      seen.add(node.pos);
      const type = declarationType(node);
      const detectedBy: ScannedAction["detectedBy"] | null = hasFullActionShape(
        node,
      )
        ? "shape"
        : hasActionType(type) &&
            getProp(node, "name") &&
            getProp(node, "validate") &&
            getProp(node, "handler")
          ? "type"
          : null;

      if (detectedBy) {
        records.push(
          makeActionRecord(
            repoRoot,
            file,
            sf,
            node,
            bindings,
            detectedBy,
            type,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return records;
}

function fallbackWalk(repoRoot: string): string[] {
  const files: string[] = [];
  const roots = SOURCE_ROOTS.map((root) => join(repoRoot, root)).filter(
    existsSync,
  );

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = toRepoPath(relative(repoRoot, abs));
      if (EXCLUDE_RE.test(rel)) continue;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        files.push(rel);
      }
    }
  }

  for (const root of roots) walk(root);
  return files;
}

function gitFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", ...SOURCE_ROOTS],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map(toRepoPath)
      .filter((file) => existsSync(join(repoRoot, file)))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !EXCLUDE_RE.test(file));
  } catch {
    return fallbackWalk(repoRoot);
  }
}

function sortActions(
  actions: ScannedAction[],
  sort: ActionScanSort,
): ScannedAction[] {
  const sorted = [...actions];
  sorted.sort((a, b) => {
    if (sort === "filepath") {
      return (
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.name.localeCompare(b.name)
      );
    }
    return (
      a.name.localeCompare(b.name) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    );
  });
  return sorted;
}

function resolveSubActionRefs(actions: ScannedAction[]): void {
  const byName = new Map<string, ScannedAction>();
  const byDecl = new Map<string, ScannedAction>();
  const byFileAndDecl = new Map<string, ScannedAction>();

  for (const action of actions) {
    if (action.name && !byName.has(action.name))
      byName.set(action.name, action);
    if (action.declarationName && !byDecl.has(action.declarationName)) {
      byDecl.set(action.declarationName, action);
    }
    if (action.declarationName) {
      byFileAndDecl.set(`${action.file}:${action.declarationName}`, action);
    }
  }

  for (const action of actions) {
    action.resolvedSubActions = action.subActions.map((raw) => {
      const parsed = parseSubActionRaw(raw);
      const imported =
        parsed.kind === "ref"
          ? actionImports(actions, action.file, parsed.name)
          : undefined;
      const importedTarget = imported
        ? byFileAndDecl.get(`${imported.file}:${imported.imported}`)
        : undefined;
      const target =
        importedTarget ??
        (parsed.kind === "ref"
          ? byDecl.get(parsed.name)
          : byName.get(parsed.name));

      return {
        raw,
        name: target?.name ?? parsed.name,
        kind: parsed.kind,
        found: Boolean(target),
        targetId: target?.id,
        targetFile: target?.file,
        targetLine: target?.line,
      };
    });
  }

  const actionById = new Map(actions.map((action) => [action.id, action]));
  for (const action of actions) {
    for (const child of action.resolvedSubActions) {
      if (!child.targetId) continue;
      const target = actionById.get(child.targetId);
      if (!target) continue;
      target.parentIds.push(action.id);
      target.parentNames.push(action.name);
    }
  }
}

function actionImports(
  actions: ScannedAction[],
  file: string,
  localName: string,
): ImportedBinding | undefined {
  const importer = importBindingIndex.get(file);
  if (importer) return importer.get(localName);

  // This branch is only a defensive fallback. The index is filled during the
  // second parse pass in scanRepoActions.
  void actions;
  return undefined;
}

const importBindingIndex = new Map<string, Map<string, ImportedBinding>>();

function collectImportBindingIndex(repoRoot: string, files: string[]): void {
  importBindingIndex.clear();
  for (const file of files) {
    try {
      const source = readFileSync(join(repoRoot, file), "utf8");
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      importBindingIndex.set(
        file,
        collectStaticBindings(repoRoot, sf, file).importBindings,
      );
    } catch {
      importBindingIndex.set(file, new Map());
    }
  }
}

function makeTreeNode(
  action: ScannedAction,
  actionById: Map<string, ScannedAction>,
  sort: ActionScanSort,
  seen = new Set<string>(),
): ActionTreeNode {
  const cycle = seen.has(action.id);
  const node: ActionTreeNode = {
    id: action.id,
    name: action.name,
    kind: "action",
    file: action.file,
    absoluteFile: action.absoluteFile,
    line: action.line,
    source: action.source,
    actionId: action.id,
    cycle,
    children: [],
  };
  if (cycle) return node;

  const nextSeen = new Set(seen);
  nextSeen.add(action.id);

  const actionChildren = action.resolvedSubActions.map(
    (child): ActionTreeNode => {
      const target = child.targetId
        ? actionById.get(child.targetId)
        : undefined;
      if (target) return makeTreeNode(target, actionById, sort, nextSeen);
      return {
        id: `${action.id}:missing:${child.raw}`,
        name: child.name,
        kind: "missing",
        ref: child.raw,
        children: [],
      };
    },
  );

  const inferredChildren = action.inferredSubActions.map(
    (child): ActionTreeNode => ({
      id: `${action.id}:inferred:${child.parameter}:${child.name}`,
      name: child.name,
      kind: "inferred",
      parameter: child.parameter,
      inferredSource: child.source,
      children: [],
    }),
  );

  node.children = sortTreeNodes([...actionChildren, ...inferredChildren], sort);
  return node;
}

function sortTreeNodes(
  nodes: ActionTreeNode[],
  sort: ActionScanSort,
): ActionTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (sort === "filepath") {
      return (
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.name.localeCompare(b.name)
      );
    }
    return (
      a.name.localeCompare(b.name) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0)
    );
  });
}

function sourceGroups(
  actions: ScannedAction[],
): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.source, (counts.get(action.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function scanRepoActions(options: {
  repoRoot: string;
  sort?: ActionScanSort;
}): ActionScanResult {
  const repoRoot = resolve(options.repoRoot);
  const sort = options.sort ?? "name";
  exportedBindingCache.clear();

  const files = gitFiles(repoRoot);
  collectImportBindingIndex(repoRoot, files);

  const actions: ScannedAction[] = files
    .flatMap((file) => scanFile(repoRoot, file))
    .map((action) => ({
      ...action,
      resolvedSubActions: [],
      parentIds: [],
      parentNames: [],
    }));

  resolveSubActionRefs(actions);

  const actionById = new Map(actions.map((action) => [action.id, action]));
  const sortedActions = sortActions(actions, sort);
  const childIds = new Set(
    actions.flatMap((action) =>
      action.resolvedSubActions.flatMap((child) =>
        child.targetId ? [child.targetId] : [],
      ),
    ),
  );
  const roots = sortActions(
    actions.filter((action) => !childIds.has(action.id)),
    sort,
  ).map((action) => makeTreeNode(action, actionById, sort));

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    sourceRoots: SOURCE_ROOTS,
    filesScanned: files.length,
    actionCount: actions.length,
    rootCount: roots.length,
    parentCount: actions.filter(
      (action) =>
        action.resolvedSubActions.length > 0 ||
        action.inferredSubActions.length > 0,
    ).length,
    unresolvedSubActionCount: actions.reduce(
      (count, action) =>
        count +
        action.resolvedSubActions.filter((child) => !child.found).length,
      0,
    ),
    inferredSubActionCount: actions.reduce(
      (count, action) => count + action.inferredSubActions.length,
      0,
    ),
    dynamicNameCount: actions.filter((action) => !action.nameStatic).length,
    sort,
    sourceGroups: sourceGroups(actions),
    roots,
    actions: sortedActions,
  };
}
