"""
Vercel Serverless Function - Health Check Endpoint (Python)
"""

from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    """Health check endpoint handler."""

    def do_GET(self) -> None:
        """Handle GET requests."""
        response = {
            "status": "healthy",
            "runtime": "elizaos-python",
            "version": "2.0.0-alpha",
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()










