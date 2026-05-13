"""
Baidu Qianfan API — Sample Request Script
==========================================
This script demonstrates how to authenticate and make chat completion
requests to the Baidu Qianfan API.

Author: Developer A
Created: 2024-01-10
"""

import requests
import json


# TODO: implement token retrieval and chat completion


def get_access_token(api_key, secret_key):
    """
    Retrieve an access token from the Baidu OAuth endpoint.
    
    Args:
        api_key (str): Your Baidu API Key (client_id)
        secret_key (str): Your Baidu Secret Key (client_secret)
    
    Returns:
        str: The access token
    """
    pass


def chat_completion(access_token, messages):
    """
    Send a chat completion request to the ERNIE-Bot endpoint.
    
    Args:
        access_token (str): Valid access token
        messages (list): List of message dicts with 'role' and 'content'
    
    Returns:
        dict: The API response
    """
    pass


if __name__ == "__main__":
    # Replace with your actual credentials
    API_KEY = "YOUR_API_KEY"
    SECRET_KEY = "YOUR_SECRET_KEY"
    
    # Example usage (uncomment when functions are implemented)
    # token = get_access_token(API_KEY, SECRET_KEY)
    # response = chat_completion(token, [{"role": "user", "content": "Hello!"}])
    # print(json.dumps(response, indent=2, ensure_ascii=False))
