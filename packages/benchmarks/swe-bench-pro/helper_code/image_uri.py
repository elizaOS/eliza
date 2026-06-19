"""
Utilities for generating Docker Hub image URIs for SWE-bench Pro instances.

This module provides functions to convert instance IDs and repository names
into properly formatted Docker Hub image URIs that match the expected format
from the upload scripts.
"""


def get_dockerhub_image_uri(uid, dockerhub_username, repo_name=""):
    repo_base, repo_name_only = repo_name.lower().split("/")
    hsh = uid.replace("instance_", "")

    if uid == "instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan":
        repo_name_only = 'element-web'  # Keep full name for this one case
    elif 'element-hq' in repo_name.lower() and 'element-web' in repo_name.lower():
        repo_name_only = 'element'
        if hsh.endswith('-vnan'):
            hsh = hsh[:-5]
    # All other repos: strip -vnan suffix
    elif hsh.endswith('-vnan'):
        hsh = hsh[:-5]
    
    tag = f"{repo_base}.{repo_name_only}-{hsh}"
    if len(tag) > 128:
        tag = tag[:128]
    
    return f"{dockerhub_username}/sweap-images:{tag}"

