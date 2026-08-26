/**
 * Discovers maintained React composition through TypeScript symbols so design
 * ownership cannot be bypassed by omitting a component from a registry.
 */

import path from "node:path";
import ts from "typescript";
import type { DesignCapability } from "./design-contract-schema.ts";

export interface DiscoveredComponent {
  id: string;
  file: string;
  symbol: string;
  exported: boolean;
  directAtoms: readonly string[];
  transitiveAtoms: readonly string[];
  dependencies: readonly string[];
  consumerDomains: readonly string[];
  consumers: readonly string[];
  inferredLayer: "atom" | "molecule" | "organism";
  discoveryReason:
    | "canonical-atom-owner"
    | "declared-higher-order-owner"
    | "canonical-molecule-directory"
    | "cross-domain-reuse"
    | "multi-consumer-reuse"
    | "domain-private-composition";
  rawCapabilities: readonly RawCapabilityOccurrence[];
}

export interface RawCapabilityOccurrence {
  file: string;
  line: number;
  host: string;
  capabilities: readonly DesignCapability[];
}

export interface ComponentGraph {
  components: readonly DiscoveredComponent[];
}

interface MutableComponent {
  id: string;
  file: string;
  symbol: string;
  exported: boolean;
  node: ts.Node;
  directAtoms: Set<string>;
  dependencies: Set<string>;
  consumerDomains: Set<string>;
  consumers: Set<string>;
  rawCapabilities: RawCapabilityOccurrence[];
  exportOwnerKey: string;
}

interface ComponentDeclaration {
  name: string;
  node: ts.Node;
  ownerDeclaration: ts.Declaration;
  exportOwnerDeclaration: ts.Declaration;
}

const DOMAIN_ROOTS = [
  "components/accounts",
  "components/apps",
  "components/auth",
  "components/browser",
  "components/chat",
  "components/composites",
  "components/connectors",
  "components/local-inference",
  "components/pages",
  "components/settings",
  "components/shell",
  "components/stream",
  "cloud",
  "genui",
  "layouts",
  "spatial",
  "widgets",
] as const;

function normalized(file: string): string {
  return file.split(path.sep).join("/");
}

function domainForFile(file: string): string {
  const marker = "/packages/ui/src/";
  const normalizedFile = normalized(path.resolve(file));
  if (!normalizedFile.includes(marker)) {
    const externalDomain = /\/(packages|plugins)\/([^/]+)\//.exec(
      normalizedFile,
    );
    if (externalDomain) return `${externalDomain[1]}/${externalDomain[2]}`;
  }
  const relative = normalizedFile.includes(marker)
    ? normalizedFile.split(marker)[1]
    : normalizedFile;
  const root = [...DOMAIN_ROOTS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => relative.startsWith(`${candidate}/`));
  return root ?? relative.split("/").slice(0, 2).join("/");
}

function namedComponentDeclaration(
  node: ts.Statement | ts.Declaration,
  allowedNames?: ReadonlySet<string>,
): ComponentDeclaration | null {
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name &&
    (/^[A-Z]/.test(node.name.text) || allowedNames?.has(node.name.text))
  ) {
    return {
      name: node.name.text,
      node,
      ownerDeclaration: node,
      exportOwnerDeclaration: node,
    };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    (/^[A-Z]/.test(node.name.text) || allowedNames?.has(node.name.text))
  ) {
    return {
      name: node.name.text,
      node,
      ownerDeclaration: node,
      exportOwnerDeclaration: node,
    };
  }
  return null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) ||
      ts.isNoSubstitutionTemplateLiteral(name.expression) ||
      ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return null;
}

function propertyHeldComponentDeclarations(
  root: ts.VariableDeclaration,
  object: ts.ObjectLiteralExpression,
  pathParts: readonly string[],
): readonly ComponentDeclaration[] {
  const declarations: ComponentDeclaration[] = [];
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property)
    ) {
      continue;
    }
    const propertyName = staticPropertyName(property.name);
    if (!propertyName) continue;
    const propertyPath = [...pathParts, propertyName];
    if (ts.isPropertyAssignment(property)) {
      const initializer = unwrapExpression(property.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        declarations.push(
          ...propertyHeldComponentDeclarations(root, initializer, propertyPath),
        );
        continue;
      }
      if (
        !/^[A-Z]/.test(propertyName) ||
        (!ts.isArrowFunction(initializer) &&
          !ts.isFunctionExpression(initializer))
      ) {
        continue;
      }
      declarations.push({
        name: propertyPath.join("."),
        node: initializer,
        ownerDeclaration: property,
        exportOwnerDeclaration: root,
      });
      continue;
    }
    if (/^[A-Z]/.test(propertyName) && property.body) {
      declarations.push({
        name: propertyPath.join("."),
        node: property,
        ownerDeclaration: property,
        exportOwnerDeclaration: root,
      });
    }
  }
  return declarations;
}

function componentDeclarations(
  statement: ts.Statement,
  allowedNames?: ReadonlySet<string>,
): readonly ComponentDeclaration[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isObjectLiteralExpression(initializer)) {
          return propertyHeldComponentDeclarations(declaration, initializer, [
            declaration.name.text,
          ]);
        }
      }
      const component = namedComponentDeclaration(declaration, allowedNames);
      return component ? [component] : [];
    });
  }
  const component = namedComponentDeclaration(statement, allowedNames);
  return component ? [component] : [];
}

function hasExport(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword,
        ),
  );
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declarationKey(declaration: ts.Declaration): string | null {
  const sourceFile = declaration.getSourceFile();
  if (ts.isVariableDeclaration(declaration)) {
    return ts.isIdentifier(declaration.name)
      ? `${normalized(sourceFile.fileName)}#${declaration.name.text}`
      : null;
  }
  let current: ts.Node | undefined = declaration;
  while (current && current.parent !== sourceFile) current = current.parent;
  if (!current || !ts.isStatement(current)) return null;
  if (
    (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) &&
    current.name
  ) {
    return `${normalized(sourceFile.fileName)}#${current.name.text}`;
  }
  return null;
}

type LocalFunctionImplementation =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

type RenderHost =
  | {
      kind: "jsx";
      node: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
    }
  | {
      kind: "create-element";
      node: ts.CallExpression;
      tag: ts.Expression;
      props: ts.Expression | undefined;
    };

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function importDeclarationFor(node: ts.Node): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isImportDeclaration(current) ? current : null;
}

function importsFromReact(node: ts.Node): boolean {
  const declaration = importDeclarationFor(node);
  return Boolean(
    declaration &&
      ts.isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === "react",
  );
}

function isReactNamespace(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol>,
): boolean {
  const root = unwrapExpression(expression);
  if (!ts.isIdentifier(root)) return false;
  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) return root.text === "React";
  if (visited.has(symbol)) return false;
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) &&
      importsFromReact(declaration)
    ) {
      return true;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isReactNamespace(declaration.initializer, checker, visited)
    ) {
      return true;
    }
  }
  return false;
}

function isReactCreateElementReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>(),
): boolean {
  const root = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(root) &&
    root.name.text === "createElement"
  ) {
    return isReactNamespace(root.expression, checker, visited);
  }
  if (
    ts.isElementAccessExpression(root) &&
    root.argumentExpression &&
    (ts.isStringLiteral(root.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(root.argumentExpression)) &&
    root.argumentExpression.text === "createElement"
  ) {
    return isReactNamespace(root.expression, checker, visited);
  }
  if (!ts.isIdentifier(root)) return false;
  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol || visited.has(symbol)) return false;
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isImportSpecifier(declaration) &&
      (declaration.propertyName ?? declaration.name).text === "createElement" &&
      importsFromReact(declaration)
    ) {
      return true;
    }
    if (ts.isBindingElement(declaration)) {
      const importedName = declaration.propertyName ?? declaration.name;
      const bindingPattern = declaration.parent;
      const variableDeclaration = bindingPattern.parent;
      if (
        ts.isIdentifier(importedName) &&
        importedName.text === "createElement" &&
        ts.isObjectBindingPattern(bindingPattern) &&
        ts.isVariableDeclaration(variableDeclaration) &&
        variableDeclaration.initializer &&
        isReactNamespace(variableDeclaration.initializer, checker, visited)
      ) {
        return true;
      }
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isReactCreateElementReference(declaration.initializer, checker, visited)
    ) {
      return true;
    }
  }
  return false;
}

function renderHostAt(
  node: ts.Node,
  checker: ts.TypeChecker,
): RenderHost | null {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    return { kind: "jsx", node };
  }
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length === 0 ||
    !isReactCreateElementReference(node.expression, checker)
  ) {
    return null;
  }
  const tag = node.arguments[0];
  const props = node.arguments[1];
  return {
    kind: "create-element",
    node,
    tag,
    props:
      props && props.kind !== ts.SyntaxKind.NullKeyword ? props : undefined,
  };
}

function localFunctionImplementations(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  visited = new Set<ts.Symbol>(),
): readonly LocalFunctionImplementation[] {
  const root = unwrapExpression(expression);
  const symbol = ts.isPropertyAccessExpression(root)
    ? checker.getSymbolAtLocation(root.name)
    : ts.isElementAccessExpression(root)
      ? (checker.getSymbolAtLocation(root.argumentExpression) ??
        checker.getSymbolAtLocation(root))
      : ts.isIdentifier(root)
        ? checker.getSymbolAtLocation(root)
        : undefined;
  if (!symbol || visited.has(symbol)) return [];
  visited.add(symbol);
  const implementations: LocalFunctionImplementation[] = [];
  for (const declaration of symbol.declarations ?? []) {
    if (declaration.getSourceFile() !== sourceFile) continue;
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      implementations.push(declaration);
      continue;
    }
    if (ts.isMethodDeclaration(declaration) && declaration.body) {
      implementations.push(declaration);
      continue;
    }
    if (
      ts.isPropertyAssignment(declaration) &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      implementations.push(declaration.initializer);
      continue;
    }
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }
    const initializer = unwrapExpression(declaration.initializer);
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) {
      implementations.push(initializer);
    } else {
      implementations.push(
        ...localFunctionImplementations(
          initializer,
          checker,
          sourceFile,
          visited,
        ),
      );
    }
  }
  return implementations;
}

function returnedExpressions(
  implementation: LocalFunctionImplementation,
): readonly ts.Expression[] {
  if (ts.isArrowFunction(implementation) && !ts.isBlock(implementation.body)) {
    return [implementation.body];
  }
  if (!implementation.body) return [];
  const results: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== implementation.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      results.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(implementation.body);
  return results;
}

function rootFunctionImplementation(node: ts.Node): ts.Node | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return node;
  }
  if (!ts.isVariableDeclaration(node) || !node.initializer) return null;
  const initializer = unwrapExpression(node.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? initializer
    : null;
}

function isDeferredLocalFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ((ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node) ||
        (ts.isPropertyAssignment(node.parent) &&
          unwrapExpression(node.parent.initializer) === node)))
  );
}

function forEachReachableNode(
  root: ts.Node,
  checker: ts.TypeChecker,
  callback: (node: ts.Node) => void,
): void {
  const sourceFile = root.getSourceFile();
  const rootImplementation = rootFunctionImplementation(root);
  const visitedImplementations = new Set<ts.Node>();
  if (rootImplementation) visitedImplementations.add(rootImplementation);

  const visit = (node: ts.Node, active: ts.Node | null): void => {
    if (isDeferredLocalFunction(node) && node !== active) return;
    callback(node);
    if (ts.isCallExpression(node)) {
      for (const implementation of localFunctionImplementations(
        node.expression,
        checker,
        sourceFile,
      )) {
        if (visitedImplementations.has(implementation)) continue;
        visitedImplementations.add(implementation);
        visit(implementation, implementation);
      }
    }
    ts.forEachChild(node, (child) => visit(child, active));
  };

  visit(root, rootImplementation);
}

function staticClassFragments(
  initializer: ts.JsxAttributeValue | ts.Expression | undefined,
  checker: ts.TypeChecker,
): string {
  if (!initializer) return "";
  if (
    ts.isStringLiteral(initializer) ||
    ts.isNoSubstitutionTemplateLiteral(initializer)
  ) {
    return initializer.text;
  }
  const root = ts.isJsxExpression(initializer)
    ? initializer.expression
    : initializer;
  if (!root) return "";
  const fragments: string[] = [];
  const visitedSymbols = new Set<ts.Symbol>();
  const visitedImplementations = new Set<LocalFunctionImplementation>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      fragments.push(node.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) visit(argument);
      for (const implementation of localFunctionImplementations(
        node.expression,
        checker,
        node.getSourceFile(),
      )) {
        if (visitedImplementations.has(implementation)) continue;
        visitedImplementations.add(implementation);
        for (const expression of returnedExpressions(implementation)) {
          visit(expression);
        }
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const target = unalias(checker, symbol);
        if (!visitedSymbols.has(target)) {
          visitedSymbols.add(target);
          for (const declaration of target.declarations ?? []) {
            if (
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer
            ) {
              visit(declaration.initializer);
            } else if (
              ts.isPropertyAssignment(declaration) ||
              ts.isShorthandPropertyAssignment(declaration)
            ) {
              const initializer = ts.isPropertyAssignment(declaration)
                ? declaration.initializer
                : declaration.name;
              if (
                ts.isPropertyAssignment(declaration) &&
                (ts.isStringLiteral(declaration.name) ||
                  ts.isNoSubstitutionTemplateLiteral(declaration.name))
              ) {
                fragments.push(declaration.name.text);
              }
              visit(initializer);
            }
          }
        }
      }
      return;
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return fragments.join(" ");
}

function objectPropertyExpressions(
  expression: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
): readonly (ts.JsxAttributeValue | ts.Expression | undefined)[] {
  const results: (ts.JsxAttributeValue | ts.Expression | undefined)[] = [];
  const visitedSymbols = new Set<ts.Symbol>();
  const visitedImplementations = new Set<LocalFunctionImplementation>();
  const visitObject = (value: ts.Expression): void => {
    const root = unwrapExpression(value);
    if (ts.isIdentifier(root)) {
      const symbol = checker.getSymbolAtLocation(root);
      if (!symbol || visitedSymbols.has(symbol)) return;
      visitedSymbols.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          visitObject(declaration.initializer);
        } else if (
          ts.isShorthandPropertyAssignment(declaration) &&
          declaration.objectAssignmentInitializer
        ) {
          visitObject(declaration.objectAssignmentInitializer);
        }
      }
      return;
    }
    if (ts.isCallExpression(root)) {
      for (const implementation of localFunctionImplementations(
        root.expression,
        checker,
        root.getSourceFile(),
      )) {
        if (visitedImplementations.has(implementation)) continue;
        visitedImplementations.add(implementation);
        for (const returned of returnedExpressions(implementation)) {
          visitObject(returned);
        }
      }
      return;
    }
    if (ts.isConditionalExpression(root) || ts.isBinaryExpression(root)) {
      if (ts.isConditionalExpression(root)) {
        visitObject(root.whenTrue);
        visitObject(root.whenFalse);
      } else {
        visitObject(root.left);
        visitObject(root.right);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(root)) return;
    for (const property of root.properties) {
      if (ts.isSpreadAssignment(property)) {
        visitObject(property.expression);
      } else if (
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        property.name.getText().replace(/^['"]|['"]$/g, "") === name
      ) {
        results.push(
          ts.isPropertyAssignment(property)
            ? property.initializer
            : property.name,
        );
      } else if (
        ts.isMethodDeclaration(property) &&
        property.name.getText().replace(/^['"]|['"]$/g, "") === name
      ) {
        results.push(undefined);
      }
    }
  };
  visitObject(expression);
  return results;
}

function jsxAttributeExpressions(
  attributes: ts.JsxAttributes,
  name: string,
  checker: ts.TypeChecker,
): readonly (ts.JsxAttributeValue | ts.Expression | undefined)[] {
  const results: (ts.JsxAttributeValue | ts.Expression | undefined)[] = [];
  for (const property of attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      results.push(
        ...objectPropertyExpressions(property.expression, name, checker),
      );
    } else if (property.name.getText() === name) {
      results.push(property.initializer);
    }
  }
  return results;
}

function renderHostAttributeExpressions(
  host: RenderHost,
  name: string,
  checker: ts.TypeChecker,
): readonly (ts.JsxAttributeValue | ts.Expression | undefined)[] {
  if (host.kind === "jsx") {
    return jsxAttributeExpressions(host.node.attributes, name, checker);
  }
  return host.props ? objectPropertyExpressions(host.props, name, checker) : [];
}

function expressionText(
  value: ts.JsxAttributeValue | ts.Expression | undefined,
  checker: ts.TypeChecker,
): string {
  if (!value) return "";
  const expression = ts.isJsxExpression(value) ? value.expression : value;
  if (!expression) return "";
  const pieces: string[] = [];
  const visited = new Set<ts.Symbol>();
  const visitedImplementations = new Set<LocalFunctionImplementation>();
  const visit = (node: ts.Node): void => {
    pieces.push(node.getText());
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) visit(argument);
      for (const implementation of localFunctionImplementations(
        node.expression,
        checker,
        node.getSourceFile(),
      )) {
        if (visitedImplementations.has(implementation)) continue;
        visitedImplementations.add(implementation);
        for (const returned of returnedExpressions(implementation)) {
          visit(returned);
        }
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return;
      const target = unalias(checker, symbol);
      if (visited.has(target)) return;
      visited.add(target);
      for (const declaration of target.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          visit(declaration.initializer);
      }
      return;
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return pieces.join(" ");
}

function intrinsicTagName(
  tagName: ts.JsxTagNameExpression,
  checker: ts.TypeChecker,
): string | null {
  const text = tagName.getText();
  if (/^[a-z]/.test(text)) return text;
  if (!ts.isIdentifier(tagName)) return null;
  const symbol = checker.getSymbolAtLocation(tagName);
  if (!symbol) return null;
  for (const declaration of unalias(checker, symbol).declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isStringLiteral(declaration.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer))
    ) {
      return declaration.initializer.text;
    }
  }
  return null;
}

function intrinsicCreateElementTag(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string | null {
  const root = unwrapExpression(expression);
  if (ts.isStringLiteral(root) || ts.isNoSubstitutionTemplateLiteral(root)) {
    return root.text;
  }
  if (!ts.isIdentifier(root)) return null;
  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) return null;
  for (const declaration of unalias(checker, symbol).declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isStringLiteral(declaration.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer))
    ) {
      return declaration.initializer.text;
    }
  }
  return null;
}

function renderHostIntrinsicTag(
  host: RenderHost,
  checker: ts.TypeChecker,
): string | null {
  return host.kind === "jsx"
    ? intrinsicTagName(host.node.tagName, checker)
    : intrinsicCreateElementTag(host.tag, checker);
}

function renderHostTagNode(host: RenderHost): ts.Node {
  return host.kind === "jsx" ? host.node.tagName : host.tag;
}

function renderHostTagText(host: RenderHost): string {
  if (host.kind === "jsx") return host.node.tagName.getText();
  const tag = unwrapExpression(host.tag);
  return ts.isStringLiteral(tag) || ts.isNoSubstitutionTemplateLiteral(tag)
    ? tag.text
    : tag.getText();
}

function isProvablyTrue(
  value: ts.JsxAttributeValue | ts.Expression | undefined,
): boolean {
  if (!value) return true;
  const expression = ts.isJsxExpression(value) ? value.expression : value;
  return expression?.kind === ts.SyntaxKind.TrueKeyword;
}

/** Build the exhaustive maintained component and transitive atom graph. */
export function discoverComponentGraph(input: {
  absoluteFiles: readonly string[];
  atomOwnerByKey: ReadonlyMap<string, string>;
  higherOrderOwnerKeys?: ReadonlySet<string>;
  sourceRoot?: string;
}): ComponentGraph {
  const sourceRoot = input.sourceRoot
    ? path.resolve(input.sourceRoot)
    : path.dirname(path.dirname(path.dirname(input.absoluteFiles[0] ?? ".")));
  const program = ts.createProgram({
    rootNames: [...input.absoluteFiles],
    options: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: sourceRoot,
      paths: {
        "@elizaos/ui": ["packages/ui/src/index.ts"],
        "@elizaos/ui/*": ["packages/ui/src/*"],
      },
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const checker = program.getTypeChecker();
  const components = new Map<string, MutableComponent>();
  const componentKeyByDeclaration = new Map<ts.Declaration, string>();
  const exportedComponentKeys = new Set<string>();

  const exportedLocalNames = new Map<ts.SourceFile, Set<string>>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!input.absoluteFiles.includes(sourceFile.fileName)) continue;
    const names = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        continue;
      for (const element of statement.exportClause.elements) {
        if (/^[A-Z]/.test(element.name.text))
          names.add((element.propertyName ?? element.name).text);
      }
    }
    exportedLocalNames.set(sourceFile, names);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!input.absoluteFiles.includes(sourceFile.fileName)) continue;
    for (const statement of sourceFile.statements) {
      for (const declaration of componentDeclarations(
        statement,
        exportedLocalNames.get(sourceFile),
      )) {
        let containsReactRender = false;
        forEachReachableNode(declaration.node, checker, (node) => {
          if (
            ts.isJsxElement(node) ||
            ts.isJsxSelfClosingElement(node) ||
            renderHostAt(node, checker)?.kind === "create-element"
          ) {
            containsReactRender = true;
          }
        });
        if (!containsReactRender) continue;
        const id = `${normalized(sourceFile.fileName)}#${declaration.name}`;
        const exportOwnerKey = declarationKey(
          declaration.exportOwnerDeclaration,
        );
        if (!exportOwnerKey) continue;
        components.set(id, {
          id,
          file: normalized(sourceFile.fileName),
          symbol: declaration.name,
          exported: hasExport(statement),
          node: declaration.node,
          directAtoms: new Set(),
          dependencies: new Set(),
          consumerDomains: new Set(),
          consumers: new Set(),
          rawCapabilities: [],
          exportOwnerKey,
        });
        componentKeyByDeclaration.set(declaration.ownerDeclaration, id);
      }
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!input.absoluteFiles.includes(sourceFile.fileName)) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
      const target = unalias(checker, exportedSymbol);
      for (const declaration of target.declarations ?? []) {
        const key = declarationKey(declaration);
        if (key) exportedComponentKeys.add(key);
      }
    }
  }
  for (const component of components.values()) {
    component.exported =
      component.exported ||
      exportedComponentKeys.has(component.id) ||
      exportedComponentKeys.has(component.exportOwnerKey);
  }

  const keyForSymbol = (symbol: ts.Symbol): string | null => {
    for (const declaration of unalias(checker, symbol).declarations ?? []) {
      const componentKey = componentKeyByDeclaration.get(declaration);
      if (componentKey) return componentKey;
      const key = declarationKey(declaration);
      if (key) return key;
    }
    return null;
  };

  for (const component of components.values()) {
    const isAtomHost = (host: RenderHost): boolean => {
      const symbol = checker.getSymbolAtLocation(renderHostTagNode(host));
      if (!symbol) return false;
      const key = keyForSymbol(symbol);
      return key ? input.atomOwnerByKey.has(key) : false;
    };

    const isDirectSlottedByAtom = (host: RenderHost): boolean => {
      let wrapperHost: RenderHost | null = null;
      if (host.kind === "jsx") {
        const node = host.node;
        if (!ts.isJsxOpeningElement(node) || !ts.isJsxElement(node.parent)) {
          return false;
        }
        const wrapper = node.parent.parent;
        if (!ts.isJsxElement(wrapper)) return false;
        wrapperHost = { kind: "jsx", node: wrapper.openingElement };
      } else {
        const wrapper = host.node.parent;
        if (
          !ts.isCallExpression(wrapper) ||
          wrapper.arguments.indexOf(host.node) < 2
        ) {
          return false;
        }
        wrapperHost = renderHostAt(wrapper, checker);
      }
      if (!wrapperHost || !isAtomHost(wrapperHost)) return false;
      return renderHostAttributeExpressions(
        wrapperHost,
        "asChild",
        checker,
      ).some(isProvablyTrue);
    };

    const visit = (node: ts.Node): void => {
      const host = renderHostAt(node, checker);
      if (!host) return;
      const tagText = renderHostTagText(host);
      const intrinsicTag = renderHostIntrinsicTag(host, checker);
      const capabilities = new Set<DesignCapability>();
      const className = renderHostAttributeExpressions(
        host,
        "className",
        checker,
      )
        .map((value) => staticClassFragments(value, checker))
        .join(" ");
      if (/(?:^|\s)(?:[a-z-]+:)*bg-/.test(className))
        capabilities.add("paint.surface");
      if (/(?:^|\s)(?:[a-z-]+:)*border(?:-|\s|$)/.test(className))
        capabilities.add("paint.border");
      if (/(?:^|\s)(?:[a-z-]+:)*rounded(?:-|\s|$)/.test(className))
        capabilities.add("paint.radius");
      if (/(?:^|\s)(?:[a-z-]+:)*shadow(?:-|\s|$)/.test(className))
        capabilities.add("paint.elevation");
      const styleText = renderHostAttributeExpressions(host, "style", checker)
        .map((value) => expressionText(value, checker))
        .join(" ");
      if (/\b(?:background|backgroundColor)\s*:/.test(styleText))
        capabilities.add("paint.surface");
      if (/\bborder(?:Color|Style|Width)?\s*:/.test(styleText))
        capabilities.add("paint.border");
      if (/\bborderRadius\s*:/.test(styleText))
        capabilities.add("paint.radius");
      if (/\bboxShadow\s*:/.test(styleText))
        capabilities.add("paint.elevation");
      if (intrinsicTag && !isDirectSlottedByAtom(host)) {
        const hasAttribute = (name: string): boolean =>
          renderHostAttributeExpressions(host, name, checker).length > 0;
        const hasEnabledBooleanAttribute = (name: string): boolean =>
          renderHostAttributeExpressions(host, name, checker).some(
            (value) =>
              !value || !/\bfalse\b/.test(expressionText(value, checker)),
          );
        const semanticActivation =
          ["button", "input", "select", "textarea", "summary"].includes(
            intrinsicTag,
          ) ||
          (intrinsicTag === "a" && hasAttribute("href")) ||
          (intrinsicTag === "form" && hasAttribute("onSubmit")) ||
          hasEnabledBooleanAttribute("contentEditable") ||
          hasEnabledBooleanAttribute("draggable") ||
          renderHostAttributeExpressions(host, "role", checker).some((value) =>
            /(?:button|link)/.test(expressionText(value, checker)),
          );
        if (semanticActivation) {
          capabilities.add("interaction.activate");
        } else if (
          /^(?:onClick|onKeyDown|onKeyUp|onPointerDown|onPointerUp|onMouseDown|onTouchStart|tabIndex)$/.test(
            [
              "onClick",
              "onKeyDown",
              "onKeyUp",
              "onPointerDown",
              "onPointerUp",
              "onMouseDown",
              "onTouchStart",
              "tabIndex",
            ].find(hasAttribute) ?? "",
          )
        ) {
          capabilities.add("interaction.activate");
        }
      }
      if (capabilities.size > 0) {
        component.rawCapabilities.push({
          file: normalized(host.node.getSourceFile().fileName),
          line:
            host.node
              .getSourceFile()
              .getLineAndCharacterOfPosition(host.node.getStart()).line + 1,
          host: tagText,
          capabilities: [...capabilities].sort(),
        });
      }
      const symbol = checker.getSymbolAtLocation(renderHostTagNode(host));
      if (!symbol) return;
      const key = keyForSymbol(symbol);
      if (!key) return;
      const atom = input.atomOwnerByKey.get(key);
      if (atom) component.directAtoms.add(atom);
      if (components.has(key) && key !== component.id) {
        component.dependencies.add(key);
        components.get(key)?.consumerDomains.add(domainForFile(component.file));
        components.get(key)?.consumers.add(component.id);
      }
    };
    forEachReachableNode(component.node, checker, visit);
  }

  const closure = new Map<string, Set<string>>();
  const transitiveAtoms = (
    id: string,
    visiting = new Set<string>(),
  ): Set<string> => {
    const cached = closure.get(id);
    if (cached) return cached;
    const component = components.get(id);
    if (!component || visiting.has(id)) return new Set();
    const nextVisiting = new Set(visiting).add(id);
    const result = new Set(component.directAtoms);
    for (const dependency of component.dependencies) {
      for (const atom of transitiveAtoms(dependency, nextVisiting))
        result.add(atom);
    }
    closure.set(id, result);
    return result;
  };

  return {
    components: [...components.values()]
      .map((component): DiscoveredComponent => {
        const displayFile = input.sourceRoot
          ? normalized(path.relative(input.sourceRoot, component.file))
          : component.file;
        const displayComponentId = (id: string): string => {
          const dependency = components.get(id);
          if (!dependency || !input.sourceRoot) return id;
          return `${normalized(path.relative(input.sourceRoot, dependency.file))}#${dependency.symbol}`;
        };
        const canonicalDirectory = component.file.includes(
          "/packages/ui/src/components/composites/",
        );
        const crossDomain = component.consumerDomains.size >= 2;
        const multiConsumer = component.consumers.size >= 2;
        const isolatedFixture =
          component.file.includes("/__e2e__/") ||
          component.file.endsWith(
            "/packages/ui/src/layouts/page-frame/page-frame.tsx",
          );
        const atomOwner = input.atomOwnerByKey.has(component.id);
        const declaredHigherOrderOwner = input.higherOrderOwnerKeys?.has(
          `${displayFile}:${component.symbol}`,
        );
        const canonicalMolecule = canonicalDirectory && !isolatedFixture;
        const inferredLayer = atomOwner
          ? "atom"
          : declaredHigherOrderOwner
            ? "organism"
            : canonicalMolecule ||
                ((crossDomain || multiConsumer) && !isolatedFixture)
              ? "molecule"
              : "organism";
        return {
          id: `${displayFile}#${component.symbol}`,
          file: displayFile,
          symbol: component.symbol,
          exported: component.exported,
          directAtoms: [...component.directAtoms].sort(),
          transitiveAtoms: [...transitiveAtoms(component.id)].sort(),
          dependencies: [...component.dependencies]
            .map(displayComponentId)
            .sort(),
          consumerDomains: [...component.consumerDomains].sort(),
          consumers: [...component.consumers].map(displayComponentId).sort(),
          inferredLayer,
          discoveryReason: atomOwner
            ? "canonical-atom-owner"
            : declaredHigherOrderOwner
              ? "declared-higher-order-owner"
              : canonicalMolecule
                ? "canonical-molecule-directory"
                : crossDomain && !isolatedFixture
                  ? "cross-domain-reuse"
                  : multiConsumer && !isolatedFixture
                    ? "multi-consumer-reuse"
                    : "domain-private-composition",
          rawCapabilities: component.rawCapabilities.map((occurrence) => ({
            ...occurrence,
            file: input.sourceRoot
              ? normalized(path.relative(input.sourceRoot, occurrence.file))
              : occurrence.file,
          })),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
