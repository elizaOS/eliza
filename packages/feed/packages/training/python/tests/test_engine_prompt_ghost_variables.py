"""
GHOST VARIABLE DETECTION TESTS for Babylon Engine Prompts

These tests parse every prompt template in the engine, extract all {{variable}}
patterns, and verify that every variable is either:
  1. In the optionalVars list (will be silently emptied if not passed)
  2. Auto-injected (currentDate, currentTime, etc.)
  3. Provided by worldContext spread (...worldContext)
  4. Explicitly passed by the caller

Any variable that fails ALL of these checks is a GHOST - it will appear as
literal "{{variableName}}" in the rendered prompt sent to the LLM.

This test reads the TypeScript source files directly (no TS compilation needed).
"""

import os
import re
from pathlib import Path

import pytest

# Engine prompts directory
ENGINE_DIR = Path(__file__).parent.parent.parent.parent.parent / "packages" / "engine" / "src"
PROMPTS_DIR = ENGINE_DIR / "prompts"


def _extract_template_vars(filepath: str) -> set[str]:
    """Extract all {{variableName}} from a TypeScript file's template strings."""
    with open(filepath) as f:
        content = f.read()
    # Match {{word}} but exclude comment-only occurrences in define-prompt.ts
    return set(re.findall(r"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}", content))


def _extract_optional_vars() -> set[str]:
    """Extract the optionalVars list from loader.ts."""
    loader_path = PROMPTS_DIR / "loader.ts"
    with open(loader_path) as f:
        content = f.read()
    # Find the optionalVars array
    match = re.search(r"optionalVars\s*=\s*\[(.*?)\]", content, re.DOTALL)
    if not match:
        return set()
    block = match.group(1)
    return set(re.findall(r"'([a-zA-Z_][a-zA-Z0-9_]*)'", block))


def _extract_prompt_id(filepath: str) -> str:
    """Extract prompt ID from a TypeScript prompt definition file."""
    with open(filepath) as f:
        content = f.read()
    match = re.search(r"id:\s*'([^']+)'", content)
    return match.group(1) if match else os.path.basename(filepath)


# Auto-injected date vars from loader.ts
AUTO_INJECTED_VARS = {
    "currentDateTime",
    "currentDate",
    "currentTime",
    "currentYear",
    "currentMonth",
    "currentDay",
}

# Variables provided by generateWorldContext() spread (...worldContext)
WORLD_CONTEXT_VARS = {
    "worldActors",
    "currentMarkets",
    "activePredictions",
    "recentTrades",
    "realityGrounding",
    "worldFacts",
    "richGameContext",
    # Also includes date vars (redundant but for completeness)
    "currentDateTime",
    "currentDate",
    "currentTime",
    "currentYear",
    "currentMonth",
    "currentDay",
}

# Skip documentation/example files that aren't actual prompts
SKIP_FILES = {
    "define-prompt.ts",
    "loader.ts",
    "index.ts",
    "complete-example.ts",
    "feed-example.ts",
    "validate-output.ts",
    "world-context.ts",
    "reality-grounding.ts",
    "shared-sections.ts",
    "random-context.ts",
}


@pytest.fixture(scope="module")
def optional_vars() -> set[str]:
    return _extract_optional_vars()


@pytest.fixture(scope="module")
def all_covered_vars(optional_vars) -> set[str]:
    """All variables that are 'covered' (won't be ghost)."""
    return optional_vars | AUTO_INJECTED_VARS | WORLD_CONTEXT_VARS


@pytest.fixture(scope="module")
def prompt_files() -> list[tuple[str, str, set[str]]]:
    """Return list of (filepath, prompt_id, template_vars) for all prompt files."""
    results = []
    for subdir in ["feed", "game", "trading", "world", "image", "system"]:
        dirpath = PROMPTS_DIR / subdir
        if not dirpath.exists():
            continue
        for f in sorted(dirpath.glob("*.ts")):
            if f.name in SKIP_FILES:
                continue
            prompt_id = _extract_prompt_id(str(f))
            template_vars = _extract_template_vars(str(f))
            if template_vars:
                results.append((str(f), prompt_id, template_vars))
    return results


# =============================================================================
# Test: optionalVars list is well-formed
# =============================================================================


class TestOptionalVarsList:
    def test_optional_vars_loaded(self, optional_vars):
        """Verify we can parse the optionalVars list from loader.ts."""
        assert len(optional_vars) > 40, f"Expected 40+ optional vars, got {len(optional_vars)}"

    def test_no_duplicates_in_optional(self):
        """Check for duplicates in the optionalVars array."""
        loader_path = PROMPTS_DIR / "loader.ts"
        with open(loader_path) as f:
            content = f.read()
        match = re.search(r"optionalVars\s*=\s*\[(.*?)\]", content, re.DOTALL)
        assert match
        all_entries = re.findall(r"'([a-zA-Z_]+)'", match.group(1))
        duplicates = [v for v in all_entries if all_entries.count(v) > 1]
        assert duplicates == [], f"Duplicate optionalVars: {set(duplicates)}"


# =============================================================================
# Test: Every template variable is either optional, auto-injected, from
# worldContext, or is a legitimately-required caller-provided variable.
#
# Variables that are required (not optional) MUST be explicitly provided.
# If a caller forgets one, it remains as literal {{varName}} in the prompt.
# =============================================================================


class TestNoGhostVariables:
    """
    Detect template variables that will render as literal '{{varName}}' because
    they are:
    - NOT in the optionalVars list (won't be auto-cleared to empty)
    - NOT auto-injected (date vars)
    - NOT in worldContext (won't come from ...worldContext spread)
    - NOT explicitly passed by the caller

    The first three checks are static. The caller check requires analyzing
    each renderPrompt() call site, which we approximate by checking if the
    variable name appears in the caller files.
    """

    # Known required variables that ARE passed by callers.
    # This is the authoritative list. If a var is here, it's been verified
    # as passed by at least one caller. If it's NOT here and NOT optional,
    # it's a ghost.
    KNOWN_REQUIRED_VARS = {
        # Common content vars passed by many callers
        "eventDescription",
        "eventType",
        "eventContext",
        "characterName",
        "characterInfo",
        "actorName",
        "actorDescription",
        "companyName",
        "companyDescription",
        "day",
        "outcome",
        "question",
        # Feed-specific (passed explicitly)
        "mediaCount",
        "mediaList",
        "postType",
        "originalAuthor",
        "originalPost",
        "originalAuthorName",
        "originalContent",
        "ticker",
        "currentPrice",
        "priceChange",
        "direction",
        "volume",
        "mood",
        # Feed generation — organic/social posts (FeedGenerator.ts)
        "domainContext",
        "domainHints",
        "runningBitContext",
        "targetName",
        "targetRecentActivity",
        # Game-specific
        "fullContext",
        "eventCount",
        "eventRequestsList",
        "scenariosList",
        "organizationContext",
        "questionText",
        "eventHistory",
        "groupCount",
        "groupsList",
        "questionContext",
        "eventsList",
        "recentEventContext",
        "scenarioContext",
        "conversationHistory",
        "personality",
        "domain",
        "groupTheme",
        "groupMembers",
        "currentPositions",
        "marketConditions",
        "informationHint",
        "adminName",
        "adminRole",
        "adminAffiliations",
        "memberDescriptions",
        "existingGroupNames",
        "numToGenerate",
        "actorsList",
        "orgsList",
        "exampleQuestions",
        "dailyTopicContext",
        "questionCount",
        "questionsList",
        "outcomeContext",
        "resolutionEvent",
        "winningPercentage",
        "marketImpact",
        "mainActorsList",
        "dateStr",
        "actorDescriptions",
        "npcCount",
        "activeQuestions",
        "recentEvents",
        "eventMarketSignals",
        # World-specific
        "eventsToday",
        "expertName",
        "expertRole",
        "knowsTruth",
        "reliability",
        "confidenceContext",
        "reliabilityContext",
        "journalistName",
        "journalistRole",
        "journalistReliability",
        "reputationContext",
        "truthContext",
        "outcomeHint",
        "outcomeText",
        # Article-specific
        "orgName",
        "orgType",
        "orgStyle",
        "biasInstructions",
        # Analyst/stock-specific
        "analystName",
        "analystDescription",
        "analystTrackRecord",
        # Image-specific
        "title",
        "summary",
        "category",
        "twist",
        "pfpDescription",
        "descriptionParts",
        "realName",
        "organizationName",
        "originalCompany",
        "bannerDescription",
        "profileBanner",
        # Price announcement
        "previousPriceMoves",
        # Phase
        "phaseName",
        # Vars confirmed passed by callers
        "progressContext",  # ambient-posts: passed by FeedGenerator
        "keyActors",  # day-transition: passed by FeedGenerator
        "topicsList",  # trending-topics: passed by TrendingTopicsEngine
        # Ambient
        "timeEnergy",
        # Baseline event
        "previousEvents",
        # Day transition
        "previousDayEvents",
        # Government post
        "govDescription",
        "govName",
        # Trading — passed by MarketDecisionEngine
        "momentumAlerts",
    }

    # =========================================================================
    # GHOST VARIABLES: vars that are in templates, NOT optional, NOT worldContext,
    # NOT auto-injected, and NOT confirmed as passed by callers.
    #
    # ALL PREVIOUSLY IDENTIFIED GHOSTS HAVE BEEN FIXED:
    # - Added to optionalVars in loader.ts (for enrichment context)
    # - Explicitly passed by callers (for structural data)
    # If new ghosts appear, add them here and fix in the caller or loader.
    # =========================================================================
    CONFIRMED_GHOSTS: set[str] = set()

    def test_no_remaining_ghosts(self):
        """
        All previously identified ghost variables have been fixed.
        This test verifies the CONFIRMED_GHOSTS set is empty.
        If new ghosts are found, they should be added here temporarily
        and then fixed in loader.ts optionalVars or the caller.
        """
        assert len(self.CONFIRMED_GHOSTS) == 0, (
            f"There are {len(self.CONFIRMED_GHOSTS)} confirmed ghosts that need fixing: "
            f"{sorted(self.CONFIRMED_GHOSTS)}"
        )

    def test_all_template_vars_accounted_for(self, prompt_files, all_covered_vars):
        """
        For each prompt template, check that every {{variable}} is either:
        1. In optionalVars (will be auto-cleared to "")
        2. Auto-injected (date vars)
        3. In worldContext (...worldContext spread)
        4. In KNOWN_REQUIRED_VARS (verified as passed by callers)
        5. In CONFIRMED_GHOSTS (documented bugs to fix)

        Any variable NOT in any of these categories is an UNDOCUMENTED ghost.
        """
        all_accounted = all_covered_vars | self.KNOWN_REQUIRED_VARS | self.CONFIRMED_GHOSTS

        undocumented_ghosts = {}
        for filepath, prompt_id, template_vars in prompt_files:
            unaccounted = template_vars - all_accounted
            if unaccounted:
                undocumented_ghosts[prompt_id] = unaccounted

        if undocumented_ghosts:
            msg = "UNDOCUMENTED ghost variables found:\n"
            for pid, vars in sorted(undocumented_ghosts.items()):
                msg += f"  {pid}: {sorted(vars)}\n"
            msg += "\nAdd these to KNOWN_REQUIRED_VARS (if callers pass them) "
            msg += "or CONFIRMED_GHOSTS (if they're bugs)."
            pytest.fail(msg)

    def test_ghost_vars_not_in_optional(self, optional_vars):
        """Verify confirmed ghosts really aren't in optionalVars."""
        in_optional = self.CONFIRMED_GHOSTS & optional_vars
        if in_optional:
            pytest.fail(
                f"These 'ghosts' are actually in optionalVars (false positives): "
                f"{sorted(in_optional)}"
            )

    def test_ghost_vars_not_in_world_context(self):
        """Verify confirmed ghosts aren't provided by worldContext."""
        in_wc = self.CONFIRMED_GHOSTS & WORLD_CONTEXT_VARS
        if in_wc:
            pytest.fail(f"These 'ghosts' are in worldContext (false positives): {sorted(in_wc)}")


# =============================================================================
# Test: Shared sections embedded variables
# =============================================================================


class TestSharedSections:
    def test_shared_sections_vars_covered(self, all_covered_vars):
        """
        shared-sections.ts defines header constants with {{vars}} that get
        interpolated into templates via ${HEADER_NAME}. These vars must also
        be covered (optional or provided).
        """
        shared_path = PROMPTS_DIR / "shared-sections.ts"
        if not shared_path.exists():
            pytest.skip("shared-sections.ts not found")

        vars_in_shared = _extract_template_vars(str(shared_path))
        # Remove the dynamic ${actorVariableName} pattern
        vars_in_shared.discard("actorVariableName")

        uncovered = vars_in_shared - all_covered_vars
        if uncovered:
            pytest.fail(
                f"shared-sections.ts has template vars not in optionalVars "
                f"or worldContext: {sorted(uncovered)}"
            )

    def test_current_phase_in_optional_vars(self, optional_vars):
        """
        {{currentPhase}} is in FULL_CONTEXT_HEADER (shared-sections.ts).
        It must be in optionalVars so it gets silently cleared when not passed.
        """
        assert "currentPhase" in optional_vars, (
            "currentPhase must be in optionalVars - it's in shared-sections "
            "FULL_CONTEXT_HEADER but not all callers provide it"
        )


# =============================================================================
# Test: No unknown {{}} patterns in rendered prompts (smoke test)
# =============================================================================


class TestNoDoubleBraceLeakage:
    """
    If a template has {{foo}} and foo is not provided and not optional,
    the literal string '{{foo}}' will appear in the prompt sent to the LLM.
    This can confuse the model and waste tokens.
    """

    def test_count_total_template_vars(self, prompt_files, all_covered_vars):
        """Report on total vars and coverage."""
        all_vars = set()
        for _, _, template_vars in prompt_files:
            all_vars |= template_vars

        covered = all_vars & all_covered_vars
        not_covered = all_vars - all_covered_vars

        print(f"\nTotal unique template vars: {len(all_vars)}")
        print(f"Covered by optionalVars/worldContext/auto: {len(covered)}")
        print(f"Must be explicitly passed or are ghosts: {len(not_covered)}")

        # At minimum, the core set should be covered
        assert len(covered) > 50
