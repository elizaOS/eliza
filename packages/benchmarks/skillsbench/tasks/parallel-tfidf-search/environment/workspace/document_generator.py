#!/usr/bin/env python3
"""
Document Generator for TF-IDF Testing

Generates a synthetic corpus of documents with:
- Realistic vocabulary and term distributions
- Variable document lengths (simulating real-world variation)
- Multiple topics/domains for diverse content
- Zipf-like term frequency distribution
"""

import argparse
import json
import random
import time
from collections import defaultdict
from dataclasses import asdict, dataclass

# Topic-specific vocabularies for realistic content
TOPICS = {
    "technology": {
        "nouns": [
            "algorithm",
            "software",
            "hardware",
            "database",
            "network",
            "server",
            "computer",
            "system",
            "program",
            "application",
            "interface",
            "protocol",
            "framework",
            "platform",
            "architecture",
            "infrastructure",
            "cloud",
            "security",
            "encryption",
            "authentication",
            "api",
            "microservice",
            "container",
            "kubernetes",
            "docker",
            "cache",
            "memory",
            "processor",
            "bandwidth",
            "latency",
            "throughput",
            "scalability",
            "reliability",
            "machine",
            "learning",
            "neural",
            "model",
            "training",
            "inference",
            "data",
            "analytics",
            "pipeline",
            "streaming",
            "batch",
            "realtime",
        ],
        "verbs": [
            "process",
            "compute",
            "analyze",
            "optimize",
            "implement",
            "deploy",
            "scale",
            "monitor",
            "debug",
            "test",
            "integrate",
            "migrate",
            "configure",
            "automate",
            "parallelize",
            "distribute",
            "synchronize",
            "cache",
            "compress",
            "encrypt",
            "authenticate",
            "validate",
        ],
        "adjectives": [
            "distributed",
            "parallel",
            "concurrent",
            "asynchronous",
            "scalable",
            "reliable",
            "efficient",
            "robust",
            "secure",
            "optimized",
            "automated",
            "real-time",
            "high-performance",
            "fault-tolerant",
            "cloud-native",
        ],
    },
    "science": {
        "nouns": [
            "research",
            "experiment",
            "hypothesis",
            "theory",
            "observation",
            "analysis",
            "methodology",
            "sample",
            "variable",
            "correlation",
            "causation",
            "phenomenon",
            "measurement",
            "instrument",
            "laboratory",
            "study",
            "findings",
            "results",
            "conclusion",
            "evidence",
            "data",
            "statistics",
            "probability",
            "distribution",
            "variance",
            "deviation",
            "particle",
            "molecule",
            "atom",
            "cell",
            "organism",
            "species",
            "genome",
            "protein",
            "enzyme",
            "reaction",
            "compound",
            "element",
        ],
        "verbs": [
            "observe",
            "measure",
            "analyze",
            "hypothesize",
            "experiment",
            "validate",
            "replicate",
            "synthesize",
            "isolate",
            "identify",
            "classify",
            "quantify",
            "correlate",
            "predict",
            "simulate",
        ],
        "adjectives": [
            "empirical",
            "theoretical",
            "experimental",
            "quantitative",
            "qualitative",
            "statistical",
            "significant",
            "controlled",
            "reproducible",
            "systematic",
            "rigorous",
            "peer-reviewed",
        ],
    },
    "business": {
        "nouns": [
            "market",
            "customer",
            "revenue",
            "profit",
            "growth",
            "strategy",
            "investment",
            "portfolio",
            "stakeholder",
            "shareholder",
            "dividend",
            "acquisition",
            "merger",
            "partnership",
            "venture",
            "startup",
            "enterprise",
            "corporation",
            "subsidiary",
            "franchise",
            "brand",
            "product",
            "service",
            "pricing",
            "margin",
            "cost",
            "budget",
            "forecast",
            "projection",
            "quarter",
            "fiscal",
            "annual",
            "report",
        ],
        "verbs": [
            "invest",
            "acquire",
            "merge",
            "diversify",
            "expand",
            "launch",
            "market",
            "sell",
            "purchase",
            "negotiate",
            "contract",
            "outsource",
            "streamline",
            "restructure",
            "monetize",
            "capitalize",
            "leverage",
        ],
        "adjectives": [
            "profitable",
            "sustainable",
            "competitive",
            "strategic",
            "fiscal",
            "quarterly",
            "annual",
            "global",
            "domestic",
            "emerging",
            "mature",
            "disruptive",
            "innovative",
            "scalable",
            "diversified",
        ],
    },
    "health": {
        "nouns": [
            "patient",
            "diagnosis",
            "treatment",
            "therapy",
            "medication",
            "symptom",
            "disease",
            "condition",
            "disorder",
            "syndrome",
            "infection",
            "inflammation",
            "immunity",
            "vaccine",
            "antibody",
            "hospital",
            "clinic",
            "physician",
            "surgeon",
            "nurse",
            "specialist",
            "procedure",
            "surgery",
            "recovery",
            "rehabilitation",
            "prevention",
            "nutrition",
            "exercise",
            "lifestyle",
            "wellness",
            "mental",
            "physical",
        ],
        "verbs": [
            "diagnose",
            "treat",
            "prescribe",
            "administer",
            "monitor",
            "examine",
            "evaluate",
            "assess",
            "recommend",
            "prevent",
            "rehabilitate",
            "recover",
            "heal",
            "immunize",
            "vaccinate",
        ],
        "adjectives": [
            "clinical",
            "medical",
            "therapeutic",
            "preventive",
            "chronic",
            "acute",
            "infectious",
            "genetic",
            "hereditary",
            "symptomatic",
            "asymptomatic",
            "benign",
            "malignant",
            "invasive",
            "non-invasive",
        ],
    },
    "general": {
        "nouns": [
            "time",
            "year",
            "people",
            "way",
            "day",
            "man",
            "woman",
            "child",
            "world",
            "life",
            "hand",
            "part",
            "place",
            "case",
            "week",
            "company",
            "system",
            "program",
            "question",
            "work",
            "government",
            "number",
            "night",
            "point",
            "home",
            "water",
            "room",
            "mother",
            "area",
            "money",
            "story",
            "fact",
            "month",
            "lot",
            "right",
            "study",
            "book",
            "eye",
            "job",
            "word",
            "business",
            "issue",
            "side",
            "kind",
            "head",
            "house",
            "service",
            "friend",
            "father",
            "power",
            "hour",
            "game",
            "line",
        ],
        "verbs": [
            "be",
            "have",
            "do",
            "say",
            "get",
            "make",
            "go",
            "know",
            "take",
            "see",
            "come",
            "think",
            "look",
            "want",
            "give",
            "use",
            "find",
            "tell",
            "ask",
            "work",
            "seem",
            "feel",
            "try",
            "leave",
            "call",
            "keep",
            "let",
            "begin",
            "show",
            "hear",
            "play",
            "run",
            "move",
        ],
        "adjectives": [
            "good",
            "new",
            "first",
            "last",
            "long",
            "great",
            "little",
            "own",
            "other",
            "old",
            "right",
            "big",
            "high",
            "different",
            "small",
            "large",
            "next",
            "early",
            "young",
            "important",
            "few",
            "public",
            "bad",
            "same",
            "able",
            "local",
            "sure",
            "free",
            "best",
            "better",
        ],
    },
}

# Common English stop words and connectors
CONNECTORS = [
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "is",
    "was",
    "are",
    "were",
    "been",
    "be",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "they",
    "them",
    "their",
    "we",
    "us",
    "our",
    "you",
    "your",
    "he",
    "him",
    "his",
    "she",
    "her",
    "which",
    "who",
    "whom",
    "what",
    "where",
    "when",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "not",
    "only",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "also",
    "now",
    "here",
    "there",
    "then",
    "once",
]


@dataclass
class Document:
    """Represents a generated document."""

    doc_id: int
    title: str
    content: str
    topic: str
    word_count: int


def zipf_choice(items: list[str], alpha: float = 1.2) -> str:
    """
    Select an item using Zipf-like distribution.
    Earlier items in the list are more likely to be selected.
    """
    n = len(items)
    weights = [1.0 / ((i + 1) ** alpha) for i in range(n)]
    return random.choices(items, weights=weights, k=1)[0]


def generate_sentence(topic_vocab: dict[str, list[str]], length: int = None) -> str:  # noqa: RUF013
    """Generate a realistic-looking sentence."""
    if length is None:
        length = random.randint(8, 25)

    words = []
    general = TOPICS["general"]

    for i in range(length):  # noqa: B007
        roll = random.random()

        if roll < 0.3:
            # Use connector/common word
            words.append(random.choice(CONNECTORS))
        elif roll < 0.55:
            # Use topic noun
            words.append(zipf_choice(topic_vocab["nouns"]))
        elif roll < 0.75:
            # Use topic verb
            words.append(zipf_choice(topic_vocab["verbs"]))
        elif roll < 0.85:
            # Use topic adjective
            words.append(zipf_choice(topic_vocab["adjectives"]))
        elif roll < 0.92:
            # Use general noun
            words.append(zipf_choice(general["nouns"]))
        else:
            # Use general verb/adjective
            if random.random() < 0.5:
                words.append(zipf_choice(general["verbs"]))
            else:
                words.append(zipf_choice(general["adjectives"]))

    # Capitalize first word and add period
    if words:
        words[0] = words[0].capitalize()
        sentence = " ".join(words) + "."
        return sentence
    return ""


def generate_paragraph(topic_vocab: dict[str, list[str]], sentences: int = None) -> str:  # noqa: RUF013
    """Generate a paragraph with multiple sentences."""
    if sentences is None:
        sentences = random.randint(3, 8)

    return " ".join(generate_sentence(topic_vocab) for _ in range(sentences))


def generate_document(doc_id: int, topic: str = None, min_words: int = 20, max_words: int = 10000) -> Document:  # noqa: RUF013
    """
    Generate a single document with variable length.

    Document lengths follow a log-normal distribution to simulate
    real-world variation (many short docs, few very long docs).
    High variance creates load balancing challenges for parallelization.
    """
    if topic is None:
        topic = random.choice(list(TOPICS.keys()))

    topic_vocab = TOPICS[topic]

    # Log-normal distribution with HIGH variance for load imbalance
    # mu=5.5, sigma=1.5 creates range from ~20 to ~10000 words
    # This creates significant load balancing challenges
    target_words = int(random.lognormvariate(5.5, 1.5))
    target_words = max(min_words, min(max_words, target_words))

    # Generate title
    title_words = [
        zipf_choice(topic_vocab["adjectives"]).capitalize(),
        zipf_choice(topic_vocab["nouns"]).capitalize(),
        random.choice(["Analysis", "Study", "Overview", "Guide", "Review", "Introduction", "Exploration", "Investigation"]),
    ]
    title = " ".join(title_words)

    # Generate content paragraphs until we reach target length
    paragraphs = []
    word_count = 0

    while word_count < target_words:
        para = generate_paragraph(topic_vocab)
        paragraphs.append(para)
        word_count += len(para.split())

    content = "\n\n".join(paragraphs)

    return Document(doc_id=doc_id, title=title, content=content, topic=topic, word_count=len(content.split()))


def _generate_doc_worker(args: tuple[int, str, int, int, int]) -> Document:
    """Worker function for parallel document generation."""
    doc_id, topic, min_words, max_words, worker_seed = args
    random.seed(worker_seed)
    return generate_document(doc_id, topic, min_words, max_words)


def generate_corpus(
    num_docs: int,
    seed: int = 42,
    min_words: int = 50,
    max_words: int = 2000,
    topic_distribution: dict[str, float] = None,  # noqa: RUF013
    num_workers: int = None,  # noqa: RUF013
) -> list[Document]:
    """
    Generate a corpus of documents in parallel.

    Args:
        num_docs: Number of documents to generate
        seed: Random seed for reproducibility
        min_words: Minimum words per document
        max_words: Maximum words per document
        topic_distribution: Optional dict mapping topics to probabilities
        num_workers: Number of parallel workers (default: CPU count)
    """

    random.seed(seed)

    if topic_distribution is None:
        topics = list(TOPICS.keys())
        topic_distribution = {t: 1.0 / len(topics) for t in topics}

    total = sum(topic_distribution.values())
    topic_probs = {t: p / total for t, p in topic_distribution.items()}

    topics_list = list(topic_probs.keys())
    probs_list = list(topic_probs.values())

    # Pre-generate all work items with unique seeds
    documents = []
    for i in range(num_docs):
        topic = random.choices(topics_list, weights=probs_list, k=1)[0]
        doc = generate_document(i, topic, min_words, max_words)
        documents.append(doc)

    print(f"Generated {len(documents)} documents.")
    return documents


def save_corpus(documents: list[Document], filepath: str):
    """Save corpus to JSON file."""
    data = {
        "metadata": {
            "num_documents": len(documents),
            "total_words": sum(d.word_count for d in documents),
            "topics": list(set(d.topic for d in documents)),  # noqa: C401
        },
        "documents": [asdict(d) for d in documents],
    }

    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Saved corpus to {filepath}")


def load_corpus(filepath: str) -> list[Document]:
    """Load corpus from JSON file."""
    with open(filepath) as f:
        data = json.load(f)

    documents = [Document(**doc_data) for doc_data in data["documents"]]

    return documents


def corpus_statistics(documents: list[Document]) -> dict:
    """Compute statistics about the corpus."""
    word_counts = [d.word_count for d in documents]
    topic_counts = defaultdict(int)
    for d in documents:
        topic_counts[d.topic] += 1

    return {
        "num_documents": len(documents),
        "total_words": sum(word_counts),
        "avg_words_per_doc": sum(word_counts) / len(documents),
        "min_words": min(word_counts),
        "max_words": max(word_counts),
        "median_words": sorted(word_counts)[len(word_counts) // 2],
        "topic_distribution": dict(topic_counts),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic document corpus for TF-IDF testing")
    parser.add_argument("--num-docs", type=int, default=10000, help="Number of documents to generate (default: 10000)")
    parser.add_argument("--output", type=str, default="corpus.json", help="Output file path (default: corpus.json)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument("--min-words", type=int, default=50, help="Minimum words per document (default: 50)")
    parser.add_argument("--max-words", type=int, default=2000, help="Maximum words per document (default: 2000)")

    args = parser.parse_args()

    print("=" * 60)
    print("Document Corpus Generator")
    print("=" * 60)
    print(f"\nGenerating {args.num_docs} documents...")
    print(f"Word range: {args.min_words} - {args.max_words}")
    print(f"Random seed: {args.seed}")

    start_time = time.perf_counter()
    documents = generate_corpus(num_docs=args.num_docs, seed=args.seed, min_words=args.min_words, max_words=args.max_words)
    gen_time = time.perf_counter() - start_time

    print(f"\nGeneration completed in {gen_time:.2f} seconds")

    # Print statistics
    stats = corpus_statistics(documents)
    print("\nCorpus Statistics:")
    print(f"  Total documents: {stats['num_documents']:,}")
    print(f"  Total words: {stats['total_words']:,}")
    print(f"  Average words/doc: {stats['avg_words_per_doc']:.1f}")
    print(f"  Min words: {stats['min_words']}")
    print(f"  Max words: {stats['max_words']}")
    print(f"  Median words: {stats['median_words']}")
    print("\nTopic distribution:")
    for topic, count in sorted(stats["topic_distribution"].items()):
        pct = count / stats["num_documents"] * 100
        print(f"  {topic}: {count} ({pct:.1f}%)")

    # Save to file
    save_corpus(documents, args.output)

    return documents


if __name__ == "__main__":
    main()
