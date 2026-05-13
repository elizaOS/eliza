# Skill Invocation Surfaces — claude-code / opencode / openhands / codex / pi vs. agentskills.io spec

Source-level audit of *how* each harness exposes skills to the model (tool call vs.
prompt injection), what frontmatter it recognises, and how invocations show up in the
trajectory. Goes deeper than per-path discovery on the five harnesses benchflow
currently registers.

**Verified 2026-05-03.** OpenHands rows reflect the unreleased CLI `main` (sdk
1.19+), which has changed the implementation substantively since our 2026-04-30
audit; released CLI `1.15.0` (sdk 1.17.0) does **not** yet have these features.

---

## Sources audited

| Harness | Ref | Files |
|---|---|---|
| **agentskills.io spec** | `agentskills/agentskills@main` | `docs/specification.mdx` |
| **claude-code** | docs at `code.claude.com/docs/en/skills` | reference impl |
| **opencode** | `opencode.ai/docs/skills` (current) | TypeScript runtime, Skills doc rev May 2026 |
| **openhands (new sdk)** | `OpenHands/software-agent-sdk@main` (2026-04-28) | `openhands-sdk/openhands/sdk/tool/builtins/invoke_skill.py`, `openhands-sdk/openhands/sdk/skills/__init__.py` |
| **codex** | `openai/codex@main` | `codex-rs/core-skills/src/injection.rs`, `codex-rs/core/src/context/skill_instructions.rs`, `codex-rs/core/src/skills.rs` |
| **pi** | last-verified 2026-04-30; `inception-ai/pi-mono` no longer publicly accessible | flagged below — **needs reverification** |

---

## Frontmatter recognition vs. spec

The agentskills.io spec defines `name` and `description` as required and
`license`/`compatibility`/`metadata`/`allowed-tools` (experimental) as optional
([spec](https://agentskills.io/specification),
[`docs/specification.mdx`](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)).

| Field | Spec | claude-code | opencode | openhands (sdk 1.19+) | codex | pi (Apr 30 — needs reverify) |
|---|---|---|---|---|---|---|
| `name` (req) | required | ✓ | ✓ | ✓ | ✓ | ✓ |
| `description` (req) | required | ✓ | ✓ | ✓ | ✓ | ✓ |
| `license` | optional | ✓ | ✓ | ignored | ignored | ✓ |
| `compatibility` | optional | ✓ | ✓ | ignored | ignored | ✓ |
| `metadata` | optional | ✓ | ✓ | ignored | ignored | ✓ |
| `allowed-tools` | experimental | **enforced** | ignored | ignored | ignored | **enforced** |
| Beyond-spec extensions | n/a | `disable-model-invocation`, `paths`, `context: fork`, `agent`, `model`, `effort`, `hooks`, `arguments` | none (spec-strict) | `triggers` (KeywordTrigger / TaskTrigger) | sibling `agents/openai.yaml`: `policy.allow_implicit_invocation`, `dependencies.tools` (per-skill MCP) | `disable-model-invocation` |

opencode evidence: docs explicitly enumerate the recognised fields and add
"Unknown frontmatter fields are ignored" — `allowed-tools` is not in the list
([opencode.ai/docs/skills](https://opencode.ai/docs/skills)).

openhands evidence: `openhands-sdk/openhands/sdk/skills/__init__.py` exports
`Skill`, `SkillResources`, triggers (`KeywordTrigger`, `TaskTrigger`), and
install lifecycle but no permission frontmatter handling.

---

## Discovery paths

| Harness | Paths searched |
|---|---|
| **claude-code** | `~/.claude/skills/`, `<proj>/.claude/skills/`, plugin dirs, enterprise (live-watched) |
| **opencode** | `.opencode/skills/`, `~/.config/opencode/skills/`, `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`, `~/.agents/skills/` (project paths walked to git root) |
| **openhands** | `.agents/skills/`, `~/.openhands/skills/`, plus `OpenHands/extensions` public registry via `load_public_skills` |
| **codex** | `.agents/skills/` walked to repo root, `~/.agents/skills/`, `/etc/codex/skills/`, bundled |
| **pi** | `.pi/skills/`, `.agents/skills/` (walked), `~/.pi/agent/skills/`, `~/.agents/skills/`, packages, `--skill <path>` |

opencode evidence: "OpenCode searches these locations: `.opencode/skills/<name>/SKILL.md`,
`~/.config/opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`,
`~/.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`,
`~/.agents/skills/<name>/SKILL.md`" ([opencode.ai/docs/skills](https://opencode.ai/docs/skills)).

---

## Invocation surface

| | claude-code | opencode | openhands (new sdk) | codex | pi |
|---|---|---|---|---|---|
| **Activation** | model picks from desc list (auto) + `/skill-name` slash | model calls `skill({name})` tool | model calls `invoke_skill(name="…")` tool | `$skill-name` mention OR command-pattern implicit match | model picks from desc list + `/skill:name` |
| **Body delivery** | tool-call observation | tool-call observation | tool-call observation | injected as `<skill>` user-role text fragment | tool-call observation |
| **Trajectory event** | `Skill(name=…)` tool call | `skill(name=…)` tool call | `invoke_skill(name=…)` tool call | **none** — only a user-role text fragment with `<skill>` markers (analytics counter `codex.skill.injected` is out-of-band) | tool call |
| **Progressive disclosure** | desc in ctx, body on invoke | desc in ctx, body on invoke | desc in ctx, body on invoke | nothing in ctx until activation triggers, then full body | desc in ctx, body on invoke |

### Codex evidence — prompt injection, not a tool

`codex-rs/core-skills/src/injection.rs` (excerpted):

```rust
pub async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],
    ...
) -> SkillInjections {
    ...
    for skill in mentioned_skills {
        match fs.read_file_text(&skill.path_to_skills_md, None).await {
            Ok(contents) => {
                ...
                invocations.push(SkillInvocation {
                    skill_name: skill.name.clone(),
                    skill_scope: skill.scope,
                    skill_path: skill.path_to_skills_md.to_path_buf(),
                    invocation_type: InvocationType::Explicit,
                });
                result.items.push(SkillInjection {
                    name: skill.name.clone(),
                    path: skill.path_to_skills_md.to_string_lossy().into_owned(),
                    contents,
                });
            }
            ...
        }
    }
    analytics_client.track_skill_invocations(tracking, invocations);
    ...
}
```

`codex-rs/core/src/context/skill_instructions.rs`:

```rust
impl ContextualUserFragment for SkillInstructions {
    const ROLE: &'static str = "user";
    const START_MARKER: &'static str = "<skill>";
    const END_MARKER: &'static str = "</skill>";
    fn body(&self) -> String {
        format!("\n<name>{}</name>\n<path>{}</path>\n{}\n",
            self.name, self.path, self.contents)
    }
}
```

The `SkillInvocation` analytics record is a separate stream from the trajectory.
Activation entry points: `collect_explicit_skill_mentions` (`$skill-name` token via
`TOOL_MENTION_SIGIL = "$"`) and `detect_implicit_skill_invocation_for_command`
(pattern-match against skill metadata) — both in `codex-rs/core-skills/src/`.

### OpenHands evidence — first-class tool

`openhands-sdk/openhands/sdk/tool/builtins/invoke_skill.py` (excerpted):

```python
class InvokeSkillAction(Action):
    name: str = Field(description="Name of the loaded skill to invoke.")

TOOL_DESCRIPTION = """Invoke a skill by name.

This is the only supported way to invoke a skill listed in
`<available_skills>`. Call it with the `<name>` shown in that block; the
skill's full content is rendered (including any dynamic context) and
returned as the tool result.
"""

class InvokeSkillExecutor(ToolExecutor):
    @staticmethod
    def _record_invocation(conversation, name):
        invoked = conversation.state.invoked_skills
        if name not in invoked:
            invoked.append(name)
    def __call__(self, action, conversation=None):
        skills, working_dir = self._get_skills_and_working_dir(conversation)
        match = next((s for s in skills if s.name == action.name.strip()), None)
        ...
        rendered = render_content_with_commands(match.content, working_dir=working_dir)
        rendered = self._append_skill_location_footer(rendered, match.source, working_dir)
        self._record_invocation(conversation, action.name.strip())
        return InvokeSkillObservation.from_text(text=rendered, skill_name=action.name.strip())
```

Two trajectory-auditable signals: (1) the `invoke_skill` tool call event itself,
(2) `conversation.state.invoked_skills` accumulator.

CLI version pinning:
- CLI `1.15.0` (released 2026-04-24) → `openhands-sdk==1.17.0` → no `invoke_skill`
- CLI `main` (unreleased) → `openhands-sdk==1.19.0` → has `invoke_skill`
- `invoke_skill.py` first appears at `software-agent-sdk@v1.18.0` (verified by 404→200 on raw URL across tags)

### opencode evidence — first-class tool

[opencode.ai/docs/skills](https://opencode.ai/docs/skills): "Agents see available
skills and can load the full content when needed." Tool description format:

```xml
<available_skills>
  <skill>
    <name>git-release</name>
    <description>Create consistent releases and changelogs</description>
  </skill>
</available_skills>
```

"The agent loads a skill by calling the tool: `skill({ name: "git-release" })`."

---

## Permission / scoping per skill

| | claude-code | opencode | openhands | codex | pi |
|---|---|---|---|---|---|
| **Per-skill tool gating** | `allowed-tools` frontmatter | none (skill-level allow/deny via `opencode.json` glob patterns: `allow`/`deny`/`ask`) | none | `policy.allow_implicit_invocation` per skill | `allowed-tools` |
| **Disable model invocation** | `disable-model-invocation` frontmatter | global tool disable (`tools.skill: false`) + per-agent permissions | none | n/a | `disable-model-invocation` frontmatter |
| **Sandbox / fork** | `context: fork` → subagent | none | none | inherits session sandbox (landlock+seccomp / seatbelt) | none |
| **Per-skill MCP deps** | none | none | none | `dependencies.tools[type=mcp]` in sibling `agents/openai.yaml` | none |

opencode evidence: `permission.skill` block with glob patterns and three
verbs (`allow`/`deny`/`ask`); per-agent override via agent frontmatter
`permission.skill` map.

---

## Lifecycle & registry

| | claude-code | opencode | openhands | codex | pi |
|---|---|---|---|---|---|
| **Install/enable/disable API** | filesystem + plugin manager | filesystem + permissions | **`install_skill`/`uninstall_skill`/`enable_skill`/`update_skill`** (only one with this) | filesystem + bundled | `--skill <path>` flag |
| **Public registry** | Anthropic-bundled + plugins | none | `OpenHands/extensions` (`load_public_skills`) | bundled in repo | none |
| **Live reload** | yes (filesystem watch) | unknown | unknown | unknown | `/model` reloads; skill watch unknown |

openhands evidence — `openhands-sdk/openhands/sdk/skills/__init__.py` module docstring:

```
**Installed Skills Management:**
- `install_skill` - Install a skill from a source
- `uninstall_skill` - Uninstall a skill
- `list_installed_skills` - List all installed skills
- `load_installed_skills` - Load enabled installed skills
- `enable_skill`, `disable_skill` - Toggle skill enabled state
- `update_skill` - Update an installed skill
```

---

## Spec compliance summary

| Harness | Reads spec frontmatter | Implements `allowed-tools` (experimental) | Beyond-spec extensions |
|---|---|---|---|
| **claude-code** | full | ✓ | richest superset |
| **opencode** | full | ✗ (ignored) | none — spec-strict |
| **openhands** | partial — only `name`+`description` | ✗ | `triggers` |
| **codex** | partial — only `name`+`description` | ✗ | sibling-file MCP/policy |
| **pi (Apr 30)** | full | ✓ | `disable-model-invocation` |

---

## One-line characterisation

- **claude-code** — reference implementation. Richest frontmatter, richest scoping. Skill = first-class tool with permission gates.
- **opencode** — spec-strict. Native `skill` tool. Best discovery breadth (reads `.claude/skills/` and `.agents/skills/` natively). Permissions live in config, not frontmatter.
- **openhands (new sdk)** — first-class `invoke_skill` tool. Only one with a real install/registry lifecycle. No per-skill scoping yet.
- **codex** — *intentionally* not a tool. Skills are prompt injections, but with the richest activation model (mention + command-pattern) and the only per-skill MCP wiring.
- **pi** — closest spiritual clone of claude-code. Same frontmatter superset, same auto+slash invocation. No registry. **Public source no longer accessible — needs reverification.**

---

## Implication for SkillsBench measurement

For "did the agent use the skill?" — counted from the trajectory alone:

| Harness | Counting method | Reliable? |
|---|---|---|
| claude-code | grep `Skill(name=…)` tool calls | ✓ |
| opencode | grep `skill(name=…)` tool calls | ✓ |
| openhands (new sdk) | grep `invoke_skill(name=…)` tool calls **or** read `state.invoked_skills` | ✓ |
| codex | grep user-role text for `<skill>` markers (misses implicit pattern triggers — those land in OTel `codex.skill.injected` only) | partial |
| pi | grep skill tool calls | ✓ (assuming Apr 30 model still holds) |

OpenHands' new SDK flips the harness from worst-case (rebrand of microagents,
keyword-trigger prompt injection, no audit signal) to tied-best for SkillsBench's
measurement model. Codex remains an outlier — its skills are deliberately
not tool calls, so reward-vs-skill-use analysis from trajectories alone
under-counts it.

---

## Re-rank delta vs. earlier (2026-04-30) audit

| Old (Apr 30) | New (May 03) | Movement |
|---|---|---|
| 1. claude-code | 1. claude-code | unchanged |
| 2. opencode | 2. opencode ↔ openhands (tied) | openhands jumps 3 places |
| 3. pi | 3. pi | unchanged |
| 4. codex | 4. codex | unchanged |
| 5. openhands | — | promoted |

The Apr 30 audit placed openhands at #5 because skills were keyword-triggered
prompt extensions (microagents rebrand) with no tool-call audit signal. SDK
v1.18.0 (released bundled with the Apr 28 CLI-main bump to sdk 1.19.0)
introduced `invoke_skill` as a first-class tool, which addresses both the
auditability and progressive-disclosure concerns. Per-skill permission
scoping is still missing, so claude-code retains #1.

---

## Open questions

1. **Pi current state** — repo no longer publicly accessible; if pi-mono moved or
   went closed, our claim of `allowed-tools` enforcement is unverifiable. Re-audit
   before relying on it for harness ranking.
2. **OpenHands CLI release timing** — `invoke_skill` only ships when CLI cuts a
   release pinning sdk ≥1.18.0. As of 2026-05-03, latest released CLI is 1.15.0.
3. **`allowed-tools` adoption** — only claude-code and pi enforce it. The spec
   marks it experimental. Worth raising with the spec maintainers whether to
   promote or drop, since 3 of 5 major harnesses ignore it.
4. **Codex implicit-trigger counting** — `detect_implicit_skill_invocation_for_command`
   never appears in the trajectory. To count codex skill use accurately, SkillsBench
   would need to ingest the `codex.skill.injected` OTel counter or the
   `track_skill_invocations` analytics stream — not possible in a sandboxed eval
   without instrumentation hooks.
