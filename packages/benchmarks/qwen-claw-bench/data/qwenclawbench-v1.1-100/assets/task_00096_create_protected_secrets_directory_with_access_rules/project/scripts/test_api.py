#!/usr/bin/env python3
"""
Quick script to test API connectivity.
WARNING: Contains hardcoded credentials - DO NOT COMMIT
"""
import requests
import os

# TODO: Move these to env vars - just using for quick testing
API_BASE = "https://api.example.com/v2"
TEMP_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzQyIiwibmFtZSI6IkFsZXggUml2ZXJhIiwiaWF0IjoxNzE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

def check_health():
    resp = requests.get(f"{API_BASE}/health")
    return resp.status_code == 200

def fetch_data(endpoint, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.get(f"{API_BASE}/{endpoint}", headers=headers)
    return resp.json()

if __name__ == "__main__":
    print("Health check:", "OK" if check_health() else "FAIL")
    data = fetch_data("pipeline/status", TEMP_TOKEN)
    print("Pipeline status:", data)
