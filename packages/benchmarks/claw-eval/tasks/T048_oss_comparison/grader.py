"""T24en_oss_comparison grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T047zh_oss_comparison")


class OSSComparisonGraderEN(_Base):
    """English variant — adjusts keyword lists for English-only output."""

    LICENSE_CONCEPTS = {
        "rsalv2": ["RSALv2", "RSAL", "Redis Source Available License",
                   "Source Available License"],
        "sspl": ["SSPL", "SSPLv1", "Server Side Public License"],
        "bsd": ["BSD", "BSD 3-Clause", "BSD license"],
        "source_available": ["source-available", "source available",
                            "not open-source", "not open source",
                            "proprietary"],
        "dual_license": ["dual license", "dual-license",
                        "RSALv2/SSPLv1", "RSAL or SSPL"],
    }

    VALKEY_CONCEPTS = {
        "linux_foundation": ["Linux Foundation"],
        "fork": ["fork", "forked"],
        "timeline": ["March 2024", "march 2024", "2024"],
        "community": ["community-driven", "community driven",
                     "community governance", "open governance"],
    }

    TECHNICAL_CONCEPTS = {
        "api_compat": ["API compatible", "API-compatible", "compatible API",
                      "backward compatible", "backwards compatible"],
        "drop_in": ["drop-in", "drop in replacement", "seamless replacement"],
        "resp_protocol": ["RESP", "Redis Serialization Protocol",
                         "Redis protocol", "protocol compatible"],
        "redis_base": ["Redis 7.2", "7.2.4", "Redis 7"],
    }

    CLOUD_CONCEPTS = {
        "aws_elasticache": ["ElastiCache", "elasticache"],
        "aws_memorydb": ["MemoryDB", "memorydb"],
        "aws": ["AWS", "Amazon Web Services", "Amazon"],
        "google": ["Google Cloud", "Memorystore", "Google Cloud Memorystore"],
    }

    MIGRATION_CONCEPTS = {
        "compatible_protocol": ["compatible protocol", "protocol compatible",
                               "RESP compatible"],
        "minimal_changes": ["minimal changes", "minor changes",
                           "few changes", "little to no changes"],
        "configuration": ["configuration", "config",
                         "configuration compatible"],
    }

    COMMUNITY_CONCEPTS = {
        "contributors": ["contributors", "contributor", "committers",
                        "maintainers"],
        "releases": ["releases", "release", "version", "release cadence"],
        "governance": ["governance", "foundation governance",
                      "transparent governance", "open governance"],
    }

    RECOMMENDATION_CONCEPTS = {
        "recommend": ["recommend", "recommendation", "suggest",
                     "suggestion", "advise", "our recommendation"],
        "reasoning": ["because", "due to", "considering", "given that",
                     "based on", "rationale", "reasons"],
    }
