/**
 * Strict deletion-rule document parsing at the local file boundary. JSON and
 * YAML feed the same validated rule schema; YAML conveniences that can hide or
 * expand data are rejected so owner review always covers one explicit tree.
 */
import path from "node:path";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import { type DeletionRules, parseDeletionRules } from "./delete.ts";

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error("invalid deletion rules JSON", { cause: error });
  }
}

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const diagnostics = [...document.errors, ...document.warnings]
      .map((diagnostic) => diagnostic.message)
      .join("; ");
    throw new Error(`invalid deletion rules YAML: ${diagnostics}`);
  }
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) throw new Error("YAML aliases are not allowed");
      if ("anchor" in node && node.anchor) {
        throw new Error("YAML anchors are not allowed");
      }
      if (
        "tag" in node &&
        node.tag &&
        !node.tag.startsWith("tag:yaml.org,2002:")
      ) {
        throw new Error("custom YAML tags are not allowed");
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new Error("YAML merge keys are not allowed");
      }
    },
  });
  return document.toJS({ maxAliasCount: 0 });
}

export function parseDeletionRulesDocument(
  source: string,
  filename: string,
): DeletionRules {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".json") return parseDeletionRules(parseJson(source));
  if (extension === ".yaml" || extension === ".yml") {
    return parseDeletionRules(parseYaml(source));
  }
  throw new Error("deletion rules must use .json, .yaml, or .yml");
}
