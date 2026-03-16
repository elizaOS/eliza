"""
Secret management actions.

Actions for natural language secret management.
"""

import re
import logging
from typing import Optional, Dict, List, Any

from elizaos.runtime import AgentRuntime
from elizaos.types import Action, Message, Memory

from .types import SecretLevel, SecretContext


logger = logging.getLogger(__name__)


def mask_secret(value: str, visible_chars: int = 4) -> str:
    """Mask a secret value for safe display."""
    if len(value) <= visible_chars * 2:
        return "*" * len(value)
    return value[:visible_chars] + "*" * (len(value) - visible_chars * 2) + value[-visible_chars:]


class SetSecretAction(Action):
    """Action to set a secret via natural language."""
    
    name = "SET_SECRET"
    description = "Set a secret/API key for the agent. Use when the user wants to configure or store a secret."
    similes = [
        "configure secret",
        "store api key",
        "set api key",
        "add secret",
        "save credential",
    ]
    examples = [
        [
            {"user": "user", "content": {"text": "Set my OpenAI key to sk-abc123xyz"}},
            {"user": "assistant", "content": {"text": "I've saved your OpenAI API key."}},
        ],
        [
            {"user": "user", "content": {"text": "Configure ANTHROPIC_API_KEY as sk-ant-mykey123"}},
            {"user": "assistant", "content": {"text": "I've configured your Anthropic API key."}},
        ],
    ]
    
    async def validate(self, runtime: AgentRuntime, message: Message) -> bool:
        """Validate that this action should be triggered."""
        text = message.content.get("text", "").lower() if isinstance(message.content, dict) else str(message.content).lower()
        
        # Check for secret-setting keywords
        keywords = ["set", "configure", "store", "save", "add"]
        secret_keywords = ["secret", "key", "api", "token", "credential", "password"]
        
        has_action = any(kw in text for kw in keywords)
        has_secret = any(kw in text for kw in secret_keywords)
        
        return has_action and has_secret
    
    async def handler(self, runtime: AgentRuntime, message: Message, state: Dict) -> Dict:
        """Handle secret setting."""
        from .service import SecretsService
        
        secrets_service: SecretsService = runtime.get_service(SecretsService.service_type)
        if not secrets_service:
            return {
                "success": False,
                "message": "Secrets service not available",
            }
        
        text = message.content.get("text", "") if isinstance(message.content, dict) else str(message.content)
        
        # Extract key and value using LLM
        extraction = await self._extract_secret_info(runtime, text)
        
        if not extraction.get("key") or not extraction.get("value"):
            return {
                "success": False,
                "message": "Could not extract secret key and value from your message. Please specify the secret name and value.",
            }
        
        key = extraction["key"]
        value = extraction["value"]
        level = SecretLevel(extraction.get("level", "global"))
        description = extraction.get("description", "")
        secret_type = extraction.get("type", "api_key")
        
        # Build context
        context = SecretContext(
            level=level,
            agent_id=runtime.agent_id,
            user_id=message.user_id if hasattr(message, "user_id") else None,
            world_id=message.room_id if hasattr(message, "room_id") else None,
        )
        
        # Set the secret
        config = {
            "description": description,
            "type": secret_type,
        }
        
        success = await secrets_service.set(key, value, context, config)
        
        if success:
            masked = mask_secret(value)
            return {
                "success": True,
                "message": f"Successfully set secret '{key}' with value {masked}",
            }
        else:
            return {
                "success": False,
                "message": f"Failed to set secret '{key}'",
            }
    
    async def _extract_secret_info(self, runtime: AgentRuntime, text: str) -> Dict:
        """Extract secret information from text."""
        # Try pattern matching first
        patterns = [
            r"(?:set|configure|store|save)\s+(?:the\s+)?(?:secret\s+)?([A-Z_][A-Z0-9_]*)\s+(?:to|as|=)\s+([^\s]+)",
            r"([A-Z_][A-Z0-9_]*)\s*[:=]\s*([^\s]+)",
            r"(?:api\s*key|secret|token)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:is|to|as|=)\s+([^\s]+)",
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return {
                    "key": match.group(1).upper(),
                    "value": match.group(2),
                    "level": "global",
                    "type": "api_key",
                }
        
        # Use LLM for complex extraction
        prompt = f"""Extract the secret information from this message:
"{text}"

Return ONLY a JSON object with these fields:
- key: The secret name (uppercase with underscores, e.g., OPENAI_API_KEY)
- value: The secret value
- description: Brief description (optional)
- type: Type of secret (api_key, token, password, credential, url)
- level: Storage level (global, world, user)

If you cannot find a key or value, return {{"key": null, "value": null}}"""

        response = await runtime.generate_text(
            prompt,
            {"temperature": 0.1, "max_tokens": 200}
        )
        
        # Parse JSON from response
        import json
        try:
            # Find JSON in response
            json_match = re.search(r"\{[^}]+\}", response)
            if json_match:
                return json.loads(json_match.group())
        except (json.JSONDecodeError, AttributeError):
            pass
        
        return {"key": None, "value": None}


class ManageSecretAction(Action):
    """Action for comprehensive secret management via natural language."""
    
    name = "MANAGE_SECRET"
    description = "Manage secrets - get, set, delete, list, or check secrets."
    similes = [
        "manage secret",
        "show secrets",
        "delete secret",
        "list secrets",
        "check secret",
        "get secret",
        "remove api key",
    ]
    examples = [
        [
            {"user": "user", "content": {"text": "List all my secrets"}},
            {"user": "assistant", "content": {"text": "Here are your configured secrets: OPENAI_API_KEY (set), ANTHROPIC_API_KEY (not set)"}},
        ],
        [
            {"user": "user", "content": {"text": "Delete my GROQ_API_KEY"}},
            {"user": "assistant", "content": {"text": "I've deleted the GROQ_API_KEY secret."}},
        ],
    ]
    
    async def validate(self, runtime: AgentRuntime, message: Message) -> bool:
        """Validate that this action should be triggered."""
        text = message.content.get("text", "").lower() if isinstance(message.content, dict) else str(message.content).lower()
        
        # Operations
        operations = ["list", "show", "get", "delete", "remove", "check", "verify", "what", "which"]
        secret_keywords = ["secret", "key", "api", "token", "credential", "configured"]
        
        has_operation = any(op in text for op in operations)
        has_secret = any(kw in text for kw in secret_keywords)
        
        return has_operation and has_secret
    
    async def handler(self, runtime: AgentRuntime, message: Message, state: Dict) -> Dict:
        """Handle secret management."""
        from .service import SecretsService
        
        secrets_service: SecretsService = runtime.get_service(SecretsService.service_type)
        if not secrets_service:
            return {
                "success": False,
                "message": "Secrets service not available",
            }
        
        text = message.content.get("text", "") if isinstance(message.content, dict) else str(message.content)
        
        # Determine operation
        operation = self._detect_operation(text)
        
        # Build context
        context = SecretContext(
            level=SecretLevel.GLOBAL,
            agent_id=runtime.agent_id,
            user_id=message.user_id if hasattr(message, "user_id") else None,
        )
        
        if operation == "list":
            return await self._handle_list(secrets_service, context)
        elif operation == "get":
            key = self._extract_key(text)
            if not key:
                return {"success": False, "message": "Please specify which secret to get."}
            return await self._handle_get(secrets_service, key, context)
        elif operation == "delete":
            key = self._extract_key(text)
            if not key:
                return {"success": False, "message": "Please specify which secret to delete."}
            return await self._handle_delete(secrets_service, key, context)
        elif operation == "check":
            key = self._extract_key(text)
            if key:
                return await self._handle_check(secrets_service, key, context)
            else:
                return await self._handle_list(secrets_service, context)
        else:
            return {"success": False, "message": "Unknown operation. You can list, get, set, delete, or check secrets."}
    
    def _detect_operation(self, text: str) -> str:
        """Detect the secret operation from text."""
        text_lower = text.lower()
        
        if any(kw in text_lower for kw in ["list", "show all", "what secrets", "which secrets"]):
            return "list"
        if any(kw in text_lower for kw in ["delete", "remove"]):
            return "delete"
        if any(kw in text_lower for kw in ["check", "verify", "is", "have"]):
            return "check"
        if any(kw in text_lower for kw in ["get", "show", "what is"]):
            return "get"
        
        return "list"
    
    def _extract_key(self, text: str) -> Optional[str]:
        """Extract secret key from text."""
        # Look for uppercase key patterns
        match = re.search(r"([A-Z][A-Z0-9_]{2,})", text)
        if match:
            return match.group(1)
        
        # Try to find common key names
        common_keys = [
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
            "GOOGLE_API_KEY", "DISCORD_TOKEN", "TELEGRAM_TOKEN",
        ]
        text_upper = text.upper()
        for key in common_keys:
            if key in text_upper:
                return key
        
        return None
    
    async def _handle_list(self, service, context: SecretContext) -> Dict:
        """Handle list operation."""
        metadata = await service.list(context)
        
        if not metadata.keys:
            return {
                "success": True,
                "message": "No secrets configured.",
                "secrets": [],
            }
        
        secrets_info = []
        for key in metadata.keys:
            config = await service.get_config(key, context)
            status = "configured"
            if config:
                desc = config.description or ""
                secrets_info.append(f"- {key}: {status}" + (f" ({desc})" if desc else ""))
            else:
                secrets_info.append(f"- {key}: {status}")
        
        return {
            "success": True,
            "message": f"Configured secrets:\n" + "\n".join(secrets_info),
            "secrets": metadata.keys,
        }
    
    async def _handle_get(self, service, key: str, context: SecretContext) -> Dict:
        """Handle get operation."""
        exists = await service.exists(key, context)
        
        if not exists:
            return {
                "success": False,
                "message": f"Secret '{key}' is not configured.",
            }
        
        # Don't return actual value for security
        config = await service.get_config(key, context)
        desc = config.description if config else ""
        
        return {
            "success": True,
            "message": f"Secret '{key}' is configured." + (f" Description: {desc}" if desc else ""),
            "exists": True,
        }
    
    async def _handle_delete(self, service, key: str, context: SecretContext) -> Dict:
        """Handle delete operation."""
        success = await service.delete(key, context)
        
        if success:
            return {
                "success": True,
                "message": f"Deleted secret '{key}'.",
            }
        else:
            return {
                "success": False,
                "message": f"Secret '{key}' not found or could not be deleted.",
            }
    
    async def _handle_check(self, service, key: str, context: SecretContext) -> Dict:
        """Handle check operation."""
        exists = await service.exists(key, context)
        
        return {
            "success": True,
            "message": f"Secret '{key}' is {'configured' if exists else 'not configured'}.",
            "exists": exists,
        }


# Export actions
set_secret_action = SetSecretAction()
manage_secret_action = ManageSecretAction()
