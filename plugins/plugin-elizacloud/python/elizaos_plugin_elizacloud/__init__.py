__version__ = "1.7.4"

# ─── Model Handlers ─────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.models import (
    handle_batch_text_embedding,
    handle_image_description,
    handle_image_generation,
    handle_object_large,
    handle_object_small,
    handle_text_embedding,
    handle_text_large,
    handle_text_small,
    handle_text_to_speech,
    handle_tokenizer_decode,
    handle_tokenizer_encode,
    handle_transcription,
)

# ─── Inference Client ────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.providers import ElizaCloudClient

# ─── Inference Types ─────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.types import (
    DetokenizeTextParams,
    ElizaCloudConfig,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ObjectGenerationParams,
    TextEmbeddingParams,
    TextGenerationParams,
    TextToSpeechParams,
    TokenizeTextParams,
    TranscriptionParams,
)

# ─── Cloud Services ──────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.services import (
    CloudAuthService,
    CloudBackupService,
    CloudBridgeService,
    CloudContainerService,
)

# ─── Cloud Actions ───────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.actions import (
    check_cloud_credits_action,
    freeze_cloud_agent_action,
    provision_cloud_agent_action,
    resume_cloud_agent_action,
)
from elizaos_plugin_elizacloud.actions.check_credits import handle_check_credits, validate_check_credits
from elizaos_plugin_elizacloud.actions.freeze_agent import handle_freeze, validate_freeze
from elizaos_plugin_elizacloud.actions.provision_agent import (
    ServiceRegistry,
    handle_provision,
    validate_provision,
)
from elizaos_plugin_elizacloud.actions.resume_agent import handle_resume, validate_resume

# ─── Cloud Providers ─────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.cloud_providers import (
    cloud_status_provider,
    container_health_provider,
    credit_balance_provider,
)
from elizaos_plugin_elizacloud.cloud_providers.cloud_status import get_cloud_status
from elizaos_plugin_elizacloud.cloud_providers.container_health import get_container_health
from elizaos_plugin_elizacloud.cloud_providers.credit_balance import get_credit_balance

# ─── Cloud Utils ─────────────────────────────────────────────────────────────
from elizaos_plugin_elizacloud.utils import CloudApiClient
from elizaos_plugin_elizacloud.utils.forwarded_settings import FORWARDED_SETTINGS, collect_env_vars

__all__ = [
    "__version__",
    # Inference client
    "ElizaCloudClient",
    "CloudApiClient",
    # Inference types
    "ElizaCloudConfig",
    "TextGenerationParams",
    "ObjectGenerationParams",
    "TextEmbeddingParams",
    "ImageGenerationParams",
    "ImageDescriptionParams",
    "ImageDescriptionResult",
    "TextToSpeechParams",
    "TranscriptionParams",
    "TokenizeTextParams",
    "DetokenizeTextParams",
    # Model handlers
    "handle_text_small",
    "handle_text_large",
    "handle_object_small",
    "handle_object_large",
    "handle_text_embedding",
    "handle_batch_text_embedding",
    "handle_image_generation",
    "handle_image_description",
    "handle_text_to_speech",
    "handle_transcription",
    "handle_tokenizer_encode",
    "handle_tokenizer_decode",
    # Cloud services
    "CloudAuthService",
    "CloudContainerService",
    "CloudBridgeService",
    "CloudBackupService",
    # Cloud actions
    "provision_cloud_agent_action",
    "freeze_cloud_agent_action",
    "resume_cloud_agent_action",
    "check_cloud_credits_action",
    "ServiceRegistry",
    "handle_provision",
    "validate_provision",
    "handle_freeze",
    "validate_freeze",
    "handle_resume",
    "validate_resume",
    "handle_check_credits",
    "validate_check_credits",
    # Cloud providers
    "cloud_status_provider",
    "credit_balance_provider",
    "container_health_provider",
    "get_cloud_status",
    "get_credit_balance",
    "get_container_health",
    # Utils
    "FORWARDED_SETTINGS",
    "collect_env_vars",
]


def get_plugin() -> dict[str, object]:
    return {
        "name": "@elizaos/plugin-elizacloud",
        "description": (
            "elizaOS Cloud plugin — Multi-model AI generation, container provisioning, "
            "agent bridge, and billing management"
        ),
        "version": __version__,
        "models": {
            "TEXT_SMALL": handle_text_small,
            "TEXT_LARGE": handle_text_large,
            "OBJECT_SMALL": handle_object_small,
            "OBJECT_LARGE": handle_object_large,
            "TEXT_EMBEDDING": handle_text_embedding,
            "IMAGE": handle_image_generation,
            "IMAGE_DESCRIPTION": handle_image_description,
            "TEXT_TO_SPEECH": handle_text_to_speech,
            "TRANSCRIPTION": handle_transcription,
            "TEXT_TOKENIZER_ENCODE": handle_tokenizer_encode,
            "TEXT_TOKENIZER_DECODE": handle_tokenizer_decode,
        },
        "services": [
            CloudAuthService,
            CloudContainerService,
            CloudBridgeService,
            CloudBackupService,
        ],
        "actions": [
            provision_cloud_agent_action,
            freeze_cloud_agent_action,
            resume_cloud_agent_action,
            check_cloud_credits_action,
        ],
        "providers": [
            cloud_status_provider,
            credit_balance_provider,
            container_health_provider,
        ],
    }
