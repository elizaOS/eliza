/**
 * Contract tests for the API Explorer's generated OpenAPI export and catalog
 * helpers. The suite exercises the real `API_ENDPOINTS` catalog through the
 * public generator functions — no mocks — pinning the wire format downloaded
 * by `ApiExplorerPage` (JSON + YAML export buttons) and the catalog
 * behaviors (search, categories, per-category listing) its UI renders.
 * Harness: deterministic, pure functions only.
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  API_ENDPOINTS,
  type ApiEndpoint,
  formatEndpointPrice,
  getAvailableCategories,
  getEndpointsByCategory,
  searchEndpoints,
} from "./endpoint-discovery.js";
import {
  generateOpenAPIJSON,
  generateOpenAPISpec,
  generateOpenAPIYAML,
} from "./openapi-generator.js";

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
    // `voice-speech-to-text` declares a 200 example; generated clients and the
    // docs preview render it.
    const operation = spec.paths["/api/elevenlabs/stt"]?.post;
    expect(
      operation.responses["200"].content?.["application/json"]?.example,
    ).toEqual({
      transcript: "This is the transcribed text from the audio file.",
      duration_ms: 1234,
    });
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

  it("builds a JSON request body whose required list matches required body params", () => {
    const createKey = spec.paths["/api/v1/api-keys"]?.post;
    const requestBody = createKey.requestBody;
    const schema = requestBody?.content["application/json"].schema;
    expect(schema?.type).toBe("object");
    expect(schema?.required).toEqual(["name"]);
    const properties = schema?.properties ?? {};
    expect(properties.name).toMatchObject({ type: "string" });
    expect(properties.rate_limit).toMatchObject({
      type: "number",
      default: 1000,
    });
  });

  it("omits requestBody when the endpoint declares no body parameters", () => {
    const models = spec.paths["/api/v1/models"]?.get;
    expect(models.requestBody).toBeUndefined();
  });

  it("propagates numeric bounds onto the generated schema", () => {
    const listVoices = spec.paths["/api/elevenlabs/voices/user"]?.get;
    const limit = listVoices.parameters?.find((p) => p.name === "limit");
    expect(limit?.schema).toMatchObject({ minimum: 1, maximum: 100 });
  });
});

describe("generateOpenAPISpec — document-level contract", () => {
  it("pins the OpenAPI version, security schemes, and global auth", () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
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
  it("renders free endpoints as the literal 'Free'", () => {
    const pricing = API_ENDPOINTS.find(
      (e) => e.id === "generate-prompts",
    )?.pricing;
    expect(formatEndpointPrice(pricing)).toBe("Free");
  });

  it("renders variable pricing with a range as '$min - $max'", () => {
    const pricing = API_ENDPOINTS.find(
      (e) => e.id === "chat-completions",
    )?.pricing;
    expect(formatEndpointPrice(pricing)).toBe("$0.001 - $0.03");
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

describe("catalog search and category helpers", () => {
  it("searchEndpoints matches name, description, and path case-insensitively", () => {
    const byName = searchEndpoints("VOICE");
    // "Text-to-Speech" matches via its description/path, not its name — every
    // voice-catalog entry must still be discoverable by the term.
    expect(byName.map((e) => e.id)).toEqual([
      "voice-text-to-speech",
      "voice-speech-to-text",
      "voice-list-available",
      "voice-clone-create",
      "voice-list-user",
      "voice-get-by-id",
      "voice-delete",
    ]);

    const byPath = searchEndpoints("/api/v1/api-keys");
    expect(byPath.map((e) => e.id)).toContain("api-keys-list");

    const byDescription = searchEndpoints("Transcribe audio to text");
    expect(byDescription.map((e) => e.id)).toContain("voice-speech-to-text");

    expect(searchEndpoints("definitely-not-in-the-catalog")).toEqual([]);
  });

  it("getEndpointsByCategory returns only that category's endpoints", () => {
    const voiceCloning = getEndpointsByCategory("Voice Cloning");
    expect(voiceCloning.length).toBeGreaterThan(0);
    expect(voiceCloning.every((e) => e.category === "Voice Cloning")).toBe(
      true,
    );
    expect(getEndpointsByCategory("Nonexistent Category")).toEqual([]);
  });

  it("getAvailableCategories returns the deduped, sorted category list", () => {
    const categories = getAvailableCategories();
    expect(categories).toEqual([...new Set(categories)].sort());
    const catalogCategories = new Set(API_ENDPOINTS.map((e) => e.category));
    expect(new Set(categories)).toEqual(catalogCategories);
  });
});

describe("catalog invariants the generated spec depends on", () => {
  it("every endpoint declares at least one response", () => {
    for (const endpoint of API_ENDPOINTS) {
      expect(endpoint.responses.length, endpoint.id).toBeGreaterThan(0);
    }
  });

  it("path parameters appear in the path template as {name}", () => {
    for (const endpoint of API_ENDPOINTS) {
      for (const param of endpoint.parameters?.path ?? []) {
        expect(endpoint.path, `${endpoint.id}: ${param.name}`).toContain(
          `{${param.name}}`,
        );
      }
    }
  });

  it("operations sharing a path use distinct methods", () => {
    const seen = new Set<string>();
    for (const endpoint of API_ENDPOINTS) {
      const key = `${endpoint.method} ${endpoint.path}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

// Re-exported type sanity used by the assertions above (compile-time pin).
export type { ApiEndpoint };
