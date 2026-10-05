/**
 * Interprets Handlebars' parsed templates without generating JavaScript.
 * The parser and registered helpers retain the template language; rendering keeps
 * full values opaque and shares the same implementation across host environments.
 */
import Handlebars from "handlebars";

type Renderer = Handlebars.TemplateDelegate<unknown>;
type Options = Handlebars.RuntimeOptions;
type Program = hbs.AST.Program;
type Invocation =
  | hbs.AST.MustacheStatement
  | hbs.AST.BlockStatement
  | hbs.AST.SubExpression;
interface Nodes {
  PathExpression: hbs.AST.PathExpression;
  SubExpression: hbs.AST.SubExpression;
  StringLiteral: hbs.AST.StringLiteral;
  NumberLiteral: hbs.AST.NumberLiteral;
  BooleanLiteral: hbs.AST.BooleanLiteral;
  NullLiteral: hbs.AST.NullLiteral;
  UndefinedLiteral: hbs.AST.UndefinedLiteral;
  MustacheStatement: hbs.AST.MustacheStatement;
  BlockStatement: hbs.AST.BlockStatement;
  ContentStatement: hbs.AST.ContentStatement;
  CommentStatement: hbs.AST.CommentStatement;
  PartialStatement: hbs.AST.PartialStatement;
  PartialBlockStatement: hbs.AST.PartialBlockStatement;
  Decorator: Omit<hbs.AST.MustacheStatement, "type"> & { type: "Decorator" };
  DecoratorBlock: Omit<hbs.AST.BlockStatement, "type"> & {
    type: "DecoratorBlock";
  };
}
interface Frame {
  context: unknown;
  parent: Frame | null;
  data: Record<string, unknown>;
  bindings: Record<string, unknown>[];
  partials: Record<string, unknown>;
  helpers: Record<string, unknown>;
  decorators: Record<string, unknown>;
  options: Options;
}

// Handlebars' declarations do not discriminate their base Node interfaces.
// All nodes here originate in its parser, never in caller-supplied AST objects.
function isNode<K extends keyof Nodes>(
  node: hbs.AST.Node,
  kind: K,
): node is Nodes[K] {
  return node.type === kind;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function own(value: unknown, key: string): unknown {
  return value != null && Object.hasOwn(Object(value), key)
    ? Reflect.get(Object(value), key)
    : undefined;
}
function lookup(value: unknown, key: string, options: Options): unknown {
  if (value == null) return undefined;
  const result: unknown = Reflect.get(Object(value), key);
  if (Object.hasOwn(Object(value), key)) return result;
  const method = typeof result === "function";
  const allow = method
    ? options.allowedProtoMethods
    : options.allowedProtoProperties;
  const explicit = own(allow, key);
  if (typeof explicit === "boolean") return explicit ? result : undefined;
  const denied = method
    ? [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
      ].includes(key)
    : key === "__proto__";
  return !denied &&
    (method
      ? options.allowProtoMethodsByDefault
      : options.allowProtoPropertiesByDefault)
    ? result
    : undefined;
}
function readPath(node: hbs.AST.PathExpression, frame: Frame): unknown {
  let cursor: Frame | null = frame;
  for (let n = 0; n < node.depth; n++) cursor = cursor?.parent ?? null;
  if (!cursor) return undefined;
  let value: unknown;
  if (node.data) {
    value = frame.data;
    for (let n = 0; n < node.depth; n++) value = own(value, "_parent");
  } else {
    const [first, ...rest] = node.parts;
    if (
      !node.depth &&
      !/^(this[./]|\.[/]|this$|\.$)/.test(node.original) &&
      first
    ) {
      for (const bindings of frame.bindings) {
        if (!Object.hasOwn(bindings, first)) continue;
        value = bindings[first];
        for (const key of rest) value = lookup(value, key, frame.options);
        return value;
      }
    }
    value = cursor.context;
  }
  for (const key of node.parts) value = lookup(value, key, frame.options);
  return value;
}
function expression(node: hbs.AST.Expression, frame: Frame): unknown {
  if (isNode(node, "PathExpression")) return readPath(node, frame);
  if (isNode(node, "SubExpression")) return invoke(node, frame);
  if (
    isNode(node, "StringLiteral") ||
    isNode(node, "NumberLiteral") ||
    isNode(node, "BooleanLiteral")
  )
    return node.value;
  if (isNode(node, "NullLiteral")) return null;
  if (isNode(node, "UndefinedLiteral")) return undefined;
  throw new Error(`Unsupported template expression: ${node.type}`);
}
function hash(
  node: { hash?: hbs.AST.Hash },
  frame: Frame,
): Record<string, unknown> {
  return Object.fromEntries(
    (node.hash?.pairs ?? []).map((pair) => [
      pair.key,
      expression(pair.value, frame),
    ]),
  );
}
function program(
  ast: Program | undefined,
  frame: Frame,
  context: unknown,
  options: Options = {},
): string {
  if (!ast) return "";
  const bindings = Object.fromEntries(
    (ast.blockParams ?? []).map((name, index) => [
      name,
      options.blockParams?.[index],
    ]),
  );
  const child: Frame = {
    ...frame,
    context,
    parent: context === frame.context ? frame.parent : frame,
    data: record(options.data) ? options.data : frame.data,
    bindings: ast.blockParams?.length
      ? [bindings, ...frame.bindings]
      : frame.bindings,
    partials: options.partials ?? frame.partials,
  };
  const container = { partials: child.partials };
  let render: Renderer = (current, runtimeOptions = {}) =>
    ast.body
      .map((node) =>
        statement(node, {
          ...child,
          context: current,
          data: record(runtimeOptions.data) ? runtimeOptions.data : child.data,
          partials: container.partials,
        }),
      )
      .join("");
  const props = {};
  for (const node of ast.body) {
    if (!isNode(node, "Decorator") && !isNode(node, "DecoratorBlock")) continue;
    if (!isNode(node.path, "PathExpression"))
      throw new Error("Invalid template decorator name");
    const name = node.path.original;
    const decorator = own(child.decorators, name);
    if (typeof decorator !== "function")
      throw new Error(`Unknown template decorator: ${name}`);
    const options = {
      name,
      args: node.params.map((param) => expression(param, child)),
      hash: hash(node, child),
      data: child.data,
      fn: (current: unknown, runtimeOptions?: Options) =>
        program(
          isNode(node, "DecoratorBlock") ? node.program : undefined,
          child,
          current,
          runtimeOptions,
        ),
    };
    const result: unknown = decorator(render, props, container, options);
    if (typeof result === "function")
      render = (current, runtimeOptions) => result(current, runtimeOptions);
  }
  Object.assign(render, props);
  return render(context, options);
}
function invoke(node: Invocation, frame: Frame): unknown {
  const name = isNode(node.path, "PathExpression")
    ? node.path.original
    : String(expression(node.path, frame));
  const simple =
    !isNode(node.path, "PathExpression") ||
    (!node.path.depth &&
      !node.path.data &&
      node.path.parts.length === 1 &&
      !/^(this[./]|\.[/])/.test(node.path.original) &&
      !frame.bindings.some((bindings) => Object.hasOwn(bindings, name)));
  const internal = name === "helperMissing" || name === "blockHelperMissing";
  if (simple && internal && !frame.options.allowCallsToHelperMissing) {
    throw new TypeError(`Direct calls to ${name} are disabled`);
  }
  const helper = simple ? own(frame.helpers, name) : undefined;
  const params = node.params.map((param) => expression(param, frame));
  const fn = Object.assign(
    (context: unknown, options?: Options) =>
      program(
        isNode(node, "BlockStatement") ? node.program : undefined,
        frame,
        context,
        options,
      ),
    {
      blockParams: isNode(node, "BlockStatement")
        ? (node.program?.blockParams?.length ?? 0)
        : 0,
    },
  );
  const inverse = Object.assign(
    (context: unknown, options?: Options) =>
      program(
        isNode(node, "BlockStatement") ? node.inverse : undefined,
        frame,
        context,
        options,
      ),
    {
      blockParams: isNode(node, "BlockStatement")
        ? (node.inverse?.blockParams?.length ?? 0)
        : 0,
    },
  );
  const options = {
    name,
    hash: hash(node, frame),
    fn,
    inverse,
    data: frame.data,
    lookupProperty: (value: unknown, key: string) =>
      lookup(value, key, frame.options),
    loc: node.loc,
  };
  const receiver = frame.context == null ? Object.seal({}) : frame.context;
  if (typeof helper === "function")
    return Reflect.apply(helper, receiver, [...params, options]);
  let value = isNode(node.path, "PathExpression")
    ? readPath(node.path, frame)
    : lookup(frame.context, name, frame.options);
  const explicit =
    params.length > 0 ||
    Boolean(node.hash?.pairs.length) ||
    isNode(node, "SubExpression");
  const missing = own(frame.helpers, "helperMissing");
  if (explicit) {
    const target = value || missing;
    if (typeof target !== "function")
      throw new TypeError(`Template helper ${name} is not callable`);
    return Reflect.apply(target, receiver, [...params, options]);
  }
  if (value == null && simple && typeof missing === "function")
    value = Reflect.apply(missing, receiver, [options]);
  else if (typeof value === "function")
    value = Reflect.apply(value, receiver, simple ? [options] : []);
  if (isNode(node, "BlockStatement")) {
    const block = own(frame.helpers, "blockHelperMissing");
    if (typeof block !== "function")
      throw new TypeError("Block fallback is not callable");
    return Reflect.apply(block, receiver, [value, options]);
  }
  return value;
}
function statement(node: hbs.AST.Statement, frame: Frame): string {
  if (isNode(node, "ContentStatement")) return node.value;
  if (
    isNode(node, "CommentStatement") ||
    isNode(node, "Decorator") ||
    isNode(node, "DecoratorBlock")
  )
    return "";
  if (isNode(node, "MustacheStatement")) {
    const value = invoke(node, frame);
    return node.escaped
      ? Reflect.apply(Handlebars.escapeExpression, Handlebars, [value])
      : value == null
        ? ""
        : String(value);
  }
  if (isNode(node, "BlockStatement")) return String(invoke(node, frame) ?? "");
  if (
    isNode(node, "PartialStatement") ||
    isNode(node, "PartialBlockStatement")
  ) {
    const name = isNode(node.name, "SubExpression")
      ? String(expression(node.name, frame))
      : node.name.original;
    const body = isNode(node, "PartialBlockStatement")
      ? node.program
      : undefined;
    let partial = own(frame.partials, name);
    if (partial === undefined && body)
      partial = (context: unknown, options?: Options) =>
        program(body, frame, context, options);
    if (partial === undefined)
      throw new Error(`The partial ${name} could not be found`);
    let context = node.params.length
      ? expression(node.params[0], frame)
      : frame.context;
    if (node.hash?.pairs.length)
      context = Object.assign({}, context, hash(node, frame));
    const partials = { ...frame.partials };
    if (body)
      partials["@partial-block"] = (current: unknown, options?: Options) =>
        program(body, frame, current, options);
    const next = { ...frame, partials };
    let output: unknown;
    if (typeof partial === "function")
      output = partial(context, {
        data: frame.data,
        partials,
        helpers: frame.helpers,
      });
    else if (typeof partial === "string")
      output = program(
        Handlebars.parse(partial),
        { ...next, context, parent: null, bindings: [] },
        context,
      );
    else throw new Error(`Invalid template partial: ${name}`);
    if (typeof output !== "string")
      throw new Error(`Template partial ${name} did not return text`);
    if (isNode(node, "PartialStatement") && node.indent)
      return output
        .split("\n")
        .map((line, index, lines) =>
          index === lines.length - 1 && !line ? "" : node.indent + line,
        )
        .join("\n");
    return output;
  }
  throw new Error(`Unsupported template statement: ${node.type}`);
}

/** Parses only template source; context values are never parsed or compiled as templates. */
export function compileTemplate(source: string): Renderer {
  if (typeof source !== "string")
    throw new TypeError("Template source must be a string");
  const ast = Handlebars.parse(source);
  return (context, options = {}) =>
    program(
      ast,
      {
        context,
        parent: null,
        data:
          record(options.data) && "root" in options.data
            ? options.data
            : { ...options.data, root: context },
        bindings: [],
        options,
        partials: { ...Handlebars.partials, ...options.partials },
        helpers: { ...Handlebars.helpers, ...options.helpers },
        decorators: { ...Handlebars.decorators, ...options.decorators },
      },
      context,
    );
}
