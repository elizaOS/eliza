"""
Agent Skills Types

Implements the Agent Skills specification from agentskills.io
with Otto compatibility extensions.

See: https://agentskills.io/specification
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# ============================================================
# CONSTANTS
# ============================================================

SKILL_NAME_MAX_LENGTH = 64
SKILL_DESCRIPTION_MAX_LENGTH = 1024
SKILL_COMPATIBILITY_MAX_LENGTH = 500
SKILL_BODY_RECOMMENDED_TOKENS = 5000
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


# ============================================================
# OTTO EXTENSIONS
# ============================================================


@dataclass
class OttoInstallOption:
    """Otto installation option for dependencies."""

    id: str
    kind: str  # 'brew', 'apt', 'node', 'pip', 'cargo', 'manual'
    formula: Optional[str] = None
    package: Optional[str] = None
    bins: List[str] = field(default_factory=list)
    label: Optional[str] = None


@dataclass
class OttoMetadata:
    """Otto-specific metadata extensions."""

    emoji: Optional[str] = None
    requires: Optional[Dict[str, List[str]]] = None  # e.g., {"bins": ["gh"]}
    install: List[OttoInstallOption] = field(default_factory=list)




# ============================================================
# CORE SKILL TYPES
# ============================================================


@dataclass
class SkillMetadata:
    """Skill metadata - arbitrary key-value mapping."""

    author: Optional[str] = None
    version: Optional[str] = None
    otto: Optional[OttoMetadata] = None
    extra: Dict[str, object] = field(default_factory=dict)


@dataclass
class SkillFrontmatter:
    """
    Skill frontmatter as defined by the Agent Skills specification.

    Required fields: name, description
    Optional fields: license, compatibility, metadata, allowed_tools
    """

    name: str
    description: str
    license: Optional[str] = None
    compatibility: Optional[str] = None
    metadata: Optional[SkillMetadata] = None
    allowed_tools: Optional[str] = None
    homepage: Optional[str] = None


@dataclass
class Skill:
    """A fully loaded skill with parsed content."""

    slug: str
    name: str
    description: str
    version: str
    content: str
    frontmatter: SkillFrontmatter
    path: str
    scripts: List[str] = field(default_factory=list)
    references: List[str] = field(default_factory=list)
    assets: List[str] = field(default_factory=list)
    loaded_at: int = 0


@dataclass
class SkillMetadataEntry:
    """Skill metadata for progressive disclosure (Level 1)."""

    name: str
    description: str
    location: str


@dataclass
class SkillInstructions:
    """Skill instructions (Level 2)."""

    slug: str
    body: str
    estimated_tokens: int


# ============================================================
# REGISTRY TYPES
# ============================================================


@dataclass
class SkillSearchResult:
    """Search result from registry."""

    score: float
    slug: str
    display_name: str
    summary: str
    version: str
    updated_at: int


@dataclass
class SkillCatalogEntry:
    """Catalog entry from registry."""

    slug: str
    display_name: str
    summary: Optional[str]
    version: str
    tags: Dict[str, str] = field(default_factory=dict)
    stats: Dict[str, int] = field(default_factory=dict)  # downloads, stars
    updated_at: int = 0


@dataclass
class SkillDetails:
    """Detailed skill information from registry."""

    slug: str
    display_name: str
    summary: str
    tags: Dict[str, str]
    stats: Dict[str, int]
    created_at: int
    updated_at: int
    latest_version: str
    latest_version_created_at: int
    changelog: Optional[str] = None
    owner_handle: Optional[str] = None
    owner_display_name: Optional[str] = None


# ============================================================
# VALIDATION TYPES
# ============================================================


@dataclass
class SkillValidationError:
    """Validation error."""

    field: str
    message: str
    code: str


@dataclass
class SkillValidationWarning:
    """Validation warning."""

    field: str
    message: str
    code: str


@dataclass
class SkillValidationResult:
    """Skill validation result."""

    valid: bool
    errors: List[SkillValidationError] = field(default_factory=list)
    warnings: List[SkillValidationWarning] = field(default_factory=list)
