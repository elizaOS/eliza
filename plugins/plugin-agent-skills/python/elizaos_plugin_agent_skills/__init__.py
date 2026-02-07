"""
Agent Skills Plugin for elizaOS (Python)

Implements the Agent Skills specification with:
- Spec-compliant SKILL.md parsing and validation
- Progressive disclosure (metadata → instructions → resources)
- ClawHub registry integration
- Otto metadata compatibility
- Dual storage modes (memory/filesystem)

See: https://agentskills.io
"""

from .types import (
    Skill,
    SkillFrontmatter,
    SkillMetadata,
    SkillMetadataEntry,
    SkillInstructions,
    OttoMetadata,
    OttoInstallOption,
    SkillSearchResult,
    SkillCatalogEntry,
    SkillDetails,
    SkillValidationResult,
    SkillValidationError,
    SkillValidationWarning,
    SKILL_NAME_MAX_LENGTH,
    SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_COMPATIBILITY_MAX_LENGTH,
    SKILL_BODY_RECOMMENDED_TOKENS,
    SKILL_NAME_PATTERN,
)

from .parser import (
    parse_frontmatter,
    validate_frontmatter,
    validate_skill_directory,
    extract_body,
    estimate_tokens,
    generate_skills_xml,
)

from .storage import (
    ISkillStorage,
    MemorySkillStore,
    FileSystemSkillStore,
    SkillFile,
    SkillPackage,
    create_storage,
    load_skill_from_storage,
    install_from_github,
    install_from_url,
)

from .service import AgentSkillsService
from .plugin import plugin, agent_skills_plugin

from .actions import (
    search_skills_action,
    get_skill_details_action,
    get_skill_guidance_action,
    sync_catalog_action,
    run_skill_script_action,
)

__all__ = [
    # Plugin
    "plugin",
    "agent_skills_plugin",
    # Service
    "AgentSkillsService",
    # Storage
    "ISkillStorage",
    "MemorySkillStore",
    "FileSystemSkillStore",
    "SkillFile",
    "SkillPackage",
    "create_storage",
    "load_skill_from_storage",
    "install_from_github",
    "install_from_url",
    # Types
    "Skill",
    "SkillFrontmatter",
    "SkillMetadata",
    "SkillMetadataEntry",
    "SkillInstructions",
    "OttoMetadata",
    "OttoInstallOption",
    "SkillSearchResult",
    "SkillCatalogEntry",
    "SkillDetails",
    "SkillValidationResult",
    "SkillValidationError",
    "SkillValidationWarning",
    # Constants
    "SKILL_NAME_MAX_LENGTH",
    "SKILL_DESCRIPTION_MAX_LENGTH",
    "SKILL_COMPATIBILITY_MAX_LENGTH",
    "SKILL_BODY_RECOMMENDED_TOKENS",
    "SKILL_NAME_PATTERN",
    # Actions
    "search_skills_action",
    "get_skill_details_action",
    "get_skill_guidance_action",
    "sync_catalog_action",
    "run_skill_script_action",
    # Parser
    "parse_frontmatter",
    "validate_frontmatter",
    "validate_skill_directory",
    "extract_body",
    "estimate_tokens",
    "generate_skills_xml",
]
