/**
 * OpenAPI 3.0.3 Generator
 *
 * Converts endpoint catalog to OpenAPI specification for export and documentation
 */

import {
  API_ENDPOINTS,
  type ApiEndpoint,
  type EndpointParameter,
  type EndpointResponse,
  type JsonValue,
} from "./endpoint-discovery";

/**
 * OpenAPI schema definition.
 */
export interface OpenAPISchema {
  type?: string;
  format?: string;
  enum?: string[];
  example?: JsonValue;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  description?: string;
}

/**
 * OpenAPI parameter definition.
 */
interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: OpenAPISchema;
}

/**
 * OpenAPI request body definition.
 */
interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content: {
    "application/json": {
      schema: OpenAPISchema;
    };
  };
}

/**
 * OpenAPI response definition.
 */
interface OpenAPIResponse {
  description: string;
  content?: {
    "application/json": {
      schema?: OpenAPISchema;
      example?: Record<string, JsonValue>;
    };
  };
}

/**
 * OpenAPI operation definition.
 */
interface OpenAPIOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
}

/**
 * OpenAPI path definition with HTTP methods.
 */
interface OpenAPIPath {
  [method: string]: OpenAPIOperation;
}

/**
 * Complete OpenAPI 3.0.3 specification.
 */
export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
    contact: {
      name: string;
      url: string;
    };
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  security: Array<Record<string, string[]>>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: string;
        scheme: string;
        bearerFormat: string;
        description: string;
      };
      apiKeyAuth: {
        type: string;
        in: string;
        name: string;
        description: string;
      };
    };
    schemas?: Record<string, OpenAPISchema>;
  };
  paths: Record<string, OpenAPIPath>;
  tags: Array<{
    name: string;
    description: string;
  }>;
}

/**
 * Converts an endpoint parameter to an OpenAPI schema.
 *
 * @param param - Endpoint parameter definition.
 * @returns OpenAPI schema object.
 */
function convertParameterToSchema(param: EndpointParameter): OpenAPISchema {
  const schema: OpenAPISchema = {
    type: param.type,
    description: param.description,
  };

  if (param.format) schema.format = param.format;
  if (param.enum) schema.enum = param.enum;
  if (param.example !== undefined) schema.example = param.example;
  if (param.defaultValue !== undefined) schema.default = param.defaultValue;
  if (param.min !== undefined) schema.minimum = param.min;
  if (param.max !== undefined) schema.maximum = param.max;

  if (param.type === "array") {
    schema.items = { type: "string" };
  }

  return schema;
}

/**
 * Converts endpoint parameters to OpenAPI parameters.
 *
 * @param params - Array of endpoint parameters.
 * @param location - Parameter location (path, query, or header).
 * @returns Array of OpenAPI parameters.
 */
function convertParametersToOpenAPI(
  params: EndpointParameter[],
  location: "path" | "query" | "header",
): OpenAPIParameter[] {
  return params.map((param) => ({
    name: param.name,
    in: location,
    required: param.required,
    description: param.description,
    schema: convertParameterToSchema(param),
  }));
}

/**
 * Creates an OpenAPI request body from endpoint parameters.
 *
 * @param params - Array of endpoint parameters.
 * @returns OpenAPI request body definition.
 */
function createRequestBodyFromParameters(params: EndpointParameter[]): OpenAPIRequestBody {
  const properties: Record<string, OpenAPISchema> = {};
  const required: string[] = [];

  for (const param of params) {
    properties[param.name] = convertParameterToSchema(param);
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    description: "Request body",
    required: required.length > 0,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required: required.length > 0 ? required : undefined,
        },
      },
    },
  };
}

/**
 * Converts endpoint responses to OpenAPI responses.
 *
 * @param responses - Array of endpoint responses.
 * @returns Record of status codes to OpenAPI responses.
 */
function convertResponsesToOpenAPI(responses: EndpointResponse[]): Record<string, OpenAPIResponse> {
  const result: Record<string, OpenAPIResponse> = {};

  for (const response of responses) {
    const openAPIResponse: OpenAPIResponse = {
      description: response.description,
    };

    if (response.schema || response.example) {
      openAPIResponse.content = {
        "application/json": {
          schema: response.schema as OpenAPISchema,
          example: response.example,
        },
      };
    }

    result[response.statusCode.toString()] = openAPIResponse;
  }

  return result;
}

/**
 * Converts an API endpoint to an OpenAPI operation.
 *
 * @param endpoint - API endpoint definition.
 * @returns OpenAPI operation object.
 */
function convertEndpointToOperation(endpoint: ApiEndpoint): OpenAPIOperation {
  const operation: OpenAPIOperation = {
    operationId: endpoint.id,
    summary: endpoint.name,
    description: endpoint.description,
    tags: [endpoint.category],
    responses: convertResponsesToOpenAPI(endpoint.responses),
  };

  if (endpoint.requiresAuth) {
    operation.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
  }

  const parameters: OpenAPIParameter[] = [];

  if (endpoint.parameters?.path) {
    parameters.push(...convertParametersToOpenAPI(endpoint.parameters.path, "path"));
  }

  if (endpoint.parameters?.query) {
    parameters.push(...convertParametersToOpenAPI(endpoint.parameters.query, "query"));
  }

  if (endpoint.parameters?.headers) {
    parameters.push(...convertParametersToOpenAPI(endpoint.parameters.headers, "header"));
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (endpoint.parameters?.body) {
    operation.requestBody = createRequestBodyFromParameters(endpoint.parameters.body);
  }

  return operation;
}

/**
 * Generates a complete OpenAPI 3.0.3 specification from the endpoint catalog.
 *
 * @param baseUrl - Optional base URL for the API (defaults to current app URL).
 * @returns Complete OpenAPI specification.
 */
export function generateOpenAPISpec(baseUrl?: string): OpenAPISpec {
  const paths: Record<string, OpenAPIPath> = {};

  for (const endpoint of API_ENDPOINTS) {
    const path = endpoint.path;
    const method = endpoint.method.toLowerCase();

    if (!paths[path]) {
      paths[path] = {};
    }

    paths[path][method] = convertEndpointToOperation(endpoint);
  }

  const categories = new Set(API_ENDPOINTS.map((e) => e.category));
  const tags = Array.from(categories).map((category) => ({
    name: category,
    description: `${category} operations`,
  }));

  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info: {
      title: "Eliza Cloud API",
      description:
        "AI agent development platform with multi-model text generation, image creation, and enterprise features",
      version: "1.0.0",
      contact: {
        name: "Eliza Cloud",
        url: "https://www.elizacloud.ai",
      },
    },
    servers: [
      {
        url: baseUrl || "https://www.elizacloud.ai",
        description: "Production server",
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Steward session authentication",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "API Key authentication (Bearer <key>)",
        },
      },
    },
    paths,
    tags,
  };

  return spec;
}

export function generateOpenAPIJSON(baseUrl?: string): string {
  return JSON.stringify(generateOpenAPISpec(baseUrl), null, 2);
}

export function generateOpenAPIYAML(baseUrl?: string): string {
  const spec = generateOpenAPISpec(baseUrl);
  return convertToYAML(spec);
}

function convertToYAML(obj: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return "\n" + obj.map((item) => `${spaces}- ${convertToYAML(item, indent + 1)}`).join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";

    return (
      "\n" +
      entries
        .map(([key, value]) => {
          const yamlValue = convertToYAML(value, indent + 1);
          if (yamlValue.startsWith("\n") || (typeof value === "object" && value !== null)) {
            return `${spaces}${key}:${yamlValue}`;
          }
          return `${spaces}${key}: ${yamlValue}`;
        })
        .join("\n")
    );
  }

  return String(obj);
}

export function downloadOpenAPISpec(format: "json" | "yaml", baseUrl?: string) {
  const content = format === "json" ? generateOpenAPIJSON(baseUrl) : generateOpenAPIYAML(baseUrl);

  const blob = new Blob([content], {
    type: format === "json" ? "application/json" : "text/yaml",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `eliza-cloud-api.${format}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
