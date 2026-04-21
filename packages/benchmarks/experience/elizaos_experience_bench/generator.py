"""Synthetic experience data generator for benchmarking.

Generates realistic, diverse experiences across domains with known ground truth
for evaluating retrieval quality, reranking correctness, and learning cycles.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Domain-specific templates
# ---------------------------------------------------------------------------

DOMAIN_TEMPLATES: dict[str, list[dict[str, str]]] = {
    "coding": [
        {"context": "debugging {lang} application", "action": "check error logs and stack trace",
         "result": "found {issue} in {component}", "learning": "always check {component} logs when {lang} throws {issue}"},
        {"context": "refactoring {component} module", "action": "extract shared logic into utility",
         "result": "reduced code duplication by {pct}%", "learning": "extract common patterns in {component} to reduce duplication"},
        {"context": "implementing {feature} in {lang}", "action": "use {pattern} design pattern",
         "result": "{feature} works correctly with {pattern}", "learning": "{pattern} is effective for implementing {feature} in {lang}"},
        {"context": "fixing memory leak in {component}", "action": "profile heap allocations",
         "result": "identified unclosed {resource}", "learning": "always close {resource} handles in {component} to prevent leaks"},
        {"context": "optimizing {component} performance", "action": "add caching layer",
         "result": "reduced latency by {pct}%", "learning": "caching {component} responses improves performance significantly"},
    ],
    "shell": [
        {"context": "automating {task} with shell script", "action": "write bash script for {task}",
         "result": "script completes {task} successfully", "learning": "use bash scripts to automate repetitive {task} operations"},
        {"context": "debugging failed {tool} command", "action": "check {tool} exit codes and stderr",
         "result": "found missing {dependency}", "learning": "verify {dependency} is installed before running {tool}"},
        {"context": "setting up {env} environment", "action": "configure environment variables",
         "result": "{env} environment ready", "learning": "always set {env}_HOME before running {tool} commands"},
        {"context": "processing large file with {tool}", "action": "use streaming with pipes",
         "result": "processed file without memory issues", "learning": "pipe {tool} output through stream processors for large files"},
    ],
    "network": [
        {"context": "debugging {protocol} connection failure", "action": "check {protocol} handshake logs",
         "result": "found {issue} in certificate chain", "learning": "verify certificate chain when {protocol} connections fail"},
        {"context": "implementing retry logic for {service}", "action": "add exponential backoff",
         "result": "{service} calls succeed after transient failures", "learning": "use exponential backoff for {service} retries"},
        {"context": "diagnosing slow {service} responses", "action": "trace request latency",
         "result": "found bottleneck in {component}", "learning": "{component} is the bottleneck for {service} latency"},
    ],
    "database": [
        {"context": "optimizing slow {query_type} query", "action": "add index on {field}",
         "result": "query time reduced from {slow}ms to {fast}ms", "learning": "index {field} for fast {query_type} queries"},
        {"context": "handling {db} connection pool exhaustion", "action": "increase pool size and add timeout",
         "result": "connections managed properly", "learning": "set connection pool limits and timeouts for {db}"},
        {"context": "migrating {db} schema", "action": "use incremental migration strategy",
         "result": "zero-downtime migration completed", "learning": "incremental migrations prevent downtime on {db}"},
    ],
    "security": [
        {"context": "fixing {vuln} vulnerability", "action": "sanitize {input_type} input",
         "result": "{vuln} vulnerability patched", "learning": "always sanitize {input_type} to prevent {vuln}"},
        {"context": "implementing authentication for {service}", "action": "use {auth_method} tokens",
         "result": "{service} authentication working", "learning": "{auth_method} tokens are suitable for {service} auth"},
        {"context": "auditing {component} permissions", "action": "apply principle of least privilege",
         "result": "reduced {component} attack surface", "learning": "restrict {component} permissions to minimum required"},
    ],
    "ai": [
        {"context": "improving {model} prompt quality", "action": "add few-shot examples",
         "result": "response accuracy improved by {pct}%", "learning": "few-shot examples improve {model} accuracy significantly"},
        {"context": "handling {model} hallucinations", "action": "add fact-checking validation",
         "result": "reduced hallucination rate", "learning": "validate {model} outputs against known facts"},
        {"context": "optimizing {model} token usage", "action": "compress context with summarization",
         "result": "reduced tokens by {pct}% without quality loss", "learning": "summarize long contexts before sending to {model}"},
    ],
    "devops": [
        {"context": "deploying {service} to {env}", "action": "use blue-green deployment",
         "result": "zero-downtime deployment", "learning": "blue-green deployments prevent downtime for {service}"},
        {"context": "scaling {service} under load", "action": "configure auto-scaling rules",
         "result": "{service} handles {multiplier}x traffic", "learning": "auto-scaling with proper thresholds handles {service} spikes"},
        {"context": "monitoring {service} health", "action": "add health check endpoints",
         "result": "early detection of {service} failures", "learning": "health checks enable fast {service} failure detection"},
    ],
    "testing": [
        {"context": "writing tests for {component}", "action": "use {test_type} testing strategy",
         "result": "achieved {pct}% code coverage", "learning": "{test_type} tests are effective for {component} coverage"},
        {"context": "debugging flaky {test_type} test", "action": "add deterministic waits and fixtures",
         "result": "test passes consistently", "learning": "replace sleep with explicit waits in {test_type} tests"},
    ],
    "documentation": [
        {"context": "documenting {component} API", "action": "write OpenAPI specification",
         "result": "API docs auto-generated", "learning": "OpenAPI specs enable automatic {component} documentation"},
        {"context": "creating onboarding guide for {tool}", "action": "write step-by-step tutorial",
         "result": "new team members onboard faster", "learning": "step-by-step {tool} tutorials reduce onboarding time"},
    ],
    "performance": [
        {"context": "profiling {component} CPU usage", "action": "use flame graph profiler",
         "result": "identified hot path in {function}", "learning": "flame graphs reveal {component} CPU bottlenecks quickly"},
        {"context": "reducing {component} memory footprint", "action": "switch to streaming processing",
         "result": "memory usage reduced by {pct}%", "learning": "streaming reduces {component} memory usage for large datasets"},
    ],
}

FILL_VALUES: dict[str, list[str]] = {
    "lang": ["Python", "TypeScript", "Rust", "Go", "Java", "C++"],
    "issue": ["null pointer", "type error", "timeout", "race condition", "stack overflow", "OOM"],
    "component": ["auth", "database", "cache", "api", "worker", "scheduler", "gateway", "parser"],
    "feature": ["pagination", "search", "filtering", "sorting", "notifications", "webhooks"],
    "pattern": ["observer", "factory", "strategy", "singleton", "decorator", "adapter"],
    "resource": ["file", "socket", "connection", "stream", "cursor", "lock"],
    "pct": ["20", "35", "50", "65", "80"],
    "task": ["backup", "deployment", "cleanup", "migration", "monitoring", "log rotation"],
    "tool": ["docker", "git", "npm", "pip", "cargo", "kubectl", "terraform"],
    "dependency": ["runtime", "library", "config file", "binary", "certificate"],
    "env": ["production", "staging", "development", "CI", "testing"],
    "protocol": ["TLS", "HTTP/2", "gRPC", "WebSocket", "MQTT"],
    "service": ["API gateway", "auth service", "data pipeline", "message queue", "CDN"],
    "query_type": ["JOIN", "aggregation", "full-text search", "range scan", "nested subquery"],
    "field": ["user_id", "created_at", "status", "email", "category"],
    "db": ["PostgreSQL", "MongoDB", "Redis", "SQLite", "DynamoDB"],
    "slow": ["2500", "5000", "8000", "12000"],
    "fast": ["15", "50", "120", "250"],
    "vuln": ["SQL injection", "XSS", "CSRF", "path traversal", "SSRF"],
    "input_type": ["user", "query parameter", "header", "file upload", "JSON body"],
    "auth_method": ["JWT", "OAuth2", "API key", "session", "mTLS"],
    "model": ["GPT-4", "Claude", "Llama", "Mistral", "Gemini"],
    "multiplier": ["3", "5", "10", "20"],
    "test_type": ["unit", "integration", "e2e", "load", "contract"],
    "function": ["serialize", "parse", "validate", "transform", "render"],
}

# Synonym map for paraphrase query generation
_SYNONYMS: dict[str, list[str]] = {
    "debugging": ["troubleshooting", "diagnosing", "investigating"],
    "fix": ["resolve", "repair", "patch"],
    "install": ["set up", "configure", "add"],
    "optimize": ["improve", "speed up", "enhance"],
    "deploy": ["release", "ship", "launch"],
    "check": ["verify", "inspect", "examine"],
    "error": ["bug", "issue", "problem", "fault"],
    "build": ["compile", "construct", "assemble"],
    "test": ["verify", "validate", "check"],
    "run": ["execute", "start", "launch"],
    "add": ["include", "insert", "attach"],
    "use": ["utilize", "employ", "apply"],
    "reduce": ["minimize", "decrease", "lower"],
    "cache": ["store", "buffer", "memoize"],
    "query": ["search", "lookup", "fetch"],
    "monitor": ["track", "observe", "watch"],
    "configure": ["set up", "adjust", "tune"],
    "failure": ["crash", "breakdown", "outage"],
    "performance": ["speed", "efficiency", "throughput"],
    "dependency": ["requirement", "prerequisite", "library"],
    "connection": ["link", "session", "socket"],
    "memory": ["RAM", "heap", "allocation"],
}

# Domain-generic query templates for cross-domain distractors
_DOMAIN_GENERIC_QUERIES: dict[str, list[str]] = {
    "coding": ["programming best practices", "software development tips", "code quality"],
    "shell": ["command line usage", "terminal operations", "scripting automation"],
    "network": ["network troubleshooting", "API integration issues", "connection problems"],
    "database": ["database management", "data storage optimization", "query performance"],
    "security": ["security hardening", "vulnerability assessment", "access control"],
    "ai": ["machine learning workflow", "model training", "inference optimization"],
    "devops": ["deployment pipeline", "infrastructure management", "CI/CD workflow"],
    "testing": ["test strategy", "quality assurance", "regression testing"],
    "documentation": ["technical writing", "API documentation", "knowledge base"],
    "performance": ["system optimization", "bottleneck analysis", "resource usage"],
}

OUTCOME_TYPES = ["positive", "negative", "neutral", "mixed"]
EXPERIENCE_TYPES = ["success", "failure", "discovery", "correction", "learning", "hypothesis", "validation", "warning"]


@dataclass
class GeneratedExperience:
    """A generated experience with ground truth metadata for evaluation."""

    context: str
    action: str
    result: str
    learning: str
    domain: str
    experience_type: str
    outcome: str
    confidence: float
    importance: float
    tags: list[str]
    created_at_offset_days: float  # Days before "now"
    # Ground truth: which query clusters should retrieve this experience
    ground_truth_clusters: list[str] = field(default_factory=list)


@dataclass
class RetrievalQuery:
    """A test query with known relevant experience IDs."""

    query_text: str
    domain: str
    # Indices into the generated experiences list that should be relevant
    relevant_indices: list[int]
    # The cluster this query belongs to
    cluster: str


@dataclass
class LearningScenario:
    """A learn-then-apply scenario."""

    # Phase 1: Agent encounters a problem
    problem_context: str
    problem_action: str
    problem_result: str  # Failure or unexpected result
    # Phase 2: Agent records the experience
    learned_experience: GeneratedExperience
    # Phase 3: Agent faces similar problem
    similar_query: str
    # Expected: agent should retrieve the learned experience
    expected_domain: str
    expected_learning_keywords: list[str]


class ExperienceGenerator:
    """Generate synthetic experience data for benchmarking."""

    def __init__(self, seed: int = 42) -> None:
        self.rng = random.Random(seed)

    def _fill_template(self, template: str) -> str:
        """Replace {placeholder} tokens with random values."""
        result = template
        for key, values in FILL_VALUES.items():
            placeholder = f"{{{key}}}"
            while placeholder in result:
                result = result.replace(placeholder, self.rng.choice(values), 1)
        return result

    def generate_experiences(
        self,
        count: int = 1000,
        domains: list[str] | None = None,
    ) -> list[GeneratedExperience]:
        """Generate a diverse set of synthetic experiences.

        Each experience has ground truth cluster tags for retrieval evaluation.
        """
        if domains is None:
            domains = list(DOMAIN_TEMPLATES.keys())

        experiences: list[GeneratedExperience] = []

        for i in range(count):
            domain = domains[i % len(domains)]
            templates = DOMAIN_TEMPLATES.get(domain, DOMAIN_TEMPLATES["coding"])
            template = self.rng.choice(templates)

            context = self._fill_template(template["context"])
            action = self._fill_template(template["action"])
            result = self._fill_template(template["result"])
            learning = self._fill_template(template["learning"])

            # Assign experience type and outcome
            exp_type = self.rng.choice(EXPERIENCE_TYPES)
            outcome = self.rng.choice(OUTCOME_TYPES)

            # Vary quality metrics
            confidence = round(self.rng.uniform(0.3, 0.95), 2)
            importance = round(self.rng.uniform(0.2, 0.95), 2)

            # Vary age (0 = just now, up to 180 days old)
            age_days = round(self.rng.uniform(0, 180), 1)

            # Ground truth cluster based on domain + template pattern
            cluster = f"{domain}:{template['context'].split('{')[0].strip()}"

            tags = [domain, exp_type]
            if importance > 0.7:
                tags.append("important")
            if confidence > 0.8:
                tags.append("high-confidence")

            experiences.append(GeneratedExperience(
                context=context,
                action=action,
                result=result,
                learning=learning,
                domain=domain,
                experience_type=exp_type,
                outcome=outcome,
                confidence=confidence,
                importance=importance,
                tags=tags,
                created_at_offset_days=age_days,
                ground_truth_clusters=[cluster],
            ))

        return experiences

    def generate_retrieval_queries(
        self,
        experiences: list[GeneratedExperience],
        num_queries: int = 100,
    ) -> list[RetrievalQuery]:
        """Generate queries with known relevant experiences for precision/recall evaluation.

        Generates a mix of query types:
        - 40% exact-word queries (sample words from experience text)
        - 30% paraphrase queries (use synonyms and rephrasings)
        - 20% partial-overlap queries (only 2-3 shared words)
        - 10% cross-domain distractor queries (query domain X but expect domain Y nearby)
        """
        cluster_map: dict[str, list[int]] = {}
        for idx, exp in enumerate(experiences):
            for cluster in exp.ground_truth_clusters:
                cluster_map.setdefault(cluster, []).append(idx)

        valid_clusters = [(c, indices) for c, indices in cluster_map.items() if len(indices) >= 2]
        if not valid_clusters:
            return []

        # Allocate query types
        n_exact = int(num_queries * 0.4)
        n_paraphrase = int(num_queries * 0.3)
        n_partial = int(num_queries * 0.2)
        n_distractor = num_queries - n_exact - n_paraphrase - n_partial

        queries: list[RetrievalQuery] = []

        # --- Exact-word queries (easiest) ---
        for _ in range(n_exact):
            cluster, indices = self.rng.choice(valid_clusters)
            domain = cluster.split(":")[0]
            representative = experiences[self.rng.choice(indices)]
            words = (representative.context + " " + representative.learning).split()
            query_words = self.rng.sample(words, min(len(words), self.rng.randint(4, 8)))
            queries.append(RetrievalQuery(
                query_text=" ".join(query_words),
                domain=domain,
                relevant_indices=indices,
                cluster=cluster,
            ))

        # --- Paraphrase queries (harder — uses synonym substitution) ---
        for _ in range(n_paraphrase):
            cluster, indices = self.rng.choice(valid_clusters)
            domain = cluster.split(":")[0]
            representative = experiences[self.rng.choice(indices)]
            words = (representative.context + " " + representative.learning).split()
            query_words = self.rng.sample(words, min(len(words), self.rng.randint(4, 7)))
            # Replace ~40% of words with synonyms
            paraphrased = []
            for w in query_words:
                if self.rng.random() < 0.4 and w.lower() in _SYNONYMS:
                    paraphrased.append(self.rng.choice(_SYNONYMS[w.lower()]))
                else:
                    paraphrased.append(w)
            queries.append(RetrievalQuery(
                query_text=" ".join(paraphrased),
                domain=domain,
                relevant_indices=indices,
                cluster=cluster,
            ))

        # --- Partial-overlap queries (harder — only 2-3 shared words) ---
        for _ in range(n_partial):
            cluster, indices = self.rng.choice(valid_clusters)
            domain = cluster.split(":")[0]
            representative = experiences[self.rng.choice(indices)]
            words = (representative.context + " " + representative.learning).split()
            # Only take 2-3 words (much less overlap)
            query_words = self.rng.sample(words, min(len(words), self.rng.randint(2, 3)))
            # Add generic filler to make it query-like
            fillers = ["how to", "what is", "best way to", "fix", "solve", "handle"]
            query_text = self.rng.choice(fillers) + " " + " ".join(query_words)
            queries.append(RetrievalQuery(
                query_text=query_text,
                domain=domain,
                relevant_indices=indices,
                cluster=cluster,
            ))

        # --- Cross-domain distractors (hardest — query from similar domain) ---
        for _ in range(n_distractor):
            cluster, indices = self.rng.choice(valid_clusters)
            domain = cluster.split(":")[0]
            representative = experiences[self.rng.choice(indices)]
            # Use domain-generic terms mixed with a couple specific words
            domain_terms = _DOMAIN_GENERIC_QUERIES.get(domain, ["general task"])
            query_text = self.rng.choice(domain_terms)
            # Add 1-2 specific words from the experience
            words = representative.learning.split()
            if len(words) >= 2:
                specific = self.rng.sample(words, min(len(words), 2))
                query_text += " " + " ".join(specific)
            queries.append(RetrievalQuery(
                query_text=query_text,
                domain=domain,
                relevant_indices=indices,
                cluster=cluster,
            ))

        self.rng.shuffle(queries)
        return queries

    def generate_learning_scenarios(
        self, num_scenarios: int = 20,
    ) -> list[LearningScenario]:
        """Generate learn-then-apply scenarios.

        Each scenario:
        1. Agent encounters a problem and fails
        2. Agent records the failure as an experience
        3. Agent faces a similar problem
        4. Agent should retrieve and apply the past experience
        """
        scenarios: list[LearningScenario] = []

        # NOTE: keywords MUST appear in the learning text (case-insensitive).
        # The evaluator checks `all(kw in learning.lower())` for cycle success.
        scenario_templates = [
            {
                "problem_context": "running Python script without installing dependencies",
                "problem_action": "python main.py",
                "problem_result": "ModuleNotFoundError: No module named 'pandas'",
                "learning": "Always install dependencies with pip install -r requirements.txt before running Python scripts",
                "similar_query": "install dependencies pip requirements python scripts",
                "domain": "coding",
                "keywords": ["install", "dependencies", "pip"],
            },
            {
                "problem_context": "deploying to production without running tests",
                "problem_action": "git push origin main && deploy",
                "problem_result": "production crash due to uncaught TypeError",
                "learning": "Always run the full test suite before deploying to production",
                "similar_query": "best practices before deploying code to production",
                "domain": "devops",
                "keywords": ["test", "suite", "production"],
            },
            {
                "problem_context": "database query timing out on large table",
                "problem_action": "SELECT * FROM orders WHERE user_id = 123",
                "problem_result": "query timeout after 30 seconds",
                "learning": "Add an index on user_id column for the orders table to speed up lookups",
                "similar_query": "database query is slow on large table with user lookup",
                "domain": "database",
                "keywords": ["index", "user_id", "orders"],
            },
            {
                "problem_context": "API returning 401 after token refresh",
                "problem_action": "call API with refreshed OAuth token",
                "problem_result": "401 Unauthorized - token not recognized",
                "learning": "OAuth tokens need a propagation delay after refresh before use",
                "similar_query": "API auth fails after refreshing oauth token",
                "domain": "network",
                "keywords": ["tokens", "propagation", "refresh"],
            },
            {
                "problem_context": "Docker container running out of memory",
                "problem_action": "docker run app without memory limits",
                "problem_result": "OOMKilled: container exceeded default memory",
                "learning": "Always set explicit memory limits for Docker containers with the memory flag",
                "similar_query": "docker container gets killed memory issue",
                "domain": "devops",
                "keywords": ["memory", "limits", "docker", "containers"],
            },
            {
                "problem_context": "git merge conflict in generated files",
                "problem_action": "git merge feature-branch",
                "problem_result": "merge conflicts in package-lock.json and dist/",
                "learning": "Regenerate lock files and build artifacts after merge instead of resolving conflicts manually",
                "similar_query": "how to handle merge conflicts in lock files",
                "domain": "coding",
                "keywords": ["lock", "merge", "regenerate"],
            },
            {
                "problem_context": "SSL certificate expired on staging server",
                "problem_action": "access staging endpoint",
                "problem_result": "SSL_ERROR_EXPIRED_CERT_ALERT",
                "learning": "Set up automatic certificate renewal with certbot and monitor expiry dates",
                "similar_query": "SSL certificate keeps expiring on server",
                "domain": "security",
                "keywords": ["certificate", "renewal", "certbot"],
            },
            {
                "problem_context": "flaky integration test failing intermittently",
                "problem_action": "run test suite in CI",
                "problem_result": "test passes locally but fails 30% of the time in CI",
                "learning": "Replace sleep with explicit condition waits in integration tests to eliminate flakiness",
                "similar_query": "integration test passes locally fails in CI intermittently",
                "domain": "testing",
                "keywords": ["explicit", "waits", "integration", "tests"],
            },
            {
                "problem_context": "LLM generating incorrect JSON format",
                "problem_action": "parse LLM response as JSON",
                "problem_result": "JSON parse error - missing closing brace",
                "learning": "Use structured output mode or JSON schema validation when expecting JSON from LLMs",
                "similar_query": "LLM response is not valid JSON how to fix",
                "domain": "ai",
                "keywords": ["json", "structured", "validation"],
            },
            {
                "problem_context": "log files filling up disk on production server",
                "problem_action": "check disk usage",
                "problem_result": "disk 98% full from unrotated application logs",
                "learning": "Configure log rotation with logrotate and set maximum file size limits",
                "similar_query": "server disk full because of large log files",
                "domain": "devops",
                "keywords": ["log", "rotation", "logrotate"],
            },
        ]

        # Duplicate and shuffle to get enough scenarios
        all_templates = scenario_templates * ((num_scenarios // len(scenario_templates)) + 1)
        self.rng.shuffle(all_templates)

        for template in all_templates[:num_scenarios]:
            learned = GeneratedExperience(
                context=template["problem_context"],
                action=template["problem_action"],
                result=template["problem_result"],
                learning=template["learning"],
                domain=template["domain"],
                experience_type="correction",
                outcome="positive",
                confidence=0.9,
                importance=0.85,
                tags=[template["domain"], "correction", "learned"],
                created_at_offset_days=0,
                ground_truth_clusters=[],
            )

            scenarios.append(LearningScenario(
                problem_context=template["problem_context"],
                problem_action=template["problem_action"],
                problem_result=template["problem_result"],
                learned_experience=learned,
                similar_query=template["similar_query"],
                expected_domain=template["domain"],
                expected_learning_keywords=template["keywords"],
            ))

        return scenarios
