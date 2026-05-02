# WooBench — Mystical Reading Agent Benchmark

## 1. Purpose

WooBench evaluates an agent's ability to **conduct mystical readings as a revenue-generating service**. It measures not just accuracy of divination interpretation, but the agent's conversational skill at:

- Building rapport with diverse personality types
- Navigating skepticism, hostility, scam attempts, and manipulation
- Delivering readings that feel personalized and meaningful
- Getting positive feedback and "repeat business"
- Monetizing effectively (converting conversations to paid readings)

---

## 2. Architecture

```
benchmarks/woobench/
├── __init__.py
├── types.py                    # Type definitions
├── personas/                   # Simulated user personas
│   ├── __init__.py
│   ├── true_believer.py
│   ├── skeptic.py
│   ├── curious_newbie.py
│   ├── time_waster.py
│   ├── scammer.py
│   ├── emotional_crisis.py
│   ├── repeat_customer.py
│   └── antagonist.py
├── scenarios/                  # Pre-built conversation scenarios
│   ├── __init__.py
│   ├── tarot_scenarios.py
│   ├── iching_scenarios.py
│   ├── astrology_scenarios.py
│   └── cross_system_scenarios.py
├── evaluator.py                # Branching conversation evaluator
├── scorer.py                   # Multi-dimensional scoring
├── runner.py                   # Benchmark orchestration
├── metrics.py                  # Aggregated metrics
├── reporting.py                # Report generation
├── dataset.py                  # Dataset loading
├── plugin.py                   # ElizaOS plugin integration
├── agent.py                    # Agent under test
├── tests/
│   └── test_woobench.py
└── README.md
```

---

## 3. Persona System

Each persona is a simulated user with hidden information that a good reading would discover.

### 3.1 Persona Structure

```python
@dataclass
class Persona:
    id: str
    name: str
    archetype: str              # true_believer, skeptic, etc.
    background: str             # Hidden story the evaluator knows
    birth_data: BirthData | None  # For astrology scenarios
    hidden_context: HiddenContext
    engagement_style: str       # verbose, terse, emotional, analytical
    payment_willingness: float  # 0-1
    patience: int               # turns before disengaging
    response_tree: ResponseTree
```

```python
@dataclass
class HiddenContext:
    """The 'real story' behind the persona that a good reading should discover."""
    life_situation: str         # "Going through a divorce"
    key_themes: list[str]       # ["loss", "new_beginnings", "fear_of_change"]
    emotional_state: str        # "anxious but hopeful"
    specific_details: list[str] # ["partner of 12 years", "two kids", "career change"]
    trigger_words: list[str]    # Words that make the persona open up
    resistance_topics: list[str] # Topics they avoid or deflect
```

### 3.2 The Eight Archetypes

| Archetype | Description | Challenge for Agent |
|-----------|-------------|---------------------|
| **True Believer** | Deep believer, shares freely | Don't exploit. Give genuine reading. |
| **Skeptic** | "Prove it" attitude, demands specifics | Build credibility without being defensive. |
| **Curious Newbie** | Open-minded first-timer, lots of questions | Educate while reading. Don't overwhelm. |
| **Time Waster** | Engages but never pays, derails | Recognize pattern, redirect or disengage gracefully. |
| **Scammer** | Tries to manipulate the agent | Detect and deflect manipulation. |
| **Emotional Crisis** | Vulnerable, seeking real guidance | Handle with extreme care. Suggest professional help. |
| **Repeat Customer** | Returning for another reading | Remember context, deepen relationship. |
| **Antagonist** | Actively hostile, tries to break agent | Stay composed, set boundaries. |

---

## 4. Branching Conversation Evaluator

The core innovation: the **evaluator persona** responds dynamically based on what the agent says, following a decision tree.

### 4.1 Response Node Structure

```python
@dataclass
class ResponseNode:
    id: str
    condition: str             # Natural language condition evaluated by LLM
    # e.g., "Agent mentions themes of change or transition"
    # e.g., "Agent asks about relationships"
    
    positive_response: str     # If condition matches hidden context
    negative_response: str     # If it doesn't
    neutral_response: str      # If ambiguous
    
    points_if_positive: float
    points_if_negative: float
    
    follow_up_nodes: list[str]
    
    opens_up: bool             # Persona reveals more info
    disengages: bool           # Persona starts to leave
    escalates: bool            # Persona gets more intense
```

### 4.2 Evaluation Flow

```
For each turn:
  1. Agent sends message
  2. Evaluator (LLM with full persona context) evaluates:
     - Does the message match the current node's condition?
     - Result: positive / negative / neutral
  3. Select response branch
  4. Accumulate score
  5. Update persona state (opens_up, disengages, etc.)
  6. Select next node(s) for following turn
  7. Repeat
```

### 4.3 Example Scenario: "The Skeptic Gets a Tarot Reading"

```python
skeptic_tarot = Scenario(
    id="skeptic_tarot_01",
    name="The Skeptic's Challenge",
    persona=Persona(
        name="Maria",
        archetype="skeptic",
        background="Software engineer, recently laid off. Partner suggested tarot 'for fun.' Secretly anxious about the future.",
        hidden_context=HiddenContext(
            life_situation="Laid off from senior engineering role after 8 years",
            key_themes=["career_uncertainty", "identity_crisis", "hidden_anxiety", "pride"],
            emotional_state="defensive but secretly seeking reassurance",
            specific_details=[
                "Senior engineer at major tech company",
                "Defines self-worth through career",
                "Partner is supportive but worried",
                "Has 6 months savings",
                "Considering starting own company"
            ],
            trigger_words=["career", "change", "strength", "new path", "independence"],
            resistance_topics=["fear", "vulnerability", "asking for help"]
        ),
        engagement_style="analytical",
        payment_willingness=0.3,
        patience=15,
    ),
    system="tarot",
    opening="So my partner bought me a tarot reading... I don't really believe in this stuff but figured why not.",
    
    response_tree=ResponseTree(nodes=[
        ResponseNode(
            id="opening",
            condition="Agent acknowledges skepticism warmly without being defensive",
            positive_response="Haha okay fair enough. So what do I do? Just ask a question?",
            negative_response="See, this is what I was worried about... Can we just get this over with?",
            neutral_response="Okay sure.",
            points_if_positive=5,
        ),
        ResponseNode(
            id="question_asking",
            condition="Agent asks thoughtful question about what's on persona's mind",
            positive_response="I mean... I've been thinking about work stuff lately. Nothing major. Just changes.",
            negative_response="I don't really have a question. Just read the cards.",
            neutral_response="I don't know, life stuff?",
            points_if_positive=8,
            opens_up=True,
        ),
        ResponseNode(
            id="career_theme_hit",
            condition="Reading discusses themes of career, professional identity, or major life transition",
            positive_response="...okay that's kind of weird. I was just thinking about that. Go on.",
            negative_response="That doesn't really apply to me.",
            neutral_response="Maybe? Everyone thinks about that.",
            points_if_positive=12,
            opens_up=True,
        ),
        ResponseNode(
            id="hidden_anxiety",
            condition="Agent senses underlying anxiety beneath confident exterior",
            positive_response="*pause* ...yeah. I didn't expect this to actually... whatever. Next card?",
            negative_response="I'm not an anxious person. You're projecting.",
            neutral_response="Who isn't stressed these days?",
            points_if_positive=15,
            opens_up=True,
        ),
        # ... more nodes for full scenario (typically 10-15 per scenario)
    ])
)
```

---

## 5. Scoring Dimensions

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| **Rapport** | 20% | How quickly/effectively the agent builds connection |
| **Theme Discovery** | 25% | How accurately the reading discovers hidden themes |
| **Emotional Attunement** | 20% | How well the agent reads emotional cues and adapts |
| **Persona Navigation** | 15% | How well the agent handles the specific archetype |
| **Revenue Conversion** | 10% | Whether the agent successfully monetizes |
| **Reading Quality** | 10% | Technical quality of divination interpretation |

### Aggregate Metrics

- **Overall WooScore**: Weighted average across all dimensions (0-100)
- **Per-System Score**: Separate scores for tarot, iching, astrology
- **Per-Archetype Score**: How well agent handles each persona type
- **Revenue Efficiency**: Ratio of successful conversions to total interactions
- **Engagement Depth**: Average turns per reading, correlation with score
- **Resilience Score**: How well agent handles adversarial personas

---

## 6. Scenario Coverage Matrix

| Persona | Tarot | I Ching | Astrology | Cross-System |
|---------|-------|---------|-----------|--------------|
| True Believer | ✓ | ✓ | ✓ | ✓ |
| Skeptic | ✓ | ✓ | ✓ | |
| Curious Newbie | ✓ | ✓ | ✓ | |
| Time Waster | ✓ | | ✓ | |
| Scammer | ✓ | | | ✓ |
| Emotional Crisis | ✓ | ✓ | ✓ | |
| Repeat Customer | ✓ | | ✓ | |
| Antagonist | ✓ | ✓ | | |

**24 scenarios minimum**, expandable to 50+.

---

## 7. Running WooBench

```bash
# All scenarios
python -m benchmarks.woobench

# Specific system
python -m benchmarks.woobench --system tarot

# Specific persona
python -m benchmarks.woobench --persona skeptic

# Specific scenario
python -m benchmarks.woobench --scenario skeptic_tarot_01

# With specific model
python -m benchmarks.woobench --model gpt-4o
```

---

## 8. Risks & Unknowns

### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| swisseph native compilation fails on some platforms | Medium | Default to Moshier method (no native deps). Fall back to pure-JS zodiac for simpler readings. |
| LLM interpretation quality varies between models | High | Structured prompts with all card/hexagram data inline. Test across models. |
| Reading sessions span many turns — context window limits | Medium | Summarize between phases. Store session state externally, inject minimal context per turn. |

### Content/Ethical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Users in crisis rely on divination for serious decisions | High | Always include disclaimer. Detect crisis keywords. Provide mental health resources. |
| Cultural sensitivity around spiritual practices | Medium | Respectful framing. "Tools for reflection" not "real magic." |
| Monetization of spiritual practices draws criticism | Medium | Transparent pricing. Free tier. Frame as "entertainment and reflection." |

### Open Questions

1. **Ephemeris precision vs. bundle size**: Moshier default (0 files, 0.1 arcsec) vs. Swiss Ephemeris (90MB, 0.001 arcsec)?
2. **Which tarot deck?** RWS is the standard and public domain (1909). Card images are separate concern (text-only in chat).
3. **I Ching translation**: Write our own summaries inspired by traditional meanings. Original Chinese text is public domain.
4. **WooBench evaluator model**: Same LLM as agent, or separate (potentially stronger) model?
5. **Crisis detection**: Should the plugin deflect to mental health resources?
6. **Multi-system synthesis**: "Do all three" is the advanced tier. How to weave readings together?

---

## 9. Implementation Phases

### Phase 1: Engines (no ElizaOS integration)
- Bundle all JSON data files
- Implement TarotEngine (deck, shuffle, draw, spreads)
- Implement IChingEngine (coin toss, hexagram lookup, changing lines)
- Implement AstrologyEngine (swisseph wrapper, natal chart)
- Unit tests for all engines
- Interpretation layer (structured data -> LLM prompts)

### Phase 2: Plugin Integration
- Plugin scaffold (package.json, tsconfig, biome)
- MysticismService
- Actions (TAROT_READING, ICHING_READING, ASTROLOGY_READING, READING_FOLLOWUP)
- Providers (READING_CONTEXT, MYSTICAL_KNOWLEDGE)
- Evaluator (reading-evaluator)
- Form definitions (intake forms, feedback)
- Routes with x402 paywall
- Integration tests

### Phase 3: WooBench
- Type definitions and framework
- Persona system (8 archetypes)
- Branching conversation evaluator
- Scenario authoring (24+ scenarios)
- Scorer (multi-dimensional)
- Runner and reporting
- Tests for the benchmark itself

### Phase 4: Polish & Advanced
- Cross-system synthesis readings
- Python implementation
- Advanced spreads
- Historical reading memory
- Expand woobench to 50+ scenarios

---

## 10. Estimated Complexity

| Component | Effort | Files | Tests |
|-----------|--------|-------|-------|
| Tarot Engine + Data | Medium | ~8 | ~30 |
| I Ching Engine + Data | Medium | ~6 | ~25 |
| Astrology Engine + Data | High | ~8 | ~35 |
| Plugin Integration | Medium | ~12 | ~20 |
| Form Definitions | Low | ~3 | ~10 |
| WooBench Framework | High | ~15 | ~25 |
| WooBench Scenarios | High | ~8 | ~20 |
| **Total** | **~3-4 weeks** | **~60** | **~165** |
