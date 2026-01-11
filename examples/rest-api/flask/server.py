"""
elizaOS REST API Example - Flask

A simple REST API server for chat with an AI agent.
Uses plugin-localdb for storage and plugin-eliza-classic for responses.
No API keys or external services required.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import TypedDict

from flask import Flask, jsonify, request
from flask.wrappers import Response
from flask_cors import CORS

from elizaos_plugin_eliza_classic import ElizaClassicPlugin

# ============================================================================
# Configuration
# ============================================================================

PORT = int(os.environ.get("PORT", 3000))

CHARACTER_NAME = "Eliza"
CHARACTER_BIO = "A classic pattern-matching psychotherapist simulation."

# ============================================================================
# ELIZA Plugin
# ============================================================================

eliza = ElizaClassicPlugin()

# ============================================================================
# Flask App
# ============================================================================

app = Flask(__name__)
CORS(app)


# ============================================================================
# Type Definitions
# ============================================================================


class ChatRequest(TypedDict, total=False):
    message: str
    userId: str


# ============================================================================
# Routes
# ============================================================================


@app.route("/", methods=["GET"])
def info() -> Response:
    """Get information about the agent."""
    return jsonify(
        {
            "name": CHARACTER_NAME,
            "bio": CHARACTER_BIO,
            "version": "1.0.0",
            "powered_by": "elizaOS",
            "framework": "Flask",
            "endpoints": {
                "POST /chat": "Send a message and receive a response",
                "GET /health": "Health check endpoint",
                "GET /": "This info endpoint",
            },
        }
    )


@app.route("/health", methods=["GET"])
def health() -> Response:
    """Health check endpoint."""
    return jsonify(
        {
            "status": "healthy",
            "character": CHARACTER_NAME,
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.route("/chat", methods=["POST"])
def chat() -> Response | tuple[Response, int]:
    """Chat with the agent."""
    data: ChatRequest = request.get_json() or {}  # type: ignore[assignment]

    message = data.get("message", "")
    if not message or not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Message is required"}), 400

    user_id = data.get("userId") or str(uuid.uuid4())

    # Generate response using ELIZA
    response = eliza.generate_response(message)

    return jsonify(
        {
            "response": response,
            "character": CHARACTER_NAME,
            "userId": user_id,
        }
    )


# ============================================================================
# Startup
# ============================================================================


def main() -> None:
    """Start the Flask server."""
    print(f"\n🌐 elizaOS REST API (Flask)")
    print(f"   http://localhost:{PORT}\n")
    print("📚 Endpoints:")
    print("   GET  /       - Agent info")
    print("   GET  /health - Health check")
    print("   POST /chat   - Chat with agent\n")

    app.run(host="0.0.0.0", port=PORT, debug=False)


if __name__ == "__main__":
    main()





