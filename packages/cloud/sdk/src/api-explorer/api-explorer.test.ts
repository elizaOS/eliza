/**
 * Contract tests for the API Explorer's generated OpenAPI export and catalog
 * helpers. The suite exercises the real `API_ENDPOINTS` catalog through the
 * public generator functions — no mocks — pinning the exported wire document
 * downloaded via `ApiExplorerPage`'s JSON/YAML export buttons. Catalog-wide
 * rules walk the whole generated document rather than naming individual
 * entries; the few targeted fixtures (search terms, one operation per shape)
 * are chosen so each asserted behavior is exercised on a known catalog entry.
 * `getAvailableCategories` is covered because
 * `ApiExplorerPage` renders it directly; `searchEndpoints` has no shipping
 * consumer and is only covered at the behavioral-property level; the other
 * exported catalog helpers are intentionally untested here.
 * Harness: deterministic, pure functions only.
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  API_ENDPOINTS,
  formatEndpointPrice,
  getAvailableCategories,
  searchEndpoints,
} from "./endpoint-discovery.js";
import {
  generateOpenAPIJSON,
  generateOpenAPISpec,
  generateOpenAPIYAML,
  type OpenAPISchema,
  type OpenAPISpec,
} from "./openapi-generator.js";

/** Every schema object reachable from an operation, with its location for failure messages. */
function collectSchemas(
  spec: OpenAPISpec,
): Array<{ schema: OpenAPISchema; where: string }> {
  const found: Array<{ schema: OpenAPISchema; where: string }> = [];
  const walkSchema = (
    schema: OpenAPISchema | undefined,
    where: string,
  ): void => {
    if (!schema || typeof schema !== "object") return;
    found.push({ schema, where });
    walkSchema(schema.items, `${where}.items`);
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      walkSchema(property, `${where}.properties.${name}`);
    }
  };
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      for (const parameter of operation.parameters ?? []) {
        walkSchema(
          parameter.schema,
          `${method} ${path} parameter ${parameter.name}`,
        );
      }
      const bodySchema =
        operation.requestBody?.content["application/json"]?.schema;
      if (bodySchema) {
        walkSchema(bodySchema, `${method} ${path} requestBody`);
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        walkSchema(
          response.content?.["application/json"]?.schema,
          `${method} ${path} ${status} response`,
        );
      }
    }
  }
  return found;
}

describe("generateOpenAPISpec — every cataloged endpoint maps to an operation", () => {
  const spec = generateOpenAPISpec();

  it("emits one operation per catalog entry keyed by path + lowercase method", () => {
    for (const endpoint of API_ENDPOINTS) {
      const operation =
        spec.paths[endpoint.path]?.[endpoint.method.toLowerCase()];
      expect(
        operation,
        `missing operation for ${endpoint.method} ${endpoint.path}`,
      ).toBeDefined();
      expect(operation.operationId).toBe(endpoint.id);
      expect(operation.summary).toBe(endpoint.name);
      expect(operation.description).toBe(endpoint.description);
      // Tags drive OpenAPI grouping and the Explorer's category presentation.
      expect(operation.tags).toEqual([endpoint.category]);
    }
  });

  it("keeps two operations distinct when they share a path with different methods", () => {
    // `user-get` (GET /api/v1/user) and `user-update` (PATCH /api/v1/user) must
    // both survive under the same path object.
    const pathItem = spec.paths["/api/v1/user"];
    expect(pathItem.get.operationId).toBe("user-get");
    expect(pathItem.patch.operationId).toBe("user-update");
  });

  it("declares bearer + apiKey security exactly for requiresAuth endpoints", () => {
    for (const endpoint of API_ENDPOINTS) {
      const operation =
        spec.paths[endpoint.path][endpoint.method.toLowerCase()];
      if (endpoint.requiresAuth) {
        expect(operation.security, endpoint.id).toEqual([
          { bearerAuth: [] },
          { apiKeyAuth: [] },
        ]);
      } else {
        expect(operation.security, endpoint.id).toBeUndefined();
      }
    }
  });

  it("maps every declared response status code with its description", () => {
    for (const endpoint of API_ENDPOINTS) {
      const operation =
        spec.paths[endpoint.path][endpoint.method.toLowerCase()];
      expect(Object.keys(operation.responses).sort(), endpoint.id).toEqual(
        endpoint.responses.map((r) => String(r.statusCode)).sort(),
      );
      for (const response of endpoint.responses) {
        expect(
          operation.responses[String(response.statusCode)].description,
        ).toBe(response.description);
      }
    }
  });

  it("carries response examples through to the generated response content", () => {
    // Derived from the catalog rather than re-typed: every response that
    // declares an example must surface it in the operation's JSON content.
    const withExamples = API_ENDPOINTS.flatMap((endpoint) =>
      endpoint.responses
        .filter((r) => r.example !== undefined)
        .map((r) => ({ endpoint, response: r })),
    );
    expect(withExamples.length).toBeGreaterThan(0);
    for (const { endpoint, response } of withExamples) {
      const operation =
        spec.paths[endpoint.path][endpoint.method.toLowerCase()];
      expect(
        operation.responses[String(response.statusCode)].content?.[
          "application/json"
        ]?.example,
        endpoint.id,
      ).toEqual(response.example);
    }
  });
});

describe("generateOpenAPISpec — parameter and request-body mapping", () => {
  const spec = generateOpenAPISpec();

  it("emits path/query parameters as OpenAPI parameters with location and schema", () => {
    const gallery = spec.paths["/api/v1/gallery"]?.get;
    const typeParam = gallery.parameters?.find((p) => p.name === "type");
    expect(typeParam).toMatchObject({
      name: "type",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["image", "video"] },
    });
    const limitParam = gallery.parameters?.find((p) => p.name === "limit");
    expect(limitParam?.schema).toMatchObject({ type: "number", default: 100 });
  });

  it("marks path parameters required and places them in path", () => {
    const deleteKey = spec.paths["/api/v1/api-keys/{id}"]?.delete;
    expect(deleteKey.parameters).toEqual([
      expect.objectContaining({
        name: "id",
        in: "path",
        required: true,
        description: "API key ID",
      }),
    ]);
  });

  it("builds a JSON request body carrying every catalog body parameter, optional included", () => {
    // Two contracts in one walk: the `required` list mirrors required-only
    // derivation, and the `properties` map contains EVERY body parameter —
    // generated clients read `properties` to know which fields they may send,
    // so a generator that silently drops optional fields (e.g. only assigning
    // inside `if (param.required)`) corrupts every client while JSON/YAML
    // round-trips and required-list checks stay green.
    let sawOptionalBodyParam = false;
    for (const endpoint of API_ENDPOINTS) {
      const body = endpoint.parameters?.body;
      const operation =
        spec.paths[endpoint.path][endpoint.method.toLowerCase()];
      if (!body) {
        expect(operation.requestBody, endpoint.id).toBeUndefined();
        continue;
      }
      const expectedRequired = body
        .filter((p) => p.required)
        .map((p) => p.name);
      const schema = operation.requestBody?.content["application/json"]?.schema;
      expect(schema?.type, endpoint.id).toBe("object");
      expect(schema?.required ?? [], endpoint.id).toEqual(expectedRequired);
      // The body-level required flag must mirror the same derivation.
      expect(operation.requestBody?.required, endpoint.id).toBe(
        expectedRequired.length > 0,
      );
      // The properties key-set must equal the full parameter name set.
      expect(
        Object.keys(schema?.properties ?? {}).sort(),
        `${endpoint.id}: request-body properties must carry every body parameter`,
      ).toEqual(body.map((p) => p.name).sort());
      sawOptionalBodyParam ||= body.some((p) => !p.required);
    }
    // The catalog must actually exercise the optional-body-parameter rule for
    // the key-set assertion to guard the reviewer's mutation class.
    expect(sawOptionalBodyParam).toBe(true);
  });

  it("keeps concrete optional body fields usable by generated clients", () => {
    // Named instances of the class above: fields a generated client can send
    // today and would lose if optional properties were dropped.
    const userUpdate =
      spec.paths["/api/v1/user"]?.patch.requestBody?.content["application/json"]
        ?.schema;
    expect(userUpdate?.properties).toMatchObject({
      name: { type: "string" },
      avatar: { type: "string" },
    });

    const createKey =
      spec.paths["/api/v1/api-keys"]?.post.requestBody?.content[
        "application/json"
      ]?.schema;
    expect(createKey?.properties).toMatchObject({
      description: { type: "string" },
      permissions: { type: "array" },
      rate_limit: { type: "number" },
    });
  });

  it("propagates numeric bounds onto the generated schema", () => {
    const listVoices = spec.paths["/api/elevenlabs/voices/user"]?.get;
    const limit = listVoices.parameters?.find((p) => p.name === "limit");
    expect(limit?.schema).toMatchObject({ minimum: 1, maximum: 100 });
  });
});

describe("generateOpenAPISpec — OpenAPI 3.0.3 document conformance", () => {
  // These rules are properties of the exported wire document itself: a
  // dropped or mis-mapped field class (missing array `items`, an empty
  // content block, an unstated request-body requirement) silently corrupts
  // every client generated from the spec, so each rule walks the WHOLE
  // document instead of pinning individual catalog entries.

  it("array schemas always declare their item schema", () => {
    const schemas = collectSchemas(generateOpenAPISpec());
    const arrays = schemas.filter((s) => s.schema.type === "array");
    // The catalog must actually exercise this rule for the check to matter.
    expect(arrays.length).toBeGreaterThan(0);
    for (const { schema, where } of arrays) {
      expect(schema.items, `${where}: array without items`).toBeDefined();
    }
  });

  it("every declared media content carries a schema or an example", () => {
    const spec = generateOpenAPISpec();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const bodyContent = operation.requestBody?.content["application/json"];
        if (bodyContent) {
          expect(
            bodyContent.schema,
            `${method} ${path}: requestBody content has no schema`,
          ).toBeDefined();
        }
        for (const [status, response] of Object.entries(operation.responses)) {
          const content = response.content?.["application/json"];
          if (content) {
            expect(
              content.schema ?? content.example,
              `${method} ${path} ${status}: response content is empty`,
            ).toBeDefined();
          }
        }
      }
    }
  });

  it("response content is present exactly when the catalog declares a schema or example", () => {
    const spec = generateOpenAPISpec();
    for (const endpoint of API_ENDPOINTS) {
      const operation =
        spec.paths[endpoint.path][endpoint.method.toLowerCase()];
      for (const response of endpoint.responses) {
        const content =
          operation.responses[String(response.statusCode)]?.content;
        if (response.schema !== undefined || response.example !== undefined) {
          expect(content, endpoint.id).toBeDefined();
        } else {
          expect(
            content,
            `${endpoint.id} ${response.statusCode}`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("required lists only name properties that exist on their object schema", () => {
    const schemas = collectSchemas(generateOpenAPISpec());
    const objects = schemas.filter((s) => s.schema.required !== undefined);
    expect(objects.length).toBeGreaterThan(0);
    for (const { schema, where } of objects) {
      expect(Array.isArray(schema.required), where).toBe(true);
      for (const name of schema.required ?? []) {
        expect(
          schema.properties?.[name],
          `${where}: required property ${name} is not declared`,
        ).toBeDefined();
      }
    }
  });

  it("operation ids are unique across the whole document", () => {
    const spec = generateOpenAPISpec();
    const ids: string[] = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        expect(operation.operationId, `${method} ${path}`).toBeTruthy();
        ids.push(operation.operationId);
      }
    }
    expect(new Set(ids).size, "duplicate operationId in document").toBe(
      ids.length,
    );
  });

  it("every path template variable is declared as a required path parameter", () => {
    const spec = generateOpenAPISpec();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      const templateVars = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [method, operation] of Object.entries(pathItem)) {
        for (const variable of templateVars) {
          const parameter = operation.parameters?.find(
            (p) => p.name === variable,
          );
          expect(
            parameter,
            `${method} ${path}: template {${variable}} has no parameter`,
          ).toMatchObject({ in: "path", required: true });
        }
      }
    }
  });

  it("every operation declares at least one response with a description", () => {
    const spec = generateOpenAPISpec();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const statuses = Object.keys(operation.responses);
        expect(statuses.length, `${method} ${path}`).toBeGreaterThan(0);
        for (const status of statuses) {
          expect(
            operation.responses[status].description,
            `${method} ${path} ${status}`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe("generateOpenAPISpec — document-level contract", () => {
  it("pins the OpenAPI version, full info block, and security schemes", () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info).toEqual({
      title: "Eliza Cloud API",
      description:
        "AI agent development platform with multi-model text generation, image creation, and enterprise features",
      version: "1.0.0",
      contact: {
        name: "Eliza Cloud",
        url: "https://api.eliza.app",
      },
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(spec.components.securitySchemes.apiKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "Authorization",
    });
  });

  it("uses the provided baseUrl as the single server and falls back to the default", () => {
    expect(
      generateOpenAPISpec("https://staging.example.test").servers[0].url,
    ).toBe("https://staging.example.test");
    expect(generateOpenAPISpec().servers[0].url).toBe("https://api.eliza.app");
    expect(generateOpenAPISpec().servers).toHaveLength(1);
  });

  it("derives the tags list from the catalog's categories without duplicates", () => {
    const spec = generateOpenAPISpec();
    const tagNames = spec.tags.map((t) => t.name);
    // Tags follow catalog first-appearance order (Set insertion order), while
    // getAvailableCategories sorts — both must describe the same category set.
    expect([...new Set(tagNames)].sort()).toEqual(getAvailableCategories());
    expect(new Set(tagNames).size).toBe(tagNames.length);
    for (const tag of spec.tags) {
      expect(tag.description).toBe(`${tag.name} operations`);
    }
  });
});

describe("JSON / YAML export round-trips", () => {
  it("generateOpenAPIJSON parses back to the spec object", () => {
    const spec = generateOpenAPISpec("https://roundtrip.example.test");
    expect(
      JSON.parse(generateOpenAPIJSON("https://roundtrip.example.test")),
    ).toEqual(spec);
  });

  it("generateOpenAPIYAML parses back to an object equal to the spec", () => {
    const spec = generateOpenAPISpec();
    expect(parseYaml(generateOpenAPIYAML())).toEqual(spec);
  });
});

describe("formatEndpointPrice — every rendering branch", () => {
  it("renders free pricing as the literal 'Free'", () => {
    expect(
      formatEndpointPrice({ cost: 0, unit: "request", isFree: true }),
    ).toBe("Free");
  });

  it("renders variable pricing with a range as '$min - $max'", () => {
    expect(
      formatEndpointPrice({
        cost: 0,
        unit: "request",
        isVariable: true,
        estimatedRange: { min: 0.001, max: 0.03 },
      }),
    ).toBe("$0.001 - $0.03");
  });

  it("renders sub-cent fixed costs at 4-decimal precision and dollar costs at 2", () => {
    expect(formatEndpointPrice({ cost: 0.0075, unit: "request" })).toBe(
      "$0.0075",
    );
    expect(formatEndpointPrice({ cost: 0.5, unit: "clone" })).toBe("$0.50");
  });

  it("falls back to the description for non-finite costs and null when unpriced", () => {
    expect(
      formatEndpointPrice({
        cost: Number.NaN,
        unit: "request",
        description: "Varies by model",
      }),
    ).toBe("Varies by model");
    expect(
      formatEndpointPrice({
        cost: Number.NaN,
        unit: "request",
        isVariable: true,
      }),
    ).toBe("Variable");
    expect(formatEndpointPrice(undefined)).toBeNull();
  });
});

describe("searchEndpoints — behavioral properties", () => {
  // No shipping component consumes `searchEndpoints` (the Explorer UI filters
  // the catalog inline), so these tests pin the matching contract itself:
  // which fields match, case-insensitivity, and no-match behavior — all as
  // properties over the real catalog, not copied membership lists.

  it("matches on the endpoint name (term only a name contains)", () => {
    const results = searchEndpoints("Clone Voice");
    expect(results.map((e) => e.id)).toEqual(["voice-clone-create"]);
    for (const endpoint of results) {
      expect(endpoint.name.toLowerCase()).toContain("clone voice");
    }
  });

  it("matches case-insensitively: uppercase and lowercase queries agree", () => {
    const upper = searchEndpoints("VOICE");
    const lower = searchEndpoints("voice");
    expect(upper.length).toBeGreaterThan(0);
    expect(upper).toEqual(lower);
  });

  it("matches on the path and the description", () => {
    const byPath = searchEndpoints("api-keys");
    expect(byPath.length).toBeGreaterThan(0);
    for (const endpoint of byPath) {
      expect(endpoint.path).toContain("api-keys");
    }

    const byDescription = searchEndpoints("Transcribe audio to text");
    expect(byDescription.map((e) => e.id)).toContain("voice-speech-to-text");
    for (const endpoint of byDescription) {
      expect(endpoint.description.toLowerCase()).toContain(
        "transcribe audio to text",
      );
    }
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchEndpoints("definitely-not-in-the-catalog")).toEqual([]);
  });
});

describe("getAvailableCategories — the Explorer's category source", () => {
  it("returns the deduped, sorted category list", () => {
    const categories = getAvailableCategories();
    expect(categories).toEqual([...new Set(categories)].sort());
    const catalogCategories = new Set(API_ENDPOINTS.map((e) => e.category));
    expect(new Set(categories)).toEqual(catalogCategories);
  });
});

describe("catalog invariants the generated spec depends on", () => {
  it("operations sharing a path use distinct methods", () => {
    const seen = new Set<string>();
    for (const endpoint of API_ENDPOINTS) {
      const key = `${endpoint.method} ${endpoint.path}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
