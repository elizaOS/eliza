"""
Context providers for secrets.

Provides secret status information to the LLM context.
"""

import logging
from typing import Dict, List, Optional

from elizaos.runtime import AgentRuntime
from elizaos.types import Provider, Message, Memory

from .types import SecretLevel, SecretContext


logger = logging.getLogger(__name__)


class SecretsStatusProvider(Provider):
    """Provides secrets configuration status to the LLM context."""
    
    name = "SECRETS_STATUS"
    description = "Provides information about configured secrets and their status"
    
    async def get(self, runtime: AgentRuntime, message: Message, state: Dict) -> Optional[str]:
        """Get secrets status for context."""
        from .service import SecretsService
        from .activator import PluginActivatorService
        
        secrets_service: Optional[SecretsService] = runtime.get_service(SecretsService.service_type)
        if not secrets_service:
            return None
        
        context = SecretContext(
            level=SecretLevel.GLOBAL,
            agent_id=runtime.agent_id,
        )
        
        # Get list of secrets
        metadata = await secrets_service.list(context)
        
        if not metadata.keys:
            return "No secrets configured."
        
        # Build status string
        lines = ["Configured secrets:"]
        
        for key in metadata.keys[:10]:  # Limit to 10 for context
            config = await secrets_service.get_config(key, context)
            status = "configured"
            if config and config.description:
                lines.append(f"- {key}: {status} ({config.description})")
            else:
                lines.append(f"- {key}: {status}")
        
        if len(metadata.keys) > 10:
            lines.append(f"... and {len(metadata.keys) - 10} more")
        
        # Add pending plugins info
        activator: Optional[PluginActivatorService] = runtime.get_service(PluginActivatorService.service_type)
        if activator:
            pending = activator.get_pending_plugins()
            if pending:
                lines.append("")
                lines.append("Plugins waiting for secrets:")
                for p in pending[:5]:
                    plugin_name = p.plugin.plugin.name if hasattr(p.plugin.plugin, "name") else "Unknown"
                    if p.status:
                        missing = ", ".join(p.status.missing_required[:3])
                        lines.append(f"- {plugin_name}: needs {missing}")
                    else:
                        lines.append(f"- {plugin_name}: checking...")
        
        return "\n".join(lines)


class SecretsInfoProvider(Provider):
    """Provides detailed secrets information when asked about secrets."""
    
    name = "SECRETS_INFO"
    description = "Provides detailed information about the secrets system"
    
    async def get(self, runtime: AgentRuntime, message: Message, state: Dict) -> Optional[str]:
        """Get secrets info for context."""
        text = message.content.get("text", "").lower() if isinstance(message.content, dict) else str(message.content).lower()
        
        # Only provide if user is asking about secrets
        if not any(kw in text for kw in ["secret", "api key", "token", "credential", "configure"]):
            return None
        
        from .service import SecretsService
        
        secrets_service: Optional[SecretsService] = runtime.get_service(SecretsService.service_type)
        if not secrets_service:
            return "Secrets management is not available."
        
        lines = [
            "Secret Management Information:",
            "",
            "You can help users manage their secrets with these operations:",
            "- Set a secret: 'Set OPENAI_API_KEY to sk-abc123'",
            "- List secrets: 'List my configured secrets'",
            "- Check a secret: 'Is ANTHROPIC_API_KEY configured?'",
            "- Delete a secret: 'Delete my GROQ_API_KEY'",
            "",
            "Secrets are stored securely with encryption.",
            "Three levels are supported:",
            "- Global: Agent-wide secrets (API keys)",
            "- World: Server/channel specific secrets",
            "- User: Per-user secrets",
            "",
            "Common secrets that may need configuration:",
            "- OPENAI_API_KEY: For OpenAI/GPT models",
            "- ANTHROPIC_API_KEY: For Claude models",
            "- GROQ_API_KEY: For Groq inference",
            "- DISCORD_TOKEN: For Discord bot",
            "- TELEGRAM_TOKEN: For Telegram bot",
        ]
        
        return "\n".join(lines)


# Export providers
secrets_status_provider = SecretsStatusProvider()
secrets_info_provider = SecretsInfoProvider()
