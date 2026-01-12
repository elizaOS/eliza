"""
elizaOS Cloudflare Worker (Python)

A serverless AI agent running on Cloudflare Workers using Python.
"""

from js import Response, Headers, fetch, JSON, crypto
from pyodide.ffi import to_js
import json

# In-memory conversation storage
conversations: dict = {}


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


async def call_openai(messages: list, env) -> str:
    """Call OpenAI API and return the response text."""
    api_key = getattr(env, "OPENAI_API_KEY", None)
    if not api_key:
        raise ValueError("OPENAI_API_KEY is not configured")
    
    base_url = getattr(env, "OPENAI_BASE_URL", None) or "https://api.openai.com/v1"
    model = getattr(env, "OPENAI_MODEL", None) or "gpt-5-mini"
    
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


def json_response(data: dict, status: int = 200) -> Response:
    """Create a JSON response with CORS headers."""
    headers = Headers.new()
    headers.set("Content-Type", "application/json")
    headers.set("Access-Control-Allow-Origin", "*")
    
    return Response.new(
        json.dumps(data),
        to_js({"status": status, "headers": headers}, dict_converter=lambda d: to_js(d))
    )


def handle_info(env) -> Response:
    """Handle GET / - return worker info."""
    character = get_character(env)
    
    return json_response({
        "name": character["name"],
        "bio": character["bio"],
        "version": "2.0.0",
        "powered_by": "elizaOS",
        "runtime": "Python",
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
        "activeConversations": len(conversations)
    })


async def handle_chat(request, env) -> Response:
    """Handle POST /chat - process a chat message."""
    try:
        body_text = await request.text()
        body = json.loads(body_text)
    except Exception:
        return json_response({"error": "Invalid JSON body"}, 400)
    
    message = body.get("message", "").strip()
    if not message:
        return json_response({"error": "Message is required"}, 400)
    
    conversation_id = body.get("conversationId") or generate_uuid()
    character = get_character(env)
    
    # Get or create conversation
    if conversation_id not in conversations:
        conversations[conversation_id] = {
            "messages": [
                {"role": "system", "content": character["system"]}
            ]
        }
    
    state = conversations[conversation_id]
    
    # Add user message
    state["messages"].append({
        "role": "user",
        "content": message
    })
    
    # Call OpenAI
    try:
        response_text = await call_openai(state["messages"], env)
    except Exception as e:
        return json_response({"error": str(e)}, 500)
    
    # Add assistant response
    state["messages"].append({
        "role": "assistant",
        "content": response_text
    })
    
    # Prune old conversations
    if len(conversations) > 100:
        oldest_keys = list(conversations.keys())[:-100]
        for key in oldest_keys:
            del conversations[key]
    
    return json_response({
        "response": response_text,
        "conversationId": conversation_id,
        "character": character["name"]
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










