"""
elizaOS Cloudflare Worker (Python)

A serverless AI agent running on Cloudflare Workers using Python/Pyodide.

NOTE: Due to Cloudflare Workers Python (Pyodide) limitations, the full elizaOS
runtime cannot be used directly. This example provides a simplified REST API
that demonstrates the same pattern but uses direct OpenAI API calls.

For production Python agents, consider:
- Running the full elizaOS Python runtime on a proper server
- Using Cloudflare Durable Objects with the TypeScript runtime
"""

from js import Response, Headers, fetch, JSON, crypto
from pyodide.ffi import to_js
import json

# ============================================================================
# Configuration
# ============================================================================

VERSION = "2.0.0"


def generate_uuid() -> str:
    """Generate a UUID v4."""
    return str(crypto.randomUUID())


def get_character(env) -> dict:
    """Get character configuration from environment."""
    name = getattr(env, "CHARACTER_NAME", None) or "Eliza"
    bio = getattr(env, "CHARACTER_BIO", None) or "A helpful AI assistant powered by elizaOS."
    system = getattr(env, "CHARACTER_SYSTEM", None) or f"You are {name}, a helpful AI assistant. {bio}"
    
    return {
        "name": name,
        "bio": bio,
        "system": system
    }


# ============================================================================
# OpenAI API Integration
# ============================================================================


async def call_openai(messages: list, env) -> str:
    """
    Call OpenAI API and return the response text.
    
    NOTE: In a full elizaOS implementation, this would go through
    runtime.messageService.handleMessage() which handles the model
    call, context building, and response generation automatically.
    """
    api_key = getattr(env, "OPENAI_API_KEY", None)
    if not api_key:
        raise ValueError("OPENAI_API_KEY is not configured")
    
    base_url = getattr(env, "OPENAI_BASE_URL", None) or "https://api.openai.com/v1"
    model = getattr(env, "OPENAI_MODEL", None) or "gpt-4o-mini"
    
    headers = Headers.new()
    headers.set("Authorization", f"Bearer {api_key}")
    headers.set("Content-Type", "application/json")
    
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 1024
    })
    
    response = await fetch(
        f"{base_url}/chat/completions",
        to_js({
            "method": "POST",
            "headers": headers,
            "body": body
        }, dict_converter=lambda d: to_js(d))
    )
    
    if response.status != 200:
        error_text = await response.text()
        raise ValueError(f"OpenAI API error: {response.status} - {error_text}")
    
    data = await response.json()
    choices = data.get("choices", [])
    if choices and len(choices) > 0:
        return choices[0].get("message", {}).get("content", "")
    return ""


# ============================================================================
# Response Helpers
# ============================================================================


def json_response(data: dict, status: int = 200) -> Response:
    """Create a JSON response with CORS headers."""
    headers = Headers.new()
    headers.set("Content-Type", "application/json")
    headers.set("Access-Control-Allow-Origin", "*")
    
    return Response.new(
        json.dumps(data),
        to_js({"status": status, "headers": headers}, dict_converter=lambda d: to_js(d))
    )


# ============================================================================
# Route Handlers
# ============================================================================


def handle_info(env) -> Response:
    """Handle GET / - return worker info."""
    character = get_character(env)
    
    return json_response({
        "name": character["name"],
        "bio": character["bio"],
        "version": VERSION,
        "powered_by": "elizaOS",
        "runtime": "Python (Pyodide)",
        "note": "Limited runtime - for full elizaOS features, use TypeScript worker or dedicated server",
        "endpoints": {
            "POST /chat": "Send a message and receive a response",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint"
        }
    })


def handle_health(env) -> Response:
    """Handle GET /health - health check."""
    character = get_character(env)
    
    return json_response({
        "status": "healthy",
        "character": character["name"],
        "mode": "simplified",
        "note": "Pyodide runtime - full elizaOS runtime not available"
    })


async def handle_chat(request, env) -> Response:
    """
    Handle POST /chat - process a chat message.
    
    NOTE: This is a simplified implementation. The canonical elizaOS pattern would:
    1. Create an AgentRuntime with plugins
    2. Call runtime.ensureConnection() 
    3. Create a messageMemory using createMessageMemory()
    4. Call runtime.messageService.handleMessage()
    
    Due to Pyodide limitations, we directly call the OpenAI API here.
    """
    try:
        body_text = await request.text()
        body = json.loads(body_text)
    except Exception:
        return json_response({"error": "Invalid JSON body"}, 400)
    
    message = body.get("message", "").strip()
    if not message:
        return json_response({"error": "Message is required"}, 400)
    
    user_id = body.get("userId") or generate_uuid()
    character = get_character(env)
    
    # Build messages for OpenAI
    # In full elizaOS, this context would be built by providers
    messages = [
        {"role": "system", "content": character["system"]},
        {"role": "user", "content": message}
    ]
    
    try:
        response_text = await call_openai(messages, env)
    except Exception as e:
        return json_response({"error": str(e)}, 500)
    
    return json_response({
        "response": response_text,
        "character": character["name"],
        "userId": user_id
    })


def handle_cors() -> Response:
    """Handle OPTIONS - CORS preflight."""
    headers = Headers.new()
    headers.set("Access-Control-Allow-Origin", "*")
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    headers.set("Access-Control-Allow-Headers", "Content-Type")
    
    return Response.new(
        None,
        to_js({"status": 204, "headers": headers}, dict_converter=lambda d: to_js(d))
    )


# ============================================================================
# Main Handler
# ============================================================================


async def on_fetch(request, env):
    """Main request handler."""
    method = request.method
    url = request.url
    path = url.split("?")[0].rstrip("/")
    
    # Extract path from full URL
    if "://" in path:
        path = "/" + "/".join(path.split("/")[3:])
    if not path:
        path = "/"
    
    # Handle CORS preflight
    if method == "OPTIONS":
        return handle_cors()
    
    # Route handling
    if path == "/" and method == "GET":
        return handle_info(env)
    
    if path == "/health" and method == "GET":
        return handle_health(env)
    
    if path == "/chat" and method == "POST":
        return await handle_chat(request, env)
    
    return json_response({"error": "Not found"}, 404)
