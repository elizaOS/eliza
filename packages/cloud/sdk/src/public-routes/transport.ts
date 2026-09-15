/** Dispatches public endpoint requests while preserving path, response-mode, and custom transport contracts. */
import type {
  CloudRequestOptions,
  CloudResponse,
  HttpMethod,
} from "../types.js";
import { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "./descriptors.generated.js";
import type {
  PublicRouteCallOptions,
  PublicRouteKey,
  PublicRouteKeysWithoutPathParams,
  PublicRouteKeysWithPathParams,
} from "./types.generated.js";

interface ElizaCloudPublicRouteTransport {
  request<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<CloudResponse<TResponse>>;
  requestData?<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse>;
  requestRaw(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<Response>;
}

type PathParamValue = string | number | readonly (string | number)[];

function encodePathValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

function isPathParamArray(
  value: PathParamValue,
): value is readonly (string | number)[] {
  return Array.isArray(value);
}

function encodeCatchAllPathValue(value: PathParamValue): string {
  const parts = isPathParamArray(value) ? value : String(value).split("/");
  if (parts.length === 0 || parts[0] === "" || parts[parts.length - 1] === "") {
    throw new Error(
      "Catch-all path parameter cannot start or end with an empty segment",
    );
  }
  return parts
    .map(String)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildPublicRoutePath<TKey extends PublicRouteKey>(
  key: TKey,
  options: PublicRouteCallOptions<TKey> | undefined,
): string {
  const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
  const pathParams = (options?.pathParams ?? {}) as Record<
    string,
    PathParamValue
  >;
  const expectedPathParams = new Set<string>(endpoint.pathParams);
  const catchAllPathParams = new Set<string>(endpoint.catchAllPathParams);

  for (const providedParamName of Object.keys(pathParams)) {
    if (!expectedPathParams.has(providedParamName)) {
      throw new Error(
        `Unexpected path parameter "${providedParamName}" for ${key}`,
      );
    }
  }

  return endpoint.path.replace(/\{([^}]+)\}/g, (_match, paramName: string) => {
    const value = pathParams[paramName];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${paramName}" for ${key}`);
    }
    if (catchAllPathParams.has(paramName)) {
      return encodeCatchAllPathValue(value);
    }
    if (isPathParamArray(value)) {
      throw new Error(
        `Path parameter "${paramName}" for ${key} does not accept multiple segments`,
      );
    }
    return encodePathValue(value);
  });
}

function toRequestOptions<TKey extends PublicRouteKey>(
  options: PublicRouteCallOptions<TKey> | undefined,
): CloudRequestOptions {
  const { pathParams: _pathParams, ...requestOptions } = options ?? {};
  return requestOptions as CloudRequestOptions;
}

export class PublicRouteTransport {
  constructor(private readonly client: ElizaCloudPublicRouteTransport) {}

  call<TKey extends PublicRouteKeysWithoutPathParams, TResponse = unknown>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>,
  ): Promise<TResponse>;
  call<TKey extends PublicRouteKeysWithPathParams, TResponse = unknown>(
    key: TKey,
    options: PublicRouteCallOptions<TKey>,
  ): Promise<TResponse>;
  call<TKey extends PublicRouteKey, TResponse = unknown>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>,
  ): Promise<TResponse> {
    const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
    const method = endpoint.method as HttpMethod;
    const path = buildPublicRoutePath(key, options);
    const requestOptions = toRequestOptions(options);
    if (this.client.requestData) {
      return this.client.requestData<TResponse>(method, path, requestOptions);
    }
    return this.client
      .request<TResponse>(method, path, requestOptions)
      .then((response) => {
        if (response === undefined) {
          throw new Error(`Expected a data response for ${key}`);
        }
        return response;
      });
  }

  protected callBodyless<TKey extends PublicRouteKey, TResponse = unknown>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>,
  ): Promise<CloudResponse<TResponse>> {
    const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
    return this.client.request<TResponse>(
      endpoint.method as HttpMethod,
      buildPublicRoutePath(key, options),
      toRequestOptions(options),
    );
  }

  callRaw<TKey extends PublicRouteKeysWithoutPathParams>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>,
  ): Promise<Response>;
  callRaw<TKey extends PublicRouteKeysWithPathParams>(
    key: TKey,
    options: PublicRouteCallOptions<TKey>,
  ): Promise<Response>;
  callRaw<TKey extends PublicRouteKey>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>,
  ): Promise<Response> {
    const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
    return this.client.requestRaw(
      endpoint.method as HttpMethod,
      buildPublicRoutePath(key, options),
      toRequestOptions(options),
    );
  }
}
