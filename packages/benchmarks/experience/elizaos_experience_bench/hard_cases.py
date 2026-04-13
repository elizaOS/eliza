"""Hand-crafted hard benchmark cases for experience retrieval.

Each case is adversarial — designed to expose specific weaknesses in the retrieval
system. Cases are organized into tiers:

Tier "jaccard": Cases that SHOULD be solvable with token overlap + reranking.
                These test edge cases in the current algorithm.

Tier "semantic": Cases that REQUIRE real embeddings to solve. Jaccard is expected
                 to fail on these. They serve as a roadmap for improvement.

Every case is hand-written. No template generation. No sampling words from
experience text. Each case documents WHY it's hard.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class HardCaseExperience:
    """An experience to load into the service for a hard case test."""

    context: str
    action: str
    result: str
    learning: str
    domain: str
    confidence: float = 0.8
    importance: float = 0.7
    created_at_offset_days: float = 5.0  # Days before "now"


@dataclass
class HardCase:
    """A single hard benchmark case.

    The test loads all `experiences` into a fresh service, then queries with
    `query`. The experience at index `expected_best_index` should appear in the
    top `expected_within_top_k` results.
    """

    name: str
    category: str
    tier: str  # "jaccard" or "semantic"
    requires_embeddings: bool
    why_hard: str  # Human explanation of what makes this case difficult

    # The experiences to load (distractors + the correct one)
    experiences: list[HardCaseExperience]
    # The query to run
    query: str
    # Index into `experiences` that should rank highest (or within top k)
    expected_best_index: int
    # The correct experience should appear within this many results
    expected_within_top_k: int = 3


# =============================================================================
# TIER: JACCARD — Hard but solvable with token overlap + quality signals
# =============================================================================

# ---------------------------------------------------------------------------
# Category: near_miss_distractors
# Two experiences share 80%+ tokens but differ in one critical word.
# ---------------------------------------------------------------------------

NEAR_MISS_DISTRACTORS: list[HardCase] = [
    HardCase(
        name="close_vs_open_connections",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both experiences share almost all tokens. Only 'close' vs 'open' differs. Query about leaking connections should match 'close'.",
        experiences=[
            HardCaseExperience(
                context="database connection management",
                action="close database connections after each query completes",
                result="no more connection leaks in production",
                learning="always close database connections after use to prevent connection pool exhaustion",
                domain="database",
            ),
            HardCaseExperience(
                context="database connection management",
                action="open database connections at application startup",
                result="connections available when needed",
                learning="open database connections eagerly at startup for faster initial queries",
                domain="database",
            ),
        ],
        query="application leaks database connections pool exhaustion",
        expected_best_index=0,
    ),
    HardCase(
        name="enable_vs_disable_caching",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'caching', 'api', 'response'. Only 'enable' vs 'disable' differs. Query about slow API should match 'enable'.",
        experiences=[
            HardCaseExperience(
                context="api response time optimization",
                action="enable caching for api response data",
                result="api response time reduced by 70%",
                learning="enable caching on api responses to dramatically reduce response latency",
                domain="performance",
            ),
            HardCaseExperience(
                context="api response staleness issue",
                action="disable caching for api response data",
                result="api always returns fresh data",
                learning="disable caching on api responses when data freshness is critical",
                domain="performance",
            ),
        ],
        query="api responses are too slow need to reduce latency caching",
        expected_best_index=0,
    ),
    HardCase(
        name="increase_vs_decrease_timeout",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'timeout', 'request', 'service'. Query about requests timing out should match 'increase'.",
        experiences=[
            HardCaseExperience(
                context="service request timeout configuration",
                action="increase request timeout to 30 seconds",
                result="long-running requests complete successfully",
                learning="increase request timeout for services that process large payloads",
                domain="network",
            ),
            HardCaseExperience(
                context="service request timeout configuration",
                action="decrease request timeout to 5 seconds",
                result="failing requests detected faster",
                learning="decrease request timeout to fail fast and prevent resource exhaustion",
                domain="network",
            ),
        ],
        query="requests timing out before completing service large payload timeout",
        expected_best_index=0,
    ),
    HardCase(
        name="add_vs_remove_index",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'index', 'query', 'table'. Query about slow reads should match 'add index'.",
        experiences=[
            HardCaseExperience(
                context="database query performance",
                action="add index on frequently queried columns",
                result="read query time reduced from 800ms to 15ms",
                learning="add database index on columns used in WHERE clauses to speed up read queries",
                domain="database",
            ),
            HardCaseExperience(
                context="database write performance",
                action="remove unnecessary indexes from table",
                result="insert performance improved by 40%",
                learning="remove database indexes that slow down write operations if reads are infrequent",
                domain="database",
            ),
        ],
        query="database read query on table is extremely slow need index",
        expected_best_index=0,
    ),
    HardCase(
        name="sync_vs_async_processing",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'processing', 'request', 'handler'. Query about blocking should match 'async'.",
        experiences=[
            HardCaseExperience(
                context="request handler blocking the event loop",
                action="switch to async processing for heavy computation",
                result="server handles 10x more concurrent requests",
                learning="use async processing in request handlers to avoid blocking the event loop",
                domain="coding",
            ),
            HardCaseExperience(
                context="request processing order matters",
                action="use synchronous processing to maintain order",
                result="requests processed in correct sequence",
                learning="use synchronous processing when request ordering must be preserved",
                domain="coding",
            ),
        ],
        query="server blocking event loop request handler processing async",
        expected_best_index=0,
    ),
    HardCase(
        name="retry_vs_fail_fast",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'request', 'failure', 'service'. Query about transient failures should match retry.",
        experiences=[
            HardCaseExperience(
                context="handling transient service failures",
                action="implement retry with exponential backoff",
                result="transient failures recovered automatically",
                learning="retry failed requests with exponential backoff for transient service failures",
                domain="network",
            ),
            HardCaseExperience(
                context="handling permanent service failures",
                action="fail fast and return error to caller",
                result="users get immediate error feedback",
                learning="fail fast on permanent service failures instead of wasting resources on retries",
                domain="network",
            ),
        ],
        query="service requests failing intermittently transient failures retry backoff",
        expected_best_index=0,
    ),
    HardCase(
        name="horizontal_vs_vertical_scaling",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'scaling', 'traffic', 'service'. Query about cost-effective scaling for unpredictable traffic should match horizontal.",
        experiences=[
            HardCaseExperience(
                context="scaling service for unpredictable traffic",
                action="add horizontal auto-scaling with multiple instances",
                result="service handles traffic spikes automatically",
                learning="use horizontal scaling with auto-scaling groups for unpredictable traffic patterns",
                domain="devops",
            ),
            HardCaseExperience(
                context="scaling service for steady high traffic",
                action="vertical scaling by upgrading instance size",
                result="single instance handles the load",
                learning="use vertical scaling by upgrading instance size when traffic is predictable and steady",
                domain="devops",
            ),
        ],
        query="service needs scaling for unpredictable traffic spikes auto-scaling horizontal",
        expected_best_index=0,
    ),
    HardCase(
        name="eager_vs_lazy_loading",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'loading', 'data', 'performance'. Query about initial page load should match lazy.",
        experiences=[
            HardCaseExperience(
                context="reducing initial page load time",
                action="implement lazy loading for non-critical resources",
                result="initial page load time reduced by 60%",
                learning="use lazy loading for images and components below the fold to improve initial page load",
                domain="performance",
            ),
            HardCaseExperience(
                context="eliminating loading spinners during navigation",
                action="implement eager loading for critical data",
                result="pages render instantly during navigation",
                learning="use eager loading to prefetch data for likely next pages to eliminate loading states",
                domain="performance",
            ),
        ],
        query="initial page load too slow need lazy loading reduce time",
        expected_best_index=0,
    ),
    HardCase(
        name="monolith_vs_microservice",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'deployment', 'architecture', 'service'. Query about independent deployment should match microservices.",
        experiences=[
            HardCaseExperience(
                context="enabling independent service deployment",
                action="split monolith into microservices with separate deployment pipelines",
                result="teams deploy independently without coordination",
                learning="use microservices architecture when teams need independent deployment cycles",
                domain="devops",
            ),
            HardCaseExperience(
                context="simplifying deployment and debugging",
                action="consolidate microservices into a monolith",
                result="single deployment artifact, simpler debugging",
                learning="use monolith architecture when operational complexity outweighs deployment independence",
                domain="devops",
            ),
        ],
        query="teams need independent deployment microservices architecture service",
        expected_best_index=0,
    ),
    HardCase(
        name="lock_vs_lockfree",
        category="near_miss_distractors",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both share 'concurrent', 'data', 'access'. Query about high-throughput should match lock-free.",
        experiences=[
            HardCaseExperience(
                context="high-throughput concurrent data access",
                action="use lock-free concurrent data structures",
                result="throughput increased by 5x under contention",
                learning="use lock-free data structures for high-throughput concurrent access patterns",
                domain="coding",
            ),
            HardCaseExperience(
                context="preventing data corruption from concurrent access",
                action="add mutex locks around shared data",
                result="data consistency guaranteed under concurrent access",
                learning="use mutex locks to prevent data corruption when multiple threads access shared state",
                domain="coding",
            ),
        ],
        query="need high throughput concurrent data access lock-free structures",
        expected_best_index=0,
    ),
]

# ---------------------------------------------------------------------------
# Category: domain_confusion
# Same word used in different technical domains. System must pick the right one.
# ---------------------------------------------------------------------------

DOMAIN_CONFUSION: list[HardCase] = [
    HardCase(
        name="pool_database_vs_thread",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'pool' means different things in database vs threading. Query about database connections should match the database experience.",
        experiences=[
            HardCaseExperience(
                context="database connection pool exhaustion",
                action="configure connection pool size and idle timeout",
                result="database connections managed correctly",
                learning="set database connection pool max size to 20 and idle timeout to 30 seconds",
                domain="database",
            ),
            HardCaseExperience(
                context="thread pool for parallel task execution",
                action="configure thread pool size for CPU-bound tasks",
                result="CPU utilization optimized",
                learning="set thread pool size to number of CPU cores for compute-bound parallel tasks",
                domain="coding",
            ),
            HardCaseExperience(
                context="memory pool allocation strategy",
                action="use memory pool allocator for frequent small allocations",
                result="reduced allocation overhead by 80%",
                learning="memory pool allocators reduce overhead for high-frequency small object allocation",
                domain="performance",
            ),
        ],
        query="database connection pool exhausted too many connections idle timeout",
        expected_best_index=0,
    ),
    HardCase(
        name="migration_database_vs_cloud",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'migration' means schema migration in database context vs cloud migration in devops.",
        experiences=[
            HardCaseExperience(
                context="database schema migration with zero downtime",
                action="use blue-green migration with backward-compatible schema changes",
                result="schema updated without downtime",
                learning="apply backward-compatible schema changes first then deploy code that uses new schema",
                domain="database",
            ),
            HardCaseExperience(
                context="cloud migration from on-premises",
                action="lift and shift followed by incremental optimization",
                result="services running in cloud",
                learning="migrate to cloud using lift-and-shift first then optimize services incrementally",
                domain="devops",
            ),
        ],
        query="database schema migration zero downtime backward compatible changes",
        expected_best_index=0,
    ),
    HardCase(
        name="token_auth_vs_llm",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'token' means auth token in security vs LLM token in AI. Query about API authentication should match security.",
        experiences=[
            HardCaseExperience(
                context="securing API endpoints with token authentication",
                action="implement JWT token validation middleware",
                result="unauthorized requests rejected at gateway",
                learning="validate JWT tokens in middleware before requests reach application handlers",
                domain="security",
            ),
            HardCaseExperience(
                context="reducing LLM token consumption",
                action="compress prompts and use shorter system messages",
                result="token usage reduced by 40%",
                learning="compress prompts to reduce LLM token consumption and cost per request",
                domain="ai",
            ),
        ],
        query="API endpoints need token authentication JWT validation middleware security",
        expected_best_index=0,
    ),
    HardCase(
        name="cache_redis_vs_browser",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'cache' means server-side Redis cache vs browser cache. Query about session data should match Redis.",
        experiences=[
            HardCaseExperience(
                context="caching session data for fast access",
                action="store session data in Redis with TTL",
                result="session lookups reduced from 50ms to 1ms",
                learning="use Redis cache with TTL for session data to reduce database lookups",
                domain="database",
            ),
            HardCaseExperience(
                context="browser cache causing stale assets",
                action="add cache-busting hashes to static asset filenames",
                result="users always get latest assets after deployment",
                learning="use cache-busting filename hashes for static assets to prevent stale browser cache",
                domain="performance",
            ),
        ],
        query="need to cache session data Redis TTL fast lookup server-side",
        expected_best_index=0,
    ),
    HardCase(
        name="pipeline_cicd_vs_data",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'pipeline' means CI/CD pipeline vs data pipeline. Query about build failures should match CI/CD.",
        experiences=[
            HardCaseExperience(
                context="CI/CD pipeline build failures blocking releases",
                action="add pipeline caching and parallel test stages",
                result="build time reduced from 45 to 12 minutes",
                learning="cache dependencies and parallelize test stages in CI/CD pipeline to speed up builds",
                domain="devops",
            ),
            HardCaseExperience(
                context="data pipeline processing delays",
                action="optimize ETL pipeline with batch processing and partitioning",
                result="data pipeline throughput tripled",
                learning="use batch processing and partition-based parallelism in data pipelines for throughput",
                domain="database",
            ),
        ],
        query="CI/CD pipeline builds failing too slow cache parallel stages",
        expected_best_index=0,
    ),
    HardCase(
        name="container_docker_vs_kubernetes",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Both are container-related but at different levels. Query about building images should match Docker.",
        experiences=[
            HardCaseExperience(
                context="building efficient Docker container images",
                action="use multi-stage builds and minimize layer count",
                result="image size reduced from 2GB to 200MB",
                learning="use multi-stage Docker builds and combine RUN commands to minimize container image size",
                domain="devops",
            ),
            HardCaseExperience(
                context="orchestrating containers across cluster nodes",
                action="configure Kubernetes deployment with resource limits and health checks",
                result="containers automatically scheduled and health-monitored",
                learning="set resource limits and liveness probes in Kubernetes deployments for reliable orchestration",
                domain="devops",
            ),
        ],
        query="Docker container image too large multi-stage build minimize size layers",
        expected_best_index=0,
    ),
    HardCase(
        name="model_ml_vs_database",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'model' means ML model in AI vs data model in database. Query about training accuracy should match ML.",
        experiences=[
            HardCaseExperience(
                context="ML model accuracy below target on validation set",
                action="increase training data diversity and add regularization",
                result="model accuracy improved from 78% to 92%",
                learning="increase training data diversity and add dropout regularization to improve model accuracy",
                domain="ai",
            ),
            HardCaseExperience(
                context="data model normalization for relational database",
                action="normalize to third normal form and add foreign keys",
                result="data redundancy eliminated",
                learning="normalize data model to 3NF with proper foreign key constraints to prevent data anomalies",
                domain="database",
            ),
        ],
        query="ML model accuracy too low need better training data regularization",
        expected_best_index=0,
    ),
    HardCase(
        name="hook_react_vs_git",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'hook' means React hooks vs git hooks. Query about state management should match React.",
        experiences=[
            HardCaseExperience(
                context="managing component state in React application",
                action="use custom hooks for shared state logic",
                result="state management code reused across 15 components",
                learning="extract shared state logic into custom React hooks to eliminate duplication across components",
                domain="coding",
            ),
            HardCaseExperience(
                context="enforcing code quality before git commits",
                action="set up pre-commit git hooks with linting and formatting",
                result="all committed code passes quality checks",
                learning="use pre-commit git hooks to run linting and formatting automatically before every commit",
                domain="coding",
            ),
        ],
        query="React component state management custom hooks shared logic",
        expected_best_index=0,
    ),
    HardCase(
        name="service_kubernetes_vs_systemd",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'service restart' means very different things in Kubernetes vs systemd.",
        experiences=[
            HardCaseExperience(
                context="Kubernetes pod restarting in crash loop",
                action="check pod logs and increase memory limits",
                result="pod stable after memory limit increase",
                learning="check pod logs and resource limits when Kubernetes pods enter CrashLoopBackOff",
                domain="devops",
            ),
            HardCaseExperience(
                context="systemd service failing to start on boot",
                action="fix unit file dependencies and ExecStart path",
                result="service starts reliably on boot",
                learning="verify ExecStart path and After dependencies in systemd unit files for boot-time services",
                domain="shell",
            ),
        ],
        query="Kubernetes pod CrashLoopBackOff restart crash loop memory limits",
        expected_best_index=0,
    ),
    HardCase(
        name="log_application_vs_audit",
        category="domain_confusion",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="'log' means application logs vs audit trail. Query about debugging should match application logs.",
        experiences=[
            HardCaseExperience(
                context="adding structured logging for debugging production issues",
                action="implement structured JSON logging with correlation IDs",
                result="debugging time reduced from hours to minutes",
                learning="use structured JSON logs with correlation IDs for tracing requests across services",
                domain="coding",
            ),
            HardCaseExperience(
                context="audit logging for compliance requirements",
                action="log all data access and modifications with user identity",
                result="compliance audit passed",
                learning="log all data access operations with user identity and timestamp for compliance auditing",
                domain="security",
            ),
        ],
        query="need structured logging debugging production JSON correlation IDs tracing",
        expected_best_index=0,
    ),
]

# ---------------------------------------------------------------------------
# Category: specificity_trap
# General experience matches many queries but specific one is better.
# ---------------------------------------------------------------------------

SPECIFICITY_TRAP: list[HardCase] = [
    HardCase(
        name="general_error_handling_vs_specific_timeout",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General 'handle all errors' has high overlap with any error query. Specific timeout handling is better for timeout queries.",
        experiences=[
            HardCaseExperience(
                context="handling errors in production services",
                action="add comprehensive error handling with logging and alerts",
                result="all errors caught and reported",
                learning="add error handling with structured logging and monitoring alerts for all service errors",
                domain="coding",
                confidence=0.9,
                importance=0.8,
            ),
            HardCaseExperience(
                context="HTTP client timeout causing cascade failures",
                action="add circuit breaker with timeout and fallback",
                result="cascade failures prevented",
                learning="use circuit breaker pattern with configurable timeout and fallback for HTTP client calls",
                domain="network",
                confidence=0.85,
                importance=0.9,
            ),
        ],
        query="HTTP client calls timing out causing cascade failures need circuit breaker timeout",
        expected_best_index=1,
    ),
    HardCase(
        name="general_testing_vs_specific_flaky",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General testing advice matches broadly. Specific flaky test fix is better for flaky test query.",
        experiences=[
            HardCaseExperience(
                context="improving test suite quality",
                action="increase test coverage and add integration tests",
                result="test confidence improved",
                learning="write both unit and integration tests for comprehensive coverage of critical paths",
                domain="testing",
            ),
            HardCaseExperience(
                context="integration test flaking due to race condition in async setup",
                action="add explicit async barriers and deterministic test fixtures",
                result="test passes reliably in CI",
                learning="replace timing-dependent setup with explicit async barriers and deterministic fixtures for flaky tests",
                domain="testing",
            ),
        ],
        query="integration test flaking in CI race condition async setup deterministic",
        expected_best_index=1,
    ),
    HardCase(
        name="general_security_vs_specific_sqli",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General security advice vs specific SQL injection fix.",
        experiences=[
            HardCaseExperience(
                context="securing web application against attacks",
                action="implement security headers and input validation",
                result="security posture improved",
                learning="add security headers CSP CORS and validate all user input to protect web applications",
                domain="security",
            ),
            HardCaseExperience(
                context="SQL injection vulnerability in user search endpoint",
                action="switch from string concatenation to parameterized queries",
                result="SQL injection vulnerability eliminated",
                learning="always use parameterized queries instead of string concatenation to prevent SQL injection",
                domain="security",
            ),
        ],
        query="SQL injection vulnerability user input parameterized queries string concatenation",
        expected_best_index=1,
    ),
    HardCase(
        name="general_deployment_vs_specific_rollback",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General deployment advice vs specific rollback strategy.",
        experiences=[
            HardCaseExperience(
                context="deploying applications to production",
                action="set up CI/CD pipeline with staging environment",
                result="reliable deployment process",
                learning="use CI/CD pipeline with staging environment to validate deployments before production",
                domain="devops",
            ),
            HardCaseExperience(
                context="production deployment caused 500 errors need immediate rollback",
                action="use immutable deployment artifacts with one-click rollback",
                result="rolled back in under 60 seconds",
                learning="keep immutable deployment artifacts and one-click rollback capability for instant recovery",
                domain="devops",
            ),
        ],
        query="production deployment broke need rollback immediately immutable artifacts",
        expected_best_index=1,
    ),
    HardCase(
        name="general_monitoring_vs_specific_memory_leak",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General monitoring vs specific memory leak detection.",
        experiences=[
            HardCaseExperience(
                context="monitoring production services",
                action="set up dashboards with CPU memory and error rate metrics",
                result="service health visible at a glance",
                learning="monitor CPU usage memory consumption and error rates with real-time dashboards",
                domain="devops",
            ),
            HardCaseExperience(
                context="Node.js service memory growing unbounded over hours",
                action="use heap snapshots and allocation timeline to find leak",
                result="found event listener not being removed",
                learning="use Chrome DevTools heap snapshots to identify memory leaks from unreleased event listeners",
                domain="performance",
            ),
        ],
        query="Node.js service memory growing unbounded heap snapshot leak event listeners",
        expected_best_index=1,
    ),
    HardCase(
        name="general_database_vs_specific_deadlock",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General database optimization vs specific deadlock resolution.",
        experiences=[
            HardCaseExperience(
                context="optimizing database performance",
                action="analyze slow queries and add appropriate indexes",
                result="overall query performance improved",
                learning="regularly analyze slow query log and add indexes on frequently filtered columns",
                domain="database",
            ),
            HardCaseExperience(
                context="database deadlock between two concurrent transactions",
                action="enforce consistent lock ordering across all transactions",
                result="deadlocks eliminated",
                learning="always acquire locks in consistent alphabetical order across transactions to prevent deadlocks",
                domain="database",
            ),
        ],
        query="database deadlock concurrent transactions lock ordering prevent",
        expected_best_index=1,
    ),
    HardCase(
        name="general_api_design_vs_specific_pagination",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General API advice vs specific cursor pagination for large datasets.",
        experiences=[
            HardCaseExperience(
                context="designing REST API endpoints",
                action="follow REST conventions with proper status codes and versioning",
                result="API is consistent and well-documented",
                learning="use proper HTTP status codes resource naming and API versioning for REST APIs",
                domain="coding",
            ),
            HardCaseExperience(
                context="API endpoint returns 50k records causing OOM",
                action="implement cursor-based pagination with configurable page size",
                result="endpoint handles any dataset size efficiently",
                learning="use cursor-based pagination instead of offset pagination for large datasets to prevent OOM",
                domain="coding",
            ),
        ],
        query="API endpoint returns too many records OOM cursor pagination large dataset",
        expected_best_index=1,
    ),
    HardCase(
        name="general_logging_vs_specific_pii",
        category="specificity_trap",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="General logging advice vs specific PII scrubbing.",
        experiences=[
            HardCaseExperience(
                context="setting up application logging",
                action="configure log levels and structured output format",
                result="logs organized and searchable",
                learning="use structured logging with appropriate log levels for different environments",
                domain="coding",
            ),
            HardCaseExperience(
                context="PII data appearing in production log files",
                action="add log scrubbing middleware that redacts email SSN and credit card patterns",
                result="no PII in log files",
                learning="add log scrubbing middleware to redact PII patterns like email SSN and credit card numbers",
                domain="security",
            ),
        ],
        query="PII personal data appearing in production logs scrubbing redact email SSN",
        expected_best_index=1,
    ),
]

# ---------------------------------------------------------------------------
# Category: contradiction_resolution
# Old experience says X, newer one corrects it. System should prefer newer.
# ---------------------------------------------------------------------------

CONTRADICTION_RESOLUTION: list[HardCase] = [
    HardCase(
        name="api_version_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old experience recommends v1 API, new one says v2. Recency signal in reranking should prefer the correction.",
        experiences=[
            HardCaseExperience(
                context="integrating with payment service",
                action="use payment service v1 API",
                result="payments processed successfully",
                learning="use payment service v1 API endpoint for processing transactions",
                domain="coding",
                confidence=0.8,
                created_at_offset_days=90,  # Old
            ),
            HardCaseExperience(
                context="payment service v1 API deprecated",
                action="migrate to payment service v2 API",
                result="v2 API working with better error handling",
                learning="use payment service v2 API because v1 is deprecated and will be removed",
                domain="coding",
                confidence=0.9,
                created_at_offset_days=2,  # Recent
            ),
        ],
        query="which payment service API version to use v1 v2 deprecated",
        expected_best_index=1,
    ),
    HardCase(
        name="python_version_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old experience says Python 3.8, new one says 3.11+.",
        experiences=[
            HardCaseExperience(
                context="setting up Python project",
                action="use Python 3.8 for maximum compatibility",
                result="project works on all servers",
                learning="use Python 3.8 for projects requiring broad server compatibility",
                domain="coding",
                confidence=0.7,
                created_at_offset_days=120,
            ),
            HardCaseExperience(
                context="Python 3.8 end of life reached",
                action="upgrade to Python 3.11 or newer",
                result="better performance and security patches available",
                learning="use Python 3.11 or newer since Python 3.8 has reached end of life and gets no security patches",
                domain="coding",
                confidence=0.95,
                created_at_offset_days=1,
            ),
        ],
        query="which Python version to use for new project 3.8 3.11 compatibility",
        expected_best_index=1,
    ),
    HardCase(
        name="auth_method_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says API keys, new says OAuth2. Recency should win.",
        experiences=[
            HardCaseExperience(
                context="authenticating third-party API integrations",
                action="use API keys for simplicity",
                result="integration working",
                learning="use API keys for third-party service authentication for quick integration",
                domain="security",
                confidence=0.7,
                created_at_offset_days=100,
            ),
            HardCaseExperience(
                context="API key leaked in public repository",
                action="switch to OAuth2 with short-lived tokens and key rotation",
                result="no more key exposure risk",
                learning="use OAuth2 with short-lived tokens instead of static API keys to prevent credential leaks",
                domain="security",
                confidence=0.95,
                created_at_offset_days=3,
            ),
        ],
        query="how to authenticate third-party API integration API keys OAuth2 tokens",
        expected_best_index=1,
    ),
    HardCase(
        name="node_runtime_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says use callbacks, new says async/await. Recency + confidence should prefer newer.",
        experiences=[
            HardCaseExperience(
                context="handling asynchronous operations in Node.js",
                action="use callback pattern for async operations",
                result="async operations handled",
                learning="use callback pattern for handling asynchronous file and network operations in Node.js",
                domain="coding",
                confidence=0.5,
                created_at_offset_days=150,
            ),
            HardCaseExperience(
                context="callback hell making code unreadable",
                action="refactor to async/await with proper error boundaries",
                result="code is readable and maintainable",
                learning="use async/await instead of callbacks in Node.js for readable and maintainable async code",
                domain="coding",
                confidence=0.95,
                created_at_offset_days=5,
            ),
        ],
        query="handling async operations in Node.js callbacks async await pattern",
        expected_best_index=1,
    ),
    HardCase(
        name="docker_compose_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says docker-compose (v1), new says docker compose (v2).",
        experiences=[
            HardCaseExperience(
                context="running multi-container application",
                action="use docker-compose command to start services",
                result="services running",
                learning="run docker-compose up -d to start multi-container applications in detached mode",
                domain="devops",
                confidence=0.6,
                created_at_offset_days=180,
            ),
            HardCaseExperience(
                context="docker-compose v1 is deprecated",
                action="migrate to docker compose v2 plugin syntax",
                result="using supported compose version",
                learning="use 'docker compose' (v2 plugin) instead of 'docker-compose' (v1) which is deprecated",
                domain="devops",
                confidence=0.9,
                created_at_offset_days=7,
            ),
        ],
        query="docker compose vs docker-compose which version multi-container deprecated",
        expected_best_index=1,
    ),
    HardCase(
        name="testing_framework_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says Jest, new says Vitest. More recent and higher confidence.",
        experiences=[
            HardCaseExperience(
                context="setting up TypeScript test framework",
                action="configure Jest with ts-jest transformer",
                result="tests running with TypeScript support",
                learning="use Jest with ts-jest for TypeScript testing projects",
                domain="testing",
                confidence=0.6,
                created_at_offset_days=140,
            ),
            HardCaseExperience(
                context="Jest slow for large TypeScript projects",
                action="migrate to Vitest for native ESM and TypeScript support",
                result="test suite 5x faster",
                learning="use Vitest instead of Jest for TypeScript projects because it has native ESM support and is much faster",
                domain="testing",
                confidence=0.9,
                created_at_offset_days=3,
            ),
        ],
        query="TypeScript test framework Jest Vitest which to use ESM support",
        expected_best_index=1,
    ),
    HardCase(
        name="state_management_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says Redux, new says Zustand. Recency favors the correction.",
        experiences=[
            HardCaseExperience(
                context="managing global state in React application",
                action="set up Redux with actions reducers and store",
                result="global state management working",
                learning="use Redux with actions and reducers for managing complex global state in React",
                domain="coding",
                confidence=0.65,
                created_at_offset_days=160,
            ),
            HardCaseExperience(
                context="Redux boilerplate slowing down development",
                action="replace Redux with Zustand for simpler state management",
                result="70% less boilerplate code same functionality",
                learning="use Zustand instead of Redux for React state management to reduce boilerplate significantly",
                domain="coding",
                confidence=0.9,
                created_at_offset_days=5,
            ),
        ],
        query="React state management Redux Zustand which one less boilerplate global state",
        expected_best_index=1,
    ),
    HardCase(
        name="css_approach_correction",
        category="contradiction_resolution",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Old says CSS-in-JS, new says Tailwind. Recency should prefer newer.",
        experiences=[
            HardCaseExperience(
                context="styling React components",
                action="use styled-components for CSS-in-JS",
                result="components styled with scoped CSS",
                learning="use styled-components CSS-in-JS for scoped styling in React components",
                domain="coding",
                confidence=0.6,
                created_at_offset_days=130,
            ),
            HardCaseExperience(
                context="CSS-in-JS causing runtime performance issues",
                action="switch to Tailwind CSS utility classes",
                result="zero runtime CSS overhead smaller bundle size",
                learning="use Tailwind CSS utility classes instead of CSS-in-JS for better runtime performance and smaller bundles",
                domain="coding",
                confidence=0.9,
                created_at_offset_days=4,
            ),
        ],
        query="React component styling CSS-in-JS Tailwind performance runtime overhead",
        expected_best_index=1,
    ),
]

# ---------------------------------------------------------------------------
# Category: noisy_context
# Experience has irrelevant context words that dilute Jaccard overlap.
# ---------------------------------------------------------------------------

NOISY_CONTEXT: list[HardCase] = [
    HardCase(
        name="buried_learning_in_noise",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="The relevant experience has lots of irrelevant context words that dilute token overlap with the query.",
        experiences=[
            HardCaseExperience(
                context="during the quarterly planning meeting on Tuesday afternoon the team discussed various infrastructure topics including cloud costs budget reviews and the ongoing discussion about whether to switch providers and eventually got to the topic of the Redis cluster configuration",
                action="reviewed Redis cluster configuration and found maxmemory not set",
                result="after a long discussion and several tangential debates about vendor choice the team finally set maxmemory-policy to allkeys-lru",
                learning="set Redis maxmemory and maxmemory-policy to allkeys-lru to prevent out of memory crashes",
                domain="database",
            ),
            HardCaseExperience(
                context="Redis configuration best practices",
                action="configure Redis persistence settings",
                result="data persists across restarts",
                learning="enable Redis AOF persistence for durability and configure fsync to everysec",
                domain="database",
            ),
        ],
        query="Redis out of memory crash maxmemory policy allkeys-lru configuration",
        expected_best_index=0,
    ),
    HardCase(
        name="signal_in_verbose_log",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Relevant experience has verbose log-like context. Query is precise.",
        experiences=[
            HardCaseExperience(
                context="2024-01-15T10:23:45Z INFO starting deployment pipeline for service-auth v2.3.1 to production-us-east-1 triggered by merge to main branch commit abc123def456 by user ops-engineer after approval from security-review team",
                action="noticed deployment stuck at health check stage for 15 minutes before timing out and rolling back automatically",
                result="root cause was health check endpoint returning 503 because database migration had not completed",
                learning="ensure database migrations complete before deploying new application version by adding migration check to readiness probe",
                domain="devops",
            ),
            HardCaseExperience(
                context="deployment health check configuration",
                action="configure health check intervals and thresholds",
                result="health checks properly detect unhealthy instances",
                learning="set health check interval to 10 seconds with 3 failure threshold for reliable detection",
                domain="devops",
            ),
        ],
        query="deployment stuck health check failing database migration not completed readiness probe",
        expected_best_index=0,
    ),
    HardCase(
        name="key_insight_in_rambling_context",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="The actionable learning is buried in a rambling context with many unrelated words.",
        experiences=[
            HardCaseExperience(
                context="after spending three days investigating why the nightly batch job was failing randomly and checking all the usual suspects like network issues disk space CPU utilization cron scheduling and even daylight saving time changes it turned out the PostgreSQL connection was being silently dropped",
                action="added connection validation query before executing batch operations",
                result="batch job has been stable for 6 months since",
                learning="validate PostgreSQL connections with a test query before starting batch operations because idle connections get dropped silently",
                domain="database",
            ),
            HardCaseExperience(
                context="PostgreSQL connection pooling setup",
                action="configure PgBouncer connection pool",
                result="connection pooling working efficiently",
                learning="use PgBouncer for PostgreSQL connection pooling to handle many short-lived connections",
                domain="database",
            ),
        ],
        query="PostgreSQL connection dropped silently batch job failing validate test query",
        expected_best_index=0,
    ),
    HardCase(
        name="solution_buried_in_error_dump",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Context includes error stack trace noise but learning contains the actual fix.",
        experiences=[
            HardCaseExperience(
                context="Error: EMFILE too many open files at Object.openSync fs.js:498 at Module._compile internal/modules/cjs/loader.js:778 at Object.Module._extensions..js at Module.load at Function.Module._load at Module.require at require internal/modules/cjs/helpers.js:88 during npm install with 5000 dependencies",
                action="increased system file descriptor limit using ulimit",
                result="npm install completes successfully with all 5000 dependencies",
                learning="increase file descriptor limit with ulimit -n 65536 when npm install fails with EMFILE too many open files",
                domain="shell",
            ),
            HardCaseExperience(
                context="npm install failing with network errors",
                action="configure npm registry mirror",
                result="installs complete without network timeouts",
                learning="set npm registry to a mirror when network timeouts cause install failures",
                domain="shell",
            ),
        ],
        query="npm install EMFILE too many open files ulimit file descriptor limit",
        expected_best_index=0,
    ),
    HardCase(
        name="solution_in_long_postmortem",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Context is a full postmortem narrative with the fix at the end.",
        experiences=[
            HardCaseExperience(
                context="postmortem for outage on 2024-03-15: at 14:23 UTC monitoring detected elevated error rates on the payment processing service. Initial investigation focused on recent deployments but the last deploy was 3 days prior. Network team confirmed no infrastructure changes. Database team reported normal query latency. The issue was eventually traced to a memory leak in the connection pool middleware introduced in a dependency update two weeks prior that only manifested under sustained high load",
                action="pinned the problematic dependency version and added memory usage alerts",
                result="service stable, memory usage bounded, alerts in place for early detection",
                learning="pin dependency versions in lockfile and add memory usage threshold alerts to catch slow memory leaks from dependency updates",
                domain="devops",
            ),
            HardCaseExperience(
                context="dependency security vulnerability",
                action="update vulnerable dependency to patched version",
                result="vulnerability resolved",
                learning="regularly scan and update dependencies for security vulnerabilities using automated tools",
                domain="security",
            ),
        ],
        query="memory leak from dependency update pin versions lockfile memory alerts threshold",
        expected_best_index=0,
    ),
    HardCase(
        name="nugget_in_war_story",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="A useful learning is inside a long war story context.",
        experiences=[
            HardCaseExperience(
                context="spent an entire weekend debugging why the Kubernetes cluster kept losing nodes randomly and at first everyone thought it was a cloud provider issue and we even opened a support ticket and had calls with their engineering team but after extensive investigation including examining kernel logs dmesg output and systemd journal entries we discovered",
                action="found that the kubelet was being OOM-killed because system reserved memory was not configured",
                result="after setting system-reserved and kube-reserved memory parameters all nodes remained stable",
                learning="always configure kubelet system-reserved and kube-reserved memory parameters to prevent kubelet OOM kills on Kubernetes nodes",
                domain="devops",
            ),
            HardCaseExperience(
                context="Kubernetes node scaling configuration",
                action="configure cluster autoscaler with proper scaling thresholds",
                result="nodes scale up and down based on demand",
                learning="configure Kubernetes cluster autoscaler with scale-down delay and utilization thresholds",
                domain="devops",
            ),
        ],
        query="Kubernetes nodes disappearing kubelet OOM killed system-reserved kube-reserved memory",
        expected_best_index=0,
    ),
    HardCase(
        name="fix_in_multi_step_investigation",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Multi-step investigation with the actual fix at step 5.",
        experiences=[
            HardCaseExperience(
                context="investigation: step 1 checked application logs found nothing unusual. step 2 checked network connectivity all endpoints reachable. step 3 verified DNS resolution working correctly. step 4 examined TLS certificates all valid. step 5 discovered that the proxy was stripping the Authorization header on redirect responses causing authentication failures on the downstream service",
                action="configured proxy to preserve Authorization header on 301/302 redirects",
                result="authentication works correctly through the proxy for all redirect scenarios",
                learning="configure reverse proxy to preserve Authorization headers on redirect responses to prevent auth failures on downstream services",
                domain="network",
            ),
            HardCaseExperience(
                context="proxy configuration for load balancing",
                action="set up nginx as reverse proxy with upstream balancing",
                result="traffic distributed evenly across backends",
                learning="configure nginx upstream block with least_conn balancing for even traffic distribution",
                domain="network",
            ),
        ],
        query="proxy stripping Authorization header redirect 301 302 authentication failure preserve",
        expected_best_index=0,
    ),
    HardCase(
        name="config_fix_in_environment_mess",
        category="noisy_context",
        tier="jaccard",
        requires_embeddings=False,
        why_hard="Relevant experience mentions many environment-specific details but the core fix is about TZ.",
        experiences=[
            HardCaseExperience(
                context="production server in us-east-1 running Ubuntu 22.04 with Node.js 18.17.0 Docker 24.0.5 behind AWS ALB with WAF rules and CloudFront CDN was producing incorrect timestamps in audit logs compared to staging environment running on local Kubernetes cluster with same application version",
                action="found TZ environment variable was not set in production container causing UTC vs local time mismatch",
                result="set TZ=UTC explicitly in Dockerfile and all timestamps are now consistent",
                learning="always set TZ=UTC explicitly in container environment variables to ensure consistent timestamps across all deployment environments",
                domain="devops",
            ),
            HardCaseExperience(
                context="timestamp formatting in application logs",
                action="use ISO 8601 format for all timestamps",
                result="timestamps are unambiguous and parseable",
                learning="use ISO 8601 timestamp format in all log output for consistency and parseability",
                domain="coding",
            ),
        ],
        query="container timestamps wrong different environments TZ UTC timezone environment variable Dockerfile",
        expected_best_index=0,
    ),
]

# =============================================================================
# TIER: SEMANTIC — Requires real embeddings, expected to fail on Jaccard
# =============================================================================

# ---------------------------------------------------------------------------
# Category: zero_overlap_paraphrase
# Query and experience describe the same thing with completely different words.
# ---------------------------------------------------------------------------

ZERO_OVERLAP_PARAPHRASE: list[HardCase] = [
    HardCase(
        name="crash_on_startup",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Zero shared tokens between query and experience. Semantically identical meaning.",
        experiences=[
            HardCaseExperience(
                context="application fails to initialize after launch",
                action="examined bootstrap sequence and found missing configuration",
                result="added default configuration values for missing fields",
                learning="provide default values for all configuration fields so the bootstrap sequence completes even with partial config",
                domain="coding",
            ),
        ],
        query="my program crashes immediately when I start it up",
        expected_best_index=0,
    ),
    HardCase(
        name="out_of_memory_oom",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'OOM' acronym has zero overlap with 'heap allocation exceeded'. Same concept.",
        experiences=[
            HardCaseExperience(
                context="heap allocation exceeded maximum threshold during peak hours",
                action="implemented object pooling and reduced allocation frequency",
                result="heap stays within bounds during sustained load",
                learning="use object pooling to reduce garbage collection pressure and keep heap within bounds",
                domain="performance",
            ),
        ],
        query="getting OOM killed in production need to reduce memory usage",
        expected_best_index=0,
    ),
    HardCase(
        name="slow_queries_latency",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'sluggish data retrieval' vs 'slow query performance'. Same meaning, different vocabulary.",
        experiences=[
            HardCaseExperience(
                context="slow query performance on analytics dashboard",
                action="added materialized views for pre-computed aggregations",
                result="dashboard loads in under 2 seconds",
                learning="create materialized views for complex aggregation queries that run frequently",
                domain="database",
            ),
        ],
        query="data retrieval is sluggish on our reporting interface",
        expected_best_index=0,
    ),
    HardCase(
        name="rate_limiting_throttling",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'getting 429 errors' vs 'implement rate limiting'. Problem vocabulary vs solution vocabulary.",
        experiences=[
            HardCaseExperience(
                context="external API returning HTTP 429 Too Many Requests",
                action="implemented client-side rate limiter with token bucket algorithm",
                result="requests stay within API rate limits",
                learning="use token bucket rate limiter on the client side to respect external API rate limits",
                domain="network",
            ),
        ],
        query="our app keeps getting throttled by the third-party service",
        expected_best_index=0,
    ),
    HardCase(
        name="secret_management",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'hardcoded credentials' vs 'secrets in vault'. The experience is the solution to the query's problem but uses none of the same words.",
        experiences=[
            HardCaseExperience(
                context="discovered plaintext passwords embedded in source code repository",
                action="migrated all secrets to HashiCorp Vault with dynamic credential generation",
                result="no more secrets in codebase",
                learning="store all credentials in HashiCorp Vault with dynamic generation instead of hardcoding in source files",
                domain="security",
            ),
        ],
        query="we have API keys and database passwords hardcoded in our config files",
        expected_best_index=0,
    ),
    HardCase(
        name="horizontal_autoscaling",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'handle more users' vs 'horizontal pod autoscaler'. Casual question vs infrastructure answer.",
        experiences=[
            HardCaseExperience(
                context="Kubernetes horizontal pod autoscaler configured for web tier",
                action="set HPA with CPU target of 70% and min 3 max 20 replicas",
                result="web tier scales automatically with traffic",
                learning="configure Kubernetes HPA with CPU target 70% and appropriate min/max replica counts for the web tier",
                domain="devops",
            ),
        ],
        query="our website goes down whenever we get a lot of visitors at the same time",
        expected_best_index=0,
    ),
    HardCase(
        name="dns_resolution",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'can not reach the website' vs 'DNS resolution failure'. User-level language vs technical root cause.",
        experiences=[
            HardCaseExperience(
                context="DNS resolution failure for internal service discovery",
                action="fixed CoreDNS configuration and added ndots:2 to pod DNS config",
                result="service-to-service DNS resolution works reliably",
                learning="configure CoreDNS with proper ndots setting in Kubernetes for reliable internal service DNS resolution",
                domain="network",
            ),
        ],
        query="our microservices can not talk to each other by name inside the cluster",
        expected_best_index=0,
    ),
    HardCase(
        name="ci_speed",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'builds take forever' vs 'CI pipeline optimization'. Colloquial vs technical.",
        experiences=[
            HardCaseExperience(
                context="CI pipeline taking 45 minutes per build",
                action="added layer caching and test parallelization",
                result="build time reduced to 8 minutes",
                learning="cache Docker layers and run test suites in parallel to dramatically reduce CI pipeline build time",
                domain="devops",
            ),
        ],
        query="every time we push code it takes ages before we know if it works",
        expected_best_index=0,
    ),
    HardCase(
        name="tls_cert_rotation",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'browser says connection not secure' vs 'TLS certificate expired'. User symptom vs technical cause.",
        experiences=[
            HardCaseExperience(
                context="TLS certificate expired on production load balancer",
                action="set up cert-manager with Let's Encrypt for automatic renewal",
                result="certificates auto-renew 30 days before expiry",
                learning="use cert-manager with Let's Encrypt ACME for automatic TLS certificate renewal",
                domain="security",
            ),
        ],
        query="customers complaining the browser shows a scary warning about our site being unsafe",
        expected_best_index=0,
    ),
    HardCase(
        name="database_backup",
        category="zero_overlap_paraphrase",
        tier="semantic",
        requires_embeddings=True,
        why_hard="'lost all our data' vs 'implement backup strategy'. Disaster vs prevention, completely different words.",
        experiences=[
            HardCaseExperience(
                context="implemented automated database backup strategy",
                action="configured daily snapshots with 30-day retention and cross-region replication",
                result="can restore to any point in the last 30 days",
                learning="configure automated daily database snapshots with cross-region replication for disaster recovery",
                domain="database",
            ),
        ],
        query="we accidentally deleted a table and lost all the user records how to prevent this",
        expected_best_index=0,
    ),
]

# ---------------------------------------------------------------------------
# Category: problem_to_solution_gap
# Query describes a problem, experience describes the solution.
# Different vocabulary for problem vs solution.
# ---------------------------------------------------------------------------

PROBLEM_TO_SOLUTION_GAP: list[HardCase] = [
    HardCase(
        name="504_timeout_to_upstream_config",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is about 504 errors (symptom). Experience is about upstream timeout config (solution). No word overlap.",
        experiences=[
            HardCaseExperience(
                context="nginx returning 504 gateway timeout for API calls",
                action="increased proxy_read_timeout and proxy_connect_timeout in nginx config",
                result="API calls complete without 504 errors",
                learning="increase nginx proxy_read_timeout to 120s for API endpoints that process large requests",
                domain="network",
            ),
        ],
        query="users seeing 504 gateway timeout on our API when they upload large files",
        expected_best_index=0,
    ),
    HardCase(
        name="white_screen_to_build_error",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is about white screen (symptom). Experience is about webpack configuration (root cause).",
        experiences=[
            HardCaseExperience(
                context="React app showing blank white page in production",
                action="fixed webpack publicPath configuration for deployed subdirectory",
                result="app renders correctly in production subdirectory",
                learning="set webpack output.publicPath to match the deployment subdirectory path for correct asset loading",
                domain="coding",
            ),
        ],
        query="deployed our React app and all users see is a blank white page",
        expected_best_index=0,
    ),
    HardCase(
        name="email_not_delivered_to_spf",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about emails going to spam. Experience about SPF/DKIM configuration.",
        experiences=[
            HardCaseExperience(
                context="transactional emails landing in spam folders",
                action="configured SPF DKIM and DMARC DNS records for sending domain",
                result="email deliverability improved from 40% to 98%",
                learning="configure SPF DKIM and DMARC DNS records for any domain used to send transactional emails",
                domain="network",
            ),
        ],
        query="customers not receiving our notification emails or they end up in junk folder",
        expected_best_index=0,
    ),
    HardCase(
        name="slow_page_to_n_plus_one",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about slow page. Experience about N+1 query problem. Completely different domains of language.",
        experiences=[
            HardCaseExperience(
                context="product listing page loading slowly with many database queries",
                action="replaced N+1 queries with eager loading using JOIN",
                result="page load reduced from 5s to 200ms",
                learning="use eager loading with JOINs to eliminate N+1 query problems on list pages",
                domain="database",
            ),
        ],
        query="our product catalog page takes 5 seconds to show up for users",
        expected_best_index=0,
    ),
    HardCase(
        name="mobile_app_crash_to_null_safety",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about mobile crash. Experience about null pointer handling.",
        experiences=[
            HardCaseExperience(
                context="mobile app crashing when API returns unexpected null fields",
                action="added null safety checks and default values for all API response fields",
                result="app handles missing data gracefully",
                learning="always add null safety checks with sensible defaults for every field in API response parsing",
                domain="coding",
            ),
        ],
        query="our Android app keeps force closing when users open their profile",
        expected_best_index=0,
    ),
    HardCase(
        name="disk_full_to_log_rotation",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about disk full (symptom). Experience about log rotation (solution).",
        experiences=[
            HardCaseExperience(
                context="server disk reached 100% capacity from application logs",
                action="configured logrotate with daily rotation 7-day retention and compression",
                result="disk usage stable at 30%",
                learning="configure logrotate with daily rotation compress and maxsize 100M to prevent disk exhaustion from logs",
                domain="devops",
            ),
        ],
        query="production server ran out of storage space and stopped responding",
        expected_best_index=0,
    ),
    HardCase(
        name="intermittent_failure_to_connection_reuse",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about random 502 errors. Experience about keepalive/connection reuse.",
        experiences=[
            HardCaseExperience(
                context="random 502 bad gateway errors on nginx reverse proxy",
                action="enabled upstream keepalive connections and set keepalive_timeout",
                result="502 errors eliminated",
                learning="enable nginx upstream keepalive connections with keepalive 32 and keepalive_timeout 60s to prevent 502 errors",
                domain="network",
            ),
        ],
        query="we get random 502 errors about 5% of the time and can not figure out why",
        expected_best_index=0,
    ),
    HardCase(
        name="data_inconsistency_to_transactions",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about data being wrong. Experience about database transactions.",
        experiences=[
            HardCaseExperience(
                context="user balance and order records becoming inconsistent",
                action="wrapped related database operations in ACID transactions with proper isolation level",
                result="data consistency maintained even under concurrent operations",
                learning="use database transactions with SERIALIZABLE isolation for operations that must be atomic and consistent",
                domain="database",
            ),
        ],
        query="sometimes user accounts show the wrong balance after they make a purchase",
        expected_best_index=0,
    ),
    HardCase(
        name="build_size_to_tree_shaking",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about large JS bundle. Experience about tree shaking.",
        experiences=[
            HardCaseExperience(
                context="JavaScript bundle size causing slow page loads on mobile",
                action="enabled tree shaking and code splitting with dynamic imports",
                result="initial bundle reduced from 2MB to 300KB",
                learning="enable tree shaking and use dynamic imports for code splitting to reduce JavaScript bundle size",
                domain="performance",
            ),
        ],
        query="our web app downloads way too much JavaScript and is unusable on slow phones",
        expected_best_index=0,
    ),
    HardCase(
        name="clock_skew_to_ntp",
        category="problem_to_solution_gap",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query about auth tokens randomly failing. Experience about NTP clock sync. Non-obvious root cause.",
        experiences=[
            HardCaseExperience(
                context="JWT validation failing intermittently across service fleet",
                action="discovered clock skew between servers and configured NTP synchronization",
                result="JWT validation consistent across all servers",
                learning="ensure NTP time synchronization across all servers to prevent JWT validation failures from clock skew",
                domain="security",
            ),
        ],
        query="authentication tokens work on some servers but randomly fail on others",
        expected_best_index=0,
    ),
]

# ---------------------------------------------------------------------------
# Category: abstraction_shift
# Query at a different abstraction level than the experience.
# ---------------------------------------------------------------------------

ABSTRACTION_SHIFT: list[HardCase] = [
    HardCase(
        name="make_app_faster_to_caching",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is abstract ('faster'). Experience is concrete (Redis caching for user profiles).",
        experiences=[
            HardCaseExperience(
                context="user profile API endpoint response time over 2 seconds",
                action="added Redis caching layer with 5-minute TTL for user profile data",
                result="response time reduced to 50ms for cached profiles",
                learning="cache frequently accessed user profile data in Redis with 5-minute TTL for sub-100ms response times",
                domain="performance",
            ),
        ],
        query="how to make our application respond faster to users",
        expected_best_index=0,
    ),
    HardCase(
        name="more_reliable_to_circuit_breaker",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is vague ('more reliable'). Experience is concrete implementation (circuit breaker).",
        experiences=[
            HardCaseExperience(
                context="payment service outage causing entire checkout to fail",
                action="implemented circuit breaker with fallback to queued processing",
                result="checkout stays functional even when payment service is down",
                learning="implement circuit breaker pattern with fallback queue for critical service dependencies",
                domain="coding",
            ),
        ],
        query="how to prevent one broken thing from taking down our whole system",
        expected_best_index=0,
    ),
    HardCase(
        name="save_money_to_reserved_instances",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is business-level ('save money on cloud'). Experience is specific infrastructure action.",
        experiences=[
            HardCaseExperience(
                context="AWS monthly bill growing 30% quarter over quarter",
                action="purchased reserved instances for stable workloads and enabled spot instances for batch jobs",
                result="cloud costs reduced by 45%",
                learning="use reserved instances for predictable workloads and spot instances for batch processing to reduce AWS costs",
                domain="devops",
            ),
        ],
        query="our cloud infrastructure costs are getting out of control",
        expected_best_index=0,
    ),
    HardCase(
        name="better_code_quality_to_linting",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is abstract ('better code quality'). Experience is concrete (ESLint + Prettier).",
        experiences=[
            HardCaseExperience(
                context="inconsistent code style causing merge conflicts and review delays",
                action="configured ESLint with strict rules and Prettier for auto-formatting with pre-commit hooks",
                result="code style unified, merge conflicts from formatting eliminated",
                learning="enforce ESLint strict rules and Prettier auto-formatting via pre-commit hooks for consistent code style",
                domain="coding",
            ),
        ],
        query="our team writes very messy inconsistent code and reviews take forever",
        expected_best_index=0,
    ),
    HardCase(
        name="handle_traffic_to_load_balancer",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is abstract ('handle more traffic'). Experience is concrete (ALB + target groups).",
        experiences=[
            HardCaseExperience(
                context="single server unable to handle growing user base",
                action="set up AWS ALB with auto-scaling target group across multiple AZs",
                result="system handles 50x the previous traffic",
                learning="use AWS ALB with auto-scaling across multiple availability zones to handle growing traffic",
                domain="devops",
            ),
        ],
        query="we need our website to handle way more visitors than it currently can",
        expected_best_index=0,
    ),
    HardCase(
        name="find_bugs_faster_to_observability",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is abstract ('find bugs faster'). Experience is specific (distributed tracing).",
        experiences=[
            HardCaseExperience(
                context="debugging production issues takes hours across multiple services",
                action="implemented distributed tracing with Jaeger and correlated log aggregation",
                result="root cause identification reduced from hours to minutes",
                learning="implement distributed tracing with Jaeger and centralized log aggregation for fast root cause analysis",
                domain="devops",
            ),
        ],
        query="when something breaks in production we have no idea where to look",
        expected_best_index=0,
    ),
    HardCase(
        name="protect_user_data_to_encryption",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is business-level ('protect user data'). Experience is technical (encryption at rest).",
        experiences=[
            HardCaseExperience(
                context="storing sensitive user data without encryption",
                action="enabled AES-256 encryption at rest for database and S3 with KMS key management",
                result="all user data encrypted in storage",
                learning="enable AES-256 encryption at rest for all databases and object storage using AWS KMS for key management",
                domain="security",
            ),
        ],
        query="we need to make sure nobody can steal our users personal information",
        expected_best_index=0,
    ),
    HardCase(
        name="easier_onboarding_to_dev_containers",
        category="abstraction_shift",
        tier="semantic",
        requires_embeddings=True,
        why_hard="Query is organizational ('easier onboarding'). Experience is technical (dev containers).",
        experiences=[
            HardCaseExperience(
                context="new developers take 2 days to set up local development environment",
                action="created devcontainer configuration with all dependencies pre-installed",
                result="new developers productive within 30 minutes",
                learning="create a devcontainer.json with all project dependencies for instant development environment setup",
                domain="devops",
            ),
        ],
        query="new team members spend their whole first week just trying to get things running",
        expected_best_index=0,
    ),
]


# =============================================================================
# Registry: all cases by category
# =============================================================================

ALL_HARD_CASES: dict[str, list[HardCase]] = {
    "near_miss_distractors": NEAR_MISS_DISTRACTORS,
    "domain_confusion": DOMAIN_CONFUSION,
    "specificity_trap": SPECIFICITY_TRAP,
    "contradiction_resolution": CONTRADICTION_RESOLUTION,
    "noisy_context": NOISY_CONTEXT,
    "zero_overlap_paraphrase": ZERO_OVERLAP_PARAPHRASE,
    "problem_to_solution_gap": PROBLEM_TO_SOLUTION_GAP,
    "abstraction_shift": ABSTRACTION_SHIFT,
}

JACCARD_CATEGORIES = [
    "near_miss_distractors",
    "domain_confusion",
    "specificity_trap",
    "contradiction_resolution",
    "noisy_context",
]

SEMANTIC_CATEGORIES = [
    "zero_overlap_paraphrase",
    "problem_to_solution_gap",
    "abstraction_shift",
]


def get_all_cases() -> list[HardCase]:
    """Return a flat list of all hard cases."""
    result: list[HardCase] = []
    for cases in ALL_HARD_CASES.values():
        result.extend(cases)
    return result


def get_jaccard_cases() -> list[HardCase]:
    """Return only cases that should be solvable with Jaccard."""
    result: list[HardCase] = []
    for cat in JACCARD_CATEGORIES:
        result.extend(ALL_HARD_CASES.get(cat, []))
    return result


def get_semantic_cases() -> list[HardCase]:
    """Return only cases that require real embeddings."""
    result: list[HardCase] = []
    for cat in SEMANTIC_CATEGORIES:
        result.extend(ALL_HARD_CASES.get(cat, []))
    return result
