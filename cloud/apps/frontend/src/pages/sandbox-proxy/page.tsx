/**
 * Sandbox Proxy Page
 *
 * This page is embedded as an invisible iframe in sandbox apps during local development.
 * It acts as a bridge between the cloud sandbox and the local API server.
 *
 * Flow:
 * 1. Sandbox app sends postMessage to this iframe
 * 2. This page (running on localhost) makes the actual API call
 * 3. Response is sent back via postMessage
 *
 * Security:
 * - Only enabled in development mode
 * - Origin validation against allowed sandbox host patterns
 * - Path allowlisting for API routes
 */

import { useCallback, useEffect } from "react";

// Allowed sandbox origins. Add docker sandbox host patterns here as the
// docker-sandbox subsystem stabilizes; localhost is permitted for testing.
const ALLOWED_ORIGIN_PATTERNS = [
  // Allow localhost for testing
  /^http:\/\/localhost:\d+$/,
];

// Allowed API paths that can be proxied
const ALLOWED_PATH_PREFIXES = [
  "/api/v1/chat",
  "/api/v1/generate-image",
  "/api/v1/generate-video",
  "/api/v1/track",
  "/api/v1/credits",
  "/api/v1/agents",
  "/api/v1/embeddings",
  "/api/v1/documents",
];

interface ProxyRequest {
  type: "eliza-proxy-request";
  id: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}

interface ProxyResponse {
  type: "eliza-proxy-response";
  id: string;
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isValidRequest(data: unknown): data is ProxyRequest {
  if (!data || typeof data !== "object") return false;
  const req = data as Record<string, unknown>;
  return (
    req.type === "eliza-proxy-request" &&
    typeof req.id === "string" &&
    typeof req.path === "string" &&
    typeof req.method === "string" &&
    ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(req.method as string)
  );
}

export default function SandboxProxyPage() {
  const handleMessage = useCallback(async (event: MessageEvent) => {
    // Validate origin
    if (!isAllowedOrigin(event.origin)) {
      console.warn("[SandboxProxy] Rejected message from origin:", event.origin);
      return;
    }

    // Validate request structure
    if (!isValidRequest(event.data)) {
      return; // Silently ignore non-proxy messages
    }

    const request = event.data;

    // Validate path
    if (!isAllowedPath(request.path)) {
      const response: ProxyResponse = {
        type: "eliza-proxy-response",
        id: request.id,
        success: false,
        error: `Path not allowed: ${request.path}`,
      };
      event.source?.postMessage(response, { targetOrigin: event.origin });
      return;
    }

    try {
      // Build fetch options
      const fetchOptions: RequestInit = {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          ...request.headers,
        },
      };

      if (request.body && request.method !== "GET") {
        fetchOptions.body = JSON.stringify(request.body);
      }

      // Make the actual API call to localhost
      const apiResponse = await fetch(request.path, fetchOptions);

      let data: unknown;
      const contentType = apiResponse.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        data = await apiResponse.json();
      } else {
        data = await apiResponse.text();
      }

      const response: ProxyResponse = {
        type: "eliza-proxy-response",
        id: request.id,
        success: apiResponse.ok,
        status: apiResponse.status,
        data,
      };

      event.source?.postMessage(response, { targetOrigin: event.origin });
    } catch (error) {
      const response: ProxyResponse = {
        type: "eliza-proxy-response",
        id: request.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
      event.source?.postMessage(response, { targetOrigin: event.origin });
    }
  }, []);

  useEffect(() => {
    // Only enable in development
    if (process.env.NODE_ENV !== "development") {
      console.warn("[SandboxProxy] Disabled in production");
      return;
    }

    window.addEventListener("message", handleMessage);

    // Signal that the proxy is ready
    if (window.parent !== window) {
      window.parent.postMessage({ type: "eliza-proxy-ready" }, "*");
    }

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  // Invisible page - just shows status in dev
  if (process.env.NODE_ENV !== "development") {
    return (
      <div className="p-4">
        <p className="text-red-500">Sandbox proxy is only available in development mode.</p>
      </div>
    );
  }

  return (
    <div className="p-4 text-sm text-gray-500">
      <p>🔌 Eliza Sandbox Proxy Active</p>
      <p className="text-xs mt-2">
        This page proxies API requests from sandbox apps to your local server.
      </p>
    </div>
  );
}
